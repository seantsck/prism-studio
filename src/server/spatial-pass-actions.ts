"use server";

import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { ZodError } from "zod";
import { PrevisError, type SpatialPassBundleRecord } from "@/data/previs-repository";
import { renderedBlockingProvenance } from "@/domain/previs/blocking";
import { assetSchema } from "@/domain/schemas";
import {
  CHARACTER_MASK_FORMAT,
  CHARACTER_MASKS_SCHEMA,
  DEPTH_FORMAT,
  OBJECT_ID_FORMAT,
  SPATIAL_MIME,
  cameraSourceFromBookmark,
  cameraSourceFromPath,
  MAX_MANIFEST_JSON_CHARS,
  buildControlFrame,
  checkUploadShape,
  countObjectPixels,
  decodeDepthF32,
  decodeObjectIdsU32,
  depthMatchesIds,
  depthMetadata,
  deriveCharacterMasks,
  expectedManifest,
  expectedRasterBytes,
  manifestIdentity,
  spatialBundleFingerprint,
  validateDepth,
  validateMaskValues,
  withPixelCounts,
  type CharacterMasksJson,
  type ControlCameraSource,
  type ObjectManifest,
} from "@/domain/previs/spatial-passes";
import { PREVIS_PRODUCTION_FRAME } from "@/domain/previs/types";
import { buildObjectPath } from "@/lib/storage-paths";
import { UserFacingError } from "./action-result";
import { requireUser } from "./auth";
import { getPrevisRepo } from "./previs";
import { getRepo, requireProjectFresh } from "./repo";
import { persistPassBundle, type PassStoreDeps } from "./spatial-pass-store";
import { checksum, getUploadStorage, storageForAsset } from "./storage";

/**
 * Phase 2F M2C server actions for spatial control-pass bundles. The browser renders the rasters; the server
 * RE-DERIVES everything it can (scene, rendered blocking, camera by value, object manifest, bundle fingerprint),
 * validates every raster structurally, re-derives each Character mask from the object-id raster, and only then
 * stores the private machine assets and the immutable bundle row. A failure at any point removes what that capture
 * uploaded: a bundle row never points at a missing asset.
 */
export type SpatialPassResult<T> = ({ ok: true } & T) | { ok: false; error: string; conflict?: boolean };

const str = (f: FormData, k: string) => String(f.get(k) ?? "").trim();
const actorOf = (user: Awaited<ReturnType<typeof requireUser>>) =>
  user.kind === "supabase" ? user.id : null;
const refresh = (slug: string) => revalidatePath(`/projects/${slug}`, "layout");

async function guarded<T>(body: () => Promise<SpatialPassResult<T>>): Promise<SpatialPassResult<T>> {
  try {
    return await body();
  } catch (err) {
    if (err instanceof PrevisError)
      return { ok: false, error: err.message, conflict: err.code === "conflict" };
    if (err instanceof UserFacingError) return { ok: false, error: err.message };
    if (err instanceof ZodError) return { ok: false, error: "The control pass data is not valid." };
    const digest = (err as { digest?: unknown } | null)?.digest;
    if (typeof digest === "string") throw err;
    const ref = randomUUID().slice(0, 8);
    console.error(`[spatial-passes ${ref}]`, err instanceof Error ? err.message : "unknown error");
    return { ok: false, error: `Something went wrong capturing the control passes (ref ${ref}).` };
  }
}

/** The only non-file fields a capture may carry. */
const TEXT_FIELDS = new Set([
  "projectSlug",
  "shotId",
  "locationId",
  "cameraSource",
  "timeMs",
  "blockingFingerprint",
  "bundleFingerprint",
  "manifest",
]);

const bytesOf = async (form: FormData, key: string): Promise<Uint8Array> => {
  const f = form.get(key);
  if (!(f instanceof File) || f.size === 0) throw new UserFacingError(`The ${key} pass was not received.`);
  return new Uint8Array(await f.arrayBuffer());
};

/**
 * Stores one capture. Fields: projectSlug, shotId, locationId, cameraSource ("camera_path" | "bookmark"),
 * timeMs (camera_path), blockingFingerprint (the rendered layer the client used; "" = none), bundleFingerprint (the
 * client's computed identity), manifest (JSON), files `depth`, `objectIds` and `mask:<characterId>`.
 */
export async function captureSpatialPassBundle(
  form: FormData,
): Promise<SpatialPassResult<{ bundle: SpatialPassBundleRecord; existing: boolean }>> {
  return guarded<{ bundle: SpatialPassBundleRecord; existing: boolean }>(async () => {
    const slug = str(form, "projectSlug");
    const shotId = str(form, "shotId");
    const locationId = str(form, "locationId");
    const sourceKind = str(form, "cameraSource");
    const claimedBlocking = str(form, "blockingFingerprint") || null;
    const claimedFingerprint = str(form, "bundleFingerprint");
    if (sourceKind !== "camera_path" && sourceKind !== "bookmark")
      throw new UserFacingError("Choose a camera source (camera path or Production Camera).");
    // Bounds that do not depend on any proxy / body-size setting: the request may carry only the known text fields
    // and only the files the saved state implies (checked below, before a single raster byte is read).
    for (const [key, value] of form.entries())
      if (!(value instanceof File) && !TEXT_FIELDS.has(key))
        throw new UserFacingError(`Unexpected field ${key.slice(0, 40)}.`);
    const manifestText = str(form, "manifest");
    if (manifestText.length > MAX_MANIFEST_JSON_CHARS)
      throw new UserFacingError("The object manifest is too large.");
    let claimedManifest: ObjectManifest;
    try {
      claimedManifest = JSON.parse(manifestText) as ObjectManifest;
    } catch {
      throw new UserFacingError("The object manifest is not valid.");
    }

    const user = await requireUser();
    const data = await requireProjectFresh(slug);
    const shot = data.shots.find((s) => s.id === shotId);
    if (!shot) throw new UserFacingError("That shot no longer exists.");
    if (!data.locations.some((l) => l.id === locationId))
      throw new UserFacingError("That location is not in this project.");
    const previs = await getPrevisRepo();
    const scene = await previs.getSceneForLocation(locationId);
    if (!scene || scene.projectId !== data.project.id)
      throw new UserFacingError("Save the 3D set before capturing control passes.");

    // the rendered blocking must be the SAVED blocking, anchored to the CURRENT set (server derives, client claims)
    const blockingRecords = await previs.listShotBlocking(shotId);
    const blockingProv = renderedBlockingProvenance(blockingRecords, { locationId });
    const blockingFp = blockingProv?.fingerprint ?? null;
    if (blockingFp !== claimedBlocking)
      throw new PrevisError(
        "conflict",
        "The character blocking changed after these passes were rendered. Save the blocking and capture again.",
      );
    if (
      blockingRecords.some(
        (b) =>
          b.entry.visibility &&
          (b.sceneDocumentId !== scene.id || b.sceneFingerprint !== scene.sceneFingerprint),
      )
    )
      throw new UserFacingError(
        "The character blocking is stale for the current set. Re-anchor it before capturing control passes.",
      );

    // the camera source, re-derived from SAVED state (never the navigation camera, never a client camera)
    let camera: ControlCameraSource;
    if (sourceKind === "camera_path") {
      const path = await previs.getCameraPathForShot(shotId);
      if (!path || path.projectId !== data.project.id)
        throw new UserFacingError("Save the camera path before capturing at a time on it.");
      if (path.sceneDocumentId !== scene.id || path.sceneFingerprint !== scene.sceneFingerprint)
        throw new UserFacingError(
          "The set changed since this camera path was saved. Re-save the path first.",
        );
      const timeMs = Number(str(form, "timeMs"));
      try {
        camera = cameraSourceFromPath(
          path.path,
          { id: path.id, revision: path.revision, pathFingerprint: path.pathFingerprint },
          timeMs,
        );
      } catch (e) {
        throw new UserFacingError(e instanceof Error ? e.message : "The capture time is not valid.");
      }
    } else {
      const bookmark = await previs.getBookmarkForShot(shotId);
      if (!bookmark || bookmark.projectId !== data.project.id)
        throw new UserFacingError("Use the production camera for this shot before capturing.");
      if (bookmark.sceneDocumentId !== scene.id || bookmark.sceneFingerprint !== scene.sceneFingerprint)
        throw new UserFacingError(
          "The set changed since the Production Camera was linked. Link it again first.",
        );
      camera = cameraSourceFromBookmark({ id: bookmark.id }, bookmark.value);
    }

    // the manifest implied by the saved Set + saved blocking must be exactly what the client rendered
    const names = Object.fromEntries(data.characters.map((c) => [c.id, c.name]));
    const manifest = expectedManifest(scene.document, blockingRecords, names);
    if (JSON.stringify(manifestIdentity(manifest)) !== JSON.stringify(manifestIdentity(claimedManifest)))
      throw new PrevisError(
        "conflict",
        "The objects in the set or shot changed (or did not all load) while the passes were rendered. Capture again.",
      );
    const { width, height } = PREVIS_PRODUCTION_FRAME;
    // exact files, exact canonical sizes, bounded total: from File.size, before any byte is read into memory
    const shape = checkUploadShape(
      [...form.entries()].flatMap(([key, v]) => (v instanceof File ? [{ key, size: v.size }] : [])),
      manifest,
      width,
      height,
    );
    if (!shape.ok) throw new UserFacingError(shape.error);
    const frame = buildControlFrame({
      shotId,
      scene: { documentId: scene.id, revision: scene.revision, fingerprint: scene.sceneFingerprint },
      blockingFingerprint: blockingFp,
      camera,
    });
    const bundleFingerprint = spatialBundleFingerprint({
      shotId,
      sceneFingerprint: frame.scene.fingerprint,
      blockingFingerprint: frame.blockingFingerprint,
      camera: frame.camera,
      width: frame.width,
      height: frame.height,
      manifest,
    });
    if (bundleFingerprint !== claimedFingerprint)
      throw new PrevisError(
        "conflict",
        "The camera or scene changed while the passes were rendering. Capture again.",
      );

    // the same exact control frame is captured once (rendering is deterministic)
    const prior = (await previs.listSpatialPassBundles(shotId)).find(
      (b) => b.bundleFingerprint === bundleFingerprint,
    );
    if (prior) return { ok: true, bundle: prior, existing: true };

    // ── structural validation of every raster (no trust in the browser) ──
    const depthBytes = await bytesOf(form, "depth");
    const idBytes = await bytesOf(form, "objectIds");
    if (depthBytes.byteLength !== expectedRasterBytes.depth(width, height))
      throw new UserFacingError(`The depth pass must be ${expectedRasterBytes.depth(width, height)} bytes.`);
    if (idBytes.byteLength !== expectedRasterBytes.objectIds(width, height))
      throw new UserFacingError(
        `The object-id pass must be ${expectedRasterBytes.objectIds(width, height)} bytes.`,
      );
    const depth = decodeDepthF32(depthBytes, width, height);
    const depthCheck = validateDepth(depth);
    if (!depthCheck.ok) throw new UserFacingError(depthCheck.error);
    const ids = decodeObjectIdsU32(idBytes, width, height);
    const counted = countObjectPixels(ids, manifest.objects.length);
    if (!counted.ok) throw new UserFacingError(counted.error);
    if (!depthMatchesIds(depth, ids))
      throw new UserFacingError("The depth and object-id passes do not cover the same pixels.");
    const withCounts = withPixelCounts(manifest, counted.counts);

    // each Character mask is DERIVED from the ids here and must equal what the browser sent
    const derived = deriveCharacterMasks(ids, manifest);
    const maskKeys = [...form.keys()].filter((k) => k.startsWith("mask:"));
    if (
      maskKeys.length !== derived.length ||
      derived.some((d) => !maskKeys.includes(`mask:${d.characterId}`))
    )
      throw new UserFacingError("The Character masks do not match the visible Characters of this shot.");
    const maskBytes = new Map<string, Uint8Array>();
    for (const d of derived) {
      // a fully occluded Character still has a (w×h, all-zero) mask: that is truthful
      const bytes = await bytesOf(form, `mask:${d.characterId}`);
      if (bytes.byteLength !== expectedRasterBytes.mask(width, height))
        throw new UserFacingError(
          `A Character mask must be ${expectedRasterBytes.mask(width, height)} bytes.`,
        );
      if (!validateMaskValues(bytes))
        throw new UserFacingError("A Character mask contains values other than 0 and 255.");
      for (let i = 0; i < bytes.length; i++)
        if (bytes[i] !== d.mask[i])
          throw new UserFacingError("A Character mask does not match the object-id pass.");
      maskBytes.set(d.characterId, bytes);
    }

    // ── store assets, then the immutable bundle; clean up everything on any failure ──
    const stamp = new Date().toISOString();
    const bundleId = randomUUID();
    const storage = await getUploadStorage();
    const repo = await getRepo();
    const location = data.locations.find((l) => l.id === locationId);
    const label = `${location?.name ?? "3D set"} · Shot ${shot.shotCode}`;
    const makeAsset = (
      kind: "depth" | "object-ids" | "mask",
      mime: string,
      filename: string,
      bytes: Uint8Array,
      title: string,
      extra: Record<string, unknown>,
    ) => {
      const assetId = randomUUID();
      const objectPath = buildObjectPath(data.project.id, assetId, filename);
      return {
        assetId,
        objectPath,
        mime,
        bytes,
        asset: assetSchema.parse({
          id: assetId,
          projectId: data.project.id,
          createdBy: actorOf(user),
          type: "data",
          purpose: "spatial_control",
          source: "3d_render",
          name: `${label} — ${title}`,
          originalFilename: filename,
          storageProvider: storage.name,
          bucket: storage.bucket,
          objectPath,
          mime,
          byteSize: bytes.length,
          checksum: checksum(bytes),
          width,
          height,
          durationMs: null,
          frameRate: null,
          sampleRate: null,
          channels: null,
          tags: ["spatial_pass", kind],
          notes: "",
          metadata: {
            spatialPass: {
              bundleId,
              bundleFingerprint,
              kind,
              width,
              height,
              rowOrder: "top-to-bottom",
              endianness: "little",
              ...extra,
            },
          },
          createdAt: stamp,
          updatedAt: stamp,
        }),
      };
    };

    const depthAsset = makeAsset("depth", SPATIAL_MIME.depth, "depth.f32", depthBytes, "depth", {
      encoding: DEPTH_FORMAT,
      units: "metres",
    });
    const idAsset = makeAsset("object-ids", SPATIAL_MIME.objectIds, "object-ids.u32", idBytes, "object IDs", {
      encoding: OBJECT_ID_FORMAT,
    });
    const maskAssets = derived.map((d) => {
      const rec = blockingRecords.find((b) => b.characterId === d.characterId)!;
      const m = makeAsset(
        "mask",
        SPATIAL_MIME.characterMask,
        `mask-${d.characterId.slice(0, 8)}.u8`,
        maskBytes.get(d.characterId)!,
        `${names[d.characterId] ?? "Character"} mask`,
        { encoding: CHARACTER_MASK_FORMAT, characterId: d.characterId, objectIndex: d.objectIndex },
      );
      return { d, rec, ...m };
    });

    const writes = [depthAsset, idAsset, ...maskAssets].map((a) => ({
      asset: a.asset,
      bytes: a.bytes,
      objectPath: a.objectPath,
      mime: a.mime,
    }));
    const deps: PassStoreDeps = {
      putObject: (path, bytes, mime) => storage.put(path, bytes, mime),
      upsertAsset: (asset) => repo.upsert(data.project.id, "assets", asset),
      removeAsset: (id) => repo.remove(data.project.id, "assets", id),
      removeObject: async (asset) => {
        const st = await storageForAsset(asset);
        if (st && asset.objectPath) await st.remove(asset.objectPath);
      },
    };
    const characterMasks: CharacterMasksJson = {
      schema: CHARACTER_MASKS_SCHEMA,
      masks: Object.fromEntries(
        maskAssets.map((m) => [
          m.d.characterId,
          {
            blockingId: m.rec.id,
            blockingRevision: m.rec.revision,
            blockingFingerprint: m.rec.blockingFingerprint,
            objectIndex: m.d.objectIndex,
            assetId: m.assetId,
            encoding: CHARACTER_MASK_FORMAT,
            visiblePixelCount: m.d.visiblePixelCount,
          },
        ]),
      ),
    };
    // all-or-nothing: any failure (or a lost race with an identical capture) removes everything this attempt wrote
    const out = await persistPassBundle(deps, writes, () =>
      previs.recordSpatialPassBundle({
        id: bundleId,
        projectId: data.project.id,
        shotId,
        locationId,
        sceneDocumentId: scene.id,
        sceneRevision: scene.revision,
        sceneFingerprint: scene.sceneFingerprint,
        blockingFingerprint: blockingFp,
        camera,
        bundleFingerprint,
        width,
        height,
        depth: {
          assetId: depthAsset.assetId,
          encoding: DEPTH_FORMAT,
          metadata: depthMetadata(depthCheck.stats),
        },
        objectIds: { assetId: idAsset.assetId, encoding: OBJECT_ID_FORMAT, manifest: withCounts },
        characterMasks,
        createdAt: stamp,
        userId: actorOf(user),
      }),
    );
    if (out.existing) return { ok: true, bundle: out.record, existing: true };
    refresh(slug);
    return { ok: true, bundle: out.record, existing: false };
  });
}

/** The stored bundles of one Shot (used when the editor switches Shot without leaving the page). */
export async function loadSpatialPassBundles(
  form: FormData,
): Promise<SpatialPassResult<{ bundles: SpatialPassBundleRecord[] }>> {
  return guarded(async () => {
    const slug = str(form, "projectSlug");
    const shotId = str(form, "shotId");
    await requireUser();
    const data = await requireProjectFresh(slug);
    if (!data.shots.some((s) => s.id === shotId)) throw new UserFacingError("That shot no longer exists.");
    const previs = await getPrevisRepo();
    return { ok: true, bundles: await previs.listSpatialPassBundles(shotId) };
  });
}

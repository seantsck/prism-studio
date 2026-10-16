"use server";

import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { ZodError } from "zod";
import { PrevisError } from "@/data/previs-repository";
import { assetSchema, shotSchema, storyboardFrameSchema } from "@/domain/schemas";
import { buildPrevisDocument } from "@/domain/previs/document";
import { PREVIS_PRODUCTION_FRAME } from "@/domain/previs/types";
import { readImageSize } from "@/lib/image-size";
import { buildObjectPath } from "@/lib/storage-paths";
import { checkUpload } from "@/lib/upload-policy";
import { UserFacingError } from "./action-result";
import { requireUser } from "./auth";
import { getPrevisRepo } from "./previs";
import { getRepo, requireProjectFresh } from "./repo";
import { checksum, getUploadStorage, storageForAsset } from "./storage";

/**
 * Direct-call actions for the 3D set editor. They return structured results (not just ok/error) because the
 * client needs the new revision/ids. Every write is project-owner scoped by RLS in Supabase mode.
 */
export type PrevisResult<T> = ({ ok: true } & T) | { ok: false; error: string; conflict?: boolean };

const str = (f: FormData, k: string) => String(f.get(k) ?? "").trim();
const MAX_SCENE_JSON_BYTES = 4 * 1024 * 1024;
const actorOf = (user: Awaited<ReturnType<typeof requireUser>>) =>
  user.kind === "supabase" ? user.id : null;

function refresh(slug: string) {
  revalidatePath(`/projects/${slug}`, "layout");
}

async function guarded<T>(body: () => Promise<PrevisResult<T>>): Promise<PrevisResult<T>> {
  try {
    return await body();
  } catch (err) {
    if (err instanceof PrevisError)
      return { ok: false, error: err.message, conflict: err.code === "conflict" };
    if (err instanceof UserFacingError) return { ok: false, error: err.message };
    if (err instanceof ZodError) return { ok: false, error: "The 3D set data is not valid." };
    // control-flow errors (redirect / notFound / auth) must keep propagating
    const digest = (err as { digest?: unknown } | null)?.digest;
    if (typeof digest === "string") throw err;
    const ref = randomUUID().slice(0, 8);
    console.error(`[previs ${ref}]`, err instanceof Error ? err.message : "unknown error");
    return { ok: false, error: `Something went wrong saving the 3D set (ref ${ref}).` };
  }
}

/** Saves the editor's engine scene as the Location's current 3D set (compare-and-set on revision). */
export async function saveLocationScene(
  form: FormData,
): Promise<PrevisResult<{ sceneDocumentId: string; revision: number; fingerprint: string }>> {
  return guarded(async () => {
    const slug = str(form, "projectSlug");
    const locationId = str(form, "locationId");
    const expectedRaw = str(form, "expectedRevision");
    const sceneRaw = String(form.get("sceneJson") ?? "");
    if (sceneRaw.length === 0 || sceneRaw.length > MAX_SCENE_JSON_BYTES)
      throw new UserFacingError("The 3D set is empty or too large to save.");

    const user = await requireUser();
    const data = await requireProjectFresh(slug);
    if (!data.locations.some((l) => l.id === locationId))
      throw new UserFacingError("That location is not in this project.");

    let engineScene: Record<string, unknown>;
    try {
      engineScene = JSON.parse(sceneRaw) as Record<string, unknown>;
    } catch {
      throw new UserFacingError("The 3D set data is not valid JSON.");
    }

    // asset ids referenced by the scene must be this project's own assets; checksums come from the server
    const tokens = JSON.stringify(engineScene).match(/"m_([0-9a-f-]{36})"/g) ?? [];
    const assetChecksums: Record<string, string | null> = {};
    for (const t of tokens) {
      const id = t.slice(3, -1); // strip the leading quote, `m_` and the trailing quote
      const asset = data.assets.find((a) => a.id === id);
      if (!asset) throw new UserFacingError("The 3D set references an asset that is not in this project.");
      if (asset.mime !== "model/gltf-binary")
        throw new UserFacingError("Only .glb models from the asset library can be placed in a 3D set.");
      assetChecksums[id] = asset.checksum ?? null;
    }

    const document = buildPrevisDocument({ engineScene, assetChecksums });
    const repo = await getPrevisRepo();
    const saved = await repo.saveScene({
      id: randomUUID(),
      projectId: data.project.id,
      locationId,
      document,
      expectedRevision: expectedRaw === "" ? null : Number(expectedRaw),
      engineVersion: "artcraft-derived@d4e4ac6",
      userId: actorOf(user),
      now: new Date().toISOString(),
    });
    refresh(slug);
    return {
      ok: true,
      sceneDocumentId: saved.id,
      revision: saved.revision,
      fingerprint: saved.sceneFingerprint,
    };
  });
}

/** "Use Production Camera for Shot": freezes the saved set's production camera as the Shot's bookmark. */
export async function linkShotCamera(
  form: FormData,
): Promise<PrevisResult<{ bookmarkId: string; sceneRevision: number; sceneFingerprint: string }>> {
  return guarded(async () => {
    const slug = str(form, "projectSlug");
    const shotId = str(form, "shotId");
    const locationId = str(form, "locationId");
    const user = await requireUser();
    const data = await requireProjectFresh(slug);
    const shot = data.shots.find((s) => s.id === shotId);
    if (!shot) throw new UserFacingError("That shot no longer exists.");
    if (!data.locations.some((l) => l.id === locationId))
      throw new UserFacingError("That location is not in this project.");
    if (shot.spatial.locationId && shot.spatial.locationId !== locationId) {
      const current =
        data.locations.find((l) => l.id === shot.spatial.locationId)?.name ?? "another location";
      throw new UserFacingError(
        `This shot is set in ${current}. Change the shot's location first, then link its camera.`,
      );
    }
    const previs = await getPrevisRepo();
    const scene = await previs.getSceneForLocation(locationId);
    if (!scene) throw new UserFacingError("Save the 3D set before linking its camera to a shot.");

    const bookmark = await previs.setBookmark({
      id: randomUUID(),
      projectId: data.project.id,
      shotId,
      locationId,
      sceneDocumentId: scene.id,
      userId: actorOf(user),
      now: new Date().toISOString(),
    });
    if (!shot.spatial.locationId) {
      const repo = await getRepo();
      await repo.upsert(
        data.project.id,
        "shots",
        shotSchema.parse({
          ...shot,
          spatial: { ...shot.spatial, locationId },
          updatedAt: new Date().toISOString(),
        }),
      );
    }
    refresh(slug);
    return {
      ok: true,
      bookmarkId: bookmark.id,
      sceneRevision: bookmark.sceneRevision,
      sceneFingerprint: bookmark.sceneFingerprint,
    };
  });
}

/**
 * Stores a locally rendered master frame in the PRIVATE asset store with scene provenance. The render happens in
 * the browser from the editor's scene; the server re-derives revision/fingerprint from the saved scene (a client
 * value is only a claim that must match) and verifies the image really is a production-frame render.
 */
export async function captureMasterFrame(
  form: FormData,
): Promise<PrevisResult<{ masterFrameId: string; assetId: string }>> {
  return guarded(async () => {
    const slug = str(form, "projectSlug");
    const shotId = str(form, "shotId");
    const locationId = str(form, "locationId");
    const claimedRevision = Number(str(form, "sceneRevision"));
    const file = form.get("file");
    if (!(file instanceof File) || file.size === 0)
      throw new UserFacingError("No rendered frame was received.");

    const user = await requireUser();
    const data = await requireProjectFresh(slug);
    if (!data.shots.some((s) => s.id === shotId)) throw new UserFacingError("That shot no longer exists.");
    const previs = await getPrevisRepo();
    const scene = await previs.getSceneForLocation(locationId);
    if (!scene || scene.projectId !== data.project.id)
      throw new UserFacingError("Save the 3D set before capturing a master frame.");
    if (scene.revision !== claimedRevision)
      throw new PrevisError("conflict", "The set changed after this frame was rendered. Capture again.");
    const bookmark = await previs.getBookmarkForShot(shotId);
    if (!bookmark || bookmark.sceneDocumentId !== scene.id)
      throw new UserFacingError("Use the production camera for this shot before capturing.");

    const bytes = new Uint8Array(await file.arrayBuffer());
    const check = checkUpload(
      { name: "master-frame.png", size: file.size, claimedMime: "image/png" },
      bytes,
      ["image"],
    );
    if (!check.ok || check.mime !== "image/png")
      throw new UserFacingError(check.reason ?? "The frame must be a PNG.");
    const dims = readImageSize(bytes);
    if (
      !dims ||
      dims.width !== PREVIS_PRODUCTION_FRAME.width ||
      dims.height !== PREVIS_PRODUCTION_FRAME.height
    )
      throw new UserFacingError(
        `The frame must be rendered at ${PREVIS_PRODUCTION_FRAME.width}×${PREVIS_PRODUCTION_FRAME.height} (2.39:1).`,
      );

    const stamp = new Date().toISOString();
    const assetId = randomUUID();
    const objectPath = buildObjectPath(data.project.id, assetId, "master-frame.png");
    const storage = await getUploadStorage();
    await storage.put(objectPath, bytes, "image/png");
    const location = data.locations.find((l) => l.id === locationId);
    const asset = assetSchema.parse({
      id: assetId,
      projectId: data.project.id,
      createdBy: actorOf(user),
      type: "image",
      purpose: "storyboard",
      source: "3d_render",
      name: `${location?.name ?? "3D set"} — master frame r${scene.revision}`,
      originalFilename: "master-frame.png",
      storageProvider: storage.name,
      bucket: storage.bucket,
      objectPath,
      mime: "image/png",
      byteSize: bytes.length,
      checksum: checksum(bytes),
      width: dims.width,
      height: dims.height,
      durationMs: null,
      frameRate: null,
      sampleRate: null,
      channels: null,
      tags: ["master_frame", "scene_render"],
      notes: "",
      metadata: {
        previs: {
          source: "scene_render",
          projectId: data.project.id,
          locationId,
          sceneDocumentId: scene.id,
          sceneRevision: scene.revision,
          sceneFingerprint: scene.sceneFingerprint,
          cameraBookmarkId: bookmark.id,
          renderWidth: dims.width,
          renderHeight: dims.height,
          productionAspectRatio: PREVIS_PRODUCTION_FRAME.ratio,
          capturedAt: stamp,
          upstreamCommit: scene.upstreamCommit,
        },
      },
      createdAt: stamp,
      updatedAt: stamp,
    });

    const repo = await getRepo();
    try {
      await repo.upsert(data.project.id, "assets", asset);
      const frame = await previs.recordMasterFrame({
        id: randomUUID(),
        projectId: data.project.id,
        shotId,
        locationId,
        sceneDocumentId: scene.id,
        sceneRevision: scene.revision,
        sceneFingerprint: scene.sceneFingerprint,
        cameraBookmarkId: bookmark.id,
        assetId,
        renderWidth: dims.width,
        renderHeight: dims.height,
        productionAspectRatio: PREVIS_PRODUCTION_FRAME.ratio,
        capturedAt: stamp,
        userId: actorOf(user),
      });
      refresh(slug);
      return { ok: true, masterFrameId: frame.id, assetId };
    } catch (err) {
      try {
        const s = await storageForAsset(asset);
        if (s && asset.objectPath) await s.remove(asset.objectPath);
      } catch {
        /* orphaned object: harmless, never referenced */
      }
      throw err;
    }
  });
}

/**
 * "Use as Master Frame": an explicit user decision. Adds the render as a NEW storyboard frame version (never
 * approved here, so an approved storyboard is never overwritten) and records it as the shot's adopted master frame.
 */
export async function adoptMasterFrame(form: FormData): Promise<PrevisResult<{ storyboardFrameId: string }>> {
  return guarded(async () => {
    const slug = str(form, "projectSlug");
    const masterFrameId = str(form, "masterFrameId");
    await requireUser();
    const data = await requireProjectFresh(slug);
    const previs = await getPrevisRepo();
    const mf = await previs.getMasterFrame(masterFrameId);
    if (!mf || mf.projectId !== data.project.id)
      throw new UserFacingError("That master frame was not found.");
    if (mf.adoptedFrameId) return { ok: true, storyboardFrameId: mf.adoptedFrameId };

    const repo = await getRepo();
    const version =
      data.frames.filter((f) => f.shotId === mf.shotId).reduce((m, f) => Math.max(m, f.version), 0) + 1;
    const frameId = randomUUID();
    const stamp = new Date().toISOString();
    await repo.upsert(
      data.project.id,
      "frames",
      storyboardFrameSchema.parse({
        id: frameId,
        projectId: data.project.id,
        shotId: mf.shotId,
        assetId: mf.assetId,
        version,
        source: "3d_preview",
        notes: `3D set master frame (scene revision ${mf.sceneRevision})`,
        approved: false,
        approvedFingerprint: null,
        approvedSnapshot: null,
        approvedAt: null,
        createdAt: stamp,
      }),
    );
    await previs.adoptMasterFrame(mf.id, frameId, stamp);
    refresh(slug);
    return { ok: true, storyboardFrameId: frameId };
  });
}

"use server";

import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { ZodError } from "zod";
import { PrevisError } from "@/data/previs-repository";
import { assetSchema, shotSchema, storyboardFrameSchema } from "@/domain/schemas";
import { audioMixFingerprint, type StoredAudioMix } from "@/domain/previs/audio-mix";
import { performanceAudioPlanForShot } from "@/domain/previs/audio-mix-shot";
import {
  blockingFingerprint,
  parseBlockingEntry,
  type BlockingFigureData,
  renderedBlockingProvenance,
  type ShotBlockingEntry,
} from "@/domain/previs/blocking";
import { cameraPathSchema, validateCameraPath } from "@/domain/previs/camera-path";
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
const optStr = (f: FormData, k: string) => str(f, k) || null;

/**
 * Container-level check that a file carries an audio track: an MP4 'soun' handler with an AAC ('mp4a') entry, or a
 * WebM Opus track. This is a plausibility check on a file the browser made, not a decode.
 */
function containerHasAudioTrack(bytes: Uint8Array, container: "mp4" | "webm"): boolean {
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return container === "mp4"
    ? buf.includes("soun", 0, "latin1") && buf.includes("mp4a", 0, "latin1")
    : buf.includes("A_OPUS", 0, "latin1");
}
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
    const claimedBlocking = optStr(form, "blockingFingerprint");
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

    // the character blocking the picture shows must be the SAVED blocking (the server derives it, the client claims)
    const blockingRecords = await previs.listShotBlocking(shotId);
    const blockingProv = renderedBlockingProvenance(blockingRecords, { locationId });
    if ((blockingProv?.fingerprint ?? null) !== claimedBlocking)
      throw new PrevisError(
        "conflict",
        "The character blocking changed after this frame was rendered. Save the blocking and capture again.",
      );

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
          // ids + fingerprints only: which saved blocking this frame shows (no pose data, no URLs)
          ...(blockingProv ? { blocking: blockingProv } : {}),
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
        blockingFingerprint: blockingProv?.fingerprint ?? null,
        blocking: blockingProv?.figures ?? null,
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

const MAX_PATH_JSON_BYTES = 256 * 1024;
const MAX_PREVIS_BYTES = 50 * 1024 * 1024;

/**
 * Saves the Shot's camera motion (compare-and-set on revision). The set revision/fingerprint it is authored
 * against are read from the LIVE saved set on the server, never trusted from the client.
 */
export async function saveShotCameraPath(
  form: FormData,
): Promise<PrevisResult<{ pathId: string; revision: number; fingerprint: string }>> {
  return guarded(async () => {
    const slug = str(form, "projectSlug");
    const shotId = str(form, "shotId");
    const locationId = str(form, "locationId");
    const expectedRaw = str(form, "expectedRevision");
    const raw = String(form.get("pathJson") ?? "");
    if (raw.length === 0 || raw.length > MAX_PATH_JSON_BYTES)
      throw new UserFacingError("The camera path is empty or too large to save.");
    let candidate: unknown;
    try {
      candidate = JSON.parse(raw);
    } catch {
      throw new UserFacingError("The camera path data is not valid JSON.");
    }
    const parsed = cameraPathSchema.safeParse(candidate);
    if (!parsed.success) throw new UserFacingError("The camera path data is not valid.");
    const problems = validateCameraPath(parsed.data);
    if (problems.length > 0) throw new UserFacingError(problems[0]);

    const user = await requireUser();
    const data = await requireProjectFresh(slug);
    const shot = data.shots.find((x) => x.id === shotId);
    if (!shot) throw new UserFacingError("That shot no longer exists.");
    if (!data.locations.some((l) => l.id === locationId))
      throw new UserFacingError("That location is not in this project.");
    if (shot.spatial.locationId && shot.spatial.locationId !== locationId)
      throw new UserFacingError("This shot is set in another location.");
    const previs = await getPrevisRepo();
    const scene = await previs.getSceneForLocation(locationId);
    if (!scene || scene.projectId !== data.project.id)
      throw new UserFacingError("Save the 3D set before saving camera motion.");

    const saved = await previs.saveCameraPath({
      id: randomUUID(),
      projectId: data.project.id,
      shotId,
      locationId,
      sceneDocumentId: scene.id,
      sceneRevision: scene.revision,
      sceneFingerprint: scene.sceneFingerprint,
      path: parsed.data,
      expectedRevision: expectedRaw === "" ? null : Number(expectedRaw),
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
    return { ok: true, pathId: saved.id, revision: saved.revision, fingerprint: saved.pathFingerprint };
  });
}

/**
 * Stores a locally rendered, locally encoded previs video as a PRIVATE asset with camera-path + scene provenance.
 * The server re-derives everything it can: the saved path must be the revision the client rendered, must be
 * current for the live set, and the file must really be a video of the stated container.
 */
export async function recordPrevisClip(
  form: FormData,
): Promise<PrevisResult<{ clipId: string; assetId: string }>> {
  return guarded(async () => {
    const slug = str(form, "projectSlug");
    const shotId = str(form, "shotId");
    const locationId = str(form, "locationId");
    const pathRevision = Number(str(form, "pathRevision"));
    const container = str(form, "container");
    const codec = str(form, "codec");
    const width = Number(str(form, "renderWidth"));
    const height = Number(str(form, "renderHeight"));
    const claimedMix = optStr(form, "audioMixFingerprint");
    const audioCodec = optStr(form, "audioCodec");
    const claimedBlocking = optStr(form, "blockingFingerprint");
    const file = form.get("file");
    if (!(file instanceof File) || file.size === 0)
      throw new UserFacingError("No rendered previs was received.");
    if (container !== "mp4" && container !== "webm")
      throw new UserFacingError("Unsupported video container.");
    if (!/^[a-z0-9.]{2,32}$/i.test(codec)) throw new UserFacingError("Unsupported video codec.");
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 64 || height < 32 || width > 1912)
      throw new UserFacingError("The previs dimensions are not valid.");
    if (Math.abs(width / height - PREVIS_PRODUCTION_FRAME.width / PREVIS_PRODUCTION_FRAME.height) > 0.02)
      throw new UserFacingError("The previs must be rendered in the 2.39:1 production frame.");
    if (file.size > MAX_PREVIS_BYTES) throw new UserFacingError("The previs file is too large.");

    const user = await requireUser();
    const data = await requireProjectFresh(slug);
    if (!data.shots.some((x) => x.id === shotId)) throw new UserFacingError("That shot no longer exists.");
    const previs = await getPrevisRepo();
    const path = await previs.getCameraPathForShot(shotId);
    if (!path || path.projectId !== data.project.id)
      throw new UserFacingError("Save the camera path before rendering a previs.");
    if (path.revision !== pathRevision)
      throw new PrevisError(
        "conflict",
        "The camera path changed after this previs was rendered. Render again.",
      );
    const scene = await previs.getSceneForLocation(locationId);
    if (!scene || scene.projectId !== data.project.id || scene.id !== path.sceneDocumentId)
      throw new UserFacingError("Save the 3D set before recording a previs.");
    if (scene.sceneFingerprint !== path.sceneFingerprint)
      throw new UserFacingError("The set changed since this camera path was saved. Re-save the path first.");

    // the character blocking the previs shows must be the SAVED blocking (static pose for the whole clip)
    const blockingProv = renderedBlockingProvenance(await previs.listShotBlocking(shotId), { locationId });
    if ((blockingProv?.fingerprint ?? null) !== claimedBlocking)
      throw new PrevisError(
        "conflict",
        "The character blocking changed while the previs was rendering. Save the blocking and render again.",
      );

    // performance audio: the server derives the mix itself from the Shot's CURRENT selected takes and timing; the
    // client only says which mix it rendered. A mismatch means the takes changed during the render.
    let mix: StoredAudioMix | null = null;
    if (claimedMix || audioCodec) {
      if (!claimedMix || !audioCodec) throw new UserFacingError("The previs audio details are incomplete.");
      if (!/^[0-9a-f]{64}$/.test(claimedMix)) throw new UserFacingError("The previs audio mix is not valid.");
      const okPair =
        (container === "mp4" && audioCodec === "aac") || (container === "webm" && audioCodec === "opus");
      if (!okPair) throw new UserFacingError("That audio codec cannot be stored in this container.");
      const plan = performanceAudioPlanForShot(data, shotId, path.durationMs);
      if (!plan)
        throw new PrevisError(
          "conflict",
          "This Shot no longer has selected performance audio. Render again.",
        );
      const current = audioMixFingerprint(plan);
      if (current !== claimedMix)
        throw new PrevisError(
          "conflict",
          "The selected performance audio changed while the previs was rendering. Render again.",
        );
      mix = { ...plan, codec: audioCodec, mixFingerprint: current };
    }

    const bytes = new Uint8Array(await file.arrayBuffer());
    const claimedMime = container === "mp4" ? "video/mp4" : "video/webm";
    const check = checkUpload({ name: `previs.${container}`, size: file.size, claimedMime }, bytes, [
      "video",
    ]);
    if (!check.ok || check.mime !== claimedMime)
      throw new UserFacingError(check.reason ?? `The file is not a ${container} video.`);

    // a file that claims audio must really carry an audio track (container-level marker, not a decode)
    if (mix && !containerHasAudioTrack(bytes, container))
      throw new UserFacingError("The rendered file does not contain an audio track.");

    const stamp = new Date().toISOString();
    const assetId = randomUUID();
    const objectPath = buildObjectPath(data.project.id, assetId, `previs.${container}`);
    const storage = await getUploadStorage();
    await storage.put(objectPath, bytes, claimedMime);
    const shot = data.shots.find((x) => x.id === shotId)!;
    const asset = assetSchema.parse({
      id: assetId,
      projectId: data.project.id,
      createdBy: actorOf(user),
      type: "video",
      purpose: "video_reference",
      source: "local_previs",
      name: `Shot ${shot.shotCode} — local previs r${path.revision}`,
      originalFilename: `previs.${container}`,
      storageProvider: storage.name,
      bucket: storage.bucket,
      objectPath,
      mime: claimedMime,
      byteSize: bytes.length,
      checksum: checksum(bytes),
      width,
      height,
      durationMs: path.durationMs,
      frameRate: path.frameRate,
      sampleRate: mix ? mix.sampleRate : null,
      channels: mix ? mix.channels : null,
      tags: mix
        ? ["previs", "local_previs", "camera_motion", "performance_audio"]
        : ["previs", "local_previs", "camera_motion"],
      notes: "",
      metadata: {
        previs: {
          source: "local_previs",
          projectId: data.project.id,
          shotId,
          locationId,
          sceneDocumentId: scene.id,
          sceneRevision: scene.revision,
          sceneFingerprint: scene.sceneFingerprint,
          cameraPathId: path.id,
          cameraPathRevision: path.revision,
          cameraPathFingerprint: path.pathFingerprint,
          durationMs: path.durationMs,
          frameRate: path.frameRate,
          renderWidth: width,
          renderHeight: height,
          container,
          codec,
          audioAssetId: null,
          hasAudio: mix !== null,
          ...(blockingProv ? { blocking: blockingProv } : {}),
          // ids/fingerprint only; the full cue list lives on the previs clip row
          ...(mix
            ? {
                audio: {
                  codec: mix.codec,
                  sampleRate: mix.sampleRate,
                  channels: mix.channels,
                  mixFingerprint: mix.mixFingerprint,
                  cueCount: mix.cues.length,
                },
              }
            : {}),
          renderedAt: stamp,
        },
      },
      createdAt: stamp,
      updatedAt: stamp,
    });

    const repo = await getRepo();
    try {
      await repo.upsert(data.project.id, "assets", asset);
      const clip = await previs.recordPrevisClip({
        id: randomUUID(),
        projectId: data.project.id,
        shotId,
        locationId,
        cameraPathId: path.id,
        pathRevision: path.revision,
        pathFingerprint: path.pathFingerprint,
        sceneDocumentId: scene.id,
        sceneRevision: scene.revision,
        sceneFingerprint: scene.sceneFingerprint,
        assetId,
        frameRate: path.frameRate,
        durationMs: path.durationMs,
        renderWidth: width,
        renderHeight: height,
        container,
        codec,
        hasAudio: mix !== null,
        audioAssetId: null,
        audioMix: mix,
        audioMixFingerprint: mix ? mix.mixFingerprint : null,
        blockingFingerprint: blockingProv?.fingerprint ?? null,
        blocking: blockingProv?.figures ?? null,
        renderedAt: stamp,
        userId: actorOf(user),
      });
      refresh(slug);
      return { ok: true, clipId: clip.id, assetId };
    } catch (err) {
      try {
        const st = await storageForAsset(asset);
        if (st && asset.objectPath) await st.remove(asset.objectPath);
      } catch {
        /* orphaned object: harmless, never referenced */
      }
      throw err;
    }
  });
}

const MAX_BLOCKING_JSON_BYTES = 512 * 1024;

export interface SavedBlockingFigure {
  characterId: string;
  blockingId: string;
  revision: number;
  fingerprint: string;
  sceneRevision: number;
  sceneFingerprint: string;
}

/**
 * Saves the CHANGED figures of one Shot's character blocking (compare-and-set per figure) and removes the ones the
 * editor dropped. Blocking belongs to the Shot: nothing here touches the Location's set or any other Shot. The
 * set revision/fingerprint a figure is authored against is read from the LIVE saved set on the server. A figure
 * whose blocking did not change is left exactly as it was, so saving never silently re-anchors a stale figure.
 */
export async function saveShotBlocking(
  form: FormData,
): Promise<PrevisResult<{ figures: SavedBlockingFigure[] }>> {
  return guarded(async () => {
    const slug = str(form, "projectSlug");
    const shotId = str(form, "shotId");
    const locationId = str(form, "locationId");
    const raw = String(form.get("blockingJson") ?? "");
    if (raw.length === 0 || raw.length > MAX_BLOCKING_JSON_BYTES)
      throw new UserFacingError("The character blocking is empty or too large to save.");
    let candidate: { save?: unknown; remove?: unknown };
    try {
      candidate = JSON.parse(raw);
    } catch {
      throw new UserFacingError("The character blocking data is not valid JSON.");
    }
    const saves = Array.isArray(candidate.save) ? (candidate.save as unknown[]) : [];
    const removes = Array.isArray(candidate.remove) ? (candidate.remove as unknown[]) : [];
    if (saves.length + removes.length === 0) throw new UserFacingError("There is no blocking to save.");
    if (saves.length + removes.length > 32) throw new UserFacingError("Too many characters in one shot.");

    const user = await requireUser();
    const data = await requireProjectFresh(slug);
    const shot = data.shots.find((x) => x.id === shotId);
    if (!shot) throw new UserFacingError("That shot no longer exists.");
    if (!data.locations.some((l) => l.id === locationId))
      throw new UserFacingError("That location is not in this project.");
    if (shot.spatial.locationId && shot.spatial.locationId !== locationId)
      throw new UserFacingError("This shot is set in another location.");
    const previs = await getPrevisRepo();
    const scene = await previs.getSceneForLocation(locationId);
    if (!scene || scene.projectId !== data.project.id)
      throw new UserFacingError("Save the 3D set before saving character blocking.");

    const existing = new Map((await previs.listShotBlocking(shotId)).map((r) => [r.characterId, r]));
    const out: SavedBlockingFigure[] = [];
    const now = new Date().toISOString();

    for (const item of saves) {
      const it = item as { entry?: unknown; expectedRevision?: unknown };
      let entry: ShotBlockingEntry;
      try {
        entry = parseBlockingEntry(it.entry);
      } catch {
        throw new UserFacingError("A character's blocking data is not valid.");
      }
      if (!data.characters.some((c) => c.id === entry.characterId))
        throw new UserFacingError("That character is not in this project.");
      const expected = it.expectedRevision === null ? null : Number(it.expectedRevision);
      if (expected !== null && !Number.isInteger(expected)) throw new UserFacingError("Invalid revision.");
      const cur = existing.get(entry.characterId);
      // unchanged blocking is left alone: saving must never silently re-anchor a stale figure
      if (
        cur &&
        cur.blockingFingerprint === blockingFingerprint(entry, { locationId }) &&
        cur.revision === expected
      ) {
        out.push({
          characterId: cur.characterId,
          blockingId: cur.id,
          revision: cur.revision,
          fingerprint: cur.blockingFingerprint,
          sceneRevision: cur.sceneRevision,
          sceneFingerprint: cur.sceneFingerprint,
        });
        continue;
      }
      const saved = await previs.saveShotBlocking({
        id: randomUUID(),
        projectId: data.project.id,
        shotId,
        characterId: entry.characterId,
        locationId,
        sceneDocumentId: scene.id,
        sceneRevision: scene.revision,
        sceneFingerprint: scene.sceneFingerprint,
        entry,
        expectedRevision: expected,
        userId: actorOf(user),
        now,
      });
      out.push({
        characterId: saved.characterId,
        blockingId: saved.id,
        revision: saved.revision,
        fingerprint: saved.blockingFingerprint,
        sceneRevision: saved.sceneRevision,
        sceneFingerprint: saved.sceneFingerprint,
      });
    }
    for (const item of removes) {
      const it = item as { characterId?: unknown; expectedRevision?: unknown };
      await previs.removeShotBlocking({
        projectId: data.project.id,
        shotId,
        characterId: String(it.characterId ?? ""),
        expectedRevision: Number(it.expectedRevision),
      });
    }
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
    return { ok: true, figures: out };
  });
}

/**
 * The explicit "Re-anchor to current set": records the live set revision/fingerprint on this Shot's blocking
 * WITHOUT changing any root transform or pose. Only ever called by a deliberate user action.
 */
export async function reanchorShotBlocking(
  form: FormData,
): Promise<PrevisResult<{ figures: SavedBlockingFigure[] }>> {
  return guarded(async () => {
    const slug = str(form, "projectSlug");
    const shotId = str(form, "shotId");
    const locationId = str(form, "locationId");
    const user = await requireUser();
    const data = await requireProjectFresh(slug);
    if (!data.shots.some((x) => x.id === shotId)) throw new UserFacingError("That shot no longer exists.");
    const previs = await getPrevisRepo();
    const scene = await previs.getSceneForLocation(locationId);
    if (!scene || scene.projectId !== data.project.id)
      throw new UserFacingError("Save the 3D set before re-anchoring character blocking.");
    const recs = await previs.reanchorShotBlocking({
      projectId: data.project.id,
      shotId,
      sceneDocumentId: scene.id,
      userId: actorOf(user),
      now: new Date().toISOString(),
    });
    refresh(slug);
    return {
      ok: true,
      figures: recs.map((r) => ({
        characterId: r.characterId,
        blockingId: r.id,
        revision: r.revision,
        fingerprint: r.blockingFingerprint,
        sceneRevision: r.sceneRevision,
        sceneFingerprint: r.sceneFingerprint,
      })),
    };
  });
}

/** The stored blocking of one Shot (used when the editor switches shot without leaving the page). */
export async function loadShotBlocking(
  form: FormData,
): Promise<PrevisResult<{ figures: BlockingFigureData[] }>> {
  return guarded(async () => {
    const slug = str(form, "projectSlug");
    const shotId = str(form, "shotId");
    await requireUser();
    const data = await requireProjectFresh(slug);
    if (!data.shots.some((x) => x.id === shotId)) throw new UserFacingError("That shot no longer exists.");
    const previs = await getPrevisRepo();
    const recs = await previs.listShotBlocking(shotId);
    return {
      ok: true,
      figures: recs.map((r) => ({
        characterId: r.characterId,
        name: data.characters.find((c) => c.id === r.characterId)?.name ?? "Character",
        blockingId: r.id,
        revision: r.revision,
        fingerprint: r.blockingFingerprint,
        sceneRevision: r.sceneRevision,
        sceneFingerprint: r.sceneFingerprint,
        entry: r.entry,
      })),
    };
  });
}

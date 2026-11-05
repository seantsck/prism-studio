import { randomUUID } from "node:crypto";
import type { MemoryRepository } from "@/data/memory-repository";
import { persistenceMode } from "@/lib/supabase/config";
import { getRepo } from "@/server/repo";

/**
 * Development/test hook (Phase 4C). Memory mode only, and in a production build only when
 * PRISM_STUDIO_DEV_PREVIS_FIXTURES=1 (set by the E2E servers). Never available with a real database.
 *   { action: "historical", masterFrameId }  copies the Master Frame as a PRE-4C record: the same render facts with
 *                                            NO camera and NO base-environment provenance (what every frame before 0049 looks like)
 *   { action: "delete", masterFrameId }      removes the Master Frame row (as a database DELETE would; its Asset stays)
 *   { action: "skybox", locationId, skybox } saves a new revision of the Location's set that changes ONLY its skybox
 *                                            (the base environment, outside sceneFingerprint): what a set save from a
 *                                            future skybox control would store. The editor has no skybox control yet.
 */
export async function POST(req: Request) {
  const allowed =
    persistenceMode() === "memory" &&
    (process.env.NODE_ENV !== "production" || process.env.PRISM_STUDIO_DEV_PREVIS_FIXTURES === "1");
  if (!allowed) return new Response("Not found", { status: 404 });
  const body = (await req.json().catch(() => null)) as {
    action?: unknown;
    masterFrameId?: unknown;
    locationId?: unknown;
    skybox?: unknown;
  } | null;
  const id = typeof body?.masterFrameId === "string" ? body.masterFrameId : "";
  const previs = ((await getRepo()) as MemoryRepository).previs;
  if (body?.action === "skybox") {
    if (typeof body.locationId !== "string" || typeof body.skybox !== "string")
      return new Response("Bad request", { status: 400 });
    const scene = await previs.getSceneForLocation(body.locationId);
    if (!scene) return new Response("Not found", { status: 404 });
    const document = structuredClone(scene.document);
    (document.scene as Record<string, unknown>).skybox = body.skybox;
    const saved = await previs.saveScene({
      id: scene.id,
      projectId: scene.projectId,
      locationId: scene.locationId,
      document,
      expectedRevision: scene.revision,
      engineVersion: scene.engineVersion,
      userId: null,
      now: new Date().toISOString(),
    });
    return Response.json({
      revision: saved.revision,
      sceneFingerprintBefore: scene.sceneFingerprint,
      sceneFingerprint: saved.sceneFingerprint,
    });
  }
  const src = await previs.getMasterFrame(id);
  if (!src) return new Response("Not found", { status: 404 });
  if (body?.action === "delete") {
    previs.deleteMasterFrame(id);
    return Response.json({ deleted: id });
  }
  if (body?.action !== "historical") return new Response("Bad request", { status: 400 });
  const copy = await previs.recordMasterFrame({
    id: randomUUID(),
    projectId: src.projectId,
    shotId: src.shotId,
    locationId: src.locationId,
    sceneDocumentId: src.sceneDocumentId,
    sceneRevision: src.sceneRevision,
    sceneFingerprint: src.sceneFingerprint,
    cameraBookmarkId: src.cameraBookmarkId,
    assetId: src.assetId,
    renderWidth: src.renderWidth,
    renderHeight: src.renderHeight,
    productionAspectRatio: src.productionAspectRatio,
    capturedAt: new Date(Date.parse(src.capturedAt) - 1000).toISOString(),
    blockingFingerprint: src.blockingFingerprint,
    blocking: src.blocking,
    lightingFingerprint: src.lightingFingerprint,
    lighting: src.lighting,
    userId: src.createdBy,
  });
  return Response.json({ id: copy.id });
}

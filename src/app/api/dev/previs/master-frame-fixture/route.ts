import { randomUUID } from "node:crypto";
import type { MemoryRepository } from "@/data/memory-repository";
import { persistenceMode } from "@/lib/supabase/config";
import { getRepo } from "@/server/repo";

/**
 * Development/test hook (Phase 4C). Memory mode only, and in a production build only when
 * PRISM_STUDIO_DEV_PREVIS_FIXTURES=1 (set by the E2E servers). Never available with a real database.
 *   { action: "historical", masterFrameId }  copies the Master Frame as a PRE-4C record: the same render facts with
 *                                            NO camera provenance (what every frame before migration 0049 looks like)
 *   { action: "delete", masterFrameId }      removes the Master Frame row (as a database DELETE would; its Asset stays)
 */
export async function POST(req: Request) {
  const allowed =
    persistenceMode() === "memory" &&
    (process.env.NODE_ENV !== "production" || process.env.PRISM_STUDIO_DEV_PREVIS_FIXTURES === "1");
  if (!allowed) return new Response("Not found", { status: 404 });
  const body = (await req.json().catch(() => null)) as { action?: unknown; masterFrameId?: unknown } | null;
  const id = typeof body?.masterFrameId === "string" ? body.masterFrameId : "";
  const previs = ((await getRepo()) as MemoryRepository).previs;
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

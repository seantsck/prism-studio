import { randomUUID } from "node:crypto";
import type { MemoryRepository } from "@/data/memory-repository";
import { persistenceMode } from "@/lib/supabase/config";
import { getRepo } from "@/server/repo";

/**
 * Development/test hook (Phase 4C): copies an existing Master Frame as a PRE-4C record, i.e. the same render facts
 * with NO camera provenance (what every frame captured before migration 0049 looks like), so memory-mode E2E can
 * exercise UNKNOWN CAMERA PROVENANCE. Memory mode only, and in a production build only when
 * PRISM_STUDIO_DEV_PREVIS_FIXTURES=1 (set by the E2E servers). Never available with a real database.
 */
export async function POST(req: Request) {
  const allowed =
    persistenceMode() === "memory" &&
    (process.env.NODE_ENV !== "production" || process.env.PRISM_STUDIO_DEV_PREVIS_FIXTURES === "1");
  if (!allowed) return new Response("Not found", { status: 404 });
  const body = (await req.json().catch(() => null)) as { masterFrameId?: unknown } | null;
  const id = typeof body?.masterFrameId === "string" ? body.masterFrameId : "";
  const previs = ((await getRepo()) as MemoryRepository).previs;
  const src = await previs.getMasterFrame(id);
  if (!src) return new Response("Not found", { status: 404 });
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

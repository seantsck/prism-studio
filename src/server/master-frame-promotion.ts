import type { MasterFrameRecord, PrevisRepository } from "@/data/previs-repository";
import { renderedBlockingProvenance } from "@/domain/previs/blocking";
import { baseEnvironmentOf } from "@/domain/previs/lighting";
import { bookmarkCameraFingerprint } from "@/domain/previs/spatial-passes";
import {
  masterFramePromotionState,
  type CurrentSpatialState,
  type MasterFramePromotionState,
} from "@/domain/previs/spatial-status";

/**
 * The Shot's CURRENT spatial setup, reloaded from the server's own records (never from the browser), in exactly the
 * terms a Master Frame recorded at capture:
 *   scene     the Location's saved set fingerprint
 *   camera    the Shot's bookmark camera (`bookmarkCameraFingerprint`) when it is on that set, else null
 *   blocking  the rendered blocking layer (the same derivation capture uses)
 *   lighting  the Shot's rig on that set (a rig authored for another set does not light this one) + base environment
 */
export async function currentSpatialStateFor(
  previs: PrevisRepository,
  mf: Pick<MasterFrameRecord, "shotId" | "locationId">,
): Promise<CurrentSpatialState> {
  const scene = await previs.getSceneForLocation(mf.locationId);
  const bookmark = await previs.getBookmarkForShot(mf.shotId);
  const blocking = renderedBlockingProvenance(await previs.listShotBlocking(mf.shotId), {
    locationId: mf.locationId,
  });
  const rig = await previs.getLightingRigForShot(mf.shotId);
  let cameraFingerprint: string | null = null;
  if (bookmark && scene && bookmark.sceneDocumentId === scene.id) {
    try {
      cameraFingerprint = bookmarkCameraFingerprint(bookmark.value);
    } catch {
      cameraFingerprint = null; // an unrenderable bookmark is no current camera
    }
  }
  return {
    sceneFingerprint: scene?.sceneFingerprint ?? null,
    cameraFingerprint,
    blockingFingerprint: blocking?.fingerprint ?? null,
    lighting: {
      lightingFingerprint: rig && scene && rig.sceneDocumentId === scene.id ? rig.lightingFingerprint : null,
      baseEnvironment: scene ? baseEnvironmentOf(scene.document) : null,
    },
  };
}

/** Recomputes the whole promotion state of one Master Frame from current server records. */
export async function promotionStateFor(
  previs: PrevisRepository,
  mf: MasterFrameRecord,
): Promise<MasterFramePromotionState> {
  return masterFramePromotionState({ masterFrame: mf, current: await currentSpatialStateFor(previs, mf) });
}

import type { MasterFrameRecord, PrevisRepository } from "@/data/previs-repository";
import { renderedBlockingProvenance } from "@/domain/previs/blocking";
import { baseEnvironmentOf } from "@/domain/previs/lighting";
import { bookmarkCameraFingerprint } from "@/domain/previs/spatial-passes";
import {
  masterFramePromotionState,
  type CurrentSpatialState,
  type MasterFramePromotionState,
} from "@/domain/previs/spatial-status";

/** The Shot as it is NOW: its id and its CURRENT Location assignment (null = none). */
export interface CurrentShotSpatial {
  shotId: string;
  /** `shot.spatial.locationId` now; never a Master Frame's own (historical) Location */
  locationId: string | null;
}

const NO_SPATIAL_STATE: CurrentSpatialState = {
  sceneFingerprint: null,
  cameraFingerprint: null,
  blockingFingerprint: null,
  lighting: { lightingFingerprint: null, baseEnvironment: null },
};

/**
 * The Shot's CURRENT spatial setup, reloaded from the server's own records (never from the browser), resolved against
 * the Shot's CURRENTLY assigned Location, in exactly the terms a Master Frame recorded at capture:
 *   scene     that Location's saved set fingerprint
 *   camera    the Shot's bookmark camera (`bookmarkCameraFingerprint`) when it is on that set, else null
 *   blocking  the rendered blocking layer anchored at that Location (the same derivation capture uses)
 *   lighting  the Shot's rig on that set (a rig authored for another set does not light this one) + base environment
 * A Master Frame's own Location is historical source provenance only: after A -> B reassignment, a frame captured in A
 * is compared with B (so it can never look fresh), and with no Location at all every current value is absent.
 */
export async function currentSpatialStateFor(
  previs: PrevisRepository,
  shot: CurrentShotSpatial,
): Promise<CurrentSpatialState> {
  if (!shot.locationId) return structuredClone(NO_SPATIAL_STATE);
  const locationId = shot.locationId;
  const scene = await previs.getSceneForLocation(locationId);
  if (!scene) return structuredClone(NO_SPATIAL_STATE);
  const bookmark = await previs.getBookmarkForShot(shot.shotId);
  const blocking = renderedBlockingProvenance(await previs.listShotBlocking(shot.shotId), { locationId });
  const rig = await previs.getLightingRigForShot(shot.shotId);
  let cameraFingerprint: string | null = null;
  if (bookmark && bookmark.locationId === locationId && bookmark.sceneDocumentId === scene.id) {
    try {
      cameraFingerprint = bookmarkCameraFingerprint(bookmark.value);
    } catch {
      cameraFingerprint = null; // an unrenderable bookmark is no current camera
    }
  }
  return {
    sceneFingerprint: scene.sceneFingerprint,
    cameraFingerprint,
    blockingFingerprint: blocking?.fingerprint ?? null,
    lighting: {
      lightingFingerprint: rig && rig.sceneDocumentId === scene.id ? rig.lightingFingerprint : null,
      baseEnvironment: baseEnvironmentOf(scene.document),
    },
  };
}

/**
 * Recomputes the whole promotion state of one Master Frame from current server records, against the Shot's CURRENT
 * Location (passed by the caller from its authoritative Shot record, never inferred from `mf.locationId`).
 */
export async function promotionStateFor(
  previs: PrevisRepository,
  mf: MasterFrameRecord,
  shot: CurrentShotSpatial,
): Promise<MasterFramePromotionState> {
  if (shot.shotId !== mf.shotId) throw new Error("promotion state: the Master Frame belongs to another Shot");
  return masterFramePromotionState({ masterFrame: mf, current: await currentSpatialStateFor(previs, shot) });
}

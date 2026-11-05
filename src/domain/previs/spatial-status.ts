import { fingerprint } from "../hash";
import {
  baseEnvironmentFingerprint,
  type CurrentLightingState,
  type RenderedLightingState,
} from "./lighting";

/**
 * MASTER FRAME SPATIAL STATUS (Phase 4C, decisions P2/P4). A Master Frame is compared with the Shot's CURRENT spatial
 * setup on four axes, using only provenance the frame really holds:
 *
 *   stale    the frame recorded this axis, and the current setup differs
 *   unknown  the frame never recorded this axis, so nobody can say (the camera of a pre-4C frame; the base
 *            environment of a frame that froze neither its fingerprint nor a render-lighting snapshot)
 *
 * The LIGHTING axis covers both the Shot Lighting Rig (`lightingFingerprint`) and the engine base environment
 * (`baseEnvironmentFingerprint`: skybox + engine commit, pixel-affecting and outside `sceneFingerprint`).
 *
 * UNKNOWN is never fresh and never silently turned into stale. Both are WORKFLOW state: computed per request, shown to
 * the person and bound into a promotion digest, never persisted on a Production Frame. Pure domain code.
 */
export const SPATIAL_AXES = ["scene", "camera", "blocking", "lighting"] as const;
export type SpatialAxis = (typeof SPATIAL_AXES)[number];

export interface MasterFrameSpatialSource extends RenderedLightingState {
  sceneFingerprint: string;
  /** the Location set (scene document) the frame was captured on; absent = not known to the caller */
  sceneDocumentId?: string;
  /** null = camera provenance was not frozen at capture (pre-4C, or captured while the database was at 0048) */
  cameraFingerprint: string | null;
  blockingFingerprint: string | null;
  /**
   * `baseEnvironmentFingerprint` frozen at capture (0049). null = not frozen: the frozen render-lighting snapshot's
   * base environment is used for status when present, otherwise the lighting axis is UNKNOWN (never fresh).
   */
  baseEnvironmentFingerprint: string | null;
}

export interface CurrentSpatialState {
  /** the Location's saved set now (null = none) */
  sceneFingerprint: string | null;
  /** that set's scene document (null = none); absent = not known to the caller */
  sceneDocumentId?: string | null;
  /** the Shot's production camera bookmark now, as `bookmarkCameraFingerprint` (null = none on this set) */
  cameraFingerprint: string | null;
  /** the rendered blocking layer now (null = no visible proxies) */
  blockingFingerprint: string | null;
  lighting: CurrentLightingState;
}

export interface SpatialStatus {
  stale: SpatialAxis[];
  unknown: SpatialAxis[];
}

const canonical = (axes: readonly SpatialAxis[]): SpatialAxis[] =>
  SPATIAL_AXES.filter((a) => axes.includes(a));

export function masterFrameSpatialStatus(
  frame: MasterFrameSpatialSource,
  current: CurrentSpatialState,
): SpatialStatus {
  const stale: SpatialAxis[] = [];
  const unknown: SpatialAxis[] = [];
  // scene: a different or missing saved set is stale (unchanged 4B semantics). 4C-I2: a frame captured on ANOTHER
  // Location's set is stale too even when that set's content fingerprint happens to equal the current one (e.g. the
  // same test set loaded into both): a frame from an old Location is never scene-fresh
  const otherSet =
    frame.sceneDocumentId !== undefined &&
    current.sceneDocumentId !== undefined &&
    frame.sceneDocumentId !== current.sceneDocumentId;
  if (frame.sceneFingerprint !== current.sceneFingerprint || otherSet) stale.push("scene");
  // camera: known → same bookmark camera is fresh, a different or missing one is stale; not recorded → unknown
  if (frame.cameraFingerprint === null) unknown.push("camera");
  else if (frame.cameraFingerprint !== current.cameraFingerprint) stale.push("camera");
  // blocking: unchanged 4B semantics (no proxies then and now is fresh)
  if ((frame.blockingFingerprint ?? null) !== (current.blockingFingerprint ?? null)) stale.push("blocking");
  // lighting: the rig (added / removed / changed is stale), then the base environment (changed is stale; never
  // recorded is UNKNOWN, so "no rig then and now" is no longer enough to call a frame fresh)
  const rigChanged = (frame.lightingFingerprint ?? null) !== (current.lighting.lightingFingerprint ?? null);
  const thenEnv = frozenBaseEnvironmentFingerprint(frame);
  if (rigChanged) stale.push("lighting");
  else if (thenEnv === null) unknown.push("lighting");
  else if (thenEnv !== currentBaseEnvironmentFingerprint(current)) stale.push("lighting");
  return { stale: canonical(stale), unknown: canonical(unknown) };
}

/**
 * The base environment a frame rendered with: its frozen fingerprint, else (runtime only, never written back) the
 * fingerprint of the base environment frozen inside its immutable render-lighting snapshot, else null (unknown).
 */
export function frozenBaseEnvironmentFingerprint(frame: MasterFrameSpatialSource): string | null {
  if (frame.baseEnvironmentFingerprint) return frame.baseEnvironmentFingerprint;
  const env = frame.lighting?.baseEnvironment;
  if (!env) return null;
  try {
    return baseEnvironmentFingerprint(env);
  } catch {
    return null; // a malformed snapshot is not trustworthy provenance
  }
}

export function currentBaseEnvironmentFingerprint(current: CurrentSpatialState): string | null {
  return current.lighting.baseEnvironment
    ? baseEnvironmentFingerprint(current.lighting.baseEnvironment)
    : null;
}

export const SPATIAL_STALE_LABEL: Record<SpatialAxis, string> = {
  scene: "STALE SCENE — the set changed after this frame.",
  camera: "STALE CAMERA — the Shot's production camera changed after this frame.",
  blocking: "STALE BLOCKING — the character blocking changed after this frame.",
  lighting: "STALE LIGHTING — the Shot's lighting or base environment (skybox) changed after this frame.",
};

export const SPATIAL_UNKNOWN_LABEL: Record<SpatialAxis, string> = {
  scene: "UNKNOWN SCENE PROVENANCE — this frame did not record its set.",
  camera: "UNKNOWN CAMERA PROVENANCE — this frame did not record which camera rendered it.",
  blocking: "UNKNOWN BLOCKING PROVENANCE — this frame did not record its blocking.",
  lighting:
    "UNKNOWN LIGHTING PROVENANCE — this frame did not record its base environment (skybox), so its lighting cannot be confirmed.",
};

export function spatialStatusMessages(status: SpatialStatus): string[] {
  return [
    ...status.stale.map((a) => SPATIAL_STALE_LABEL[a]),
    ...status.unknown.map((a) => SPATIAL_UNKNOWN_LABEL[a]),
  ];
}

// ───────────────────────── promotion state (the confirmation contract) ─────────────────────────

export const PROMOTION_STATE_SCHEMA = "prism.master-frame-promotion-state.v1" as const;

export interface MasterFramePromotionState extends SpatialStatus {
  masterFrameId: string;
  /** the current values the decision was made against; an absent value is an explicit null */
  current: {
    sceneFingerprint: string | null;
    cameraFingerprint: string | null;
    blockingFingerprint: string | null;
    lightingFingerprint: string | null;
    baseEnvironmentFingerprint: string | null;
  };
  /**
   * Deterministic identity of exactly what a person is asked to confirm: the Master Frame, every current value
   * (explicit nulls) and the canonical stale / unknown axes. No time, no user, no browser state.
   */
  digest: string;
  requiresConfirmation: boolean;
  messages: string[];
}

export function masterFramePromotionState(args: {
  masterFrame: MasterFrameSpatialSource & { id: string };
  current: CurrentSpatialState;
}): MasterFramePromotionState {
  const status = masterFrameSpatialStatus(args.masterFrame, args.current);
  const current = {
    sceneFingerprint: args.current.sceneFingerprint ?? null,
    cameraFingerprint: args.current.cameraFingerprint ?? null,
    blockingFingerprint: args.current.blockingFingerprint ?? null,
    lightingFingerprint: args.current.lighting.lightingFingerprint ?? null,
    baseEnvironmentFingerprint: currentBaseEnvironmentFingerprint(args.current),
  };
  const digest = fingerprint({
    schema: PROMOTION_STATE_SCHEMA,
    masterFrameId: args.masterFrame.id,
    current,
    stale: status.stale,
    unknown: status.unknown,
  });
  return {
    masterFrameId: args.masterFrame.id,
    current,
    stale: status.stale,
    unknown: status.unknown,
    digest,
    requiresConfirmation: status.stale.length > 0 || status.unknown.length > 0,
    messages: spatialStatusMessages(status),
  };
}

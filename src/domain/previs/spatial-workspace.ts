import type { ProductionFrame } from "@/domain/production-frame";
import type { ProjectData } from "@/domain/schemas";
import { SPATIAL_AXES, type SpatialAxis } from "./spatial-status";

/**
 * Phase 4C-I2: the Shot-centric Spatial Workspace, pure parts. Routes, the Shot-switch decision, the Set dirty rule,
 * shared-Set wording, the four-axis Master Frame badges and the Production Frame source lineage presentation. Nothing
 * here decides authority: promotion state is computed on the server, and these only present it.
 */

/** The canonical Shot route of the spatial workspace (the route owns the Shot identity). */
export function shotSpatialHref(slug: string, episodeSlug: string, shotId: string): string {
  return `/projects/${slug}/episodes/${episodeSlug}/shots/${shotId}/spatial`;
}

/** Shot Prep's Location / set section of the same Shot. */
export function shotPrepSetHref(slug: string, episodeSlug: string, shotId: string): string {
  return `/projects/${slug}/episodes/${episodeSlug}/shots/${shotId}?section=set`;
}

/** The Location 3D page, optionally opened for one Shot (a Shot switch there is a NAVIGATION to this URL). */
export function locationSetHref(slug: string, locationId: string, shotId: string | null): string {
  const base = `/projects/${slug}/locations/${locationId}/3d`;
  return shotId ? `${base}?shot=${encodeURIComponent(shotId)}` : base;
}

/**
 * What the Location page's Shot selector does when the user picks `to` while `from` is open:
 *   none      the same Shot: nothing happens
 *   navigate  load `to` from the server (the editor remounts keyed to it)
 *   confirm   unsaved Location-owned Set changes would be discarded: ask first (never autosave)
 */
export function shotSwitchDecision(input: {
  from: string | null;
  to: string | null;
  setDirty: boolean;
}): "none" | "navigate" | "confirm" {
  if ((input.from ?? null) === (input.to ?? null)) return "none";
  return input.setDirty ? "confirm" : "navigate";
}

/**
 * The in-product Shot switch, decided from the Set AS IT IS AT THE SWITCH: `readSetDirty` is called exactly once, at
 * the switch itself (the editor serializes the adapter there), never a presentation flag that may lag an edit made just
 * before. Choosing the same Shot is "none" without reading.
 */
export function shotSwitchDecisionNow(input: {
  from: string | null;
  to: string | null;
  readSetDirty: () => boolean;
}): "none" | "navigate" | "confirm" {
  if ((input.from ?? null) === (input.to ?? null)) return "none";
  return shotSwitchDecision({ from: input.from, to: input.to, setDirty: input.readSetDirty() });
}

export const SHOT_SWITCH_DIRTY_MESSAGE =
  "You have unsaved 3D Set changes. Switching Shots will discard them." as const;

/**
 * Whether the editor's live Set differs from Location-owned truth (Phase 4C-I2). Two independent identities:
 *   scene             `sceneFingerprint` (objects + production camera + frame) against the CLEAN baseline: the saved
 *                     fingerprint, or, after the Shot workspace restored the Shot's camera on open, the fingerprint
 *                     of the saved set with that camera (a restore is never a Set edit)
 *   base environment  `baseEnvironmentFingerprint` (skybox + engine), which `sceneFingerprint` deliberately does not
 *                     cover, against the SAVED one, so a skybox-only change is a Set change too
 * Selection, navigation, the Shot bookmark, blocking, Shot lighting and camera motion never reach either identity.
 */
export function workingSetChanges(input: {
  liveFingerprint: string | null;
  cleanFingerprint: string | null;
  liveBaseEnvironmentFingerprint: string | null;
  savedBaseEnvironmentFingerprint: string | null;
}): { dirty: boolean; sceneChanged: boolean; baseEnvironmentChanged: boolean } {
  const sceneChanged = input.liveFingerprint !== null && input.liveFingerprint !== input.cleanFingerprint;
  const baseEnvironmentChanged =
    input.liveBaseEnvironmentFingerprint !== null &&
    input.savedBaseEnvironmentFingerprint !== null &&
    input.liveBaseEnvironmentFingerprint !== input.savedBaseEnvironmentFingerprint;
  return { dirty: sceneChanged || baseEnvironmentChanged, sceneChanged, baseEnvironmentChanged };
}

/** Another Shot that uses the same Location 3D Set. */
export interface SharedSetShot {
  id: string;
  label: string;
}

/**
 * The OTHER Shots currently assigned to a Location (never the active Shot), in story order. A Location's set is
 * shared truth for every Shot assigned to it: saving it can make their Master Frames STALE SCENE.
 */
export function sharedSetShots(
  data: Pick<ProjectData, "shots" | "episodes">,
  locationId: string,
  activeShot: { id: string; episodeId: string } | null,
): SharedSetShot[] {
  const episode = new Map(data.episodes.map((e) => [e.id, e]));
  return data.shots
    .filter((s) => s.spatial.locationId === locationId && s.id !== activeShot?.id)
    .sort((a, b) => {
      const ea = episode.get(a.episodeId)?.order ?? 0;
      const eb = episode.get(b.episodeId)?.order ?? 0;
      return ea !== eb ? ea - eb : a.order - b.order;
    })
    .map((s) => ({
      id: s.id,
      label:
        activeShot && s.episodeId === activeShot.episodeId
          ? s.shotCode
          : `Ep ${episode.get(s.episodeId)?.number ?? "?"} ${s.shotCode}`,
    }));
}

/** Quiet context in the Shot workspace (not a warning): who else uses this Set. */
export function sharedSetMessage(shots: ReadonlyArray<SharedSetShot>): string | null {
  if (shots.length === 0) return null;
  const n = shots.length;
  return `This 3D Set is shared by ${n} other Shot${n === 1 ? "" : "s"}: ${shots.map((s) => s.label).join(", ")}.`;
}

/** Shown near "Save 3D Set" only while a shared Set has unsaved LOCATION-owned changes. */
export const SHARED_SET_SAVE_WARNING =
  "Saving changes this Set for every Shot using this Location. Their Master Frames may become STALE SCENE." as const;

export const SPATIAL_AXIS_LABEL: Record<SpatialAxis, string> = {
  scene: "Scene",
  camera: "Camera",
  blocking: "Blocking",
  lighting: "Lighting",
};

export type AxisState = "fresh" | "stale" | "unknown";

/** The four-axis presentation of a (server- or editor-computed) stale / unknown status. */
export function spatialAxisStates(status: {
  stale: ReadonlyArray<string>;
  unknown: ReadonlyArray<string>;
}): Array<{ axis: SpatialAxis; label: string; state: AxisState }> {
  return SPATIAL_AXES.map((axis) => ({
    axis,
    label: SPATIAL_AXIS_LABEL[axis],
    state: status.stale.includes(axis) ? "stale" : status.unknown.includes(axis) ? "unknown" : "fresh",
  }));
}

export const MISSING_SOURCE_MASTER_FRAME =
  "Source Master Frame no longer exists; frozen source provenance retained." as const;

const short = (fp: string | null) => (fp ? fp.slice(0, 12) : null);

/**
 * How a Production Frame made from a 3D Master Frame presents its source (frozen at promotion, NEVER the current
 * spatial setup). `null` for any other source. A deleted source Master Frame is a normal state, not corruption.
 */
export function productionFrameSourceLineage(
  frame: Pick<
    ProductionFrame,
    | "source"
    | "sourceMasterFrameId"
    | "sourceSceneFingerprint"
    | "sourceCameraFingerprint"
    | "sourceBlockingFingerprint"
    | "sourceLightingFingerprint"
    | "sourceBaseEnvironmentFingerprint"
  >,
  masterFrames: ReadonlyArray<{ id: string; capturedAt: string }>,
): {
  masterFrameId: string | null;
  source: { id: string; capturedAt: string } | null;
  missingMessage: string | null;
  /** short forms of the frozen fingerprints; `frozen` false = promoted before 4C recorded them */
  frozen: boolean;
  fingerprints: Array<{ label: string; value: string | null }>;
} | null {
  if (frame.source !== "previs_master") return null;
  const id = frame.sourceMasterFrameId ?? null;
  const source = id ? (masterFrames.find((m) => m.id === id) ?? null) : null;
  return {
    masterFrameId: id,
    source: source ? { id: source.id, capturedAt: source.capturedAt } : null,
    missingMessage: id && !source ? MISSING_SOURCE_MASTER_FRAME : null,
    frozen: frame.sourceSceneFingerprint !== null,
    fingerprints: [
      { label: "Scene", value: short(frame.sourceSceneFingerprint) },
      { label: "Camera", value: short(frame.sourceCameraFingerprint) },
      { label: "Blocking", value: short(frame.sourceBlockingFingerprint) },
      { label: "Lighting", value: short(frame.sourceLightingFingerprint) },
      { label: "Base environment", value: short(frame.sourceBaseEnvironmentFingerprint) },
    ],
  };
}

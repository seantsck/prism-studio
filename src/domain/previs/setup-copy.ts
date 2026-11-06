import { fingerprint } from "../hash";
import { lightingFingerprint, type ShotLightingRig } from "./lighting";
import type { ShotBlockingEntry } from "./blocking";
import { bookmarkCameraFingerprint } from "./spatial-passes";
import type { CameraBookmarkValue } from "./types";

/**
 * Phase 4D: reusable setups as EXPLICIT COPIES, never live links.
 *
 * "Copy setup from…" copies VALUES from one Shot's current camera, lighting and/or blocking into another Shot's own
 * normal rows (`shot_camera_bookmarks`, `shot_light_rigs`, `shot_character_blocking`). Nothing records the source as a
 * dependency: after the copy the destination is read, rendered, promoted and packaged from its own rows only, so
 * editing or deleting the source changes nothing on the destination (and the reverse).
 *
 * This module is pure. It turns the rows of both Shots into a reviewable plan; the repositories recompute the same
 * plan from the rows they lock inside ONE transaction and refuse when its token differs from the one the person
 * reviewed (a stale preview). Every write therefore matches exactly what was shown, or nothing is written.
 *
 * Scope: the same Project and the same Location's current 3D set. World coordinates mean nothing in another set, so a
 * cross-Location copy is refused rather than translated.
 */
export const SETUP_COPY_PLAN_SCHEMA = "prism.setup-copy-plan.v1" as const;

export const SETUP_COMPONENTS = ["camera", "lighting", "blocking"] as const;
export type SetupComponent = (typeof SETUP_COMPONENTS)[number];

export const SETUP_COMPONENT_LABEL: Record<SetupComponent, string> = {
  camera: "Camera",
  lighting: "Lighting",
  blocking: "Blocking",
};

/** The scene state a row was authored against. Copied with the value, so a stale source stays visibly stale. */
interface Anchor {
  locationId: string;
  sceneDocumentId: string;
  sceneRevision: number;
  sceneFingerprint: string;
}
export interface SetupCameraRow extends Anchor {
  cameraLabel: string;
  value: CameraBookmarkValue;
}
export interface SetupLightingRow extends Anchor {
  revision: number;
  rig: ShotLightingRig;
  lightingFingerprint: string;
}
export interface SetupBlockingRow extends Anchor {
  characterId: string;
  revision: number;
  entry: ShotBlockingEntry;
  blockingFingerprint: string;
}
/** One Shot's spatial setup rows as stored (any set; the plan keeps only those on the current set). */
export interface SetupRows {
  camera: SetupCameraRow | null;
  lighting: SetupLightingRow | null;
  blocking: readonly SetupBlockingRow[];
}
export interface CurrentSetupSet {
  locationId: string;
  sceneDocumentId: string;
}

export interface PlannedCamera {
  label: string;
  fingerprint: string;
  sceneRevision: number;
  /** the destination's current camera, which the copy replaces (null = it has none) */
  replaces: { fingerprint: string; label: string; sceneRevision: number; onCurrentSet: boolean } | null;
  unchanged: boolean;
}
export interface PlannedLighting {
  fingerprint: string;
  baseMode: ShotLightingRig["base"]["mode"];
  lightCount: number;
  sceneRevision: number;
  replaces: { revision: number; fingerprint: string; onCurrentSet: boolean } | null;
  unchanged: boolean;
}
export interface PlannedFigure {
  characterId: string;
  fingerprint: string;
  sceneRevision: number;
  replaces: { revision: number; fingerprint: string; onCurrentSet: boolean } | null;
  unchanged: boolean;
}
export interface PlannedBlocking {
  figures: PlannedFigure[];
  /** destination figures on the current set for a character the source does not block: removed by the copy */
  removes: Array<{ characterId: string; revision: number; fingerprint: string }>;
  unchanged: boolean;
}

export interface SetupCopyPlan {
  schema: typeof SETUP_COPY_PLAN_SCHEMA;
  sourceShotId: string;
  destinationShotId: string;
  locationId: string;
  sceneDocumentId: string;
  components: SetupComponent[];
  camera: PlannedCamera | null;
  lighting: PlannedLighting | null;
  blocking: PlannedBlocking | null;
  /** fingerprint of everything above: what the person reviewed. A different token at apply time refuses the copy. */
  token: string;
}

export class SetupCopyRefusal extends Error {}

export const NOTHING_TO_COPY = "Choose at least one part of the setup to copy.";
/** The same answer for a deleted Shot, another Project's Shot and a Shot the caller cannot read (no existence leak). */
export const SETUP_SHOT_GONE = "That shot no longer exists.";
export const SAME_LOCATION_ONLY =
  "A setup can only be copied between Shots set in the same Location: its positions mean nothing in another set.";
export const SETUP_CHANGED = "The setup changed after you reviewed the copy. Review it again before copying.";

const onSet = (r: Anchor, set: CurrentSetupSet) =>
  r.locationId === set.locationId && r.sceneDocumentId === set.sceneDocumentId;
const sameAnchor = (a: Anchor, b: Anchor) =>
  a.locationId === b.locationId &&
  a.sceneDocumentId === b.sceneDocumentId &&
  a.sceneRevision === b.sceneRevision &&
  a.sceneFingerprint === b.sceneFingerprint;

/** What the source Shot can offer on the current set (a row on another set is history and is never copied). */
export function availableSetup(source: SetupRows, set: CurrentSetupSet): Record<SetupComponent, boolean> {
  return {
    camera: !!source.camera && onSet(source.camera, set),
    lighting: !!source.lighting && onSet(source.lighting, set),
    blocking: source.blocking.some((b) => onSet(b, set)),
  };
}

/** Normalizes a requested component list: known names only, canonical order, no duplicates. */
export function parseSetupComponents(input: readonly unknown[]): SetupComponent[] {
  const wanted = new Set(input.map(String));
  for (const w of wanted)
    if (!(SETUP_COMPONENTS as readonly string[]).includes(w))
      throw new SetupCopyRefusal("That part of the setup cannot be copied.");
  return SETUP_COMPONENTS.filter((c) => wanted.has(c));
}

/**
 * The exact copy, derived from both Shots' stored rows. Throws SetupCopyRefusal for a copy that must not happen
 * (same Shot, nothing chosen, or a chosen part the source does not have on the current set).
 */
export function planSetupCopy(args: {
  sourceShotId: string;
  destinationShotId: string;
  set: CurrentSetupSet;
  source: SetupRows;
  destination: SetupRows;
  components: readonly SetupComponent[];
}): SetupCopyPlan {
  const { set, source, destination } = args;
  if (args.sourceShotId === args.destinationShotId)
    throw new SetupCopyRefusal("A Shot's setup cannot be copied onto itself.");
  const components = parseSetupComponents(args.components);
  if (components.length === 0) throw new SetupCopyRefusal(NOTHING_TO_COPY);
  const available = availableSetup(source, set);
  for (const c of components)
    if (!available[c])
      throw new SetupCopyRefusal(
        `The source Shot has no ${SETUP_COMPONENT_LABEL[c].toLowerCase()} on this 3D set to copy.`,
      );

  let camera: PlannedCamera | null = null;
  if (components.includes("camera")) {
    const s = source.camera!;
    const fp = bookmarkCameraFingerprint(s.value);
    const d = destination.camera;
    const dFp = d ? bookmarkCameraFingerprint(d.value) : null;
    camera = {
      label: s.cameraLabel,
      fingerprint: fp,
      sceneRevision: s.sceneRevision,
      replaces: d
        ? {
            fingerprint: dFp!,
            label: d.cameraLabel,
            sceneRevision: d.sceneRevision,
            onCurrentSet: onSet(d, set),
          }
        : null,
      unchanged: !!d && dFp === fp && d.cameraLabel === s.cameraLabel && sameAnchor(d, s),
    };
  }

  let lighting: PlannedLighting | null = null;
  if (components.includes("lighting")) {
    const s = source.lighting!;
    const fp = lightingFingerprint(s.rig);
    const d = destination.lighting;
    lighting = {
      fingerprint: fp,
      baseMode: s.rig.base.mode,
      lightCount: s.rig.lights.length,
      sceneRevision: s.sceneRevision,
      replaces: d
        ? { revision: d.revision, fingerprint: d.lightingFingerprint, onCurrentSet: onSet(d, set) }
        : null,
      unchanged: !!d && d.lightingFingerprint === fp && sameAnchor(d, s),
    };
  }

  let blocking: PlannedBlocking | null = null;
  if (components.includes("blocking")) {
    const from = source.blocking.filter((b) => onSet(b, set));
    const byChar = new Map(destination.blocking.map((b) => [b.characterId, b]));
    const figures: PlannedFigure[] = [...from]
      .sort((a, b) => (a.characterId < b.characterId ? -1 : 1))
      .map((s) => {
        const d = byChar.get(s.characterId);
        return {
          characterId: s.characterId,
          fingerprint: s.blockingFingerprint,
          sceneRevision: s.sceneRevision,
          replaces: d
            ? { revision: d.revision, fingerprint: d.blockingFingerprint, onCurrentSet: onSet(d, set) }
            : null,
          unchanged: !!d && d.blockingFingerprint === s.blockingFingerprint && sameAnchor(d, s),
        };
      });
    const copied = new Set(from.map((b) => b.characterId));
    const removes = destination.blocking
      .filter((d) => onSet(d, set) && !copied.has(d.characterId))
      .sort((a, b) => (a.characterId < b.characterId ? -1 : 1))
      .map((d) => ({ characterId: d.characterId, revision: d.revision, fingerprint: d.blockingFingerprint }));
    blocking = { figures, removes, unchanged: removes.length === 0 && figures.every((f) => f.unchanged) };
  }

  const body = {
    schema: SETUP_COPY_PLAN_SCHEMA,
    sourceShotId: args.sourceShotId,
    destinationShotId: args.destinationShotId,
    locationId: set.locationId,
    sceneDocumentId: set.sceneDocumentId,
    components,
    camera,
    lighting,
    blocking,
  };
  return { ...body, token: fingerprint(body) };
}

/** True when applying the plan would change nothing on the destination. */
export const planIsNoop = (p: SetupCopyPlan) =>
  (p.camera?.unchanged ?? true) && (p.lighting?.unchanged ?? true) && (p.blocking?.unchanged ?? true);

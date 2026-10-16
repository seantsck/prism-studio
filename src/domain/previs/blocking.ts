import { z } from "zod";
import { fingerprint } from "../hash";
import {
  headDirection,
  parsePose,
  poseFingerprint,
  poseSchema,
  quatSchema,
  canonicalizePose,
  type Pose,
} from "./pose";
import {
  DEG,
  quatCanonical,
  quatFromAxisAngle,
  quatToEuler,
  quatRotateVec,
  type Quat,
  IDENTITY_QUAT,
} from "./quat";
import { RIG_REFERENCE_HEIGHT_M, type PoseJointId } from "./rig";
import { vec3Schema, type Vec3 } from "./types";

/**
 * prism.shot-blocking.v1: WHERE a Character stands in ONE Shot and HOW their body is posed.
 *
 * Blocking is owned by the Shot, never by the Location's permanent set: Shot 3A and Shot 3B can use the same
 * Set with different blocking. CHARACTER IDENTITY != MANNEQUIN APPEARANCE: the proxy carries position, facing,
 * height, pose and blocking only. Face, hair, wardrobe and likeness stay in the Character's Prism references.
 *
 * ROOT TRANSFORM != SKELETAL POSE. Moving a figure three metres left, or turning the whole body, is root
 * blocking. Turning only the head, bending an elbow, is a pose edit.
 */
export const SHOT_BLOCKING_SCHEMA = "prism.shot-blocking.v1" as const;

/** Default proxy height when a Character has no recorded height. A blocking default, NOT a Character fact. */
export const DEFAULT_PROXY_HEIGHT_M = 1.7;
export const MIN_PROXY_HEIGHT_M = 0.5;
export const MAX_PROXY_HEIGHT_M = 2.6;

export const blockingRootSchema = z.object({
  position: vec3Schema,
  /** authoritative body orientation (quaternion); yaw is derived for the UI */
  orientation: quatSchema,
  /** uniform scale relative to the rig's 1.70 m reference figure (height = scale * 1.70) */
  scale: z.number().finite().positive(),
});
export type BlockingRoot = z.infer<typeof blockingRootSchema>;

export const shotBlockingEntrySchema = z.object({
  schema: z.literal(SHOT_BLOCKING_SCHEMA),
  characterId: z.string().min(1),
  root: blockingRootSchema,
  pose: poseSchema,
  visibility: z.boolean(),
});
export type ShotBlockingEntry = z.infer<typeof shotBlockingEntrySchema>;

const r4 = (v: number) => Math.round(v * 1e4) / 1e4 + 0;
const rv = (v: Vec3): Vec3 => ({ x: r4(v.x), y: r4(v.y), z: r4(v.z) });
const r5 = (v: number) => Math.round(v * 1e5) / 1e5 + 0;

export const scaleForHeight = (heightM: number) => r5(heightM / RIG_REFERENCE_HEIGHT_M);
export const heightForScale = (scale: number) => r5(scale * RIG_REFERENCE_HEIGHT_M);

export function yawQuat(yawDeg: number): Quat {
  return quatCanonical(quatFromAxisAngle("y", yawDeg * DEG));
}
/** Body yaw about +Y in degrees (0 faces +Z; positive turns toward +X). Display only. */
export function rootYawDeg(root: Pick<BlockingRoot, "orientation">): number {
  const f = quatRotateVec(root.orientation, { x: 0, y: 0, z: 1 });
  return Math.round((Math.atan2(f.x, f.z) / DEG) * 10) / 10 + 0;
}

/** The stored, rounded, sign-canonical form. Same placement in => byte-identical JSON out. */
export function canonicalizeEntry(e: {
  characterId: string;
  root: BlockingRoot;
  pose?: Pose | null;
  visibility?: boolean;
}): ShotBlockingEntry {
  return {
    schema: SHOT_BLOCKING_SCHEMA,
    characterId: e.characterId,
    root: {
      position: rv(e.root.position),
      orientation: quatCanonical(e.root.orientation),
      scale: r5(e.root.scale),
    },
    pose: canonicalizePose(e.pose ?? undefined),
    visibility: e.visibility !== false,
  };
}

export function newBlockingEntry(
  characterId: string,
  position: Vec3 = { x: 0, y: 0, z: 0 },
  heightM: number = DEFAULT_PROXY_HEIGHT_M,
): ShotBlockingEntry {
  return canonicalizeEntry({
    characterId,
    root: { position, orientation: { ...IDENTITY_QUAT }, scale: scaleForHeight(heightM) },
  });
}

export function parseBlockingEntry(raw: unknown): ShotBlockingEntry {
  const p = shotBlockingEntrySchema.parse(raw);
  return canonicalizeEntry({ ...p, pose: parsePose(p.pose) });
}

/**
 * Identity of one figure's blocking. Changes with: character, root position/orientation/scale, pose (and rig),
 * visibility, and the Location the Shot's blocking is anchored to. It does NOT change with the selected bone, the
 * pose-panel tab, gizmo mode, the orbit camera, timeline position or any helper visibility: none of those are
 * inputs here.
 */
export function blockingFingerprint(entry: ShotBlockingEntry, anchor: { locationId: string }): string {
  const c = canonicalizeEntry(entry);
  return fingerprint({
    schema: SHOT_BLOCKING_SCHEMA,
    characterId: c.characterId,
    locationId: anchor.locationId,
    root: c.root,
    rig: c.pose.rig,
    pose: poseFingerprint(c.pose),
    visibility: c.visibility,
  });
}

/**
 * Identity of a Shot's whole blocking layer (all figures, order-independent). `null` when the layer is empty, so
 * a render made before any blocking existed has the same "no blocking" identity as a Shot with none.
 */
export function blockingLayerFingerprint(
  entries: ReadonlyArray<ShotBlockingEntry>,
  anchor: { locationId: string },
): string | null {
  if (entries.length === 0) return null;
  const parts = entries
    .map((e) => ({ characterId: e.characterId, fp: blockingFingerprint(e, anchor) }))
    .sort((a, b) => (a.characterId < b.characterId ? -1 : a.characterId > b.characterId ? 1 : 0));
  return fingerprint({ schema: SHOT_BLOCKING_SCHEMA, figures: parts });
}

/** The stored layer only counts figures that are visible in renders (a hidden proxy is not production content). */
export const renderedEntries = (entries: ReadonlyArray<ShotBlockingEntry>) =>
  entries.filter((e) => e.visibility);

// ───────────────────────── staleness ─────────────────────────

export type BlockingStaleReason = "scene";

/** Blocking is authored against a Set state; it becomes STALE (never deleted) when the Set moves on. */
export function blockingStaleReasons(
  authoredAgainst: { sceneFingerprint: string },
  live: { sceneFingerprint: string },
): BlockingStaleReason[] {
  return authoredAgainst.sceneFingerprint === live.sceneFingerprint ? [] : ["scene"];
}

// ───────────────────────── human-readable summary ─────────────────────────

const COMPASS: Record<number, string> = {
  0: "facing +Z",
  1: "facing +X",
  [-1]: "facing -X",
  2: "facing -Z",
  [-2]: "facing -Z",
};

function facingWords(yawDeg: number): string {
  const y = ((((yawDeg + 180) % 360) + 360) % 360) - 180; // [-180, 180)
  const n = Math.round(y / 90);
  const label = COMPASS[n];
  return Math.abs(y - n * 90) < 5
    ? label
    : `${label.replace("facing", "angled toward")} (body yaw ${Math.round(y)}°)`;
}

const bend = (pose: Pose, id: PoseJointId): number => {
  const q = pose.joints[id];
  if (!q) return 0;
  return Math.abs(Math.round(quatToEuler(q).x / DEG));
};

/**
 * A deterministic, conservative description of the stored blocking. This is NOT generated by a model and does
 * not infer emotion or intent from posture. It is not injected into provider prompts.
 */
export function summarizeBlocking(entry: ShotBlockingEntry, name: string): string {
  const c = canonicalizeEntry(entry);
  const p = c.root.position;
  const pos = `(${p.x.toFixed(1)}, ${p.y.toFixed(1)}, ${p.z.toFixed(1)})`;
  const yaw = rootYawDeg(c.root);
  const head = headDirection(c.pose);
  const bits: string[] = [];
  const kneeFold = Math.max(bend(c.pose, "leftLowerLeg"), bend(c.pose, "rightLowerLeg"));
  const hipFold = Math.max(bend(c.pose, "leftUpperLeg"), bend(c.pose, "rightUpperLeg"));
  const posture = kneeFold >= 70 && hipFold >= 70 ? "seated" : "standing";
  bits.push(`${posture} at ${pos}`);
  bits.push(facingWords(yaw));
  if (Math.abs(head.yawDeg) >= 5 || Math.abs(head.pitchDeg) >= 5) {
    const parts: string[] = [];
    if (Math.abs(head.yawDeg) >= 5)
      parts.push(
        `${Math.abs(Math.round(head.yawDeg))}° ${head.yawDeg > 0 ? "to the figure's left" : "to the figure's right"}`,
      );
    if (Math.abs(head.pitchDeg) >= 5)
      parts.push(`${Math.abs(Math.round(head.pitchDeg))}° ${head.pitchDeg > 0 ? "down" : "up"}`);
    bits.push(`head turned ${parts.join(", ")} relative to the body`);
  }
  for (const side of ["left", "right"] as const) {
    const elbow = bend(c.pose, `${side}LowerArm` as PoseJointId);
    if (elbow >= 20) bits.push(`${side} elbow bent ${elbow}°`);
  }
  const arms: string[] = [];
  for (const side of ["left", "right"] as const) {
    const j = c.pose.joints[`${side}UpperArm` as PoseJointId];
    const el = bend(c.pose, `${side}LowerArm` as PoseJointId);
    if (!j && el < 20) arms.push(side);
  }
  if (arms.length) bits.push(`${arms.join(" and ")} arm${arms.length > 1 ? "s" : ""} relaxed`);
  if (!c.visibility) bits.push("proxy hidden in renders");
  return `${name}: ${bits.join(", ")}.`;
}

/**
 * The identity of what a render (master frame or previs) actually shows of the Shot's blocking: only figures
 * that are visible. `null` = no proxies in the picture, the identity of every render made before M2B.
 */
export function renderedBlockingFingerprint(
  entries: ReadonlyArray<ShotBlockingEntry>,
  anchor: { locationId: string },
): string | null {
  return blockingLayerFingerprint(renderedEntries(entries), anchor);
}

/** Per-figure provenance kept on a render: which stored blocking revision/fingerprint it was rendered from. */
export interface RenderedBlockingFigure {
  characterId: string;
  blockingId: string;
  revision: number;
  fingerprint: string;
}

// ───────────────────────── GenerationPackage reference ─────────────────────────

export const SHOT_BLOCKING_REFERENCE_SCHEMA_VERSION = 1 as const;

/**
 * One figure's blocking, frozen BY VALUE in a package. Identity (the approved Character/Look references) is a
 * separate channel: nothing here describes a face, hair, wardrobe or likeness.
 */
export interface ShotBlockingFigureReference {
  characterId: string;
  blockingId: string;
  revision: number;
  fingerprint: string;
  visible: boolean;
  /** the Set state this was authored against (differs from the live Set when stale) */
  sceneRevision: number;
  sceneFingerprint: string;
  root: { position: Vec3; orientation: Quat; scale: number; heightMeters: number };
  rigVersion: string;
  pose: {
    schemaVersion: typeof SHOT_BLOCKING_REFERENCE_SCHEMA_VERSION;
    poseFingerprint: string;
    joints: Record<string, Quat>;
  };
  /** deterministic text from the stored values (not model generated; not used in provider prompts in M2B) */
  summary: string;
}

export interface ShotBlockingReference {
  schemaVersion: typeof SHOT_BLOCKING_REFERENCE_SCHEMA_VERSION;
  /** identity of the whole rendered layer (visible figures); null when none is visible */
  layerFingerprint: string | null;
  figures: ShotBlockingFigureReference[];
}

export interface BlockingRecordLike {
  id: string;
  characterId: string;
  revision: number;
  entry: ShotBlockingEntry;
  sceneRevision: number;
  sceneFingerprint: string;
}

export function buildShotBlockingReference(
  records: ReadonlyArray<BlockingRecordLike>,
  names: Readonly<Record<string, string>>,
  anchor: { locationId: string },
): ShotBlockingReference | null {
  if (records.length === 0) return null;
  const figures = [...records]
    .sort((a, b) => (a.characterId < b.characterId ? -1 : a.characterId > b.characterId ? 1 : 0))
    .map((r): ShotBlockingFigureReference => {
      const c = canonicalizeEntry(r.entry);
      return {
        characterId: r.characterId,
        blockingId: r.id,
        revision: r.revision,
        fingerprint: blockingFingerprint(c, anchor),
        visible: c.visibility,
        sceneRevision: r.sceneRevision,
        sceneFingerprint: r.sceneFingerprint,
        root: {
          position: { ...c.root.position },
          orientation: { ...c.root.orientation },
          scale: c.root.scale,
          heightMeters: heightForScale(c.root.scale),
        },
        rigVersion: c.pose.rig,
        pose: {
          schemaVersion: SHOT_BLOCKING_REFERENCE_SCHEMA_VERSION,
          poseFingerprint: poseFingerprint(c.pose),
          joints: structuredClone(c.pose.joints),
        },
        summary: summarizeBlocking(c, names[r.characterId] ?? "Character"),
      };
    });
  return {
    schemaVersion: SHOT_BLOCKING_REFERENCE_SCHEMA_VERSION,
    layerFingerprint: renderedBlockingFingerprint(
      records.map((r) => r.entry),
      anchor,
    ),
    figures,
  };
}

/**
 * What a render should record about the blocking it showed: the layer identity plus which stored revision each
 * visible figure came from. `null` when no proxy is visible (the identity of every pre-M2B render).
 */
export function renderedBlockingProvenance(
  records: ReadonlyArray<BlockingRecordLike>,
  anchor: { locationId: string },
): { fingerprint: string; figures: RenderedBlockingFigure[] } | null {
  const visible = records.filter((r) => r.entry.visibility);
  const fingerprint = blockingLayerFingerprint(
    visible.map((r) => r.entry),
    anchor,
  );
  if (!fingerprint) return null;
  return {
    fingerprint,
    figures: [...visible]
      .sort((a, b) => (a.characterId < b.characterId ? -1 : a.characterId > b.characterId ? 1 : 0))
      .map((r) => ({
        characterId: r.characterId,
        blockingId: r.id,
        revision: r.revision,
        fingerprint: blockingFingerprint(r.entry, anchor),
      })),
  };
}

/** A stored figure as the 3D editor receives it (plain data; the server derives every fingerprint). */
export interface BlockingFigureData {
  characterId: string;
  name: string;
  blockingId: string;
  revision: number;
  fingerprint: string;
  sceneRevision: number;
  sceneFingerprint: string;
  entry: ShotBlockingEntry;
}

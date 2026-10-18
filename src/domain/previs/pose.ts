import { z } from "zod";
import { fingerprint } from "../hash";
import {
  DEG,
  IDENTITY_QUAT,
  quatCanonical,
  quatFromAxisAngle,
  quatConjugate,
  quatFromEuler,
  quatPow,
  quatRotateVec,
  quatIsIdentity,
  quatMultiply,
  quatNormalize,
  quatToEuler,
  type Quat,
} from "./quat";
import { HUMANOID_RIG_VERSION, POSE_JOINT_IDS, isPoseJointId, jointDef, type PoseJointId } from "./rig";

/**
 * prism.pose.v1: the skeletal pose of one figure. Quaternions are authoritative (Euler angles exist only in the
 * editor UI). Only joints that differ from neutral are stored, so the neutral pose is `joints: {}` and the
 * evaluated pose is always deterministic. The ROOT (position, facing, height) is blocking, not pose.
 */
export const POSE_SCHEMA = "prism.pose.v1" as const;

const num = z.number().finite();
export const quatSchema = z.object({ x: num, y: num, z: num, w: num });

export const poseSchema = z.object({
  schema: z.literal(POSE_SCHEMA),
  rig: z.literal(HUMANOID_RIG_VERSION),
  joints: z.record(z.string(), quatSchema),
});
export type Pose = z.infer<typeof poseSchema>;

export const NEUTRAL_POSE: Pose = Object.freeze({
  schema: POSE_SCHEMA,
  rig: HUMANOID_RIG_VERSION,
  joints: Object.freeze({}) as Record<string, Quat>,
}) as Pose;

export const neutralPose = (): Pose => ({ schema: POSE_SCHEMA, rig: HUMANOID_RIG_VERSION, joints: {} });

/**
 * The canonical stored form: unknown/root joints dropped, each quaternion normalised, sign-canonical and rounded,
 * neutral joints omitted, keys in rig order. Same orientation set in => byte-identical JSON out.
 */
export function canonicalizePose(input: { joints?: Record<string, Quat> } | null | undefined): Pose {
  const joints: Record<string, Quat> = {};
  for (const id of POSE_JOINT_IDS) {
    const q = input?.joints?.[id];
    if (!q) continue;
    if (![q.x, q.y, q.z, q.w].every(Number.isFinite)) continue;
    if (quatIsIdentity(q, 1e-5)) continue;
    joints[id] = quatCanonical(q);
  }
  return { schema: POSE_SCHEMA, rig: HUMANOID_RIG_VERSION, joints };
}

/** Stable identity of a pose. Changes with any joint rotation and the rig version; nothing else. */
export function poseFingerprint(pose: Pose): string {
  const c = canonicalizePose(pose);
  return fingerprint({
    schema: c.schema,
    rig: pose.rig === HUMANOID_RIG_VERSION ? c.rig : pose.rig,
    joints: c.joints,
  });
}

export function poseJointQuat(pose: Pose, id: PoseJointId): Quat {
  return pose.joints[id] ? { ...pose.joints[id] } : { ...IDENTITY_QUAT };
}

/** Returns a new canonical pose with one joint set (identity removes it). */
export function setPoseJoint(pose: Pose, id: PoseJointId, q: Quat): Pose {
  return canonicalizePose({ joints: { ...pose.joints, [id]: q } });
}

/** Parses untrusted stored JSON into a canonical pose, or throws a zod error. */
export function parsePose(raw: unknown): Pose {
  const p = poseSchema.parse(raw);
  for (const k of Object.keys(p.joints)) {
    if (!isPoseJointId(k)) throw new Error(`pose has an unknown joint: ${k}`);
  }
  return canonicalizePose(p);
}

// ───────────────────────── joint limits (editor safety constraints) ─────────────────────────

const clamp = (v: number, [lo, hi]: readonly [number, number]) => Math.min(hi, Math.max(lo, v));

/**
 * Clamps a joint rotation into its conservative limits (Euler XYZ ranges, degrees). These are editor safety
 * constraints (no backwards elbows/knees, no spun-around heads), NOT biomechanically exact. The stored
 * quaternion stays authoritative: a pose loaded from storage is never silently rewritten by the limits.
 */
export function clampJointToLimits(id: PoseJointId, q: Quat): Quat {
  const lim = jointDef(id).limits;
  const e = quatToEuler(q);
  const x = clamp(e.x / DEG, lim.x) * DEG;
  const y = clamp(e.y / DEG, lim.y) * DEG;
  const z = clamp(e.z / DEG, lim.z) * DEG;
  return quatCanonical(quatFromEuler(x, y, z));
}

export function isJointWithinLimits(id: PoseJointId, q: Quat, epsDeg = 0.01): boolean {
  const lim = jointDef(id).limits;
  const e = quatToEuler(q);
  const within = (v: number, [lo, hi]: readonly [number, number]) => v >= lo - epsDeg && v <= hi + epsDeg;
  return within(e.x / DEG, lim.x) && within(e.y / DEG, lim.y) && within(e.z / DEG, lim.z);
}

export function posesWithinLimits(pose: Pose): boolean {
  return POSE_JOINT_IDS.every((id) => !pose.joints[id] || isJointWithinLimits(id, pose.joints[id]));
}

// ───────────────────────── head direction ─────────────────────────

/** Share of the head turn carried by the neck (the rest is the head). */
const NECK_SHARE = 0.4;

/**
 * Head direction as yaw (about +Y, positive = turning toward the figure's LEFT, i.e. +X) and pitch (about +X,
 * positive = looking down). Split across neck and head so a 60-degree look is not a snapped head.
 */
export function withHeadDirection(pose: Pose, yawDeg: number, pitchDeg: number): Pose {
  // total = yaw about +Y, then pitch about the turned +X: forward = (cos p sin y, -sin p, cos p cos y)
  const total = quatMultiply(quatFromAxisAngle("y", yawDeg * DEG), quatFromAxisAngle("x", pitchDeg * DEG));
  const neckPart = quatPow(total, NECK_SHARE);
  const headPart = quatMultiply(quatConjugate(neckPart), total);
  const neck = clampJointToLimits("neck", neckPart);
  const head = clampJointToLimits("head", headPart);
  return canonicalizePose({ joints: { ...pose.joints, neck, head } });
}

/** The combined neck+head look direction relative to the body. */
export function headDirection(pose: Pose): { yawDeg: number; pitchDeg: number } {
  const total = quatMultiply(
    quatNormalize(pose.joints.neck ?? IDENTITY_QUAT),
    quatNormalize(pose.joints.head ?? IDENTITY_QUAT),
  );
  const f = quatRotateVec(total, { x: 0, y: 0, z: 1 });
  return {
    yawDeg: round1(Math.atan2(f.x, f.z) / DEG),
    pitchDeg: round1(Math.asin(Math.max(-1, Math.min(1, -f.y))) / DEG),
  };
}

const round1 = (v: number) => Math.round(v * 10) / 10 + 0;

// ───────────────────────── presets ─────────────────────────

export const POSE_PRESET_IDS = ["neutral_stand", "seated", "walk_a", "walk_b", "hands_on_hips"] as const;
export type PosePresetId = (typeof POSE_PRESET_IDS)[number];

export interface PosePreset {
  id: PosePresetId;
  label: string;
  /**
   * Metres at the rig's reference height (scaled with the figure). Applying a preset never moves the root,
   * EXCEPT this documented vertical offset: a seated figure's hips sit lower than a standing figure's. The
   * editor applies the DIFFERENCE from the preset the figure was previously in, so a stand->sit->stand round
   * trip returns to the same height.
   */
  rootYOffsetM: number;
  pose: Pose;
}

const e = (xDeg = 0, yDeg = 0, zDeg = 0) => quatFromEuler(xDeg * DEG, yDeg * DEG, zDeg * DEG);
const axis = (a: "x" | "y" | "z", deg: number) => quatFromAxisAngle(a, deg * DEG);

function preset(
  id: PosePresetId,
  label: string,
  rootYOffsetM: number,
  joints: Partial<Record<PoseJointId, Quat>>,
): PosePreset {
  return { id, label, rootYOffsetM, pose: canonicalizePose({ joints: joints as Record<string, Quat> }) };
}

/** A small, Prism-owned, procedural preset set. Starting points only; no animation data is involved. */
export const POSE_PRESETS: ReadonlyArray<PosePreset> = [
  preset("neutral_stand", "Neutral Stand", 0, {}),
  preset("seated", "Seated", -0.42, {
    leftUpperLeg: axis("x", -90),
    rightUpperLeg: axis("x", -90),
    leftLowerLeg: axis("x", 90),
    rightLowerLeg: axis("x", 90),
    leftFoot: axis("x", 0),
    spine: axis("x", 4),
  }),
  preset("walk_a", "Walk A", 0, {
    leftUpperLeg: axis("x", -28),
    leftLowerLeg: axis("x", 8),
    rightUpperLeg: axis("x", 20),
    rightLowerLeg: axis("x", 32),
    rightFoot: axis("x", 12),
    leftUpperArm: axis("x", 22),
    leftLowerArm: axis("x", -12),
    rightUpperArm: axis("x", -26),
    rightLowerArm: axis("x", -28),
    spine: e(2, -4, 0),
    chest: e(0, 5, 0),
  }),
  preset("walk_b", "Walk B", 0, {
    leftUpperLeg: axis("x", 20),
    leftLowerLeg: axis("x", 32),
    leftFoot: axis("x", 12),
    rightUpperLeg: axis("x", -28),
    rightLowerLeg: axis("x", 8),
    leftUpperArm: axis("x", -26),
    leftLowerArm: axis("x", -28),
    rightUpperArm: axis("x", 22),
    rightLowerArm: axis("x", -12),
    spine: e(2, 4, 0),
    chest: e(0, -5, 0),
  }),
  preset("hands_on_hips", "Hands on Hips", 0, {
    leftUpperArm: e(20, 25, 35),
    leftLowerArm: axis("x", -115),
    leftHand: e(0, 0, 0),
    rightUpperArm: e(20, -25, -35),
    rightLowerArm: axis("x", -115),
  }),
];

export const presetById = (id: PosePresetId): PosePreset => POSE_PRESETS.find((p) => p.id === id)!;

/** The preset whose pose the given pose matches exactly, or null (used for the root-height difference). */
export function matchingPreset(pose: Pose): PosePreset | null {
  const fp = poseFingerprint(pose);
  return POSE_PRESETS.find((p) => poseFingerprint(p.pose) === fp) ?? null;
}

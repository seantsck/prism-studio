import type { Vec3 } from "./types";

/**
 * Prism-owned neutral humanoid rig (prism.humanoid-rig.v1).
 *
 * This is the semantic model the domain stores and fingerprints. The runtime (three.js Bones, the vendored
 * ArtCraft FK helpers) is an adapter over it: `mixamoAlias` below is the explicit mapping to the `mixamorig:*`
 * names the vendored FK machinery looks for. NO Mixamo/ArtCraft asset is used: only the naming convention.
 *
 * Conventions (three.js, right-handed, Y up): the figure faces +Z at yaw 0, so its LEFT side is +X. Offsets are
 * metres for a figure of RIG_REFERENCE_HEIGHT_M standing on y = 0; blocking scales the whole figure uniformly.
 * The neutral pose (every joint at identity) is a relaxed stand with the arms hanging at the sides.
 */

export const HUMANOID_RIG_VERSION = "prism.humanoid-rig.v1" as const;
export const RIG_REFERENCE_HEIGHT_M = 1.7;

export const JOINT_IDS = [
  "root",
  "hips",
  "spine",
  "chest",
  "neck",
  "head",
  "leftShoulder",
  "leftUpperArm",
  "leftLowerArm",
  "leftHand",
  "rightShoulder",
  "rightUpperArm",
  "rightLowerArm",
  "rightHand",
  "leftUpperLeg",
  "leftLowerLeg",
  "leftFoot",
  "rightUpperLeg",
  "rightLowerLeg",
  "rightFoot",
] as const;
export type JointId = (typeof JOINT_IDS)[number];

/** Joints a pose may rotate. `root` is the blocking root (position/orientation/scale), never a pose joint. */
export const POSE_JOINT_IDS = JOINT_IDS.filter((j) => j !== "root") as Exclude<JointId, "root">[];
export type PoseJointId = (typeof POSE_JOINT_IDS)[number];

/** [min, max] degrees on the joint's Euler XYZ components. These are editor safety constraints, not anatomy. */
export type AxisRange = readonly [number, number];
export interface JointLimits {
  x: AxisRange;
  y: AxisRange;
  z: AxisRange;
}

export interface JointDef {
  id: JointId;
  parent: JointId | null;
  /** rest offset from the parent joint, metres, at RIG_REFERENCE_HEIGHT_M */
  offset: Vec3;
  /** the name the vendored FK helpers expect (explicit adapter mapping, not the domain schema) */
  mixamoAlias: string;
  limits: JointLimits;
  /** short human label for the editor */
  label: string;
}

const FIXED: AxisRange = [0, 0];
const sym = (d: number): AxisRange => [-d, d];

const side = (s: "left" | "right") => (s === "left" ? 1 : -1);

function arm(s: "left" | "right"): JointDef[] {
  const k = side(s);
  const S = s === "left" ? "Left" : "Right";
  const cap = s === "left" ? "left" : "right";
  return [
    {
      id: `${cap}Shoulder` as JointId,
      parent: "chest",
      offset: { x: 0.04 * k, y: 0.2, z: 0 },
      mixamoAlias: `mixamorig:${S}Shoulder`,
      limits: { x: sym(10), y: sym(10), z: sym(20) },
      label: `${S} shoulder`,
    },
    {
      id: `${cap}UpperArm` as JointId,
      parent: `${cap}Shoulder` as JointId,
      offset: { x: 0.12 * k, y: 0, z: 0 },
      mixamoAlias: `mixamorig:${S}Arm`,
      // abduction is +Z on the left and -Z on the right
      limits: { x: [-180, 60], y: sym(90), z: s === "left" ? [-30, 180] : [-180, 30] },
      label: `${S} upper arm`,
    },
    {
      id: `${cap}LowerArm` as JointId,
      parent: `${cap}UpperArm` as JointId,
      offset: { x: 0, y: -0.28, z: 0 },
      mixamoAlias: `mixamorig:${S}ForeArm`,
      // an elbow is a hinge that only folds forward
      limits: { x: [-150, 0], y: FIXED, z: FIXED },
      label: `${S} lower arm`,
    },
    {
      id: `${cap}Hand` as JointId,
      parent: `${cap}LowerArm` as JointId,
      offset: { x: 0, y: -0.25, z: 0 },
      mixamoAlias: `mixamorig:${S}Hand`,
      limits: { x: sym(70), y: sym(30), z: sym(20) },
      label: `${S} hand`,
    },
  ];
}

function leg(s: "left" | "right"): JointDef[] {
  const k = side(s);
  const S = s === "left" ? "Left" : "Right";
  const cap = s === "left" ? "left" : "right";
  return [
    {
      id: `${cap}UpperLeg` as JointId,
      parent: "hips",
      offset: { x: 0.09 * k, y: -0.05, z: 0 },
      mixamoAlias: `mixamorig:${S}UpLeg`,
      limits: { x: [-120, 30], y: sym(45), z: s === "left" ? [-20, 50] : [-50, 20] },
      label: `${S} upper leg`,
    },
    {
      id: `${cap}LowerLeg` as JointId,
      parent: `${cap}UpperLeg` as JointId,
      offset: { x: 0, y: -0.42, z: 0 },
      mixamoAlias: `mixamorig:${S}Leg`,
      // a knee is a hinge that only folds backward
      limits: { x: [0, 150], y: FIXED, z: FIXED },
      label: `${S} lower leg`,
    },
    {
      id: `${cap}Foot` as JointId,
      parent: `${cap}LowerLeg` as JointId,
      offset: { x: 0, y: -0.42, z: 0 },
      mixamoAlias: `mixamorig:${S}Foot`,
      limits: { x: [-40, 50], y: sym(25), z: sym(20) },
      label: `${S} foot`,
    },
  ];
}

const DEFS: JointDef[] = [
  {
    id: "root",
    parent: null,
    offset: { x: 0, y: 0, z: 0 },
    mixamoAlias: "mixamorig:Root",
    limits: { x: FIXED, y: FIXED, z: FIXED },
    label: "Root",
  },
  {
    id: "hips",
    parent: "root",
    offset: { x: 0, y: 0.92, z: 0 },
    mixamoAlias: "mixamorig:Hips",
    limits: { x: sym(45), y: sym(60), z: sym(30) },
    label: "Hips",
  },
  {
    id: "spine",
    parent: "hips",
    offset: { x: 0, y: 0.1, z: 0 },
    mixamoAlias: "mixamorig:Spine",
    limits: { x: [-20, 40], y: sym(35), z: sym(25) },
    label: "Spine",
  },
  {
    id: "chest",
    parent: "spine",
    offset: { x: 0, y: 0.17, z: 0 },
    mixamoAlias: "mixamorig:Spine1",
    limits: { x: [-15, 25], y: sym(35), z: sym(15) },
    label: "Chest",
  },
  {
    id: "neck",
    parent: "chest",
    offset: { x: 0, y: 0.21, z: 0 },
    mixamoAlias: "mixamorig:Neck",
    limits: { x: [-30, 35], y: sym(50), z: sym(25) },
    label: "Neck",
  },
  {
    id: "head",
    parent: "neck",
    offset: { x: 0, y: 0.1, z: 0 },
    mixamoAlias: "mixamorig:Head",
    limits: { x: [-30, 35], y: sym(50), z: sym(25) },
    label: "Head",
  },
  ...arm("left"),
  ...arm("right"),
  ...leg("left"),
  ...leg("right"),
];

export const HUMANOID_RIG: ReadonlyArray<JointDef> = JOINT_IDS.map((id) => {
  const d = DEFS.find((j) => j.id === id);
  if (!d) throw new Error(`rig definition missing for ${id}`);
  return d;
});

const byId = new Map<JointId, JointDef>(HUMANOID_RIG.map((j) => [j.id, j]));
const byAlias = new Map<string, JointId>(HUMANOID_RIG.map((j) => [j.mixamoAlias.toLowerCase(), j.id]));

export const isJointId = (v: unknown): v is JointId => typeof v === "string" && byId.has(v as JointId);
export const isPoseJointId = (v: unknown): v is PoseJointId => isJointId(v) && v !== "root";
export const jointDef = (id: JointId): JointDef => byId.get(id)!;
export const mixamoAliasOf = (id: JointId): string => byId.get(id)!.mixamoAlias;
/** Resolves an upstream-style bone name (case-insensitive) to the Prism semantic joint, or null. */
export const jointFromAlias = (name: string): JointId | null => byAlias.get(name.toLowerCase()) ?? null;
export const childrenOf = (id: JointId): JointId[] =>
  HUMANOID_RIG.filter((j) => j.parent === id).map((j) => j.id);

/** World position of every joint for a figure at the rest pose (used for visuals and tests). */
export function restPositions(): Record<JointId, Vec3> {
  const out = {} as Record<JointId, Vec3>;
  for (const j of HUMANOID_RIG) {
    const p = j.parent ? out[j.parent] : { x: 0, y: 0, z: 0 };
    out[j.id] = { x: p.x + j.offset.x, y: p.y + j.offset.y, z: p.z + j.offset.z };
  }
  return out;
}

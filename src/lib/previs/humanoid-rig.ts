import * as THREE from "three";
import { canonicalizePose, type Pose } from "@/domain/previs/pose";
import type { Quat } from "@/domain/previs/quat";
import {
  HUMANOID_RIG,
  POSE_JOINT_IDS,
  RIG_REFERENCE_HEIGHT_M,
  jointDef,
  jointFromAlias,
  mixamoAliasOf,
  type JointId,
  type PoseJointId,
} from "@/domain/previs/rig";

/**
 * A neutral, Prism-owned procedural humanoid: a real THREE.Bone hierarchy (one bone per rig joint except `root`,
 * which is the Group itself) with simple rigid primitives attached to the bones. No third-party mesh, texture or
 * animation is used. It represents position, facing, height and pose: NOT a Character's face, hair, wardrobe or
 * likeness.
 *
 * The Bones carry the explicit `mixamorig:*` alias (rig.ts) so the vendored FK helpers recognise them; the Prism
 * semantic joint id is also stored in `userData.prismJoint`, and that is what Prism code reads.
 */

export const PROXY_USERDATA = "prismBlocking" as const;
export const BODY_MATERIAL_COLOR = 0xa9aeb8;

export interface RigHandle {
  group: THREE.Group;
  bones: Map<JointId, THREE.Bone>;
  setPose(pose: Pose): void;
  readPose(): Pose;
  /** Releases every geometry/material the rig created (idempotent). */
  dispose(): void;
}

type Prim = {
  make: () => THREE.BufferGeometry;
  at: [number, number, number];
  rot?: [number, number, number];
};

/** Rigid pieces per joint, in the joint's local frame (metres at the 1.70 m reference height). */
const PIECES: Partial<Record<JointId, Prim[]>> = {
  hips: [{ make: () => new THREE.BoxGeometry(0.3, 0.16, 0.18), at: [0, 0.01, 0] }],
  spine: [{ make: () => new THREE.BoxGeometry(0.27, 0.18, 0.17), at: [0, 0.085, 0] }],
  chest: [{ make: () => new THREE.BoxGeometry(0.33, 0.24, 0.19), at: [0, 0.11, 0] }],
  neck: [{ make: () => new THREE.CylinderGeometry(0.04, 0.045, 0.12, 10), at: [0, 0.05, 0] }],
  head: [
    { make: () => new THREE.SphereGeometry(0.105, 18, 14), at: [0, 0.105, 0] },
    // a small nose-wedge so the facing direction (+Z) reads at a glance; not a face
    { make: () => new THREE.ConeGeometry(0.022, 0.05, 8), at: [0, 0.1, 0.11], rot: [Math.PI / 2, 0, 0] },
  ],
  leftShoulder: [{ make: () => new THREE.SphereGeometry(0.05, 10, 8), at: [0.0, 0, 0] }],
  rightShoulder: [{ make: () => new THREE.SphereGeometry(0.05, 10, 8), at: [0.0, 0, 0] }],
  leftUpperArm: [{ make: () => new THREE.CylinderGeometry(0.045, 0.04, 0.28, 10), at: [0, -0.14, 0] }],
  rightUpperArm: [{ make: () => new THREE.CylinderGeometry(0.045, 0.04, 0.28, 10), at: [0, -0.14, 0] }],
  leftLowerArm: [{ make: () => new THREE.CylinderGeometry(0.04, 0.032, 0.25, 10), at: [0, -0.125, 0] }],
  rightLowerArm: [{ make: () => new THREE.CylinderGeometry(0.04, 0.032, 0.25, 10), at: [0, -0.125, 0] }],
  leftHand: [{ make: () => new THREE.BoxGeometry(0.075, 0.1, 0.035), at: [0, -0.05, 0] }],
  rightHand: [{ make: () => new THREE.BoxGeometry(0.075, 0.1, 0.035), at: [0, -0.05, 0] }],
  leftUpperLeg: [{ make: () => new THREE.CylinderGeometry(0.075, 0.06, 0.42, 12), at: [0, -0.21, 0] }],
  rightUpperLeg: [{ make: () => new THREE.CylinderGeometry(0.075, 0.06, 0.42, 12), at: [0, -0.21, 0] }],
  leftLowerLeg: [{ make: () => new THREE.CylinderGeometry(0.058, 0.045, 0.42, 12), at: [0, -0.21, 0] }],
  rightLowerLeg: [{ make: () => new THREE.CylinderGeometry(0.058, 0.045, 0.42, 12), at: [0, -0.21, 0] }],
  leftFoot: [{ make: () => new THREE.BoxGeometry(0.09, 0.06, 0.24), at: [0, -0.0, 0.06] }],
  rightFoot: [{ make: () => new THREE.BoxGeometry(0.09, 0.06, 0.24), at: [0, -0.0, 0.06] }],
};

const q = (v: Quat) => new THREE.Quaternion(v.x, v.y, v.z, v.w);

export function buildHumanoidRig(opts: { name: string; color?: number }): RigHandle {
  const material = new THREE.MeshStandardMaterial({
    color: opts.color ?? BODY_MATERIAL_COLOR,
    roughness: 0.85,
    metalness: 0,
  });
  const geometries: THREE.BufferGeometry[] = [];
  const group = new THREE.Group();
  group.name = opts.name; // a non-empty name makes the group a pickable top-level object in the engine
  const bones = new Map<JointId, THREE.Bone>();

  for (const def of HUMANOID_RIG) {
    if (def.id === "root") continue;
    const bone = new THREE.Bone();
    bone.name = mixamoAliasOf(def.id);
    bone.userData.prismJoint = def.id;
    bone.position.set(def.offset.x, def.offset.y, def.offset.z);
    bones.set(def.id, bone);
    const parent = def.parent && def.parent !== "root" ? bones.get(def.parent) : group;
    (parent ?? group).add(bone);
    for (const piece of PIECES[def.id] ?? []) {
      const geo = piece.make();
      geometries.push(geo);
      const mesh = new THREE.Mesh(geo, material);
      mesh.position.set(...piece.at);
      if (piece.rot) mesh.rotation.set(...piece.rot);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.userData.prismProxyPiece = true;
      bone.add(mesh);
    }
  }

  let disposed = false;
  return {
    group,
    bones,
    setPose(pose) {
      const c = canonicalizePose(pose);
      for (const id of POSE_JOINT_IDS) {
        const bone = bones.get(id);
        if (!bone) continue;
        const jq = c.joints[id];
        if (jq) bone.quaternion.copy(q(jq));
        else bone.quaternion.identity();
      }
      group.updateMatrixWorld(true);
    },
    readPose() {
      const joints: Record<string, Quat> = {};
      for (const id of POSE_JOINT_IDS) {
        const b = bones.get(id);
        if (b) joints[id] = { x: b.quaternion.x, y: b.quaternion.y, z: b.quaternion.z, w: b.quaternion.w };
      }
      return canonicalizePose({ joints });
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      group.parent?.remove(group);
      for (const g of geometries) g.dispose();
      material.dispose();
      group.clear();
      bones.clear();
    },
  };
}

/** The semantic joint a bone represents, from its Prism tag or (for a foreign rig) its upstream-style name. */
export function jointOfBone(bone: THREE.Object3D): JointId | null {
  const tagged = bone.userData?.prismJoint as JointId | undefined;
  if (tagged) return tagged;
  return jointFromAlias(bone.name);
}

export function poseJointOfBone(bone: THREE.Object3D): PoseJointId | null {
  const j = jointOfBone(bone);
  return j && j !== "root" ? (j as PoseJointId) : null;
}

/** World-space position of a joint (for tests and labels). */
export function jointWorldPosition(handle: RigHandle, id: JointId): THREE.Vector3 | null {
  const b = handle.bones.get(id);
  if (!b) return null;
  b.updateWorldMatrix(true, false);
  return new THREE.Vector3().setFromMatrixPosition(b.matrixWorld);
}

export const rigHeightScale = (heightM: number) => heightM / RIG_REFERENCE_HEIGHT_M;
export const jointLabel = (id: JointId) => jointDef(id).label;

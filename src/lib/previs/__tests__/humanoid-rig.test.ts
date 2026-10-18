import * as THREE from "three";
import { describe, expect, it } from "vitest";
import {
  canonicalizePose,
  neutralPose,
  presetById,
  poseFingerprint,
  withHeadDirection,
} from "@/domain/previs/pose";
import { DEG, quatFromAxisAngle } from "@/domain/previs/quat";
import {
  HUMANOID_RIG,
  JOINT_IDS,
  POSE_JOINT_IDS,
  childrenOf,
  mixamoAliasOf,
  restPositions,
} from "@/domain/previs/rig";
import { buildHumanoidRig, jointOfBone, jointWorldPosition, poseJointOfBone } from "../humanoid-rig";

describe("procedural humanoid rig (three.js)", () => {
  it("builds a real Bone hierarchy that mirrors the Prism rig: one bone per joint except the root", () => {
    const rig = buildHumanoidRig({ name: "Yumeko · Character Proxy" });
    expect(rig.bones.size).toBe(JOINT_IDS.length - 1);
    expect(rig.bones.has("root" as never)).toBe(false);
    for (const def of HUMANOID_RIG) {
      if (def.id === "root") continue;
      const bone = rig.bones.get(def.id)!;
      expect(bone.type).toBe("Bone");
      expect(bone.name).toBe(mixamoAliasOf(def.id)); // the explicit alias the vendored FK helpers look for
      expect(jointOfBone(bone)).toBe(def.id);
      expect(poseJointOfBone(bone)).toBe(def.id);
      const parent = def.parent === "root" ? rig.group : rig.bones.get(def.parent!)!;
      expect(bone.parent).toBe(parent);
      expect(bone.position.toArray()).toEqual([def.offset.x, def.offset.y, def.offset.z]);
    }
    expect(childrenOf("hips").length).toBeGreaterThan(1);
    rig.dispose();
  });

  it("rest world positions match the domain rig and the figure stands on the ground at about 1.7 m", () => {
    const rig = buildHumanoidRig({ name: "t" });
    rig.group.updateMatrixWorld(true);
    const rest = restPositions();
    for (const id of JOINT_IDS) {
      if (id === "root") continue;
      const w = jointWorldPosition(rig, id)!;
      expect(w.x).toBeCloseTo(rest[id].x, 6);
      expect(w.y).toBeCloseTo(rest[id].y, 6);
      expect(w.z).toBeCloseTo(rest[id].z, 6);
    }
    const box = new THREE.Box3().setFromObject(rig.group);
    expect(box.min.y).toBeGreaterThan(-0.05);
    expect(box.min.y).toBeLessThan(0.05);
    expect(box.max.y).toBeGreaterThan(1.62);
    expect(box.max.y).toBeLessThan(1.8);
    rig.dispose();
  });

  it("propagates a parent joint rotation to its descendants (FK) and not to its siblings", () => {
    const rig = buildHumanoidRig({ name: "t" });
    const before = {
      hand: jointWorldPosition(rig, "leftHand")!.clone(),
      rightHand: jointWorldPosition(rig, "rightHand")!.clone(),
      shoulder: jointWorldPosition(rig, "leftUpperArm")!.clone(),
    };
    rig.setPose(canonicalizePose({ joints: { leftUpperArm: quatFromAxisAngle("z", 90 * DEG) } }));
    const hand = jointWorldPosition(rig, "leftHand")!;
    // the arm now points out sideways: the hand moved, the shoulder pivot did not, the other arm did not
    expect(hand.distanceTo(before.hand)).toBeGreaterThan(0.3);
    expect(hand.y).toBeCloseTo(before.shoulder.y, 2);
    expect(jointWorldPosition(rig, "leftUpperArm")!.distanceTo(before.shoulder)).toBeLessThan(1e-9);
    expect(jointWorldPosition(rig, "rightHand")!.distanceTo(before.rightHand)).toBeLessThan(1e-9);
    rig.dispose();
  });

  it("the root group scales and moves the whole figure; joints stay in rig space", () => {
    const rig = buildHumanoidRig({ name: "t" });
    rig.group.scale.setScalar(1.1);
    rig.group.position.set(2, 0, -3);
    rig.group.updateMatrixWorld(true);
    const head = jointWorldPosition(rig, "head")!;
    expect(head.x).toBeCloseTo(2, 6);
    expect(head.z).toBeCloseTo(-3, 6);
    expect(head.y).toBeCloseTo(restPositions().head.y * 1.1, 5);
    // bones carry rig-space offsets regardless of the root transform
    expect(rig.bones.get("head")!.position.y).toBeCloseTo(0.1, 9);
    rig.dispose();
  });

  it("pose apply / read round-trips and reset returns to the neutral fingerprint", () => {
    const rig = buildHumanoidRig({ name: "t" });
    for (const id of ["seated", "walk_a", "walk_b", "hands_on_hips"] as const) {
      const p = presetById(id).pose;
      rig.setPose(p);
      expect(poseFingerprint(rig.readPose())).toBe(poseFingerprint(p));
    }
    const headed = withHeadDirection(neutralPose(), 30, 10);
    rig.setPose(headed);
    expect(poseFingerprint(rig.readPose())).toBe(poseFingerprint(headed));
    rig.setPose(neutralPose());
    expect(poseFingerprint(rig.readPose())).toBe(poseFingerprint(neutralPose()));
    expect(rig.readPose().joints).toEqual({});
    rig.dispose();
  });

  it("the neutral pose is deterministic and equals the rest pose", () => {
    const a = buildHumanoidRig({ name: "a" });
    const b = buildHumanoidRig({ name: "b" });
    for (const id of POSE_JOINT_IDS) {
      expect(a.bones.get(id)!.quaternion.toArray()).toEqual([0, 0, 0, 1]);
      expect(a.bones.get(id)!.position.toArray()).toEqual(b.bones.get(id)!.position.toArray());
    }
    a.dispose();
    b.dispose();
  });

  it("carries no external asset: only procedural geometry and a single plain material", () => {
    const rig = buildHumanoidRig({ name: "t" });
    const materials = new Set<THREE.Material>();
    let meshes = 0;
    rig.group.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) {
        meshes++;
        materials.add((o as THREE.Mesh).material as THREE.Material);
        expect((o as THREE.Mesh).material).toBeInstanceOf(THREE.MeshStandardMaterial);
        expect(((o as THREE.Mesh).material as THREE.MeshStandardMaterial).map).toBeNull(); // no texture
      }
    });
    expect(meshes).toBeGreaterThan(15);
    expect(materials.size).toBe(1);
    rig.dispose();
  });

  it("dispose releases every geometry and the material, detaches the group, and is idempotent", () => {
    const rig = buildHumanoidRig({ name: "t" });
    const parent = new THREE.Scene();
    parent.add(rig.group);
    const geos: THREE.BufferGeometry[] = [];
    let material: THREE.Material | null = null;
    rig.group.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) {
        geos.push((o as THREE.Mesh).geometry);
        material = (o as THREE.Mesh).material as THREE.Material;
      }
    });
    let geoDisposed = 0;
    let matDisposed = 0;
    for (const g of geos) g.addEventListener("dispose", () => geoDisposed++);
    material!.addEventListener("dispose", () => matDisposed++);
    rig.dispose();
    rig.dispose();
    expect(geoDisposed).toBe(geos.length);
    expect(matDisposed).toBe(1);
    expect(parent.children.length).toBe(0);
    expect(rig.group.children.length).toBe(0);
  });
});

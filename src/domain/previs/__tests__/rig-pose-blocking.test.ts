import { describe, expect, it } from "vitest";
import {
  DEFAULT_PROXY_HEIGHT_M,
  blockingFingerprint,
  blockingLayerFingerprint,
  blockingStaleReasons,
  canonicalizeEntry,
  heightForScale,
  newBlockingEntry,
  parseBlockingEntry,
  rootYawDeg,
  scaleForHeight,
  summarizeBlocking,
  yawQuat,
  type ShotBlockingEntry,
} from "../blocking";
import {
  NEUTRAL_POSE,
  POSE_PRESETS,
  canonicalizePose,
  clampJointToLimits,
  headDirection,
  isJointWithinLimits,
  matchingPreset,
  neutralPose,
  parsePose,
  poseFingerprint,
  posesWithinLimits,
  presetById,
  setPoseJoint,
  withHeadDirection,
} from "../pose";
import {
  DEG,
  quatCanonical,
  quatFromAxisAngle,
  quatFromEuler,
  quatMultiply,
  quatNormalize,
  quatRotateVec,
  quatToEuler,
  quatsEqual,
} from "../quat";
import {
  HUMANOID_RIG,
  HUMANOID_RIG_VERSION,
  JOINT_IDS,
  POSE_JOINT_IDS,
  childrenOf,
  jointDef,
  jointFromAlias,
  mixamoAliasOf,
  restPositions,
} from "../rig";
import { buildHotelCanopyShotBlocking, HOTEL_CANOPY_BLOCKING_SHOTS } from "../hotel-canopy";

const ANCHOR = { locationId: "loc-1" };
const entry = (over: Partial<ShotBlockingEntry> = {}): ShotBlockingEntry => ({
  ...newBlockingEntry("char-1", { x: 1, y: 0, z: -2 }),
  ...over,
});

describe("humanoid rig", () => {
  it("has the required unique semantic joints and one root", () => {
    expect(new Set(JOINT_IDS).size).toBe(JOINT_IDS.length);
    for (const j of [
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
    ])
      expect(JOINT_IDS).toContain(j);
    expect(HUMANOID_RIG.filter((j) => j.parent === null).map((j) => j.id)).toEqual(["root"]);
    expect(POSE_JOINT_IDS).not.toContain("root");
  });

  it("is a tree: every joint reaches the root and parents precede children", () => {
    const seen = new Set<string>();
    for (const j of HUMANOID_RIG) {
      if (j.parent) expect(seen.has(j.parent)).toBe(true);
      seen.add(j.id);
    }
    expect(childrenOf("hips")).toEqual(expect.arrayContaining(["spine", "leftUpperLeg", "rightUpperLeg"]));
    expect(childrenOf("chest")).toEqual(expect.arrayContaining(["neck", "leftShoulder", "rightShoulder"]));
  });

  it("maps semantic joints to unique upstream-style aliases and back", () => {
    const aliases = JOINT_IDS.map(mixamoAliasOf);
    expect(new Set(aliases).size).toBe(aliases.length);
    for (const id of JOINT_IDS) {
      expect(jointFromAlias(mixamoAliasOf(id))).toBe(id);
      expect(jointFromAlias(mixamoAliasOf(id).toUpperCase())).toBe(id);
    }
    expect(jointFromAlias("mixamorig:Hips")).toBe("hips");
    expect(jointFromAlias("not-a-bone")).toBeNull();
    // none of the aliases is excluded by the vendored FK blacklist (substring match), so every joint is poseable
    const blacklist = [
      "def",
      "toe_end",
      "thumb",
      "index",
      "handmiddle",
      "handring",
      "pinky",
      "headtop",
      "-ear",
      "teeth",
      "eye",
      "lid",
      "jaw",
      "tongue",
      "lip",
      "chin",
      "brow",
      "cheek",
      "forehead",
      "nose",
      "temple",
    ];
    for (const a of aliases) for (const b of blacklist) expect(a.toLowerCase().includes(b)).toBe(false);
  });

  it("has a neutral rest stance: feet at the ground, head near 1.7 m, left is +X", () => {
    const p = restPositions();
    expect(p.hips.y).toBeCloseTo(0.92, 5);
    expect(p.leftFoot.y).toBeLessThan(0.1);
    expect(p.head.y + 0.1 + 0.11).toBeCloseTo(1.71, 1);
    expect(p.leftUpperArm.x).toBeGreaterThan(0);
    expect(p.rightUpperArm.x).toBeLessThan(0);
    expect(p.leftUpperLeg.x).toBeGreaterThan(0);
  });

  it("propagates a parent rotation to its children (forward kinematics)", () => {
    const rest = restPositions();
    // rotate the left upper arm 90 degrees about Z (abduct): the hand swings from below the shoulder to the side
    const q = quatFromAxisAngle("z", 90 * DEG);
    const forearm = jointDef("leftLowerArm").offset;
    const swung = quatRotateVec(q, forearm);
    expect(swung.x).toBeGreaterThan(0.25);
    expect(Math.abs(swung.y)).toBeLessThan(1e-9);
    expect(rest.leftLowerArm.y).toBeLessThan(rest.leftUpperArm.y);
  });
});

describe("quaternions", () => {
  it("round-trips Euler XYZ and canonicalises the sign", () => {
    const q = quatFromEuler(0.3, -0.4, 0.2);
    const e = quatToEuler(q);
    expect(e.x).toBeCloseTo(0.3, 6);
    expect(e.y).toBeCloseTo(-0.4, 6);
    expect(e.z).toBeCloseTo(0.2, 6);
    const neg = { x: -q.x, y: -q.y, z: -q.z, w: -q.w };
    expect(quatCanonical(neg)).toEqual(quatCanonical(q));
    expect(quatsEqual(neg, q)).toBe(true);
  });
  it("canonicalisation is idempotent", () => {
    const q = quatCanonical(quatFromEuler(0.123456789, 0.987654321, -0.5));
    expect(quatCanonical(q)).toEqual(q);
  });
  it("multiplies composed rotations", () => {
    const q = quatMultiply(quatFromAxisAngle("y", 90 * DEG), quatFromAxisAngle("y", 90 * DEG));
    expect(quatRotateVec(q, { x: 0, y: 0, z: 1 }).z).toBeCloseTo(-1, 6);
    expect(quatNormalize({ x: 0, y: 0, z: 0, w: 0 }).w).toBe(1);
  });
});

describe("pose schema + fingerprint", () => {
  const armBent = setPoseJoint(neutralPose(), "leftLowerArm", quatFromAxisAngle("x", -60 * DEG));

  it("neutral pose is empty and deterministic", () => {
    expect(neutralPose().joints).toEqual({});
    expect(canonicalizePose(undefined)).toEqual(neutralPose());
    expect(poseFingerprint(neutralPose())).toBe(poseFingerprint(NEUTRAL_POSE));
  });
  it("same pose => same fingerprint; q and -q => same fingerprint", () => {
    const q = quatFromAxisAngle("x", -60 * DEG);
    const neg = { x: -q.x, y: -q.y, z: -q.z, w: -q.w };
    expect(poseFingerprint(setPoseJoint(neutralPose(), "leftLowerArm", q))).toBe(poseFingerprint(armBent));
    expect(poseFingerprint(setPoseJoint(neutralPose(), "leftLowerArm", neg))).toBe(poseFingerprint(armBent));
  });
  it("joint insertion order does not change the fingerprint", () => {
    const a = canonicalizePose({
      joints: { head: quatFromEuler(0, 0.3, 0), leftHand: quatFromEuler(0.1, 0, 0) },
    });
    const b = canonicalizePose({
      joints: { leftHand: quatFromEuler(0.1, 0, 0), head: quatFromEuler(0, 0.3, 0) },
    });
    expect(poseFingerprint(a)).toBe(poseFingerprint(b));
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
  it("a joint rotation changes the fingerprint; setting a joint back to neutral restores it", () => {
    expect(poseFingerprint(armBent)).not.toBe(poseFingerprint(neutralPose()));
    const back = setPoseJoint(armBent, "leftLowerArm", { x: 0, y: 0, z: 0, w: 1 });
    expect(poseFingerprint(back)).toBe(poseFingerprint(neutralPose()));
  });
  it("a preset changes the fingerprint and the rig version is part of it", () => {
    expect(poseFingerprint(presetById("seated").pose)).not.toBe(poseFingerprint(neutralPose()));
    const other = { ...neutralPose(), rig: "prism.humanoid-rig.v2" } as unknown as ReturnType<
      typeof neutralPose
    >;
    expect(poseFingerprint(other)).not.toBe(poseFingerprint(neutralPose()));
  });
  it("ignores numeric noise below the rounding step", () => {
    const q = quatFromAxisAngle("x", -60 * DEG);
    const noisy = { x: q.x + 1e-9, y: q.y - 1e-9, z: q.z, w: q.w };
    expect(poseFingerprint(setPoseJoint(neutralPose(), "leftLowerArm", noisy))).toBe(
      poseFingerprint(armBent),
    );
  });
  it("serialises and parses back to the same canonical pose; rejects root and unknown joints", () => {
    const p = presetById("walk_a").pose;
    expect(parsePose(JSON.parse(JSON.stringify(p)))).toEqual(p);
    expect(() =>
      parsePose({
        schema: "prism.pose.v1",
        rig: HUMANOID_RIG_VERSION,
        joints: { tail: { x: 0, y: 0, z: 0, w: 1 } },
      }),
    ).toThrow();
    expect(() =>
      parsePose({
        schema: "prism.pose.v1",
        rig: HUMANOID_RIG_VERSION,
        joints: { root: { x: 0, y: 1, z: 0, w: 0 } },
      }),
    ).toThrow();
    expect(() => parsePose({ schema: "other", rig: HUMANOID_RIG_VERSION, joints: {} })).toThrow();
  });
});

describe("joint limits", () => {
  it("elbows and knees only fold the right way", () => {
    const backwardsElbow = quatFromAxisAngle("x", 90 * DEG);
    const fixed = clampJointToLimits("leftLowerArm", backwardsElbow);
    expect(quatToEuler(fixed).x / DEG).toBeCloseTo(0, 3);
    const backwardsKnee = quatFromAxisAngle("x", -90 * DEG);
    expect(quatToEuler(clampJointToLimits("rightLowerLeg", backwardsKnee)).x / DEG).toBeCloseTo(0, 3);
    expect(isJointWithinLimits("leftLowerArm", quatFromAxisAngle("x", -90 * DEG))).toBe(true);
    expect(isJointWithinLimits("leftLowerArm", quatFromAxisAngle("x", 30 * DEG))).toBe(false);
    expect(isJointWithinLimits("leftLowerLeg", quatFromAxisAngle("x", 90 * DEG))).toBe(true);
  });
  it("a hinge cannot twist", () => {
    const twisted = quatFromEuler(-60 * DEG, 40 * DEG, 30 * DEG);
    const e = quatToEuler(clampJointToLimits("leftLowerArm", twisted));
    expect(e.y).toBeCloseTo(0, 6);
    expect(e.z).toBeCloseTo(0, 6);
  });
  it("clamps an over-rotated head and leaves in-range rotations alone", () => {
    const wild = quatFromEuler(0, 170 * DEG, 0);
    expect(Math.abs(quatToEuler(clampJointToLimits("head", wild)).y / DEG)).toBeLessThanOrEqual(50.01);
    const fine = quatFromEuler(0, 20 * DEG, 0);
    expect(quatsEqual(clampJointToLimits("head", fine), fine)).toBe(true);
  });
  it("every preset stays inside the limits", () => {
    for (const p of POSE_PRESETS) expect(posesWithinLimits(p.pose), p.id).toBe(true);
  });
});

describe("presets", () => {
  it("has the required set and is deterministic", () => {
    expect(POSE_PRESETS.map((p) => p.id)).toEqual([
      "neutral_stand",
      "seated",
      "walk_a",
      "walk_b",
      "hands_on_hips",
    ]);
    expect(presetById("neutral_stand").pose.joints).toEqual({});
    expect(poseFingerprint(presetById("walk_a").pose)).toBe(poseFingerprint(presetById("walk_a").pose));
    const fps = POSE_PRESETS.map((p) => poseFingerprint(p.pose));
    expect(new Set(fps).size).toBe(fps.length);
  });
  it("only seated moves the root, by a documented offset", () => {
    for (const p of POSE_PRESETS) expect(p.rootYOffsetM === 0, p.id).toBe(p.id !== "seated");
    expect(presetById("seated").rootYOffsetM).toBeLessThan(0);
  });
  it("walks are mirror images and matchingPreset recognises an untouched preset", () => {
    const a = presetById("walk_a").pose.joints;
    const b = presetById("walk_b").pose.joints;
    expect(quatsEqual(a.leftUpperLeg!, b.rightUpperLeg!)).toBe(true);
    expect(matchingPreset(presetById("seated").pose)?.id).toBe("seated");
    expect(
      matchingPreset(setPoseJoint(presetById("seated").pose, "head", quatFromEuler(0, 0.3, 0))),
    ).toBeNull();
  });
  it("the seated figure's ankles land on the ground when the root drops by the offset", () => {
    const p = presetById("seated");
    const hipsY = 0.92 + p.rootYOffsetM;
    const thigh = quatRotateVec(p.pose.joints.leftUpperLeg!, { x: 0, y: -0.42, z: 0 });
    const kneeY = hipsY - 0.05 + thigh.y;
    const shin = quatRotateVec(quatMultiply(p.pose.joints.leftUpperLeg!, p.pose.joints.leftLowerLeg!), {
      x: 0,
      y: -0.42,
      z: 0,
    });
    expect(kneeY + shin.y).toBeCloseTo(0.03, 2);
  });
});

describe("head direction", () => {
  it("round-trips yaw and pitch and respects limits", () => {
    const p = withHeadDirection(neutralPose(), 30, 10);
    const d = headDirection(p);
    expect(d.yawDeg).toBeCloseTo(30, 0);
    expect(d.pitchDeg).toBeCloseTo(10, 0);
    expect(Object.keys(p.joints).sort()).toEqual(["head", "neck"]);
    const extreme = headDirection(withHeadDirection(neutralPose(), 170, 0));
    expect(extreme.yawDeg).toBeLessThanOrEqual(105);
  });
  it("is a pose edit: it does not touch the root", () => {
    const e = entry();
    const turned = { ...e, pose: withHeadDirection(e.pose, 40, 0) };
    expect(turned.root).toEqual(e.root);
  });
});

describe("blocking: root vs pose", () => {
  it("yaw is a root edit and is exposed as degrees; the quaternion is authoritative", () => {
    const r = { ...entry().root, orientation: yawQuat(25) };
    expect(rootYawDeg(r)).toBeCloseTo(25, 1);
    expect(rootYawDeg({ orientation: yawQuat(-135) })).toBeCloseTo(-135, 1);
  });
  it("height maps to a uniform scale of the 1.70 m reference figure", () => {
    expect(scaleForHeight(DEFAULT_PROXY_HEIGHT_M)).toBe(1);
    expect(heightForScale(scaleForHeight(1.85))).toBeCloseTo(1.85, 4);
  });
  it("canonicalises: rounding, quaternion sign, neutral joints dropped", () => {
    const e = canonicalizeEntry({
      characterId: "c",
      root: {
        position: { x: 1.000001, y: -0, z: 2 },
        orientation: { x: 0, y: -0.5, z: 0, w: -0.8660254 },
        scale: 1,
      },
      pose: canonicalizePose({ joints: { head: { x: 0, y: 0, z: 0, w: -1 } } }),
    });
    expect(e.root.position).toEqual({ x: 1, y: 0, z: 2 });
    expect(e.root.orientation.w).toBeGreaterThan(0);
    expect(e.pose.joints).toEqual({});
    expect(parseBlockingEntry(JSON.parse(JSON.stringify(e)))).toEqual(e);
  });
});

describe("blocking fingerprint", () => {
  const base = entry();
  const fp = (e: ShotBlockingEntry, a = ANCHOR) => blockingFingerprint(e, a);

  it("is stable for identical blocking and quaternion sign", () => {
    expect(fp(entry())).toBe(fp(base));
    const o = base.root.orientation;
    const flipped = { ...base, root: { ...base.root, orientation: { x: -o.x, y: -o.y, z: -o.z, w: -o.w } } };
    expect(fp(flipped)).toBe(fp(base));
  });
  it("changes with root position, body orientation, scale, pose, character and visibility", () => {
    const moved = {
      ...base,
      root: { ...base.root, position: { ...base.root.position, x: base.root.position.x + 0.5 } },
    };
    const turned = { ...base, root: { ...base.root, orientation: yawQuat(40) } };
    const taller = { ...base, root: { ...base.root, scale: 1.1 } };
    const posed = { ...base, pose: presetById("seated").pose };
    const other = { ...base, characterId: "char-2" };
    const hidden = { ...base, visibility: false };
    const all = [base, moved, turned, taller, posed, other, hidden].map((e) => fp(e));
    expect(new Set(all).size).toBe(all.length);
  });
  it("changes with the Location the blocking is anchored to", () => {
    expect(fp(base, { locationId: "loc-2" })).not.toBe(fp(base));
  });
  it("ignores sub-rounding noise and anything that is not blocking", () => {
    const noisy = {
      ...base,
      root: { ...base.root, position: { ...base.root.position, x: base.root.position.x + 1e-7 } },
    };
    expect(fp(noisy)).toBe(fp(base));
    // selected bone / gizmo mode / camera / timeline / helper visibility are not inputs: extra keys are ignored
    const withUi = {
      ...base,
      selectedJoint: "head",
      gizmoMode: "rotate",
      orbit: [1, 2, 3],
      showSkeleton: true,
    } as unknown as ShotBlockingEntry;
    expect(fp(withUi)).toBe(fp(base));
  });
  it("the layer fingerprint is order-independent, null when empty, and per-figure sensitive", () => {
    const a = entry({ characterId: "a" });
    const b = entry({ characterId: "b" });
    expect(blockingLayerFingerprint([], ANCHOR)).toBeNull();
    expect(blockingLayerFingerprint([a, b], ANCHOR)).toBe(blockingLayerFingerprint([b, a], ANCHOR));
    expect(blockingLayerFingerprint([a, b], ANCHOR)).not.toBe(blockingLayerFingerprint([a], ANCHOR));
    expect(blockingLayerFingerprint([a, { ...b, pose: presetById("walk_a").pose }], ANCHOR)).not.toBe(
      blockingLayerFingerprint([a, b], ANCHOR),
    );
  });
});

describe("blocking staleness", () => {
  it("is stale only when the Set fingerprint moved", () => {
    expect(blockingStaleReasons({ sceneFingerprint: "a" }, { sceneFingerprint: "a" })).toEqual([]);
    expect(blockingStaleReasons({ sceneFingerprint: "a" }, { sceneFingerprint: "b" })).toEqual(["scene"]);
  });
});

describe("blocking summary", () => {
  it("is deterministic and conservative (no emotion)", () => {
    const e = canonicalizeEntry({
      characterId: "c",
      root: { position: { x: -1.2, y: 0, z: 2.4 }, orientation: yawQuat(0), scale: 1 },
      pose: canonicalizePose({
        joints: {
          ...withHeadDirection(neutralPose(), 20, 0).joints,
          leftLowerArm: quatFromAxisAngle("x", -80 * DEG),
        },
      }),
    });
    const s = summarizeBlocking(e, "Yumeko");
    expect(s).toBe(summarizeBlocking(e, "Yumeko"));
    expect(s).toContain("Yumeko: standing at (-1.2, 0.0, 2.4)");
    expect(s).toContain("facing +Z");
    expect(s).toContain("head turned 20° to the figure's left");
    expect(s).toContain("left elbow bent 80°");
    expect(s).toContain("right arm relaxed");
    expect(s).not.toMatch(/angry|sad|happy|tense|nervous|confident/i);
  });
  it("recognises a seated figure", () => {
    const e = { ...newBlockingEntry("c"), pose: presetById("seated").pose };
    expect(summarizeBlocking(e, "Sean")).toContain("seated");
  });
});

describe("Hotel Canopy shot blocking fixture", () => {
  it("blocks Yumeko near the doorway and Sean near the vehicle in Shot 3A, facing each other", () => {
    const fx = buildHotelCanopyShotBlocking({ yumekoId: "y", seanId: "s" });
    const yumeko = fx.find((e) => e.characterId === "y")!;
    const sean = fx.find((e) => e.characterId === "s")!;
    expect(HOTEL_CANOPY_BLOCKING_SHOTS).toContain("3A");
    expect(yumeko.root.position.z).toBeLessThan(-3.5); // near the door opening (z = -5.75)
    expect(sean.root.position.x).toBeGreaterThan(2); // near the vehicle block (x = 4.2)
    expect(headDirection(yumeko.pose).yawDeg).not.toBe(0);
    // each faces roughly toward the other
    const toSean = {
      x: sean.root.position.x - yumeko.root.position.x,
      z: sean.root.position.z - yumeko.root.position.z,
    };
    const facing = quatRotateVec(yumeko.root.orientation, { x: 0, y: 0, z: 1 });
    const dot = (facing.x * toSean.x + facing.z * toSean.z) / Math.hypot(toSean.x, toSean.z);
    expect(dot).toBeGreaterThan(0.9);
    const seanFacing = quatRotateVec(sean.root.orientation, { x: 0, y: 0, z: 1 });
    expect(seanFacing.x * -toSean.x + seanFacing.z * -toSean.z).toBeGreaterThan(0);
    expect(posesWithinLimits(yumeko.pose) && posesWithinLimits(sean.pose)).toBe(true);
  });
});

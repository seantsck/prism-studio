import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { focalLengthToFovDegrees } from "../camera";
import {
  applyEasing,
  cameraPathFingerprint,
  emptyCameraPath,
  evaluateCameraPath,
  eulerToQuaternion,
  keyframeFromCamera,
  quaternionToEuler,
  removeKeyframe,
  sampleFrameTimes,
  slerpQuaternion,
  upsertKeyframe,
  validateCameraPath,
  type CameraPath,
} from "../camera-path";

const deg = (d: number) => (d * Math.PI) / 180;
const qy = (d: number) => eulerToQuaternion({ x: 0, y: deg(d), z: 0 });
const neg = (q: { x: number; y: number; z: number; w: number }) => ({ x: -q.x, y: -q.y, z: -q.z, w: -q.w });
const angleBetween = (a: ReturnType<typeof qy>, b: ReturnType<typeof qy>) => {
  const dot = Math.abs(a.x * b.x + a.y * b.y + a.z * b.z + a.w * b.w);
  return (2 * Math.acos(Math.min(1, dot)) * 180) / Math.PI;
};

const cam = (x: number, z: number, yawDeg: number, f: number) => ({
  position: { x, y: 1.6, z },
  rotation: { x: 0, y: deg(yawDeg), z: 0 },
  focalLengthMm: f,
});

function threeKey(interp: "linear" | "smooth" = "linear"): CameraPath {
  let p: CameraPath = { ...emptyCameraPath(4000, 24), interpolation: interp };
  p = upsertKeyframe(p, keyframeFromCamera("k1", 0, cam(0, 8, 0, 35), "linear"));
  p = upsertKeyframe(p, keyframeFromCamera("k2", 2000, cam(2, 4, 20, 50), "linear"));
  p = upsertKeyframe(p, keyframeFromCamera("k3", 4000, cam(2, 1, 40, 70), "linear"));
  return p;
}

describe("slerp", () => {
  it("0° → 90° at the midpoint is 45°, normalised", () => {
    const m = slerpQuaternion(qy(0), qy(90), 0.5);
    expect(angleBetween(m, qy(45))).toBeLessThan(1e-6);
    expect(Math.hypot(m.x, m.y, m.z, m.w)).toBeCloseTo(1, 10);
  });
  it("350° → 10° takes the 20° short way, not the 340° long way", () => {
    expect(angleBetween(slerpQuaternion(qy(350), qy(10), 0.5), qy(0))).toBeLessThan(1e-6);
    expect(angleBetween(slerpQuaternion(qy(350), qy(10), 0.25), qy(355))).toBeLessThan(1e-6);
  });
  it("handles the negated (same-rotation) representation without spinning", () => {
    const a = qy(30);
    expect(angleBetween(slerpQuaternion(a, neg(a), 0.5), a)).toBeLessThan(1e-6);
    expect(angleBetween(slerpQuaternion(qy(0), neg(qy(60)), 0.5), qy(30))).toBeLessThan(1e-6);
  });
  it("identical orientations stay identical", () => {
    const q = eulerToQuaternion({ x: 0.3, y: -1.1, z: 0.7 });
    expect(angleBetween(slerpQuaternion(q, q, 0.37), q)).toBeLessThan(1e-6);
  });
  it("large multi-axis rotations stay on the geodesic (constant angular speed)", () => {
    const a = eulerToQuaternion({ x: 0.2, y: 2.9, z: -1.2 });
    const b = eulerToQuaternion({ x: -2.5, y: 0.4, z: 1.9 });
    const total = angleBetween(a, b);
    const h = slerpQuaternion(a, b, 0.5);
    expect(angleBetween(a, h)).toBeCloseTo(total / 2, 4);
    expect(angleBetween(h, b)).toBeCloseTo(total / 2, 4);
  });
  it("does not mutate its inputs", () => {
    const a = qy(10);
    const b = qy(100);
    const ca = { ...a };
    const cb = { ...b };
    slerpQuaternion(a, b, 0.5);
    expect(a).toEqual(ca);
    expect(b).toEqual(cb);
  });
  it("Euler and quaternion round-trip", () => {
    const r = { x: 0.1, y: -0.4, z: 0.25 };
    const back = quaternionToEuler(eulerToQuaternion(r));
    expect(back.x).toBeCloseTo(r.x, 6);
    expect(back.y).toBeCloseTo(r.y, 6);
    expect(back.z).toBeCloseTo(r.z, 6);
  });
});

describe("easing", () => {
  it("is anchored at 0 and 1 and ordered for the curved modes", () => {
    for (const e of ["linear", "ease_in", "ease_out", "ease_in_out"] as const) {
      expect(applyEasing(0, e)).toBe(0);
      expect(applyEasing(1, e)).toBe(1);
    }
    expect(applyEasing(0.25, "ease_in")).toBeLessThan(0.25);
    expect(applyEasing(0.25, "ease_out")).toBeGreaterThan(0.25);
    expect(applyEasing(0.5, "ease_in_out")).toBeCloseTo(0.5, 10);
    expect(applyEasing(0.25, "ease_in_out")).toBeLessThan(0.25);
    expect(applyEasing(0.9, "hold")).toBe(0);
  });
});

describe("evaluateCameraPath", () => {
  const path = threeKey("linear");
  it("returns exact keyframe values at keyframe times", () => {
    const s = evaluateCameraPath(path, 2000)!;
    expect(s.position).toEqual({ x: 2, y: 1.6, z: 4 });
    expect(s.focalLengthMm).toBe(50);
    expect(s.fovVerticalDegrees).toBeCloseTo(focalLengthToFovDegrees(50), 10);
  });
  it("clamps before the first and after the last keyframe", () => {
    expect(evaluateCameraPath(path, -500)!.focalLengthMm).toBe(35);
    expect(evaluateCameraPath(path, 99999)!.focalLengthMm).toBe(70);
  });
  it("interpolates position linearly and the lens in mm (not FOV)", () => {
    const s = evaluateCameraPath(path, 1000)!;
    expect(s.position.x).toBeCloseTo(1, 10);
    expect(s.position.z).toBeCloseTo(6, 10);
    expect(s.focalLengthMm).toBeCloseTo(42.5, 10);
    const avgFov = (focalLengthToFovDegrees(35) + focalLengthToFovDegrees(50)) / 2;
    expect(s.fovVerticalDegrees).not.toBeCloseTo(avgFov, 3);
    expect(s.fovVerticalDegrees).toBeCloseTo(focalLengthToFovDegrees(42.5), 10);
  });
  it("the smooth path passes through every keyframe and differs from linear between them", () => {
    const smooth = threeKey("smooth");
    for (const [t, x, z] of [
      [0, 0, 8],
      [2000, 2, 4],
      [4000, 2, 1],
    ] as const) {
      const s = evaluateCameraPath(smooth, t)!;
      expect(s.position.x).toBeCloseTo(x, 8);
      expect(s.position.z).toBeCloseTo(z, 8);
    }
    const a = evaluateCameraPath(smooth, 1000)!.position;
    const b = evaluateCameraPath(path, 1000)!.position;
    expect(Math.hypot(a.x - b.x, a.z - b.z)).toBeGreaterThan(0.01);
  });
  it("hold keeps the previous keyframe until the next one", () => {
    const p = upsertKeyframe(threeKey("linear"), { ...threeKey().keyframes[0], easing: "hold" });
    const s = evaluateCameraPath(p, 1999)!;
    expect(s.position).toEqual({ x: 0, y: 1.6, z: 8 });
    expect(s.focalLengthMm).toBe(35);
    expect(evaluateCameraPath(p, 2000)!.focalLengthMm).toBe(50);
  });
  it("ease-in lags and ease-out leads a linear segment", () => {
    const at = (easing: "ease_in" | "ease_out" | "linear") =>
      evaluateCameraPath(upsertKeyframe(path, { ...path.keyframes[0], easing }), 500)!.focalLengthMm;
    expect(at("ease_in")).toBeLessThan(at("linear"));
    expect(at("ease_out")).toBeGreaterThan(at("linear"));
  });
  it("orientation never flips across a wrap (350° → 10°)", () => {
    let p = emptyCameraPath(1000, 24);
    p = upsertKeyframe(p, keyframeFromCamera("a", 0, cam(0, 0, 350, 35), "linear"));
    p = upsertKeyframe(p, keyframeFromCamera("b", 1000, cam(0, 0, 10, 35), "linear"));
    let prev = evaluateCameraPath(p, 0)!.quaternion;
    for (let t = 50; t <= 1000; t += 50) {
      const q = evaluateCameraPath(p, t)!.quaternion;
      expect(angleBetween(prev, q)).toBeLessThan(1.2); // 20° over 20 steps = 1° per step, never a 340° jump
      prev = q;
    }
  });
  it("is deterministic and does not mutate the path", () => {
    const copy = JSON.stringify(path);
    expect(evaluateCameraPath(path, 1234)).toEqual(evaluateCameraPath(path, 1234));
    expect(JSON.stringify(path)).toBe(copy);
  });
  it("returns null for an empty path", () => {
    expect(evaluateCameraPath(emptyCameraPath(1000, 24), 0)).toBeNull();
  });
  it("agrees with an independent three.js quaternion slerp", () => {
    const s = evaluateCameraPath(path, 1000)!.quaternion;
    const a = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, 0, 0));
    const b = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, deg(20), 0));
    const m = a.clone().slerp(b, 0.5);
    expect(Math.abs(s.x * m.x + s.y * m.y + s.z * m.z + s.w * m.w)).toBeCloseTo(1, 8);
  });
});

describe("validation and editing", () => {
  it("rejects a second keyframe at the same time", () => {
    expect(() => upsertKeyframe(threeKey(), keyframeFromCamera("dup", 2000, cam(0, 0, 0, 35)))).toThrow(
      /already a keyframe/,
    );
  });
  it("keyframes sort deterministically by time", () => {
    let p = emptyCameraPath(3000, 24);
    p = upsertKeyframe(p, keyframeFromCamera("c", 3000, cam(0, 0, 0, 35)));
    p = upsertKeyframe(p, keyframeFromCamera("a", 0, cam(0, 0, 0, 35)));
    p = upsertKeyframe(p, keyframeFromCamera("b", 1000, cam(0, 0, 0, 35)));
    expect(p.keyframes.map((k) => k.id)).toEqual(["a", "b", "c"]);
  });
  it("flags keyframes after the end and zero quaternions", () => {
    const p = threeKey();
    expect(validateCameraPath(p)).toEqual([]);
    expect(validateCameraPath({ ...p, durationMs: 3000 }).join()).toMatch(/after the end/);
    const zero = {
      ...p,
      keyframes: [
        { ...p.keyframes[0], orientation: { quaternion: { x: 0, y: 0, z: 0, w: 0 } } },
        ...p.keyframes.slice(1),
      ],
    };
    expect(validateCameraPath(zero).join()).toMatch(/zero quaternion/);
  });
  it("removeKeyframe returns a new path", () => {
    const p = threeKey();
    const q = removeKeyframe(p, "k2");
    expect(p.keyframes).toHaveLength(3);
    expect(q.keyframes).toHaveLength(2);
  });
});

describe("cameraPathFingerprint", () => {
  const base = threeKey();
  const fp = cameraPathFingerprint(base);
  it("is stable for the same path and independent of keyframe array order", () => {
    expect(cameraPathFingerprint(JSON.parse(JSON.stringify(base)))).toBe(fp);
    expect(cameraPathFingerprint({ ...base, keyframes: [...base.keyframes].reverse() })).toBe(fp);
  });
  it("ignores quaternion sign (q and −q are one rotation)", () => {
    const k = base.keyframes[1];
    const flipped = {
      ...base,
      keyframes: base.keyframes.map((x) =>
        x.id === k.id ? { ...x, orientation: { quaternion: neg(k.orientation.quaternion) } } : x,
      ),
    };
    expect(cameraPathFingerprint(flipped)).toBe(fp);
  });
  it("changes for every motion-relevant edit", () => {
    const edits: CameraPath[] = [
      removeKeyframe(base, "k2"),
      upsertKeyframe(base, keyframeFromCamera("k4", 3000, cam(0, 0, 0, 35))),
      upsertKeyframe(base, { ...base.keyframes[1], timeMs: 2500 }),
      upsertKeyframe(base, { ...base.keyframes[1], position: { x: 2.5, y: 1.6, z: 4 } }),
      upsertKeyframe(base, { ...base.keyframes[1], orientation: { quaternion: qy(25) } }),
      upsertKeyframe(base, { ...base.keyframes[1], focalLengthMm: 55 }),
      upsertKeyframe(base, { ...base.keyframes[1], easing: "ease_out" }),
      { ...base, durationMs: 5000 },
      { ...base, interpolation: "smooth" },
      { ...base, frameRate: 30 },
    ];
    const seen = new Set([fp]);
    for (const e of edits) seen.add(cameraPathFingerprint(e));
    expect(seen.size).toBe(edits.length + 1);
  });
});

describe("sampleFrameTimes", () => {
  it("samples n/frameRate deterministically", () => {
    const t = sampleFrameTimes(4000, 24);
    expect(t).toHaveLength(96);
    expect(t[0]).toBe(0);
    expect(t[24]).toBe(1000);
    expect(t[95]).toBe(Math.round((95 * 1000) / 24));
    expect(sampleFrameTimes(4000, 24)).toEqual(t);
  });
});

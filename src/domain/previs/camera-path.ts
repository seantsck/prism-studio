import * as THREE from "three";
import { z } from "zod";
import { fingerprint } from "../hash";
import { focalLengthToFovDegrees } from "./camera";
import { vec3Schema, type Vec3 } from "./types";

/**
 * Prism-owned camera motion for a Shot: time-varying production-camera state.
 *
 * EDITOR CAMERA != PRODUCTION CAMERA != CAMERA PATH. A path is built only from production-camera poses; the
 * editor/navigation camera never appears in it.
 *
 * Orientation is a unit quaternion (interpolated by shortest-arc slerp). Euler angles are an editor-facing view only.
 * Focal length (mm, on the 24 mm vertical-sensor basis) is the authored lens; FOV is derived at render time.
 */

export const CAMERA_PATH_SCHEMA = "prism.camera-path.v1" as const;
export const CAMERA_PATH_FOCAL_BASIS = "vertical-sensor-24mm" as const;

export const CAMERA_EASINGS = ["linear", "ease_in", "ease_out", "ease_in_out", "hold"] as const;
export type CameraEasing = (typeof CAMERA_EASINGS)[number];
export const CAMERA_INTERPOLATIONS = ["linear", "smooth"] as const;
export type CameraInterpolation = (typeof CAMERA_INTERPOLATIONS)[number];

const num = z.number().finite();
export const quaternionSchema = z.object({ x: num, y: num, z: num, w: num });
export type QuaternionValue = z.infer<typeof quaternionSchema>;

export const cameraKeyframeSchema = z.object({
  id: z.string().min(1).max(64),
  timeMs: z.number().int().min(0),
  position: vec3Schema,
  orientation: z.object({ quaternion: quaternionSchema }),
  focalLengthMm: num.min(1).max(1000),
  focalLengthBasis: z.literal(CAMERA_PATH_FOCAL_BASIS),
  /** shapes the segment that STARTS at this keyframe */
  easing: z.enum(CAMERA_EASINGS),
});
export type CameraKeyframe = z.infer<typeof cameraKeyframeSchema>;

export const cameraPathSchema = z.object({
  schema: z.literal(CAMERA_PATH_SCHEMA),
  durationMs: z.number().int().positive(),
  frameRate: z.number().positive().max(120),
  interpolation: z.enum(CAMERA_INTERPOLATIONS),
  keyframes: z.array(cameraKeyframeSchema),
});
export type CameraPath = z.infer<typeof cameraPathSchema>;

export interface CameraState {
  position: Vec3;
  quaternion: QuaternionValue;
  focalLengthMm: number;
  fovVerticalDegrees: number;
}

// ── helpers ────────────────────────────────────────────────────────────────

const toQ = (q: QuaternionValue) => new THREE.Quaternion(q.x, q.y, q.z, q.w).normalize();
const fromQ = (q: THREE.Quaternion): QuaternionValue => ({ x: q.x, y: q.y, z: q.z, w: q.w });

/** Euler XYZ radians (the engine's convention) → unit quaternion. */
export function eulerToQuaternion(r: Vec3): QuaternionValue {
  return fromQ(new THREE.Quaternion().setFromEuler(new THREE.Euler(r.x, r.y, r.z, "XYZ")));
}
/** Unit quaternion → Euler XYZ radians, for editor display and for the engine's camera object. */
export function quaternionToEuler(q: QuaternionValue): Vec3 {
  const e = new THREE.Euler().setFromQuaternion(toQ(q), "XYZ");
  return { x: e.x, y: e.y, z: e.z };
}

export function applyEasing(u: number, easing: CameraEasing): number {
  const t = Math.min(1, Math.max(0, u));
  switch (easing) {
    case "linear":
      return t;
    case "ease_in":
      return t * t;
    case "ease_out":
      return 1 - (1 - t) * (1 - t);
    case "ease_in_out":
      return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
    case "hold":
      return 0;
  }
}

/** Shortest-arc, normalised slerp that never mutates its inputs. */
export function slerpQuaternion(a: QuaternionValue, b: QuaternionValue, t: number): QuaternionValue {
  const qa = toQ(a);
  const qb = toQ(b);
  if (qa.dot(qb) < 0) qb.set(-qb.x, -qb.y, -qb.z, -qb.w); // take the short way round
  return fromQ(qa.slerp(qb, t).normalize());
}

export function sortedKeyframes(path: Pick<CameraPath, "keyframes">): CameraKeyframe[] {
  return [...path.keyframes].sort((a, b) => a.timeMs - b.timeMs || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** Human-facing reasons a path is not usable. Empty = valid. */
export function validateCameraPath(path: CameraPath): string[] {
  const problems: string[] = [];
  const parsed = cameraPathSchema.safeParse(path);
  if (!parsed.success) return parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
  const ids = new Set<string>();
  const times = new Set<number>();
  for (const k of path.keyframes) {
    if (ids.has(k.id)) problems.push(`duplicate keyframe id ${k.id}`);
    ids.add(k.id);
    if (times.has(k.timeMs)) problems.push(`two keyframes at ${k.timeMs} ms`);
    times.add(k.timeMs);
    if (k.timeMs > path.durationMs)
      problems.push(`keyframe ${k.id} is after the end (${path.durationMs} ms)`);
    const len = Math.hypot(
      k.orientation.quaternion.x,
      k.orientation.quaternion.y,
      k.orientation.quaternion.z,
      k.orientation.quaternion.w,
    );
    if (len < 1e-6) problems.push(`keyframe ${k.id} has a zero quaternion`);
  }
  return problems;
}

function smoothCurve(keys: CameraKeyframe[]): THREE.CatmullRomCurve3 {
  return new THREE.CatmullRomCurve3(
    keys.map((k) => new THREE.Vector3(k.position.x, k.position.y, k.position.z)),
    false,
    "catmullrom",
    0.5,
  );
}

const stateOf = (k: CameraKeyframe): CameraState => ({
  position: { ...k.position },
  quaternion: fromQ(toQ(k.orientation.quaternion)),
  focalLengthMm: k.focalLengthMm,
  fovVerticalDegrees: focalLengthToFovDegrees(k.focalLengthMm),
});

/**
 * THE evaluator. Timeline scrubbing, interactive playback, local previs rendering and any future provider camera
 * metadata all call this one function; there is no second interpolation implementation.
 *
 * Before the first keyframe → first keyframe; after the last → last. Pure and deterministic.
 */
export function evaluateCameraPath(path: CameraPath, timeMs: number): CameraState | null {
  const keys = sortedKeyframes(path);
  if (keys.length === 0) return null;
  const first = keys[0];
  const last = keys[keys.length - 1];
  if (timeMs <= first.timeMs) return stateOf(first);
  if (timeMs >= last.timeMs) return stateOf(last);

  let i = 0;
  while (i < keys.length - 2 && timeMs >= keys[i + 1].timeMs) i++;
  const a = keys[i];
  const b = keys[i + 1];
  const u = (timeMs - a.timeMs) / (b.timeMs - a.timeMs);
  const e = applyEasing(u, a.easing);

  let position: Vec3;
  if (a.easing === "hold") {
    position = { ...a.position };
  } else if (path.interpolation === "smooth") {
    const p = smoothCurve(keys).getPoint((i + e) / (keys.length - 1));
    position = { x: p.x, y: p.y, z: p.z };
  } else {
    position = {
      x: a.position.x + (b.position.x - a.position.x) * e,
      y: a.position.y + (b.position.y - a.position.y) * e,
      z: a.position.z + (b.position.z - a.position.z) * e,
    };
  }
  const focalLengthMm = a.focalLengthMm + (b.focalLengthMm - a.focalLengthMm) * e;
  return {
    position,
    quaternion: slerpQuaternion(a.orientation.quaternion, b.orientation.quaternion, e),
    focalLengthMm,
    fovVerticalDegrees: focalLengthToFovDegrees(focalLengthMm),
  };
}

// ── fingerprint ────────────────────────────────────────────────────────────

const r5 = (n: number) => Math.round(n * 1e5) / 1e5;

/**
 * Covers everything that changes the motion: keyframes (time, pose, lens, easing), duration, rate, interpolation.
 * Quaternions are sign-normalised first (q and −q are one rotation). Playhead, selection, zoom and the editor
 * camera are not part of a path, so they cannot appear here.
 */
export function cameraPathFingerprint(path: CameraPath): string {
  return fingerprint({
    schema: path.schema,
    durationMs: path.durationMs,
    frameRate: r5(path.frameRate),
    interpolation: path.interpolation,
    keyframes: sortedKeyframes(path).map((k) => {
      const q = toQ(k.orientation.quaternion);
      const flip = q.w < 0 || (q.w === 0 && (q.x < 0 || (q.x === 0 && (q.y < 0 || (q.y === 0 && q.z < 0)))));
      const s = flip ? -1 : 1;
      return {
        id: k.id,
        timeMs: k.timeMs,
        position: { x: r5(k.position.x), y: r5(k.position.y), z: r5(k.position.z) },
        quaternion: { x: r5(q.x * s) + 0, y: r5(q.y * s) + 0, z: r5(q.z * s) + 0, w: r5(q.w * s) + 0 },
        focalLengthMm: r5(k.focalLengthMm),
        easing: k.easing,
      };
    }),
  });
}

// ── frame sampling (separate from rendering and encoding) ──────────────────

/** Deterministic frame times for a path: frame n is sampled at n / frameRate, including the final instant. */
export function sampleFrameTimes(durationMs: number, frameRate: number): number[] {
  const count = Math.max(1, Math.round((durationMs / 1000) * frameRate));
  return Array.from({ length: count }, (_, n) => Math.min(durationMs, Math.round((n * 1000) / frameRate)));
}

// ── editing helpers (pure) ─────────────────────────────────────────────────

export function emptyCameraPath(durationMs: number, frameRate: number): CameraPath {
  return { schema: CAMERA_PATH_SCHEMA, durationMs, frameRate, interpolation: "smooth", keyframes: [] };
}

export function keyframeFromCamera(
  id: string,
  timeMs: number,
  camera: { position: Vec3; rotation: Vec3; focalLengthMm: number },
  easing: CameraEasing = "ease_in_out",
): CameraKeyframe {
  return {
    id,
    timeMs: Math.round(timeMs),
    position: { ...camera.position },
    orientation: { quaternion: eulerToQuaternion(camera.rotation) },
    focalLengthMm: camera.focalLengthMm,
    focalLengthBasis: CAMERA_PATH_FOCAL_BASIS,
    easing,
  };
}

/** Insert or replace by id; rejects a second keyframe at an occupied time. Returns a new path. */
export function upsertKeyframe(path: CameraPath, key: CameraKeyframe): CameraPath {
  const others = path.keyframes.filter((k) => k.id !== key.id);
  if (others.some((k) => k.timeMs === key.timeMs))
    throw new Error(`There is already a keyframe at ${key.timeMs} ms.`);
  return { ...path, keyframes: sortedKeyframes({ keyframes: [...others, key] }) };
}

export function removeKeyframe(path: CameraPath, id: string): CameraPath {
  return { ...path, keyframes: path.keyframes.filter((k) => k.id !== id) };
}

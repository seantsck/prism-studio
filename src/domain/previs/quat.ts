/**
 * Minimal, dependency-free quaternion maths for the pose/blocking domain. Pure and deterministic so the same
 * code runs in Node, the browser and tests. Conventions match three.js: right-handed, Y up, Euler order XYZ,
 * quaternions as {x, y, z, w}.
 */

export interface Quat {
  x: number;
  y: number;
  z: number;
  w: number;
}

export const IDENTITY_QUAT: Readonly<Quat> = Object.freeze({ x: 0, y: 0, z: 0, w: 1 });
export const DEG = Math.PI / 180;

export function quatNormalize(q: Quat): Quat {
  const len = Math.hypot(q.x, q.y, q.z, q.w);
  if (!Number.isFinite(len) || len < 1e-12) return { ...IDENTITY_QUAT };
  return { x: q.x / len, y: q.y / len, z: q.z / len, w: q.w / len };
}

export function quatMultiply(a: Quat, b: Quat): Quat {
  return {
    x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
    y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
    z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
    w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
  };
}

export function quatConjugate(q: Quat): Quat {
  return { x: -q.x, y: -q.y, z: -q.z, w: q.w };
}

export function quatFromAxisAngle(axis: "x" | "y" | "z", radians: number): Quat {
  const s = Math.sin(radians / 2);
  return {
    x: axis === "x" ? s : 0,
    y: axis === "y" ? s : 0,
    z: axis === "z" ? s : 0,
    w: Math.cos(radians / 2),
  };
}

/** Euler XYZ (three.js default order) in radians. */
export function quatFromEuler(x: number, y: number, z: number): Quat {
  const c1 = Math.cos(x / 2);
  const c2 = Math.cos(y / 2);
  const c3 = Math.cos(z / 2);
  const s1 = Math.sin(x / 2);
  const s2 = Math.sin(y / 2);
  const s3 = Math.sin(z / 2);
  return quatNormalize({
    x: s1 * c2 * c3 + c1 * s2 * s3,
    y: c1 * s2 * c3 - s1 * c2 * s3,
    z: c1 * c2 * s3 + s1 * s2 * c3,
    w: c1 * c2 * c3 - s1 * s2 * s3,
  });
}

/** Euler XYZ (three.js default order) in radians. */
export function quatToEuler(q: Quat): { x: number; y: number; z: number } {
  const { x, y, z, w } = quatNormalize(q);
  // rotation matrix elements (three.js Matrix4.makeRotationFromQuaternion)
  const m11 = 1 - 2 * (y * y + z * z);
  const m12 = 2 * (x * y - z * w);
  const m13 = 2 * (x * z + y * w);
  const m22 = 1 - 2 * (x * x + z * z);
  const m23 = 2 * (y * z - x * w);
  const m32 = 2 * (y * z + x * w);
  const m33 = 1 - 2 * (x * x + y * y);
  const ey = Math.asin(Math.max(-1, Math.min(1, m13)));
  if (Math.abs(m13) < 0.9999999) {
    return { x: Math.atan2(-m23, m33), y: ey, z: Math.atan2(-m12, m11) };
  }
  return { x: Math.atan2(m32, m22), y: ey, z: 0 };
}

/** q and -q are the same rotation: pick the representative with the first non-zero component positive. */
export function quatCanonicalSign(q: Quat): Quat {
  const eps = 1e-9;
  for (const k of ["w", "x", "y", "z"] as const) {
    if (Math.abs(q[k]) > eps) return q[k] < 0 ? { x: -q.x, y: -q.y, z: -q.z, w: -q.w } : { ...q };
  }
  return { ...IDENTITY_QUAT };
}

const r6 = (v: number) => Math.round(v * 1e6) / 1e6 + 0; // + 0 normalises -0

/** Normalised, sign-canonical, rounded: the stable stored/fingerprinted form of an orientation. */
export function quatCanonical(q: Quat): Quat {
  const c = quatCanonicalSign(quatNormalize(q));
  // rounding can perturb unit length by ~1e-6; renormalise then round again so the result is idempotent
  const n = quatNormalize({ x: r6(c.x), y: r6(c.y), z: r6(c.z), w: r6(c.w) });
  return quatCanonicalSign({ x: r6(n.x), y: r6(n.y), z: r6(n.z), w: r6(n.w) });
}

export function quatIsIdentity(q: Quat, eps = 1e-6): boolean {
  const c = quatCanonicalSign(quatNormalize(q));
  return Math.abs(c.x) < eps && Math.abs(c.y) < eps && Math.abs(c.z) < eps && Math.abs(c.w - 1) < eps;
}

export function quatsEqual(a: Quat, b: Quat, eps = 1e-6): boolean {
  const ca = quatCanonicalSign(quatNormalize(a));
  const cb = quatCanonicalSign(quatNormalize(b));
  return (
    Math.abs(ca.x - cb.x) < eps &&
    Math.abs(ca.y - cb.y) < eps &&
    Math.abs(ca.z - cb.z) < eps &&
    Math.abs(ca.w - cb.w) < eps
  );
}

/** Rotates a vector by a unit quaternion. */
export function quatRotateVec(q: Quat, v: { x: number; y: number; z: number }) {
  const n = quatNormalize(q);
  const ix = n.w * v.x + n.y * v.z - n.z * v.y;
  const iy = n.w * v.y + n.z * v.x - n.x * v.z;
  const iz = n.w * v.z + n.x * v.y - n.y * v.x;
  const iw = -n.x * v.x - n.y * v.y - n.z * v.z;
  return {
    x: ix * n.w + iw * -n.x + iy * -n.z - iz * -n.y,
    y: iy * n.w + iw * -n.y + iz * -n.x - ix * -n.z,
    z: iz * n.w + iw * -n.z + ix * -n.y - iy * -n.x,
  };
}

/** q^t along the shortest arc (t = 0 gives identity, t = 1 gives q). */
export function quatPow(q: Quat, t: number): Quat {
  const n = quatCanonicalSign(quatNormalize(q));
  const s = Math.hypot(n.x, n.y, n.z);
  if (s < 1e-12) return { ...IDENTITY_QUAT };
  const angle = 2 * Math.atan2(s, n.w);
  const h = (angle * t) / 2;
  const k = Math.sin(h) / s;
  return { x: n.x * k, y: n.y * k, z: n.z * k, w: Math.cos(h) };
}

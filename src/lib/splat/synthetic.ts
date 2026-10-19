import { gzipSync } from "fflate";

/**
 * Programmatically generated Gaussian data for tests and local verification. Nothing here is third-party or
 * copyrighted: it is built from the documented primitives of each format (positions, linear scales, colour, a
 * rotation). Never shipped as a demo scene.
 */
export interface SyntheticGaussian {
  x: number;
  y: number;
  z: number;
  /** linear scale (standard deviation, in source units) */
  sx: number;
  sy: number;
  sz: number;
  /** 0..255 */
  r: number;
  g: number;
  b: number;
  /** 0..255 opacity */
  a: number;
  /** unit quaternion (default identity) */
  q?: { w: number; x: number; y: number; z: number };
}

/**
 * A flat grid of coloured Gaussians in the XY plane at `z`, `size` source units wide/tall and centred on (cx, cy).
 * The colour varies across the grid so a loaded splat is visibly not empty.
 */
export function syntheticPlane(opts: {
  n?: number;
  size?: number;
  cx?: number;
  cy?: number;
  z?: number;
  rgb?: [number, number, number];
  scale?: number;
}): SyntheticGaussian[] {
  const n = opts.n ?? 24;
  const size = opts.size ?? 2;
  const cx = opts.cx ?? 0;
  const cy = opts.cy ?? 0;
  const z = opts.z ?? 0;
  const scale = opts.scale ?? (size / n) * 0.9;
  const out: SyntheticGaussian[] = [];
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const u = n === 1 ? 0.5 : i / (n - 1);
      const v = n === 1 ? 0.5 : j / (n - 1);
      const base = opts.rgb ?? [230, 60, 40];
      out.push({
        x: cx + (u - 0.5) * size,
        y: cy + (v - 0.5) * size,
        z,
        sx: scale,
        sy: scale,
        sz: scale * 0.2,
        r: Math.round(base[0] * (0.7 + 0.3 * u)),
        g: Math.round(base[1] * (0.7 + 0.3 * v)),
        b: Math.round(base[2]),
        a: 255,
      });
    }
  }
  return out;
}

const clamp8 = (v: number) => Math.max(0, Math.min(255, Math.round(v)));
const qOf = (g: SyntheticGaussian) => g.q ?? { w: 1, x: 0, y: 0, z: 0 };

/** antimatter15-style .splat: 32 bytes per Gaussian. */
export function encodeSplatFile(gs: SyntheticGaussian[]): Uint8Array {
  const out = new Uint8Array(gs.length * 32);
  const view = new DataView(out.buffer);
  gs.forEach((g, i) => {
    const o = i * 32;
    view.setFloat32(o, g.x, true);
    view.setFloat32(o + 4, g.y, true);
    view.setFloat32(o + 8, g.z, true);
    view.setFloat32(o + 12, g.sx, true);
    view.setFloat32(o + 16, g.sy, true);
    view.setFloat32(o + 20, g.sz, true);
    out[o + 24] = clamp8(g.r);
    out[o + 25] = clamp8(g.g);
    out[o + 26] = clamp8(g.b);
    out[o + 27] = clamp8(g.a);
    const q = qOf(g);
    out[o + 28] = clamp8(q.w * 128 + 128);
    out[o + 29] = clamp8(q.x * 128 + 128);
    out[o + 30] = clamp8(q.y * 128 + 128);
    out[o + 31] = clamp8(q.z * 128 + 128);
  });
  return out;
}

const SH_C0 = 0.28209479177387814;
const logit = (p: number) => {
  const c = Math.min(0.999, Math.max(0.001, p));
  return Math.log(c / (1 - c));
};

/** Binary little-endian Gaussian PLY with the standard 3DGS attribute set (DC colour only). */
export function encodePlyFile(gs: SyntheticGaussian[]): Uint8Array {
  const props = [
    "x",
    "y",
    "z",
    "f_dc_0",
    "f_dc_1",
    "f_dc_2",
    "opacity",
    "scale_0",
    "scale_1",
    "scale_2",
    "rot_0",
    "rot_1",
    "rot_2",
    "rot_3",
  ];
  const header =
    `ply\nformat binary_little_endian 1.0\nelement vertex ${gs.length}\n` +
    props.map((p) => `property float ${p}\n`).join("") +
    "end_header\n";
  const head = new TextEncoder().encode(header);
  const out = new Uint8Array(head.length + gs.length * props.length * 4);
  out.set(head, 0);
  const view = new DataView(out.buffer);
  gs.forEach((g, i) => {
    const q = qOf(g);
    const row = [
      g.x,
      g.y,
      g.z,
      (g.r / 255 - 0.5) / SH_C0,
      (g.g / 255 - 0.5) / SH_C0,
      (g.b / 255 - 0.5) / SH_C0,
      logit(g.a / 255),
      Math.log(g.sx),
      Math.log(g.sy),
      Math.log(g.sz),
      q.w,
      q.x,
      q.y,
      q.z,
    ];
    row.forEach((v, k) => view.setFloat32(head.length + (i * props.length + k) * 4, v, true));
  });
  return out;
}

/**
 * SPZ (gzip) version 2: 16-byte header, then 24-bit fixed-point positions, alphas, colours, log-scales and
 * 3-byte rotations, as separate planes.
 */
export function encodeSpzFile(gs: SyntheticGaussian[], fractionalBits = 12): Uint8Array {
  const n = gs.length;
  const raw = new Uint8Array(16 + n * (9 + 1 + 3 + 3 + 3));
  const view = new DataView(raw.buffer);
  view.setUint32(0, 0x5053474e, true);
  view.setUint32(4, 2, true);
  view.setUint32(8, n, true);
  raw[12] = 0; // no spherical harmonics
  raw[13] = fractionalBits;
  raw[14] = 0;
  raw[15] = 0;
  const fixed = 1 << fractionalBits;
  let o = 16;
  for (const g of gs) {
    for (const v of [g.x, g.y, g.z]) {
      const f = Math.round(v * fixed) & 0xffffff;
      raw[o++] = f & 0xff;
      raw[o++] = (f >> 8) & 0xff;
      raw[o++] = (f >> 16) & 0xff;
    }
  }
  for (const g of gs) raw[o++] = clamp8(g.a);
  const colorScale = 0.15 / SH_C0;
  for (const g of gs) {
    for (const c of [g.r, g.g, g.b]) raw[o++] = clamp8(((c / 255 - 0.5) / colorScale + 0.5) * 255);
  }
  for (const g of gs) {
    for (const s of [g.sx, g.sy, g.sz]) raw[o++] = clamp8((Math.log(s) + 10) * 16);
  }
  for (const g of gs) {
    const q = qOf(g);
    const sign = q.w < 0 ? -1 : 1; // the format stores x,y,z and reconstructs w >= 0
    for (const c of [q.x, q.y, q.z]) raw[o++] = clamp8((c * sign + 1) * 127.5);
  }
  return gzipSync(raw);
}

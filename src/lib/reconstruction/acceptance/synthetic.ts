import { crc32, deflateSync } from "node:zlib";

/**
 * The REAL_SMOKE dataset (M2D.3D1): a small, deterministic, synthetic "room" rendered from known viewpoints, so the
 * real COLMAP and Brush can be exercised end to end without anyone's photographs and without a download.
 *
 * A 6 m × 6 m × 2.6 m box whose walls, floor and ceiling carry distinct, non-repeating procedural textures (multi-scale
 * value noise and scattered coloured discs: corners and blobs at many scales for SIFT, nothing periodic to confuse
 * matching). Twelve cameras stand on a small circle facing outwards, so neighbouring views overlap heavily with a real
 * baseline. Flat albedo (no lighting), 2×2 supersampled: every view is photometrically consistent.
 *
 * This proves that the native tools RUN on this machine (Vulkan initialises, training writes a valid PLY, SPZ
 * converts). It says nothing about quality on real photographs; if COLMAP cannot register this scene on a machine,
 * the smoke command can be given a tiny real photo set instead (--input).
 */

export interface SyntheticView {
  name: string;
  png: Uint8Array;
}

export interface SyntheticOptions {
  views?: number;
  width?: number;
  height?: number;
  seed?: number;
}

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ROOM = { x: 3, yTop: 2.6, z: 3 } as const;
const TEX_PER_M = 160;

interface Texture {
  w: number;
  h: number;
  rgb: Uint8Array;
}

/** One face's texture over its own (u, v) extent in metres. */
function faceTexture(uM: number, vM: number, seed: number): Texture {
  const w = Math.round(uM * TEX_PER_M);
  const h = Math.round(vM * TEX_PER_M);
  const rand = mulberry32(seed);
  // value-noise lattices at several scales (cells per metre)
  const octaves = [1.5, 4, 10, 24, 48].map((f) => {
    const gw = Math.ceil(uM * f) + 2;
    const gh = Math.ceil(vM * f) + 2;
    const g = new Float32Array(gw * gh);
    for (let i = 0; i < g.length; i++) g[i] = rand();
    return { f, gw, g };
  });
  const base = [rand(), rand(), rand()];
  const discs = Array.from({ length: Math.round(uM * vM * 40) }, () => ({
    u: rand() * uM,
    v: rand() * vM,
    r: 0.015 + rand() * rand() * 0.12,
    c: [rand(), rand(), rand()],
  }));
  const rgb = new Uint8Array(w * h * 3);
  const n = new Float32Array(w * h);
  // octave by octave over the whole face (tight loops: no closure or allocation per texel)
  let amp = 0.5;
  for (const o of octaves) {
    const g = o.g;
    const gw = o.gw;
    for (let y = 0; y < h; y++) {
      const fv = ((y + 0.5) / TEX_PER_M) * o.f;
      const iv = Math.floor(fv);
      let tv = fv - iv;
      tv = tv * tv * (3 - 2 * tv);
      const row0 = iv * gw;
      const row1 = row0 + gw;
      for (let x = 0; x < w; x++) {
        const fu = ((x + 0.5) / TEX_PER_M) * o.f;
        const iu = Math.floor(fu);
        let tu = fu - iu;
        tu = tu * tu * (3 - 2 * tu);
        const top = g[row0 + iu]! * (1 - tu) + g[row0 + iu + 1]! * tu;
        const bot = g[row1 + iu]! * (1 - tu) + g[row1 + iu + 1]! * tu;
        n[y * w + x]! += amp * (top * (1 - tv) + bot * tv);
      }
    }
    amp *= 0.85;
  }
  const [b0, b1, b2] = base as [number, number, number];
  for (let k = 0; k < w * h; k++) {
    // high contrast: the sum (≈0..2.6) stretched around its mean
    const m = Math.min(1, Math.max(0, 0.5 + (n[k]! - 1.3) * 1.4));
    rgb[k * 3] = Math.round((0.08 + 0.84 * (0.3 * b0 + 0.7 * m)) * 255);
    rgb[k * 3 + 1] = Math.round((0.08 + 0.84 * (0.3 * b1 + 0.7 * m)) * 255);
    rgb[k * 3 + 2] = Math.round((0.08 + 0.84 * (0.3 * b2 + 0.7 * m)) * 255);
  }
  // discs drawn over their own bounding boxes (corners and blobs at many scales)
  for (const d of discs) {
    const x0 = Math.max(0, Math.floor((d.u - d.r) * TEX_PER_M));
    const x1 = Math.min(w - 1, Math.ceil((d.u + d.r) * TEX_PER_M));
    const y0 = Math.max(0, Math.floor((d.v - d.r) * TEX_PER_M));
    const y1 = Math.min(h - 1, Math.ceil((d.v + d.r) * TEX_PER_M));
    for (let y = y0; y <= y1; y++)
      for (let x = x0; x <= x1; x++) {
        const du = (x + 0.5) / TEX_PER_M - d.u;
        const dv = (y + 0.5) / TEX_PER_M - d.v;
        if (du * du + dv * dv >= d.r * d.r) continue;
        const i = (y * w + x) * 3;
        rgb[i] = Math.round(d.c[0]! * 255);
        rgb[i + 1] = Math.round(d.c[1]! * 255);
        rgb[i + 2] = Math.round(d.c[2]! * 255);
      }
  }
  return { w, h, rgb };
}

function sample(t: Texture, uM: number, vM: number, out: number[]) {
  const x = Math.min(t.w - 1.001, Math.max(0, uM * TEX_PER_M - 0.5));
  const y = Math.min(t.h - 1.001, Math.max(0, vM * TEX_PER_M - 0.5));
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = x - x0;
  const fy = y - y0;
  const rgb = t.rgb;
  const i00 = (y0 * t.w + x0) * 3;
  const i01 = i00 + t.w * 3;
  for (let c = 0; c < 3; c++)
    out[c] =
      (rgb[i00 + c]! * (1 - fx) + rgb[i00 + 3 + c]! * fx) * (1 - fy) +
      (rgb[i01 + c]! * (1 - fx) + rgb[i01 + 3 + c]! * fx) * fy;
}

/** A valid RGB8 PNG (filter 0 rows, zlib). */
export function encodePng(width: number, height: number, rgb: Uint8Array): Uint8Array {
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++)
    Buffer.from(rgb.buffer, rgb.byteOffset + y * width * 3, width * 3).copy(raw, y * (width * 3 + 1) + 1);
  return new Uint8Array(
    Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk("IHDR", ihdr),
      chunk("IDAT", deflateSync(raw)),
      chunk("IEND", Buffer.alloc(0)),
    ]),
  );
}

export function renderSyntheticRoom(o: SyntheticOptions = {}): SyntheticView[] {
  const views = o.views ?? 12;
  const W = o.width ?? 512;
  const H = o.height ?? 384;
  const seed = o.seed ?? 20261020;
  const { x: X, yTop: Y, z: Z } = ROOM;
  // faces: walls (u along the wall, v up), floor/ceiling (u along x, v along z)
  const tex = {
    xNeg: faceTexture(2 * Z, Y, seed + 1),
    xPos: faceTexture(2 * Z, Y, seed + 2),
    zNeg: faceTexture(2 * X, Y, seed + 3),
    zPos: faceTexture(2 * X, Y, seed + 4),
    floor: faceTexture(2 * X, 2 * Z, seed + 5),
    ceil: faceTexture(2 * X, 2 * Z, seed + 6),
  };
  const f = (0.5 * W) / Math.tan((70 / 2) * (Math.PI / 180)); // 70° horizontal field of view
  const out: SyntheticView[] = [];
  const col = [0, 0, 0];
  for (let k = 0; k < views; k++) {
    const yaw = (k / views) * 2 * Math.PI;
    const height = k % 2 === 0 ? 1.45 : 1.15;
    const cx = 0.8 * Math.cos(yaw);
    const cz = 0.8 * Math.sin(yaw);
    // looking outwards, slightly down
    const fwd = [Math.cos(yaw), -0.12, Math.sin(yaw)];
    const fl = Math.hypot(fwd[0]!, fwd[1]!, fwd[2]!);
    const F = fwd.map((v) => v / fl);
    const right = [-F[2]!, 0, F[0]!];
    const rl = Math.hypot(right[0]!, right[2]!);
    const R = right.map((v) => v / rl);
    const U = [R[1]! * F[2]! - R[2]! * F[1]!, R[2]! * F[0]! - R[0]! * F[2]!, R[0]! * F[1]! - R[1]! * F[0]!];
    const rgb = new Uint8Array(W * H * 3);
    const SUB = [0.25, 0.75];
    for (let py = 0; py < H; py++)
      for (let px = 0; px < W; px++) {
        let r = 0;
        let g = 0;
        let bl = 0;
        for (const sy of SUB)
          for (const sx of SUB) {
            const a = (px + sx - W / 2) / f;
            const b = -(py + sy - H / 2) / f;
            const dx = F[0]! + a * R[0]! + b * U[0]!;
            const dy = F[1]! + a * R[1]! + b * U[1]!;
            const dz = F[2]! + a * R[2]! + b * U[2]!;
            // nearest positive hit among the six inward-facing planes (inside the box exactly one per axis faces us)
            const tx = dx > 0 ? (X - cx) / dx : dx < 0 ? (-X - cx) / dx : Infinity;
            const ty = dy > 0 ? (Y - height) / dy : dy < 0 ? -height / dy : Infinity;
            const tz = dz > 0 ? (Z - cz) / dz : dz < 0 ? (-Z - cz) / dz : Infinity;
            let t: Texture;
            let u: number;
            let v: number;
            if (tx <= ty && tx <= tz) {
              t = dx > 0 ? tex.xPos : tex.xNeg;
              u = cz + tx * dz + Z;
              v = height + tx * dy;
            } else if (tz <= ty) {
              t = dz > 0 ? tex.zPos : tex.zNeg;
              u = cx + tz * dx + X;
              v = height + tz * dy;
            } else {
              t = dy > 0 ? tex.ceil : tex.floor;
              u = cx + ty * dx + X;
              v = cz + ty * dz + Z;
            }
            sample(t, u, v, col);
            r += col[0]!;
            g += col[1]!;
            bl += col[2]!;
          }
        const i = (py * W + px) * 3;
        rgb[i] = Math.round(r / 4);
        rgb[i + 1] = Math.round(g / 4);
        rgb[i + 2] = Math.round(bl / 4);
      }
    out.push({ name: `view-${String(k + 1).padStart(2, "0")}.png`, png: encodePng(W, H, rgb) });
  }
  return out;
}

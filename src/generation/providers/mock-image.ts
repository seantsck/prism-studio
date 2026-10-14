import { deflateSync } from "node:zlib";

/**
 * Tiny dependency-free PNG encoder for the Mock provider's image outputs. Deterministic: the same seed and
 * size always produce the same bytes (so checksums and fixtures are stable).
 */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Buffer {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "ascii");
  out.set(data, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

/** Deterministic pseudo-random generator (mulberry32). */
function rng(seed: number) {
  let t = seed >>> 0;
  return () => {
    t = (t + 0x6d2b79f5) >>> 0;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

export function seedFromString(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** A soft two-colour gradient with a grid, tinted from the seed. */
export function encodeMockPng(width: number, height: number, seed: number): Uint8Array {
  const rand = rng(seed);
  const a = [40 + Math.floor(rand() * 120), 40 + Math.floor(rand() * 120), 80 + Math.floor(rand() * 140)];
  const b = [60 + Math.floor(rand() * 160), 30 + Math.floor(rand() * 100), 60 + Math.floor(rand() * 120)];
  const stride = width * 3 + 1;
  const raw = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    raw[y * stride] = 0; // filter: none
    for (let x = 0; x < width; x++) {
      const t = (x / width + y / height) / 2;
      const grid = x % 32 === 0 || y % 32 === 0 ? 24 : 0;
      for (let ch = 0; ch < 3; ch++) {
        raw[y * stride + 1 + x * 3 + ch] = Math.min(255, Math.round(a[ch]! * (1 - t) + b[ch]! * t) + grid);
      }
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", new Uint8Array(0)),
  ]);
}

/**
 * A deterministic, richer synthetic still for benchmark fixtures: sunset sky, dark mountain band, ground, a
 * distinctive fictional figure (red coat, yellow umbrella) in the foreground and a blue lamp post in the
 * background. Fictional, no real person or copyrighted subject; identical bytes for identical sizes.
 */
export function encodeSceneStillPng(width: number, height: number): Uint8Array {
  const stride = width * 3 + 1;
  const raw = Buffer.alloc(stride * height);
  const horizon = Math.round(height * 0.62);
  const cx = Math.round(width * 0.38);
  const feet = Math.round(height * 0.9);
  const body = Math.round(height * 0.3);
  const lampX = Math.round(width * 0.78);
  for (let y = 0; y < height; y++) {
    raw[y * stride] = 0;
    for (let x = 0; x < width; x++) {
      let r: number, g: number, b: number;
      if (y < horizon) {
        const t = y / horizon;
        r = Math.round(30 + 215 * t);
        g = Math.round(60 + 110 * t);
        b = Math.round(120 - 40 * t);
        const ridge = horizon - 40 - Math.round(36 * Math.abs(Math.sin(x / 90)) + 20 * Math.sin(x / 37));
        if (y > ridge) [r, g, b] = [28, 34, 62];
      } else {
        const t = (y - horizon) / (height - horizon);
        [r, g, b] = [46 - Math.round(16 * t), 70 - Math.round(24 * t), 52 - Math.round(18 * t)];
      }
      // background lamp post (blue pole, warm lamp)
      if (x >= lampX - 4 && x <= lampX + 4 && y >= horizon - 150 && y <= horizon + 10)
        [r, g, b] = [40, 90, 210];
      if ((x - lampX) ** 2 + (y - (horizon - 160)) ** 2 < 14 * 14) [r, g, b] = [255, 224, 120];
      // figure: red coat body, skin-tone head, dark legs, yellow umbrella canopy
      if (Math.abs(x - cx) <= 46 && y >= feet - body && y <= feet - 70) [r, g, b] = [200, 30, 40];
      if (Math.abs(x - cx) <= 26 && y > feet - 70 && y <= feet) [r, g, b] = [25, 25, 35];
      if ((x - cx) ** 2 + (y - (feet - body - 34)) ** 2 < 34 * 34) [r, g, b] = [226, 184, 150];
      const ux = x - (cx + 20);
      const uy = y - (feet - body - 70);
      if (uy <= 0 && uy > -70 && ux * ux + uy * uy * 2.4 < 120 * 120) [r, g, b] = [250, 200, 30];
      raw[y * stride + 1 + x * 3] = r;
      raw[y * stride + 2 + x * 3] = g;
      raw[y * stride + 3 + x * 3] = b;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", new Uint8Array(0)),
  ]);
}

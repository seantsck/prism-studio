// Deterministic, dependency-free artwork for the SEMANTIC continuity smoke fixture.
//
// A fictional, stylised adult character drawn from flat shapes (no photograph, no real or public person, no
// copyrighted character, nothing from the canonical drama). The goal is visual clarity for a vision model, not
// beauty: distinctive, easily named features that survive a change of outfit.
//
//   character "A":  dark shoulder-length hair · round glasses · a distinctive blue scarf
//   character "B":  a DIFFERENT fictional person (short light hair, no glasses, orange scarf) for identity-mismatch
//                   diagnostics
//   outfit:         "grey"  plain grey top           (identity reference: identity must not depend on clothing)
//                   "black" black formal jacket over a white shirt      (the assigned Look)
//                   "red"   red jacket over a white shirt               (the deliberately different output)
//
// The same inputs always produce the same bytes (stable checksums). Pure JS rasteriser with 3×3 supersampling.
import { deflateSync } from "node:zlib";

export type SyntheticOutfit = "grey" | "black" | "red";
export type SyntheticCharacter = "A" | "B";
type Rgb = readonly [number, number, number];
type Shape = { hit: (x: number, y: number) => boolean; color: Rgb };

const rgb = (hex: string): Rgb => [
  parseInt(hex.slice(1, 3), 16),
  parseInt(hex.slice(3, 5), 16),
  parseInt(hex.slice(5, 7), 16),
];

const ellipse =
  (cx: number, cy: number, rx: number, ry: number) =>
  (x: number, y: number): boolean =>
    ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 <= 1;

const rect =
  (x0: number, y0: number, x1: number, y1: number) =>
  (x: number, y: number): boolean =>
    x >= x0 && x <= x1 && y >= y0 && y <= y1;

function polygon(points: Array<[number, number]>) {
  return (x: number, y: number): boolean => {
    let inside = false;
    for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
      const [xi, yi] = points[i]!;
      const [xj, yj] = points[j]!;
      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  };
}

function segment(x0: number, y0: number, x1: number, y1: number, width: number) {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const len2 = dx * dx + dy * dy || 1;
  return (x: number, y: number): boolean => {
    const t = Math.max(0, Math.min(1, ((x - x0) * dx + (y - y0) * dy) / len2));
    return Math.hypot(x - (x0 + t * dx), y - (y0 + t * dy)) <= width / 2;
  };
}

const ring = (cx: number, cy: number, r: number, width: number) => (x: number, y: number) => {
  const d = Math.hypot(x - cx, y - cy);
  return d <= r + width / 2 && d >= r - width / 2;
};

const OUTFITS: Record<SyntheticOutfit, { base: Rgb; edge: Rgb; shirt: boolean }> = {
  grey: { base: rgb("#8b9099"), edge: rgb("#a9aeb7"), shirt: false },
  black: { base: rgb("#15151b"), edge: rgb("#5a5a6e"), shirt: true },
  red: { base: rgb("#c4161c"), edge: rgb("#8f0f14"), shirt: true },
};

function scene(character: SyntheticCharacter, outfit: SyntheticOutfit, cx: number): Shape[] {
  const o = OUTFITS[outfit];
  const A = character === "A";
  const skin = rgb(A ? "#efc9a6" : "#f3d3b6");
  const hair = rgb(A ? "#1b130f" : "#cfa54a");
  const scarf = rgb(A ? "#1f5fbf" : "#e07b1f");
  const scarfDark = rgb(A ? "#174a94" : "#b25f14");
  const ink = rgb("#1a1a1f");
  const shapes: Shape[] = [];
  const add = (hit: Shape["hit"], color: Rgb) => shapes.push({ hit, color });

  // hair behind the head: shoulder-length for A, a short cap for B
  if (A) {
    add(ellipse(cx, 190, 128, 150), hair);
    add(rect(cx - 126, 180, cx + 126, 335), hair);
  } else {
    add(ellipse(cx, 168, 86, 98), hair);
  }
  // body
  add(ellipse(cx, 480, 270, 175), o.base);
  add(rect(cx - 30, 270, cx + 30, 345), skin); // neck
  if (o.shirt) {
    add(
      polygon([
        [cx - 40, 316],
        [cx + 40, 316],
        [cx, 446],
      ]),
      rgb("#f4f4f2"),
    );
    add(segment(cx - 48, 308, cx, 432, 6), o.edge);
    add(segment(cx + 48, 308, cx, 432, 6), o.edge);
    add(ellipse(cx, 462, 6, 6), o.edge);
    add(ellipse(cx, 498, 6, 6), o.edge);
  } else {
    add(ellipse(cx, 352, 44, 22), skin); // crew neckline
    add(ellipse(cx, 372, 52, 20), o.edge);
  }
  // scarf (the character's signature): band + hanging tail with a stripe
  add(ellipse(cx, 338, 66, 24), scarf);
  add(
    polygon([
      [cx + 14, 344],
      [cx + 58, 352],
      [cx + 86, 478],
      [cx + 38, 486],
    ]),
    scarf,
  );
  add(segment(cx + 40, 360, cx + 64, 480, 7), scarfDark);
  // head
  add(ellipse(cx, 205, 74, 90), skin);
  // fringe / hair cap (A: parted fringe; B: short crop)
  const face = ellipse(cx, 240, 70, 96);
  const cap = ellipse(cx, 148, A ? 86 : 80, A ? 70 : 58);
  add((x, y) => cap(x, y) && !face(x, y), hair);
  // features
  for (const dx of [-32, 32]) {
    add(ellipse(cx + dx, 205, 14, 9), rgb("#fafafa"));
    add(ellipse(cx + dx, 205, 7, 7), rgb("#231a16"));
    add(segment(cx + dx - 14, 184, cx + dx + 14, 182, 5), hair);
  }
  add(segment(cx, 210, cx - 6, 246, 4), rgb("#d9ab86")); // nose
  add(ellipse(cx, 268, 20, 5), rgb("#a8454a")); // mouth
  if (A) {
    // round glasses
    for (const dx of [-32, 32]) add(ring(cx + dx, 205, 30, 5), ink);
    add(rect(cx - 4, 201, cx + 4, 207), ink);
    add(segment(cx - 62, 203, cx - 74, 198, 4), ink);
    add(segment(cx + 62, 203, cx + 74, 198, 4), ink);
  }
  return shapes;
}

// ── PNG encoding (RGB, 8-bit, no interlace) ───────────────────────────────────────────────────────────────
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

export interface SyntheticArtwork {
  png: Uint8Array;
  width: number;
  height: number;
  /** Plain-language description of what the picture shows (for docs/tests; never sent as a verdict). */
  describes: string;
}

export function renderSyntheticCharacter(opts: {
  character: SyntheticCharacter;
  outfit: SyntheticOutfit;
  width?: number;
  height?: number;
}): SyntheticArtwork {
  const width = opts.width ?? 768;
  const height = opts.height ?? 432;
  const shapes = scene(opts.character, opts.outfit, Math.round(width / 2));
  const top = rgb("#e1e4e9");
  const bottom = rgb("#cdd1d8");
  const stride = width * 3 + 1;
  const raw = Buffer.alloc(stride * height);
  const N = 3;
  const SCALE = 0.8;
  const cx = Math.round(width / 2);
  const bg = (py: number): Rgb => {
    const t = py / height;
    return [
      top[0] + (bottom[0] - top[0]) * t,
      top[1] + (bottom[1] - top[1]) * t,
      top[2] + (bottom[2] - top[2]) * t,
    ];
  };
  // the whole figure is drawn smaller so the outfit is plainly visible; topmost shape wins (painter's order,
  // searched from the top so most samples stop after a few tests)
  const shapeAt = (px: number, py: number): Shape | null => {
    const qx = cx + (px - cx) / SCALE;
    const qy = py / SCALE;
    for (let i = shapes.length - 1; i >= 0; i--) if (shapes[i]!.hit(qx, qy)) return shapes[i]!;
    return null;
  };
  const colorAt = (px: number, py: number): Rgb => shapeAt(px, py)?.color ?? bg(py);
  for (let y = 0; y < height; y++) {
    raw[y * stride] = 0;
    for (let x = 0; x < width; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      // flat interior: four corner probes agree on one shape => no supersampling needed
      const probes = [
        shapeAt(x + 0.1, y + 0.1),
        shapeAt(x + 0.9, y + 0.1),
        shapeAt(x + 0.1, y + 0.9),
        shapeAt(x + 0.9, y + 0.9),
      ];
      if (probes.every((s) => s === probes[0])) {
        const c = probes[0]?.color ?? bg(y + 0.5);
        [r, g, b] = [c[0] * N * N, c[1] * N * N, c[2] * N * N];
      } else {
        for (let sy = 0; sy < N; sy++) {
          for (let sx = 0; sx < N; sx++) {
            const c = colorAt(x + (sx + 0.5) / N, y + (sy + 0.5) / N);
            r += c[0];
            g += c[1];
            b += c[2];
          }
        }
      }
      const o = y * stride + 1 + x * 3;
      raw[o] = Math.round(r / (N * N));
      raw[o + 1] = Math.round(g / (N * N));
      raw[o + 2] = Math.round(b / (N * N));
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", new Uint8Array(0)),
  ]);
  const who =
    opts.character === "A"
      ? "a fictional adult with dark shoulder-length hair, round glasses and a blue scarf"
      : "a different fictional adult with short light hair, no glasses and an orange scarf";
  const what =
    opts.outfit === "grey" ? "a plain grey top" : `a ${opts.outfit} formal jacket over a white shirt`;
  return { png, width, height, describes: `${who}, wearing ${what}, on a plain light-grey background` };
}

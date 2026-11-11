import { alphaCoverage, MattingRefusal, type MatteResult, type MattingEngine } from "./engine";
import type { RgbaImage } from "./png";

/**
 * Phase 5B-I3: `plain-background-keyer-1`, Prism's own deterministic matte for images on a PLAIN background (studio,
 * flat colour, the typical generated character reference). No model, no weights, no network: MIT-clean by
 * construction (it is Prism code) and private (bytes never leave the worker).
 *
 *   1. The background colour is the per-channel median of a thin border ring. If that ring is not plain (its 90th
 *      percentile colour distance is above PLAIN_LIMIT) the engine REFUSES: a busy background needs a segmentation
 *      model, and a bad cutout is worse than none.
 *   2. Only pixels CONNECTED to the border through background-like colour can become transparent (a flood fill), so a
 *      white eye or a white collar on a white background stays opaque.
 *   3. Alpha ramps smoothly across a colour-distance band [t0, t1] (soft edges for hair and antialiasing), then a 3×3
 *      average runs only where alpha changes (no effect inside the subject or the background).
 *
 * Limits (documented, not hidden): fine hair against a background of the SAME colour, glass, smoke and soft shadows
 * cannot be separated by colour; colour spill on edges is not removed (RGB is never modified).
 */
export const PLAIN_LIMIT = 40;
const BAND = 36;

const dist = (r: number, g: number, b: number, bg: readonly number[]) =>
  Math.sqrt((r - bg[0]!) ** 2 + (g - bg[1]!) ** 2 + (b - bg[2]!) ** 2);

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)] ?? 0;
}

function percentile(xs: number[], p: number): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(s.length * p))] ?? 0;
}

export const plainBackgroundKeyer: MattingEngine = {
  id: "plain-background-keyer-1",
  version: "1.0.0",
  displayName: "Plain-background keyer",
  license: "Prism Studio code (no third-party model or weights)",
  deterministic: true,
  matte(image: RgbaImage): MatteResult {
    const { width: w, height: h, data } = image;
    if (w < 16 || h < 16) throw new MattingRefusal("too_small", "The image is too small to cut out.");
    const ring = Math.max(2, Math.round(Math.min(w, h) * 0.02));
    const border: number[] = [];
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++)
        if (x < ring || y < ring || x >= w - ring || y >= h - ring) border.push(y * w + x);
    const bg = [0, 1, 2].map((c) => median(border.map((i) => data[i * 4 + c]!)));
    const borderDist = border.map((i) => dist(data[i * 4]!, data[i * 4 + 1]!, data[i * 4 + 2]!, bg));
    // a subject may touch the frame (a portrait cut at the chest): the background-like part of the border must be the
    // majority of it, and that part must itself be plain (low colour noise)
    const backgroundLike = borderDist.filter((v) => v < PLAIN_LIMIT);
    const plainShare = backgroundLike.length / borderDist.length;
    const noise = percentile(backgroundLike, 0.95);
    if (plainShare < 0.5 || noise > PLAIN_LIMIT * 0.6)
      throw new MattingRefusal(
        "background_not_plain",
        "This image's background is not plain enough for the plain-background engine. A segmentation engine is needed for busy backgrounds (not enabled yet).",
      );
    const p90 = percentile(borderDist, 0.9);
    const t0 = Math.max(12, noise * 1.5 + 6);
    const t1 = t0 + BAND;

    const n = w * h;
    const d = new Float32Array(n);
    for (let i = 0; i < n; i++) d[i] = dist(data[i * 4]!, data[i * 4 + 1]!, data[i * 4 + 2]!, bg);

    // flood fill from the border through background-like pixels (4-connected, iterative)
    const reached = new Uint8Array(n);
    const stack: number[] = [];
    for (const i of border)
      if (d[i]! < t1 && !reached[i]) {
        reached[i] = 1;
        stack.push(i);
      }
    while (stack.length) {
      const i = stack.pop()!;
      const x = i % w;
      const y = (i - x) / w;
      const visit = (j: number) => {
        if (!reached[j] && d[j]! < t1) {
          reached[j] = 1;
          stack.push(j);
        }
      };
      if (x > 0) visit(i - 1);
      if (x < w - 1) visit(i + 1);
      if (y > 0) visit(i - w);
      if (y < h - 1) visit(i + w);
    }

    const raw = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      if (!reached[i]) raw[i] = 255;
      else if (d[i]! <= t0) raw[i] = 0;
      else raw[i] = Math.round(((d[i]! - t0) / (t1 - t0)) * 255);
    }
    // antialias only where alpha changes (3×3 mean); interior and background are untouched
    const alpha = new Uint8Array(raw);
    for (let y = 1; y < h - 1; y++)
      for (let x = 1; x < w - 1; x++) {
        const i = y * w + x;
        const c = raw[i]!;
        let mixed = false;
        let sum = 0;
        for (let dy = -1; dy <= 1; dy++)
          for (let dx = -1; dx <= 1; dx++) {
            const v = raw[i + dy * w + dx]!;
            sum += v;
            if (v !== c) mixed = true;
          }
        if (mixed) alpha[i] = Math.round(sum / 9);
      }
    const coverage = alphaCoverage(alpha);
    if (coverage.opaque + coverage.soft < 0.01)
      throw new MattingRefusal("no_subject", "No subject could be separated from the background.");
    if (coverage.transparent < 0.01)
      throw new MattingRefusal("no_background", "The background could not be separated from the subject.");
    return {
      alpha,
      kind: "soft",
      details: {
        background: bg.map((v) => Math.round(v)),
        thresholds: [Math.round(t0 * 10) / 10, Math.round(t1 * 10) / 10],
        borderP90: Math.round(p90 * 10) / 10,
        plainBorderShare: Math.round(plainShare * 1000) / 1000,
        backgroundNoise: Math.round(noise * 10) / 10,
        ringPx: ring,
        coverage,
      },
    };
  },
};

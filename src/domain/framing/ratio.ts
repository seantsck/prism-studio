/**
 * Aspect-ratio vocabulary. Pure.
 *
 * Prism distinguishes three frames that must never be conflated:
 *   PRODUCTION frame  what the filmmaker designed (e.g. 2.39:1)
 *   PROVIDER canvas   what a generation model accepts (e.g. 16:9, 1280×720)
 *   DELIVERY frame    what the conformed final media uses (e.g. 2.39:1 cropped from the provider canvas)
 */

export interface Ratio {
  /** Numerator/denominator exactly as written ("2.39:1" → 2.39 / 1). */
  w: number;
  h: number;
  /** w / h */
  value: number;
}

/** Ratios closer than this (relative) are the same ratio: 2.39 vs 2.388 (1280×536) must match. */
export const RATIO_TOLERANCE = 0.01;

/** Accepts "2.39:1", "2.39", "16:9", "16/9", "1280:720", "1280x720", "1280×720". Anything else → null. */
export function parseAspectRatio(raw: string | null | undefined): Ratio | null {
  const s = (raw ?? "").trim();
  if (!s) return null;
  const pair = /^(\d+(?:\.\d+)?)\s*(?::|\/|x|×)\s*(\d+(?:\.\d+)?)$/i.exec(s);
  if (pair) {
    const w = Number(pair[1]);
    const h = Number(pair[2]);
    if (!(w > 0) || !(h > 0)) return null;
    return { w, h, value: w / h };
  }
  const single = /^(\d+(?:\.\d+)?)$/.exec(s);
  if (single) {
    const v = Number(single[1]);
    return v > 0 ? { w: v, h: 1, value: v } : null;
  }
  return null;
}

export const ratioOf = (width: number, height: number): Ratio => ({
  w: width,
  h: height,
  value: width / height,
});

export function sameRatio(a: number, b: number, tolerance = RATIO_TOLERANCE): boolean {
  return Math.abs(a - b) / Math.max(a, b) <= tolerance;
}

const NAMED: Array<[number, string]> = [
  [16 / 9, "16:9"],
  [9 / 16, "9:16"],
  [4 / 3, "4:3"],
  [3 / 4, "3:4"],
  [1, "1:1"],
  [21 / 9, "21:9"],
  [2.39, "2.39:1"],
  [2.35, "2.35:1"],
  [1.85, "1.85:1"],
];

/** Human label: the original text when it parses, else a well-known name, else `1.62:1`. */
export function formatRatio(value: number, original?: string | null): string {
  if (original && parseAspectRatio(original) && sameRatio(parseAspectRatio(original)!.value, value)) {
    return original.trim();
  }
  const named = NAMED.find(([v]) => sameRatio(v, value, 0.004));
  if (named) return named[1];
  return `${Number(value.toFixed(2))}:1`;
}

export interface Size {
  width: number;
  height: number;
}

/** A nominal canvas for a ratio when no real pixel size is known (planning/preview only). */
export function nominalCanvas(ratio: number, longEdge = 1280): Size {
  const even = (n: number) => Math.max(2, 2 * Math.round(n / 2));
  return ratio >= 1
    ? { width: even(longEdge), height: even(longEdge / ratio) }
    : { width: even(longEdge * ratio), height: even(longEdge) };
}

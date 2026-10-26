/**
 * Phase 2I edit rate: a RATIONAL frame rate (frames per second = num / den). Canonical edit time is integer
 * milliseconds; frames are derived from ABSOLUTE positions only, never stored or summed, so rounding cannot accumulate
 * from item to item (an item's frame span is frameAtMs(end) − frameAtMs(start), not a rounded duration).
 */

export interface EditRate {
  num: number;
  den: number;
}

/** The edit rates Phase 2I supports (NTSC rates as exact rationals). */
export const EDIT_RATES: readonly EditRate[] = [
  { num: 24, den: 1 },
  { num: 24000, den: 1001 },
  { num: 25, den: 1 },
  { num: 30000, den: 1001 },
  { num: 30, den: 1 },
];

export const DEFAULT_EDIT_RATE: EditRate = { num: 24, den: 1 };

export const isEditRate = (r: EditRate): boolean =>
  EDIT_RATES.some((e) => e.num === r.num && e.den === r.den);

export const editRateLabel = (r: EditRate): string =>
  r.den === 1 ? `${r.num} fps` : `${(r.num / r.den).toFixed(3)} fps (${r.num}/${r.den})`;

/**
 * The edit rate for a stored decimal frame rate (the bible's `defaultFrameRate`, `numeric(7,3)` in the database): 23.976 → 24000/1001,
 * 29.97 → 30000/1001, 24 / 25 / 30 exactly. Anything else is not a supported edit rate (`exact: false`) and falls back
 * to 24 fps, said so rather than guessed.
 */
export function editRateFromFps(fps: number | null | undefined): { rate: EditRate; exact: boolean } {
  if (typeof fps === "number" && Number.isFinite(fps)) {
    const match = EDIT_RATES.find((r) => Math.abs(r.num / r.den - fps) < 0.005);
    if (match) return { rate: match, exact: true };
  }
  return { rate: DEFAULT_EDIT_RATE, exact: false };
}

function assertMs(ms: number) {
  if (!Number.isSafeInteger(ms) || ms < 0)
    throw new Error(`Edit time must be a non-negative integer ms (${ms}).`);
}

/** The frame that contains the absolute instant `ms` (0-based): floor(ms · num / (den · 1000)), in integers. */
export function frameAtMs(ms: number, rate: EditRate): number {
  assertMs(ms);
  return Math.floor((ms * rate.num) / (rate.den * 1000));
}

/** The first integer millisecond that falls in `frame` (inverse of frameAtMs). */
export function msAtFrame(frame: number, rate: EditRate): number {
  if (!Number.isSafeInteger(frame) || frame < 0)
    throw new Error(`Frame must be a non-negative integer (${frame}).`);
  return Math.ceil((frame * rate.den * 1000) / rate.num);
}

/** Non-drop-frame timecode HH:MM:SS:FF of a frame (nominal rate = round(num / den)); display only. */
export function frameTimecode(frame: number, rate: EditRate): string {
  const nominal = Math.round(rate.num / rate.den);
  const ff = frame % nominal;
  const totalSeconds = Math.floor(frame / nominal);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(Math.floor(totalSeconds / 3600))}:${pad(Math.floor(totalSeconds / 60) % 60)}:${pad(totalSeconds % 60)}:${pad(ff)}`;
}

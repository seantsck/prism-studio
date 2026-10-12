import type { Waveform } from "./schemas";

/**
 * Deterministic waveform peaks. Pure: the same samples always give byte-identical output, so peaks can be
 * compared, cached and stored next to the take.
 *
 * `channels` are decoded PCM sample arrays (any channel count) in -1..1. The result has `sampleCount`
 * buckets (fewer when the audio is shorter than that), each holding the max absolute amplitude across all
 * channels in the bucket, normalised so the loudest bucket is 1 (silence stays 0).
 */
export const DEFAULT_WAVEFORM_SAMPLES = 500;

export function computePeaks(
  channels: ReadonlyArray<ArrayLike<number>>,
  durationMs: number,
  sampleCount: number = DEFAULT_WAVEFORM_SAMPLES,
): Waveform {
  if (channels.length === 0) throw new Error("No audio channels to analyse");
  const frames = Math.min(...channels.map((c) => c.length));
  if (frames === 0) throw new Error("Audio contains no samples");
  const buckets = Math.max(1, Math.min(sampleCount, frames));
  const raw = new Array<number>(buckets).fill(0);

  for (let b = 0; b < buckets; b++) {
    const start = Math.floor((b * frames) / buckets);
    const end = Math.max(start + 1, Math.floor(((b + 1) * frames) / buckets));
    let peak = 0;
    for (const ch of channels) {
      for (let i = start; i < end; i++) {
        const v = Math.abs(ch[i] ?? 0);
        if (v > peak) peak = v;
      }
    }
    raw[b] = peak;
  }
  const max = Math.max(...raw);
  const peaks = raw.map((v) => (max > 0 ? Math.round((v / max) * 1000) / 1000 : 0));
  return { version: 1, sampleCount: buckets, peaks, durationMs: Math.max(0, Math.round(durationMs)) };
}

/** Resamples stored peaks to `count` bars for display (max-pooling keeps transients visible). */
export function downsamplePeaks(peaks: readonly number[], count: number): number[] {
  if (count <= 0) return [];
  if (peaks.length <= count) return [...peaks];
  const out: number[] = [];
  for (let i = 0; i < count; i++) {
    const start = Math.floor((i * peaks.length) / count);
    const end = Math.max(start + 1, Math.floor(((i + 1) * peaks.length) / count));
    out.push(Math.max(...peaks.slice(start, end)));
  }
  return out;
}

import { describe, expect, it } from "vitest";
import { computePeaks, downsamplePeaks } from "@/domain/waveform";

describe("waveform peaks", () => {
  it("is deterministic and normalised to the loudest bucket", () => {
    const samples = Float32Array.from({ length: 1000 }, (_, i) => Math.sin(i / 10) * (i / 1000));
    const a = computePeaks([samples], 1000, 50);
    const b = computePeaks([samples], 1000, 50);
    expect(a).toEqual(b);
    expect(a.sampleCount).toBe(50);
    expect(Math.max(...a.peaks)).toBe(1);
    expect(a.peaks.every((p) => p >= 0 && p <= 1)).toBe(true);
  });

  it("uses the max across channels", () => {
    const left = new Float32Array(100).fill(0.1);
    const right = new Float32Array(100).fill(0);
    right[50] = 0.9;
    const w = computePeaks([left, right], 100, 10);
    expect(w.peaks[5]).toBe(1);
    expect(w.peaks[0]).toBeCloseTo(0.111, 2);
  });

  it("never produces more buckets than samples", () => {
    expect(computePeaks([new Float32Array([0.5, -0.5, 0.25])], 10, 500).sampleCount).toBe(3);
  });

  it("rejects missing or empty audio", () => {
    expect(() => computePeaks([], 0)).toThrow(/No audio channels/);
    expect(() => computePeaks([new Float32Array()], 0)).toThrow(/no samples/);
  });

  it("max-pools when downsampling for display", () => {
    expect(downsamplePeaks([0, 1, 0, 0, 0, 0.5], 3)).toEqual([1, 0, 0.5]);
    expect(downsamplePeaks([0.2, 0.4], 10)).toEqual([0.2, 0.4]);
  });
});

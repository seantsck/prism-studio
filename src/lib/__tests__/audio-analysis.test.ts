import { describe, expect, it } from "vitest";
import { AudioAnalysisError, analyzeAudio } from "../audio-analysis";
import { makeWav } from "./audio-fixtures";

describe("audio analysis (server metadata is canonical)", () => {
  it("reports duration, sample rate and channels read from the file itself", async () => {
    const wav = makeWav({ seconds: 2.5, sampleRate: 16000, channels: 1 });
    const a = await analyzeAudio(wav);
    expect(a.durationMs).toBe(2500);
    expect(a.sampleRate).toBe(16000);
    expect(a.channels).toBe(1);
    expect(a.durationFrom).toBe("metadata");
  });

  it("matches known durations for stereo audio at another sample rate", async () => {
    const a = await analyzeAudio(makeWav({ seconds: 1.234, sampleRate: 44100, channels: 2 }));
    expect(a.durationMs).toBe(1234);
    expect(a.channels).toBe(2);
    expect(a.sampleRate).toBe(44100);
  });

  it("produces a normalised waveform with the requested resolution", async () => {
    const a = await analyzeAudio(makeWav({ seconds: 1, envelope: (t) => t }), { waveformSamples: 100 });
    expect(a.waveformStatus).toBe("ok");
    expect(a.waveform?.version).toBe(1);
    expect(a.waveform?.sampleCount).toBe(100);
    expect(a.waveform?.peaks).toHaveLength(100);
    expect(Math.max(...(a.waveform?.peaks ?? []))).toBe(1);
    // A rising envelope: the end is louder than the start.
    const peaks = a.waveform!.peaks;
    expect(peaks[95]).toBeGreaterThan(peaks[5]);
    expect(a.waveform?.durationMs).toBe(a.durationMs);
  });

  it("is deterministic: same input, identical waveform", async () => {
    const wav = makeWav({ seconds: 0.8, frequency: 300 });
    const [a, b] = await Promise.all([analyzeAudio(wav), analyzeAudio(wav)]);
    expect(a.waveform).toEqual(b.waveform);
    expect(a.durationMs).toBe(b.durationMs);
  });

  it("represents silence as zero peaks rather than failing", async () => {
    const a = await analyzeAudio(makeWav({ seconds: 0.5, frequency: 0 }));
    expect(a.waveform?.peaks.every((p) => p === 0)).toBe(true);
  });

  it("fails clearly on empty and invalid audio", async () => {
    await expect(analyzeAudio(new Uint8Array())).rejects.toBeInstanceOf(AudioAnalysisError);
    await expect(analyzeAudio(new Uint8Array(2000).fill(7))).rejects.toThrow(
      /could not be read as audio|No playable audio/,
    );
    const truncated = makeWav({ seconds: 1 }).slice(0, 30);
    await expect(analyzeAudio(truncated)).rejects.toBeInstanceOf(AudioAnalysisError);
  });
});

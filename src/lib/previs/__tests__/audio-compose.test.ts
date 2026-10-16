import { describe, expect, it } from "vitest";
import { buildPerformanceAudioPlan, layoutTimelineCues } from "@/domain/previs/audio-mix";
import {
  AudioPrepError,
  mixPlanToPcm,
  prepareAudioTrack,
  type DecodedAudio,
  type PrepareEnv,
} from "../audio-compose";

const RATE = 48_000;
const frames = (ms: number) => Math.round((ms / 1000) * RATE);

/** deterministic synthetic tone (no audio files are committed) */
function tone(freq: number, ms: number, channels = 1, rate = RATE): DecodedAudio {
  const n = Math.round((ms / 1000) * rate);
  const ch = () =>
    Float32Array.from({ length: n }, (_, i) => 0.5 * Math.sin((2 * Math.PI * freq * i) / rate));
  return { sampleRate: rate, channels: Array.from({ length: channels }, ch) };
}

// pre-roll 500 · A 440 Hz 600 ms · gap 300 · B 660 Hz 800 ms · post-roll 200  → 2400 ms
const plan = () =>
  buildPerformanceAudioPlan({
    renderDurationMs: 2400,
    shotDurationMs: 2400,
    cues: layoutTimelineCues(500, 300, [
      { assetId: "A", assetChecksum: null, durationMs: 600 },
      { assetId: "B", assetChecksum: null, durationMs: 800 },
    ]),
  })!;

const peak = (a: Float32Array, from: number, to: number) => {
  let m = 0;
  for (let i = from; i < to; i++) m = Math.max(m, Math.abs(a[i]!));
  return m;
};

describe("mixPlanToPcm (sample-exact placement on the Shot timeline)", () => {
  it("silence for the pre-roll, audio at the cue, silence in the gap, audio again, silence for the post-roll", () => {
    const pcm = mixPlanToPcm(plan(), [tone(440, 600), tone(660, 800)]);
    expect(pcm.sampleRate).toBe(RATE);
    expect(pcm.frames).toBe(frames(2400));
    expect(pcm.channels).toHaveLength(2);
    const L = pcm.channels[0]!;
    expect(peak(L, 0, frames(500))).toBe(0); // pre-roll
    expect(peak(L, frames(500), frames(1100))).toBeGreaterThan(0.4); // take A
    expect(peak(L, frames(1100), frames(1400))).toBe(0); // gap
    expect(peak(L, frames(1400), frames(2200))).toBeGreaterThan(0.4); // take B
    expect(peak(L, frames(2200), frames(2400))).toBe(0); // post-roll
    // the first sample of A lands exactly on the pre-roll boundary (a sine starts at 0, the next sample is not 0)
    expect(L[frames(500) + 1]).not.toBe(0);
    expect(L[frames(500) - 1]).toBe(0);
  });

  it("mono is duplicated to L and R; stereo keeps L and R", () => {
    const mono = mixPlanToPcm(plan(), [tone(440, 600, 1), tone(660, 800, 1)]);
    expect(Array.from(mono.channels[0]!.subarray(frames(600), frames(600) + 50))).toEqual(
      Array.from(mono.channels[1]!.subarray(frames(600), frames(600) + 50)),
    );
    const left = tone(440, 600, 1).channels[0]!;
    const right = tone(880, 600, 1).channels[0]!;
    const stereo = mixPlanToPcm(plan(), [{ sampleRate: RATE, channels: [left, right] }, tone(660, 800, 1)]);
    expect(stereo.channels[0]![frames(500) + 10]).toBeCloseTo(left[10]!, 6);
    expect(stereo.channels[1]![frames(500) + 10]).toBeCloseTo(right[10]!, 6);
    expect(stereo.channels[0]![frames(500) + 10]).not.toBeCloseTo(stereo.channels[1]![frames(500) + 10], 3);
  });

  it("trims a source that is longer than its cue", () => {
    const pcm = mixPlanToPcm(plan(), [tone(440, 1500), tone(660, 800)]); // A is 1500 ms but its cue is 600 ms
    const L = pcm.channels[0]!;
    expect(peak(L, frames(1100), frames(1400))).toBe(0); // the extra audio does not leak into the gap
  });

  it("a source shorter than its cue leaves silence; it is not stretched", () => {
    const pcm = mixPlanToPcm(plan(), [tone(440, 200), tone(660, 800)]); // A plays 200 of its 600 ms
    const L = pcm.channels[0]!;
    expect(peak(L, frames(500), frames(700))).toBeGreaterThan(0.4);
    expect(peak(L, frames(700), frames(1100))).toBe(0);
  });

  it("rejects audio decoded at the wrong rate rather than resampling by hand", () => {
    expect(() => mixPlanToPcm(plan(), [tone(440, 600, 1, 44_100), tone(660, 800)])).toThrow(AudioPrepError);
  });

  it("does not apply gain: a peak survives untouched", () => {
    const loud: DecodedAudio = { sampleRate: RATE, channels: [new Float32Array(frames(600)).fill(0.9)] };
    const pcm = mixPlanToPcm(plan(), [loud, tone(660, 800)]);
    expect(pcm.channels[0]![frames(500) + 100]).toBeCloseTo(0.9, 6);
  });
});

function env(over: Partial<PrepareEnv> & { bytes?: Record<string, Uint8Array> } = {}) {
  const fetched: string[] = [];
  const decoded: string[] = [];
  const e: PrepareEnv = {
    fetchBytes: async (id) => {
      fetched.push(id);
      return over.bytes?.[id] ?? new Uint8Array([1, 2, 3]);
    },
    sha256: async () => "0".repeat(64),
    decode: async (_b, rate) => {
      decoded.push("x");
      return tone(440, 600, 1, rate);
    },
    assetLabel: (id) => `Take ${id}`,
    ...over,
  };
  return { e, fetched, decoded };
}

describe("prepareAudioTrack", () => {
  it("fetches by asset id only and decodes each distinct asset once", async () => {
    const p = buildPerformanceAudioPlan({
      renderDurationMs: 4000,
      shotDurationMs: 4000,
      cues: layoutTimelineCues(0, 100, [
        { assetId: "A", assetChecksum: null, durationMs: 600 },
        { assetId: "A", assetChecksum: null, durationMs: 600 },
      ]),
    })!;
    const { e, fetched, decoded } = env();
    const pcm = await prepareAudioTrack(p, e);
    expect(fetched).toEqual(["A"]);
    expect(decoded).toHaveLength(1);
    expect(pcm.frames).toBe(frames(4000));
  });

  it("fails clearly (asset context, no URL) when a take cannot be decoded; it never drops dialogue", async () => {
    const { e } = env({
      decode: async () => {
        throw new Error("EncodingError https://example.test/secret?token=abc");
      },
    });
    const err = await prepareAudioTrack(plan(), e).catch((x) => x);
    expect(err).toBeInstanceOf(AudioPrepError);
    expect(err.assetId).toBe("A");
    expect(err.message).toContain("Take A");
    expect(err.message).not.toMatch(/https?:|token=/);
  });

  it("fails when the fetched bytes no longer match the take's checksum", async () => {
    const p = buildPerformanceAudioPlan({
      renderDurationMs: 2400,
      shotDurationMs: 2400,
      cues: layoutTimelineCues(500, 300, [{ assetId: "A", assetChecksum: "a".repeat(64), durationMs: 600 }]),
    })!;
    const { e } = env();
    await expect(prepareAudioTrack(p, e)).rejects.toThrow(/no longer matches/);
  });

  it("reports an unreadable asset by name", async () => {
    const { e } = env({
      fetchBytes: async () => {
        throw new Error("HTTP 404");
      },
    });
    await expect(prepareAudioTrack(plan(), e)).rejects.toThrow(
      /Could not read the selected take audio “Take A”/,
    );
  });

  it("cancels between steps and does not decode after an abort", async () => {
    const ac = new AbortController();
    const { e, decoded } = env({
      fetchBytes: async () => {
        ac.abort();
        return new Uint8Array([1]);
      },
    });
    await expect(prepareAudioTrack(plan(), e, { signal: ac.signal })).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(decoded).toHaveLength(0);
  });

  it("reports progress through fetch, decode and compose", async () => {
    const phases: string[] = [];
    const { e } = env();
    await prepareAudioTrack(plan(), e, { onProgress: (p) => phases.push(p.phase) });
    expect(phases[0]).toBe("fetching");
    expect(phases).toContain("decoding");
    expect(phases.at(-1)).toBe("composing");
  });
});

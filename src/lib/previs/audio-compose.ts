import type { PerformanceAudioPlan } from "@/domain/previs/audio-mix";

/**
 * Local composition of a previs audio plan into one PCM track. Nothing leaves the browser: take audio is fetched
 * through the authenticated Asset route (bytes, never a URL kept anywhere), decoded by the browser, and placed on
 * the Shot timeline sample-exactly.
 *
 *   plan cue → fetch bytes → verify checksum → decode (browser, resampled to the plan rate) → place → PCM
 *
 * Decoding is injected (`decode`) so the placement logic is deterministic and testable without a browser.
 */

export interface DecodedAudio {
  sampleRate: number;
  /** one Float32Array per channel (1 = mono, 2 = stereo; more are down-mixed to stereo by the caller's decoder) */
  channels: Float32Array[];
}

export interface PcmTrack {
  sampleRate: number;
  /** planar, always `channels` long (L, R) */
  channels: Float32Array[];
  frames: number;
}

export class AudioPrepError extends Error {
  constructor(
    message: string,
    readonly assetId?: string,
  ) {
    super(message);
    this.name = "AudioPrepError";
  }
}

const msToFrames = (ms: number, rate: number) => Math.round((ms / 1000) * rate);

/**
 * Places decoded cue audio on a silent track the length of the render. Mono is duplicated to L and R, stereo keeps
 * L/R. A source longer than its cue is trimmed to the cue; a shorter one leaves silence (it is never stretched).
 * No gain, normalisation or effects.
 */
export function mixPlanToPcm(plan: PerformanceAudioPlan, decoded: ReadonlyArray<DecodedAudio>): PcmTrack {
  if (decoded.length !== plan.cues.length)
    throw new AudioPrepError("The decoded audio does not match the mix plan.");
  const frames = msToFrames(plan.durationMs, plan.sampleRate);
  const out = Array.from({ length: plan.channels }, () => new Float32Array(frames));
  plan.cues.forEach((cue, i) => {
    const src = decoded[i]!;
    if (src.sampleRate !== plan.sampleRate)
      throw new AudioPrepError(
        `Audio ${cue.assetId} was decoded at ${src.sampleRate} Hz, expected ${plan.sampleRate} Hz.`,
        cue.assetId,
      );
    if (src.channels.length < 1) throw new AudioPrepError("Decoded audio has no channels.", cue.assetId);
    const start = msToFrames(cue.timelineStartMs, plan.sampleRate);
    const srcOffset = msToFrames(cue.sourceStartMs, plan.sampleRate);
    const want = msToFrames(cue.durationMs, plan.sampleRate);
    const srcLen = src.channels[0]!.length;
    const n = Math.max(0, Math.min(want, srcLen - srcOffset, frames - start));
    for (let ch = 0; ch < plan.channels; ch++) {
      // mono feeds both sides; stereo maps L→L, R→R
      const s = src.channels[Math.min(ch, src.channels.length - 1)]!;
      const dst = out[ch]!;
      for (let k = 0; k < n; k++) dst[start + k] = dst[start + k]! + s[srcOffset + k]!;
    }
  });
  return { sampleRate: plan.sampleRate, channels: out, frames };
}

export interface PrepareEnv {
  /** Fetch an asset's bytes through the authenticated asset route. */
  fetchBytes(assetId: string, signal?: AbortSignal): Promise<Uint8Array>;
  /** Hex SHA-256 of bytes. */
  sha256(bytes: Uint8Array): Promise<string>;
  /** Browser-native decode, resampled to `sampleRate`. */
  decode(bytes: Uint8Array, sampleRate: number): Promise<DecodedAudio>;
  /** A human label for error messages (asset name). */
  assetLabel?(assetId: string): string;
}

export interface PrepareProgress {
  done: number;
  total: number;
  phase: "fetching" | "decoding" | "composing";
}

/** Fetches, verifies and decodes every cue, then composes the track. Honours cancellation between steps. */
export async function prepareAudioTrack(
  plan: PerformanceAudioPlan,
  env: PrepareEnv,
  opts: { signal?: AbortSignal; onProgress?: (p: PrepareProgress) => void } = {},
): Promise<PcmTrack> {
  const abortIf = () => {
    if (opts.signal?.aborted) throw new DOMException("Previs render cancelled.", "AbortError");
  };
  const cache = new Map<string, DecodedAudio>(); // a take used twice is decoded once
  const decoded: DecodedAudio[] = [];
  let done = 0;
  for (const cue of plan.cues) {
    abortIf();
    const label = env.assetLabel?.(cue.assetId) ?? cue.assetId;
    let audio = cache.get(cue.assetId);
    if (!audio) {
      opts.onProgress?.({ done, total: plan.cues.length, phase: "fetching" });
      let bytes: Uint8Array;
      try {
        bytes = await env.fetchBytes(cue.assetId, opts.signal);
      } catch (err) {
        if (opts.signal?.aborted) throw new DOMException("Previs render cancelled.", "AbortError");
        throw new AudioPrepError(
          `Could not read the selected take audio “${label}”${err instanceof Error && err.message ? ` (${err.message})` : ""}.`,
          cue.assetId,
        );
      }
      abortIf();
      if (cue.assetChecksum && (await env.sha256(bytes)) !== cue.assetChecksum)
        throw new AudioPrepError(
          `The audio file for “${label}” no longer matches the take that was selected. Reload and render again.`,
          cue.assetId,
        );
      abortIf();
      opts.onProgress?.({ done, total: plan.cues.length, phase: "decoding" });
      try {
        audio = await env.decode(bytes, plan.sampleRate);
      } catch {
        throw new AudioPrepError(
          `This browser could not decode the selected take audio “${label}”. Previs was not rendered with audio.`,
          cue.assetId,
        );
      }
      cache.set(cue.assetId, audio);
    }
    decoded.push(audio);
    done++;
  }
  abortIf();
  opts.onProgress?.({ done, total: plan.cues.length, phase: "composing" });
  return mixPlanToPcm(plan, decoded);
}

/** Browser environment: same-origin authenticated fetch, WebCrypto hash, decodeAudioData on an offline context. */
export function browserPrepareEnv(labels?: Record<string, string>): PrepareEnv {
  return {
    async fetchBytes(assetId, signal) {
      const res = await fetch(`/api/assets/${assetId}`, { credentials: "same-origin", signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return new Uint8Array(await res.arrayBuffer());
    },
    async sha256(bytes) {
      const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
      return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
    },
    async decode(bytes, sampleRate) {
      // an OfflineAudioContext at the plan rate resamples on decode; it is never started, so no audio device is used
      const ctx = new OfflineAudioContext(2, 1, sampleRate);
      const buf = await ctx.decodeAudioData(bytes.slice().buffer as ArrayBuffer);
      const channels: Float32Array[] = [];
      for (let c = 0; c < Math.min(buf.numberOfChannels, 2); c++)
        channels.push(buf.getChannelData(c).slice());
      return { sampleRate: buf.sampleRate, channels };
    },
    assetLabel: (id) => labels?.[id] ?? id,
  };
}

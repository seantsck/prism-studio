import { parseBuffer } from "music-metadata";
import decode from "audio-decode";
import type { Waveform } from "@/domain/schemas";
import { computePeaks, DEFAULT_WAVEFORM_SAMPLES } from "@/domain/waveform";

/**
 * Server-side audio inspection. The browser's idea of a file's duration is only a hint; THIS is canonical.
 *
 *   duration / sample rate / channels / codec  ← music-metadata (container + header parsing, pure JS)
 *   waveform peaks                             ← decoded PCM via audio-decode (WASM codecs, no ffmpeg)
 *
 * No native binaries and no ffmpeg dependency, so this runs unchanged on serverless hosts. Trade-off:
 * decoding a long file in-process costs memory (a 50 MB upload is the hard cap), and exotic codecs
 * outside audio-decode's list fall back to metadata-only (waveformStatus "unavailable").
 */

export class AudioAnalysisError extends Error {
  constructor(
    /** Safe to show to the user. */
    readonly userMessage: string,
    options?: { cause?: unknown },
  ) {
    super(userMessage, options);
    this.name = "AudioAnalysisError";
  }
}

export interface AudioAnalysis {
  durationMs: number;
  sampleRate: number | null;
  channels: number | null;
  codec: string | null;
  container: string | null;
  bitrate: number | null;
  /** Where durationMs came from. */
  durationFrom: "metadata" | "decoded";
  waveform: Waveform | null;
  waveformStatus: "ok" | "unavailable";
}

export async function analyzeAudio(
  bytes: Uint8Array,
  opts: { waveformSamples?: number } = {},
): Promise<AudioAnalysis> {
  if (bytes.length === 0) throw new AudioAnalysisError("The audio file is empty.");

  let meta: Awaited<ReturnType<typeof parseBuffer>>;
  try {
    meta = await parseBuffer(bytes, undefined, { duration: true });
  } catch (cause) {
    throw new AudioAnalysisError("The file could not be read as audio.", { cause });
  }

  let pcm: { channelData: Float32Array[]; sampleRate: number } | null = null;
  try {
    const decoded = await decode(bytes);
    if (decoded.channelData.length > 0 && decoded.channelData[0].length > 0) pcm = decoded;
  } catch {
    pcm = null; // handled below: metadata-only analysis
  }

  const metaDurationMs =
    typeof meta.format.duration === "number" && Number.isFinite(meta.format.duration) && meta.format.duration > 0
      ? Math.round(meta.format.duration * 1000)
      : null;
  const decodedDurationMs = pcm ? Math.round((pcm.channelData[0].length / pcm.sampleRate) * 1000) : null;

  const durationMs = metaDurationMs ?? decodedDurationMs;
  if (!durationMs || durationMs <= 0) {
    throw new AudioAnalysisError("No playable audio was found in this file.");
  }

  let waveform: Waveform | null = null;
  if (pcm) {
    waveform = computePeaks(pcm.channelData, durationMs, opts.waveformSamples ?? DEFAULT_WAVEFORM_SAMPLES);
  }

  return {
    durationMs,
    sampleRate: meta.format.sampleRate ?? pcm?.sampleRate ?? null,
    channels: meta.format.numberOfChannels ?? pcm?.channelData.length ?? null,
    codec: meta.format.codec ?? null,
    container: meta.format.container ?? null,
    bitrate: meta.format.bitrate ? Math.round(meta.format.bitrate) : null,
    durationFrom: metaDurationMs != null ? "metadata" : "decoded",
    waveform,
    waveformStatus: waveform ? "ok" : "unavailable",
  };
}

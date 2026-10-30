/**
 * Media-processing abstraction (Phase 2C). Business/domain code depends on THIS interface only: no ffmpeg
 * argument strings, no shell, no file paths outside a processor-controlled temp directory.
 *
 * The first implementation is FfmpegMediaProcessor (src/media/ffmpeg.ts). Everything is bytes-in / bytes-out so
 * callers never choose a filesystem location.
 */

export type MediaKind = "video" | "image" | "audio" | "unknown";

/** Container families Prism will hand to a decoder. Anything else is refused before any tool runs. */
export type MediaFormat = "mp4" | "webm" | "png" | "jpeg" | "webp";

export interface MediaProbe {
  kind: MediaKind;
  format: MediaFormat;
  /** Container name as reported by the probe tool (e.g. "mov,mp4,m4a,3gp,3g2,mj2"). */
  container: string | null;
  videoCodec: string | null;
  audioCodec: string | null;
  width: number | null;
  height: number | null;
  fps: number | null;
  durationMs: number | null;
  hasAudio: boolean;
  audioChannels: number | null;
  audioSampleRate: number | null;
  bitRate: number | null;
  byteSize: number;
}

export interface MediaOutput {
  bytes: Uint8Array;
  mime: string;
  extension: string;
  probe: MediaProbe;
}

export interface MediaLimits {
  maxInputBytes: number;
  maxOutputBytes: number;
  /** Wall-clock limit for ONE tool invocation. */
  timeoutMs: number;
  /** Width × height ceiling (decompression-bomb guard). */
  maxPixels: number;
  maxDurationMs: number;
}

export const DEFAULT_MEDIA_LIMITS: MediaLimits = {
  maxInputBytes: 256 * 1024 * 1024,
  maxOutputBytes: 512 * 1024 * 1024,
  timeoutMs: 120_000,
  maxPixels: 8192 * 4608,
  maxDurationMs: 10 * 60_000,
};

export const MEDIA_ERROR_CODES = [
  "unavailable",
  "unsupported_media",
  "too_large",
  "too_long",
  "timeout",
  "process_failed",
  "invalid_parameters",
] as const;
export type MediaErrorCode = (typeof MEDIA_ERROR_CODES)[number];

export class MediaError extends Error {
  constructor(
    readonly code: MediaErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "MediaError";
  }
}

export interface PixelRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ConformSpec {
  crop: PixelRect | null;
  pad: { frame: { width: number; height: number }; placement: PixelRect } | null;
  /** Keep only the first `trimMs` of the output. */
  trimMs: number | null;
}

export interface FrameOutput {
  atMs: number;
  bytes: Uint8Array;
  mime: "image/png";
  width: number;
  height: number;
}

export interface MediaProcessorIdentity {
  /** Stable adapter name; part of every derivation's identity. */
  name: string;
  /** Bump when the adapter's output semantics change; part of every derivation's identity. */
  adapterVersion: string;
  /** The underlying tool's own version string (recorded, not part of the identity). */
  toolVersion: string;
}

export interface MediaProcessor {
  identity(): Promise<MediaProcessorIdentity>;
  available(): Promise<boolean>;
  probe(bytes: Uint8Array): Promise<MediaProbe>;
  extractFrame(bytes: Uint8Array, atMs: number): Promise<FrameOutput>;
  extractFrames(bytes: Uint8Array, atMs: number[]): Promise<FrameOutput[]>;
  cropVideo(bytes: Uint8Array, rect: PixelRect): Promise<MediaOutput>;
  trimVideo(bytes: Uint8Array, durationMs: number): Promise<MediaOutput>;
  /**
   * 3A.4D: the exact window [startMs, endMs) of a video, decoded and RE-ENCODED (never stream-copied from an earlier
   * keyframe), audio stripped, with fixed encoder settings. Refuses invalid bounds. Used for cut-edge clips.
   */
  extractWindow(bytes: Uint8Array, startMs: number, endMs: number): Promise<MediaOutput>;
  scaleVideo(bytes: Uint8Array, width: number, height: number): Promise<MediaOutput>;
  /** Scales a still image to exactly width×height (PNG out). Used to bound analyzer inputs; originals are kept. */
  scaleImage(bytes: Uint8Array, width: number, height: number): Promise<MediaOutput>;
  /** Crop and/or pad and/or trim in ONE re-encode (a single generation of quality loss). */
  conform(bytes: Uint8Array, spec: ConformSpec): Promise<MediaOutput>;
  generateThumbnail(bytes: Uint8Array, opts?: { atMs?: number; width?: number }): Promise<MediaOutput>;
  generateContactSheet(
    frames: Uint8Array[],
    opts?: { columns?: number; cellWidth?: number },
  ): Promise<MediaOutput>;
}

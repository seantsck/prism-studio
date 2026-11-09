import type { EditRate } from "@/domain/edit/edit-rate";
import type { RenderManifest } from "@/domain/edit/render-manifest";

/**
 * Phase 5B-V4: THE delivery profile of a final Episode render. One deterministic profile, versioned: every segment,
 * the assembly and the verification use exactly these parameters, and they are part of every segment's cache identity
 * (a different profile never reuses a segment).
 *
 *   container  MP4 (+faststart)
 *   video      H.264 (libx264), yuv420p, constant frame rate = the edit's rational edit rate (the project's delivery
 *              rate: Ojou-sama 24/1), closed GOP of 2 s, scene-cut off (identical segment structure for concat)
 *   audio      AAC-LC 48 kHz stereo 192 kb/s in the final file; segments carry exact-length PCM (no AAC priming drift)
 *   canvas     the manifest's delivery size when the Bible records one, else 1920 wide at the Bible's aspect ratio
 *              (Ojou-sama 2.39:1 → 1920×804); never cropped: every source is fit inside and letterboxed / pillarboxed
 */

export const RENDER_PROFILE_ID = "prism-5b-delivery-h264-v1";
/** Bump when the renderer's output semantics change (filters, encoder settings): every segment key changes with it. */
export const RENDERER_VERSION = "1";

export const AUDIO_SAMPLE_RATE = 48_000;

export interface RenderProfile {
  id: typeof RENDER_PROFILE_ID;
  rendererVersion: string;
  container: "mp4";
  fps: EditRate;
  canvas: { width: number; height: number };
  video: {
    codec: "h264";
    encoder: "libx264";
    preset: string;
    crf: number;
    pixFmt: "yuv420p";
    gopFrames: number;
  };
  audio: { codec: "aac"; bitrate: "192k"; sampleRate: typeof AUDIO_SAMPLE_RATE; channels: 2 };
}

const even = (n: number) => Math.max(2, 2 * Math.round(n / 2));

/** "2.39:1", "16:9", "1.85" → width / height; null when it cannot be read. */
export function parseAspectRatio(text: string | null | undefined): number | null {
  const m = /^\s*(\d+(?:\.\d+)?)\s*(?::|x|\/)\s*(\d+(?:\.\d+)?)\s*$/i.exec(text ?? "");
  if (m) return Number(m[2]) > 0 ? Number(m[1]) / Number(m[2]) : null;
  const n = Number(text);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export class RenderProfileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RenderProfileError";
  }
}

/**
 * The delivery profile for a manifest's target. `width` overrides the default canvas width (tests and previews render a
 * smaller canvas at the same aspect ratio); `preset` the x264 speed preset. Both are recorded in the profile, so a
 * different choice is a different profile identity.
 */
export function deliveryProfile(
  target: RenderManifest["target"],
  opts: { width?: number; preset?: string } = {},
): RenderProfile {
  let canvas: { width: number; height: number };
  if (target.width && target.height && !opts.width)
    canvas = { width: even(target.width), height: even(target.height) };
  else {
    const ar = parseAspectRatio(target.aspectRatio) ?? 16 / 9;
    const width = even(opts.width ?? 1920);
    canvas = { width, height: even(width / ar) };
  }
  const fps = { num: target.editRate.num, den: target.editRate.den };
  if (!(fps.num > 0 && fps.den > 0)) throw new RenderProfileError("The edit rate is not valid.");
  return {
    id: RENDER_PROFILE_ID,
    rendererVersion: RENDERER_VERSION,
    container: "mp4",
    fps,
    canvas,
    video: {
      codec: "h264",
      encoder: "libx264",
      preset: opts.preset ?? "medium",
      crf: 18,
      pixFmt: "yuv420p",
      gopFrames: Math.max(1, Math.round((2 * fps.num) / fps.den)),
    },
    audio: { codec: "aac", bitrate: "192k", sampleRate: AUDIO_SAMPLE_RATE, channels: 2 },
  };
}

export const fpsValue = (p: Pick<RenderProfile, "fps">) => p.fps.num / p.fps.den;
export const canvasLabel = (p: Pick<RenderProfile, "canvas">) => `${p.canvas.width}×${p.canvas.height}`;

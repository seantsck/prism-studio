import {
  evaluateCameraPath,
  quaternionToEuler,
  sampleFrameTimes,
  type CameraPath,
  type CameraState,
} from "@/domain/previs/camera-path";
import type { Vec3 } from "@/domain/previs/types";
import type { PcmTrack } from "./audio-compose";

/**
 * Local previs rendering, split so each stage can be tested without the others:
 *
 *   frame sampling      sampleFrameTimes (domain)
 *   camera evaluation   evaluateCameraPath (domain; THE evaluator, shared with playback)
 *   scene rendering     FrameRenderer   (the 3D set adapter, an isolated production camera)
 *   video encoding      FrameEncoder    (MediaBunny in the browser, a fake in tests)
 *   asset persistence   server action   (private asset + provenance)
 *
 * Nothing here records the screen or reads the editor/navigation camera.
 */

export type PrevisContainer = "mp4" | "webm";

export interface RenderPose {
  position: Vec3;
  rotation: Vec3;
  focalLengthMm: number;
}

export type RenderedFrame = HTMLCanvasElement | OffscreenCanvas;

export interface FrameRenderer {
  renderFrame(pose: RenderPose, size: { width: number; height: number }): Promise<RenderedFrame>;
}

export interface FrameEncoder {
  /** Provide the composed performance audio. Called before start(); encoders without audio omit it. */
  setAudio?(pcm: PcmTrack): void;
  start(opts: { width: number; height: number; frameRate: number }): Promise<void>;
  addFrame(
    frame: RenderedFrame,
    index: number,
    timestampSeconds: number,
    durationSeconds: number,
  ): Promise<void>;
  finish(): Promise<{
    bytes: Uint8Array;
    container: PrevisContainer;
    codec: string;
    /** null / absent = a silent file */
    audioCodec?: string | null;
  }>;
  /** Releases everything; safe to call repeatedly and after finish. */
  cancel(): Promise<void>;
}

export interface PrevisProgress {
  frame: number;
  total: number;
  /** preparing_audio: fetch, decode and compose the performance audio; rendering: video frames; finalizing: mux */
  phase: "preparing_audio" | "rendering" | "finalizing";
}

export class PrevisCancelled extends Error {
  constructor() {
    super("Previs render cancelled.");
    this.name = "PrevisCancelled";
  }
}

export interface RenderPrevisOptions {
  path: CameraPath;
  size: { width: number; height: number };
  renderer: FrameRenderer;
  encoder: FrameEncoder;
  /** composed performance audio (48 kHz stereo); omit for a silent previs */
  audio?: PcmTrack | null;
  signal?: AbortSignal;
  onProgress?: (p: PrevisProgress) => void;
  /** yields to the browser between frames so the UI (cancel button, progress) stays responsive */
  yieldToUi?: () => Promise<void>;
}

export interface RenderPrevisResult {
  bytes: Uint8Array;
  container: PrevisContainer;
  codec: string;
  audioCodec: string | null;
  width: number;
  height: number;
  frameRate: number;
  durationMs: number;
  frameCount: number;
}

export const poseOf = (state: CameraState): RenderPose => ({
  position: state.position,
  rotation: quaternionToEuler(state.quaternion),
  focalLengthMm: state.focalLengthMm,
});

/**
 * Renders a camera path to an encoded video. Every frame time is sampled deterministically and evaluated by the
 * same function the editor timeline uses. On cancellation (or any error) the encoder is cancelled so its
 * encoder/muxer resources are released; the caller gets a PrevisCancelled / the original error.
 */
export async function renderPrevis(opts: RenderPrevisOptions): Promise<RenderPrevisResult> {
  const { path, size, renderer, encoder, signal, onProgress } = opts;
  if (path.keyframes.length < 2) throw new Error("A previs needs at least two camera keyframes.");
  const times = sampleFrameTimes(path.durationMs, path.frameRate);
  const frameDurationSeconds = 1 / path.frameRate;
  const yieldToUi = opts.yieldToUi ?? (() => new Promise<void>((r) => setTimeout(r, 0)));
  const abortIf = () => {
    if (signal?.aborted) throw new PrevisCancelled();
  };

  try {
    abortIf();
    if (opts.audio) {
      if (!encoder.setAudio) throw new Error("This encoder cannot write audio.");
      encoder.setAudio(opts.audio);
    }
    await encoder.start({ width: size.width, height: size.height, frameRate: path.frameRate });
    for (let i = 0; i < times.length; i++) {
      abortIf();
      const state = evaluateCameraPath(path, times[i]);
      if (!state) throw new Error("The camera path is empty.");
      const frame = await renderer.renderFrame(poseOf(state), size);
      abortIf();
      await encoder.addFrame(frame, i, i * frameDurationSeconds, frameDurationSeconds);
      onProgress?.({ frame: i + 1, total: times.length, phase: "rendering" });
      await yieldToUi();
    }
    abortIf();
    onProgress?.({ frame: times.length, total: times.length, phase: "finalizing" });
    const out = await encoder.finish();
    return {
      ...out,
      audioCodec: out.audioCodec ?? null,
      width: size.width,
      height: size.height,
      frameRate: path.frameRate,
      durationMs: path.durationMs,
      frameCount: times.length,
    };
  } catch (err) {
    await encoder.cancel().catch(() => undefined);
    throw err;
  }
}

/** The default previs size: the 2.39:1 production frame at half resolution (cheap to render and encode in a browser). */
export const PREVIS_RENDER_SIZE = { width: 956, height: 400 } as const;

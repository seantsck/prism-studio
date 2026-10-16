import type { PcmTrack } from "./audio-compose";
import type { FrameEncoder, PrevisContainer, RenderedFrame } from "./previs-render";

/**
 * Browser-local video encoding through MediaBunny (WebCodecs). The module is imported lazily, so it is only
 * downloaded when an operator actually renders a previs. Nothing leaves the browser.
 *
 * Strategy: MP4/H.264 first (plays everywhere), then WebM VP9, then VP8. The codec that was really used is
 * returned so provenance records the truth. When none can be encoded the caller gets a clear "unsupported" result.
 *
 * Audio (optional): the pair must be encodable TOGETHER and fit the container: MP4 carries H.264 + AAC, WebM
 * carries VP9/VP8 + Opus. Capability is detected, never assumed; if no compatible pair exists the caller is told
 * (audioUnavailable) and gets a video-only support to render a silent previs instead.
 */

type Mb = typeof import("mediabunny");

export type PrevisVideoCodec = "avc" | "vp9" | "vp8";
export type PrevisAudioCodec = "aac" | "opus";

export interface EncodingSupport {
  container: PrevisContainer;
  codec: PrevisVideoCodec;
  /** null = a silent (video-only) file */
  audioCodec: PrevisAudioCodec | null;
  /** audio was requested but no compatible encoder pair exists in this browser (a silent file is offered) */
  audioUnavailable?: boolean;
}

/** In preference order: container, video codec, and the audio codec that container carries. */
const CANDIDATES: Array<{
  container: PrevisContainer;
  video: PrevisVideoCodec;
  audio: PrevisAudioCodec;
}> = [
  { container: "mp4", video: "avc", audio: "aac" },
  { container: "webm", video: "vp9", audio: "opus" },
  { container: "webm", video: "vp8", audio: "opus" },
];

export interface AudioRequest {
  sampleRate: number;
  channels: number;
}

/** Which container/codec this browser can actually encode at this size, or null when none. */
export async function detectPrevisEncoding(
  size: { width: number; height: number },
  audio?: AudioRequest | null,
): Promise<EncodingSupport | null> {
  if (typeof window === "undefined" || typeof VideoEncoder === "undefined") return null;
  const mb: Mb = await import("mediabunny");
  const canVideo = async (codec: PrevisVideoCodec) => {
    try {
      return await mb.canEncodeVideo(codec, { width: size.width, height: size.height });
    } catch {
      return false;
    }
  };
  const canAudio = async (codec: PrevisAudioCodec, req: AudioRequest) => {
    if (typeof AudioEncoder === "undefined") return false;
    try {
      return await mb.canEncodeAudio(codec, { numberOfChannels: req.channels, sampleRate: req.sampleRate });
    } catch {
      return false;
    }
  };
  if (audio) {
    for (const cand of CANDIDATES) {
      if ((await canVideo(cand.video)) && (await canAudio(cand.audio, audio))) {
        return { container: cand.container, codec: cand.video, audioCodec: cand.audio };
      }
    }
  }
  for (const cand of CANDIDATES) {
    if (await canVideo(cand.video)) {
      return {
        container: cand.container,
        codec: cand.video,
        audioCodec: null,
        ...(audio ? { audioUnavailable: true } : {}),
      };
    }
  }
  return null;
}

export class MediaBunnyEncoder implements FrameEncoder {
  private mb: Mb | null = null;
  private output: import("mediabunny").Output | null = null;
  private source: import("mediabunny").CanvasSource | null = null;
  private target: import("mediabunny").BufferTarget | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private ctx: CanvasRenderingContext2D | null = null;
  private audioSource: import("mediabunny").AudioSampleSource | null = null;
  private audioTask: Promise<void> | null = null;
  private pcm: PcmTrack | null = null;
  private feedAbort = false;
  private done = false;

  constructor(private readonly support: EncodingSupport) {}

  /** Must be called before start(); only meaningful when the support names an audio codec. */
  setAudio(pcm: PcmTrack) {
    if (!this.support.audioCodec) throw new Error("This encoder was not set up for audio.");
    this.pcm = pcm;
  }

  async start(opts: { width: number; height: number; frameRate: number }) {
    const mb = (this.mb = await import("mediabunny"));
    // CanvasSource snapshots a canvas per add(); one private canvas is reused for every frame.
    const canvas = document.createElement("canvas");
    canvas.width = opts.width;
    canvas.height = opts.height;
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    if (!this.ctx) throw new Error("A 2D canvas is not available for encoding.");
    this.target = new mb.BufferTarget();
    this.output = new mb.Output({
      format: this.support.container === "mp4" ? new mb.Mp4OutputFormat() : new mb.WebMOutputFormat(),
      target: this.target,
    });
    this.source = new mb.CanvasSource(canvas, {
      codec: this.support.codec,
      bitrate: mb.QUALITY_MEDIUM,
    });
    this.output.addVideoTrack(this.source, { frameRate: opts.frameRate });
    if (this.support.audioCodec) {
      if (!this.pcm) throw new Error("Audio was requested but no audio track was provided.");
      this.audioSource = new mb.AudioSampleSource({
        codec: this.support.audioCodec,
        bitrate: mb.QUALITY_MEDIUM,
      });
      this.output.addAudioTrack(this.audioSource);
    }
    await this.output.start();
    // audio is fed alongside the video frames (not before or after) so the muxer can interleave both tracks
    if (this.audioSource && this.pcm) {
      const task = this.feedAudio(mb, this.audioSource, this.pcm);
      task.catch(() => undefined); // a failure is reported by finish(); a cancelled render must not leave it unhandled
      this.audioTask = task;
    }
  }

  private async feedAudio(
    mb: Mb,
    source: import("mediabunny").AudioSampleSource,
    pcm: PcmTrack,
  ): Promise<void> {
    const chunk = pcm.sampleRate; // one second per sample
    for (let at = 0; at < pcm.frames; at += chunk) {
      if (this.feedAbort) return;
      const n = Math.min(chunk, pcm.frames - at);
      // f32-planar: all of channel 0, then all of channel 1
      const data = new Float32Array(n * pcm.channels.length);
      pcm.channels.forEach((ch, c) => data.set(ch.subarray(at, at + n), c * n));
      const sample = new mb.AudioSample({
        data,
        format: "f32-planar",
        numberOfChannels: pcm.channels.length,
        sampleRate: pcm.sampleRate,
        timestamp: at / pcm.sampleRate,
      });
      try {
        await source.add(sample);
      } finally {
        sample.close();
      }
    }
    source.close();
  }

  async addFrame(frame: RenderedFrame, _index: number, ts: number, duration: number) {
    if (!this.ctx || !this.canvas || !this.source) throw new Error("The encoder was not started.");
    this.ctx.drawImage(frame as CanvasImageSource, 0, 0, this.canvas.width, this.canvas.height);
    await this.source.add(ts, duration);
  }

  async finish() {
    if (!this.output || !this.target || !this.source) throw new Error("The encoder was not started.");
    this.source.close();
    if (this.audioTask) await this.audioTask;
    await this.output.finalize();
    const buffer = this.target.buffer;
    if (!buffer) throw new Error("The encoder produced no data.");
    this.done = true;
    const bytes = new Uint8Array(buffer);
    this.release();
    return {
      bytes,
      container: this.support.container,
      codec: this.support.codec,
      audioCodec: this.support.audioCodec,
    };
  }

  async cancel() {
    this.feedAbort = true;
    if (!this.done && this.output && this.output.state !== "finalized" && this.output.state !== "canceled") {
      await this.output.cancel().catch(() => undefined);
    }
    this.release();
  }

  private release() {
    if (this.canvas) {
      this.canvas.width = 0; // drops the backing bitmap
      this.canvas.height = 0;
    }
    this.canvas = null;
    this.ctx = null;
    this.source = null;
    this.audioSource = null;
    this.audioTask = null;
    this.pcm = null;
    this.target = null;
    this.output = null;
    this.mb = null;
  }
}

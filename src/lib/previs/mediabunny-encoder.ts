import type { FrameEncoder, PrevisContainer, RenderedFrame } from "./previs-render";

/**
 * Browser-local video encoding through MediaBunny (WebCodecs). The module is imported lazily, so it is only
 * downloaded when an operator actually renders a previs. Nothing leaves the browser.
 *
 * Strategy: MP4/H.264 first (plays everywhere), then WebM VP9, then VP8. The codec that was really used is
 * returned so provenance records the truth. When none can be encoded the caller gets a clear "unsupported" result.
 */

type Mb = typeof import("mediabunny");

export interface EncodingSupport {
  container: PrevisContainer;
  codec: "avc" | "vp9" | "vp8";
}

const CANDIDATES: Array<{ container: PrevisContainer; codecs: Array<"avc" | "vp9" | "vp8"> }> = [
  { container: "mp4", codecs: ["avc"] },
  { container: "webm", codecs: ["vp9", "vp8"] },
];

/** Which container/codec this browser can actually encode at this size, or null when none. */
export async function detectPrevisEncoding(size: {
  width: number;
  height: number;
}): Promise<EncodingSupport | null> {
  if (typeof window === "undefined" || typeof VideoEncoder === "undefined") return null;
  const mb: Mb = await import("mediabunny");
  for (const cand of CANDIDATES) {
    for (const codec of cand.codecs) {
      try {
        if (await mb.canEncodeVideo(codec, { width: size.width, height: size.height })) {
          return { container: cand.container, codec };
        }
      } catch {
        /* try the next */
      }
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
  private done = false;

  constructor(private readonly support: EncodingSupport) {}

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
    await this.output.start();
  }

  async addFrame(frame: RenderedFrame, _index: number, ts: number, duration: number) {
    if (!this.ctx || !this.canvas || !this.source) throw new Error("The encoder was not started.");
    this.ctx.drawImage(frame as CanvasImageSource, 0, 0, this.canvas.width, this.canvas.height);
    await this.source.add(ts, duration);
  }

  async finish() {
    if (!this.output || !this.target || !this.source) throw new Error("The encoder was not started.");
    this.source.close();
    await this.output.finalize();
    const buffer = this.target.buffer;
    if (!buffer) throw new Error("The encoder produced no data.");
    this.done = true;
    const bytes = new Uint8Array(buffer);
    this.release();
    return { bytes, container: this.support.container, codec: this.support.codec };
  }

  async cancel() {
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
    this.target = null;
    this.output = null;
    this.mb = null;
  }
}

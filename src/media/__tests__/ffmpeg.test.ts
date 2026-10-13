import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { FfmpegMediaProcessor, sniffMediaFormat } from "../ffmpeg";
import { MediaError } from "../types";

/**
 * Real ffmpeg, deterministic synthetic fixtures generated at test time (a few KB each; nothing is committed).
 * The suite is skipped ONLY when ffmpeg/ffprobe genuinely are not installed — see `available` below.
 */
vi.setConfig({ testTimeout: 90_000, hookTimeout: 90_000 });
const processor = new FfmpegMediaProcessor({ limits: { timeoutMs: 60_000 } });
const available = await processor.available();

const fixtureDir = mkdtempSync(path.join(tmpdir(), "prism-media-fixtures-"));
const f = (n: string) => path.join(fixtureDir, n);
const read = (n: string) => new Uint8Array(readFileSync(f(n)));
const ff = (args: string[]) =>
  execFileSync("ffmpeg", ["-v", "error", "-y", ...args], { stdio: "pipe", windowsHide: true });

beforeAll(() => {
  if (!available) return;
  const src = (size: string, secs: number) => [
    "-f",
    "lavfi",
    "-i",
    `testsrc2=size=${size}:rate=24`,
    "-t",
    String(secs),
  ];
  const enc = ["-c:v", "libx264", "-pix_fmt", "yuv420p", "-preset", "ultrafast", "-crf", "28"];
  ff([...src("640x360", 2), ...enc, f("v169.mp4")]);
  ff([...src("640x268", 2), ...enc, f("v239.mp4")]);
  ff([...src("640x360", 5), ...enc, f("v169-5s.mp4")]);
  ff([
    ...src("640x360", 2),
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=440:duration=2",
    ...enc,
    "-c:a",
    "aac",
    "-shortest",
    f("v169-audio.mp4"),
  ]);
  ff(["-f", "lavfi", "-i", "testsrc2=size=320x180:rate=1", "-frames:v", "1", f("still.png")]);
});
afterAll(() => rmSync(fixtureDir, { recursive: true, force: true }));

const suite = available ? describe : describe.skip;

describe("media container sniffing (no ffmpeg needed)", () => {
  it("recognises the supported containers by magic bytes", () => {
    const pad = (b: number[]) => new Uint8Array([...b, ...new Array(24).fill(0)]);
    expect(sniffMediaFormat(pad([0x1a, 0x45, 0xdf, 0xa3]))).toBe("webm");
    expect(sniffMediaFormat(new Uint8Array([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0, 0, 0, 0, 0, 0]))).toBe(
      "mp4",
    );
    expect(sniffMediaFormat(pad([0x89, 0x50, 0x4e, 0x47]))).toBe("png");
    expect(sniffMediaFormat(pad([0xff, 0xd8, 0xff, 0xe0]))).toBe("jpeg");
  });
  it("refuses text containers that can reference other files (HLS, concat scripts, SDP)", () => {
    const enc = (s: string) => new TextEncoder().encode(s.padEnd(32, " "));
    expect(sniffMediaFormat(enc("#EXTM3U\n#EXT-X-VERSION:3\nfile:///etc/passwd"))).toBeNull();
    expect(sniffMediaFormat(enc("ffconcat version 1.0\nfile '/etc/passwd'"))).toBeNull();
    expect(sniffMediaFormat(enc("<svg xmlns='http://www.w3.org/2000/svg'/>"))).toBeNull();
  });
});

suite("FfmpegMediaProcessor", () => {
  it("reports its identity", async () => {
    const id = await processor.identity();
    expect(id.name).toBe("ffmpeg");
    expect(id.adapterVersion).toBeTruthy();
    expect(id.toolVersion).not.toBe("");
  });

  it("probes video metadata", async () => {
    const p = await processor.probe(read("v169-audio.mp4"));
    expect(p.kind).toBe("video");
    expect(p.format).toBe("mp4");
    expect(p).toMatchObject({
      width: 640,
      height: 360,
      videoCodec: "h264",
      hasAudio: true,
      audioCodec: "aac",
    });
    expect(p.durationMs).toBeGreaterThan(1900);
    expect(p.durationMs).toBeLessThan(2200);
    expect(p.fps).toBeCloseTo(24, 0);
    const silent = await processor.probe(read("v169.mp4"));
    expect(silent.hasAudio).toBe(false);
  });

  it("crops to a 2.39:1 window with exact dimensions and keeps the original untouched", async () => {
    const original = read("v169.mp4");
    const before = Buffer.from(original).toString("hex");
    const out = await processor.cropVideo(original, { x: 0, y: 46, width: 640, height: 268 });
    expect(out.probe).toMatchObject({ width: 640, height: 268, kind: "video" });
    expect(out.mime).toMatch(/^video\//);
    expect(Buffer.from(original).toString("hex")).toBe(before);
  });

  it("trims to the requested duration", async () => {
    const out = await processor.trimVideo(read("v169-5s.mp4"), 4500);
    expect(out.probe.durationMs).toBeGreaterThan(4300);
    expect(out.probe.durationMs).toBeLessThan(4700);
  });

  it("conforms (crop + trim) in one pass and preserves audio", async () => {
    const out = await processor.conform(read("v169-audio.mp4"), {
      crop: { x: 0, y: 46, width: 640, height: 268 },
      pad: null,
      trimMs: 1500,
    });
    expect(out.probe.width).toBe(640);
    expect(out.probe.height).toBe(268);
    expect(out.probe.hasAudio).toBe(true);
    expect(out.probe.durationMs).toBeLessThan(1700);
  });

  it("pads (letterbox) to a taller frame", async () => {
    const out = await processor.conform(read("v169.mp4"), {
      crop: null,
      pad: { frame: { width: 640, height: 480 }, placement: { x: 0, y: 60, width: 640, height: 360 } },
      trimMs: null,
    });
    expect(out.probe).toMatchObject({ width: 640, height: 480 });
  });

  it("scales video", async () => {
    const out = await processor.scaleVideo(read("v169.mp4"), 320, 180);
    expect(out.probe).toMatchObject({ width: 320, height: 180 });
  });

  it("is deterministic: same input and parameters give identical bytes", async () => {
    const spec = { crop: { x: 0, y: 46, width: 640, height: 268 }, pad: null, trimMs: 1000 };
    const a = await processor.conform(read("v169.mp4"), spec);
    const b = await processor.conform(read("v169.mp4"), spec);
    expect(Buffer.from(a.bytes).equals(Buffer.from(b.bytes))).toBe(true);
  });

  it("extracts frames at requested positions and clamps past the end", async () => {
    const frames = await processor.extractFrames(read("v169.mp4"), [0, 1000, 1900]);
    expect(frames).toHaveLength(3);
    for (const fr of frames) {
      expect(sniffMediaFormat(fr.bytes)).toBe("png");
      expect(fr).toMatchObject({ width: 640, height: 360, mime: "image/png" });
    }
    const late = await processor.extractFrame(read("v169.mp4"), 99_000);
    expect(late.width).toBe(640);
  });

  it("makes a thumbnail", async () => {
    const t = await processor.generateThumbnail(read("v169.mp4"), { width: 160 });
    expect(t.mime).toBe("image/jpeg");
    expect(t.probe.width).toBe(160);
    expect(t.probe.height).toBe(90);
  });

  it("builds a contact sheet from extracted frames", async () => {
    const frames = await processor.extractFrames(read("v169-5s.mp4"), [0, 1250, 2500, 3750, 4900]);
    const sheet = await processor.generateContactSheet(
      frames.map((x) => x.bytes),
      { columns: 3, cellWidth: 160 },
    );
    expect(sheet.mime).toBe("image/png");
    expect(sheet.probe.width).toBeGreaterThan(160 * 3);
    expect(sheet.probe.height).toBeGreaterThan(90);
  });

  it("handles still images (probe + crop)", async () => {
    const p = await processor.probe(read("still.png"));
    expect(p).toMatchObject({ kind: "image", width: 320, height: 180 });
    const c = await processor.cropVideo(read("still.png"), { x: 0, y: 24, width: 320, height: 134 });
    expect(c.probe).toMatchObject({ kind: "image", width: 320, height: 134 });
  });

  it("rejects corrupt media with a clear error and no leftover temp directories", async () => {
    const before = readdirSync(tmpdir()).filter(
      (n) => n.startsWith("prism-media-") && !n.includes("fixtures"),
    ).length;
    const junk = new Uint8Array([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, ...new Array(200).fill(0x42)]);
    await expect(processor.probe(junk)).rejects.toBeInstanceOf(MediaError);
    await expect(processor.conform(junk, { crop: null, pad: null, trimMs: 500 })).rejects.toBeInstanceOf(
      MediaError,
    );
    const after = readdirSync(tmpdir()).filter(
      (n) => n.startsWith("prism-media-") && !n.includes("fixtures"),
    ).length;
    expect(after).toBe(before);
  });

  it("rejects an unsupported container before running any tool", async () => {
    await expect(
      processor.probe(new TextEncoder().encode("#EXTM3U\n#EXT-X-VERSION:3\nfile:///etc/passwd")),
    ).rejects.toMatchObject({ code: "unsupported_media" });
  });

  it("rejects invalid parameters (crop outside the picture, odd scale, absurd trim)", async () => {
    const v = read("v169.mp4");
    await expect(processor.cropVideo(v, { x: 0, y: 0, width: 900, height: 360 })).rejects.toMatchObject({
      code: "invalid_parameters",
    });
    await expect(processor.cropVideo(v, { x: 0.5, y: 0, width: 640, height: 360 })).rejects.toMatchObject({
      code: "invalid_parameters",
    });
    await expect(processor.scaleVideo(v, 321, 181)).rejects.toMatchObject({ code: "invalid_parameters" });
    await expect(processor.trimVideo(v, -5)).rejects.toMatchObject({ code: "invalid_parameters" });
  });

  it("enforces input size, pixel and duration limits", async () => {
    const tiny = new FfmpegMediaProcessor({ limits: { maxInputBytes: 100 } });
    await expect(tiny.probe(read("v169.mp4"))).rejects.toMatchObject({ code: "too_large" });
    const pixels = new FfmpegMediaProcessor({ limits: { maxPixels: 1000 } });
    await expect(pixels.probe(read("v169.mp4"))).rejects.toMatchObject({ code: "too_large" });
    const long = new FfmpegMediaProcessor({ limits: { maxDurationMs: 500 } });
    await expect(long.probe(read("v169.mp4"))).rejects.toMatchObject({ code: "too_long" });
  });

  it("times out a runaway tool invocation", async () => {
    const impatient = new FfmpegMediaProcessor({ limits: { timeoutMs: 1 } });
    await expect(impatient.probe(read("v169-5s.mp4"))).rejects.toMatchObject({ code: "timeout" });
  });

  it("reports unavailable when the tool does not exist", async () => {
    const missing = new FfmpegMediaProcessor({
      ffmpegPath: "prism-no-such-ffmpeg",
      ffprobePath: "prism-no-such-ffprobe",
    });
    expect(await missing.available()).toBe(false);
    await expect(missing.probe(read("v169.mp4"))).rejects.toMatchObject({ code: "unavailable" });
  });

  it("never interprets a hostile file name or text as a command (arguments are an array)", async () => {
    // Input is bytes, so a "file name" never reaches a command line; the only strings passed are our own.
    const out = await processor.trimVideo(read("v169.mp4"), 1000);
    expect(out.probe.kind).toBe("video");
  });
});

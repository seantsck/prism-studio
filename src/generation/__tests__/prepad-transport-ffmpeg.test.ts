import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { planPrepadCenterCrop } from "@/domain/framing/transport";
import { ffmpegRunwayStartFrameTransport } from "../providers/runway/start-frame-transport";

/**
 * Real FFmpeg, production code path: the Gen-4.5 pre-pad transport image, centre-cropped exactly as Runway documents,
 * must be PIXEL-IDENTICAL to the Gen-4 Turbo contain-pad-v1 transport (whose delivery geometry is already validated).
 */
vi.setConfig({ testTimeout: 90_000, hookTimeout: 90_000 });

const CROP = {
  behavior: "center" as const,
  source: "https://docs.dev.runwayml.com/assets/inputs/",
  verifiedAt: "2026-11-10",
};
let dir = "";
let source: Uint8Array;

/** Decodes a PNG to raw RGB24 rows. */
function rgb(png: Uint8Array): Buffer {
  const f = path.join(dir, `d-${Math.random().toString(36).slice(2)}.png`);
  writeFileSync(f, png);
  return execFileSync("ffmpeg", ["-v", "error", "-i", f, "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], {
    maxBuffer: 64 * 1024 * 1024,
  });
}
const row = (raw: Buffer, width: number, y: number) => raw.subarray(y * width * 3, (y + 1) * width * 3);
const allZero = (b: Buffer) => b.every((v) => v === 0);

beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), "prism-prepad-"));
  const f = path.join(dir, "frame.png");
  // a 1536×642 picture with NO black pixel anywhere (so any surviving padding row is detectable)
  execFileSync("ffmpeg", [
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "color=c=gray:s=1536x642,geq=r='64+mod(X,160)':g='64+mod(Y,128)':b='96+mod(X+Y,96)'",
    "-frames:v",
    "1",
    f,
  ]);
  source = new Uint8Array(readFileSync(f));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("Gen-4.5 pre-pad transport through FFmpeg (no provider call)", () => {
  it("submits 1584×792 with the 1584×662 picture at 0,65; the documented centre crop equals the Turbo transport", async () => {
    const plan = planPrepadCenterCrop({
      source: { width: 1536, height: 642 },
      outputCanvas: { width: 1584, height: 672 },
      aspectRange: { min: 0.5, max: 2 },
      providerCrop: CROP,
    });
    if (!plan.ok) throw new Error(plan.reason);
    const g = plan.geometry;
    const asset = { bytes: source, mime: "image/png", filename: "frame.png" };
    const prepad = await ffmpegRunwayStartFrameTransport(asset, {
      targetCanvas: g.submittedCanvas,
      aspectRange: { min: 0.5, max: 2 },
      placement: { ...g.content, ...g.submittedOffset },
      expectedSource: g.source,
    });
    expect(prepad.target).toMatchObject({ width: 1584, height: 792, aspect: 2 });
    expect(prepad.content).toMatchObject({ width: 1584, height: 662, x: 0, y: 65, scaled: true });

    const sub = rgb(prepad.asset.bytes);
    expect(sub.length).toBe(1584 * 792 * 3);
    for (let y = 0; y < 65; y++) expect(allZero(row(sub, 1584, y))).toBe(true);
    for (let y = 727; y < 792; y++) expect(allZero(row(sub, 1584, y))).toBe(true);
    // every picture row is present and has no black pixel at all (the source has none)
    for (let y = 65; y < 727; y++) expect(row(sub, 1584, y).every((v) => v > 0)).toBe(true);

    // Runway's documented centre crop to 1584:672: rows 60..731
    const cropped = sub.subarray(60 * 1584 * 3, (60 + 672) * 1584 * 3);
    const turbo = await ffmpegRunwayStartFrameTransport(asset, {
      targetCanvas: { width: 1584, height: 672 },
      aspectRange: { min: 0.5, max: 2.358 },
    });
    expect(turbo.content).toMatchObject({ width: 1584, height: 662, x: 0, y: 5 });
    const turboRaw = rgb(turbo.asset.bytes);
    expect(Buffer.compare(Buffer.from(cropped), turboRaw)).toBe(0); // pixel-identical
    // in the effective frame: exactly 5 synthetic rows above and below, all 662 picture rows kept
    const eff = Buffer.from(cropped);
    for (let y = 0; y < 5; y++) expect(allZero(row(eff, 1584, y))).toBe(true);
    for (let y = 667; y < 672; y++) expect(allZero(row(eff, 1584, y))).toBe(true);
    for (let y = 5; y < 667; y++) expect(row(eff, 1584, y).every((v) => v > 0)).toBe(true);
  });

  it("refuses a source whose dimensions differ from the frozen record, and a placement off the contain scale", async () => {
    const asset = { bytes: source, mime: "image/png", filename: "frame.png" };
    await expect(
      ffmpegRunwayStartFrameTransport(asset, {
        targetCanvas: { width: 1584, height: 792 },
        aspectRange: { min: 0.5, max: 2 },
        placement: { width: 1584, height: 662, x: 0, y: 65 },
        expectedSource: { width: 1536, height: 640 },
      }),
    ).rejects.toThrow(/differ from the frozen transport record/);
    await expect(
      ffmpegRunwayStartFrameTransport(asset, {
        targetCanvas: { width: 1584, height: 792 },
        aspectRange: { min: 0.5, max: 2 },
        placement: { width: 1584, height: 664, x: 0, y: 64 },
      }),
    ).rejects.toThrow(/uniform contain scale/);
    // an out-of-range submitted canvas is still refused by the transport itself
    await expect(
      ffmpegRunwayStartFrameTransport(asset, {
        targetCanvas: { width: 1584, height: 672 },
        aspectRange: { min: 0.5, max: 2 },
      }),
    ).rejects.toThrow(/outside the documented prompt-image aspect range/);
  });

  it("does not modify the canonical bytes", async () => {
    const before = Buffer.from(source).toString("base64");
    await ffmpegRunwayStartFrameTransport(
      { bytes: source, mime: "image/png", filename: "frame.png" },
      {
        targetCanvas: { width: 1584, height: 792 },
        aspectRange: { min: 0.5, max: 2 },
        placement: { width: 1584, height: 662, x: 0, y: 65 },
        expectedSource: { width: 1536, height: 642 },
      },
    );
    expect(Buffer.from(source).toString("base64")).toBe(before);
  });
});

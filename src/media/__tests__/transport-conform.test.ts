import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { buildConformPlan, resolveConform } from "@/domain/framing/conform";
import { attemptTransportGeometry, type ProviderTransportGeometry } from "@/domain/framing/transport";
import { FfmpegMediaProcessor } from "../ffmpeg";

/**
 * Phase 5B acceptance regression: Runway Shot 3A came back as 1584×672 with the canonical 1536×642 frame contained
 * at 1584×662, x0 y5 (5 px provider-only padding top and bottom). The generic delivery crop (even-rounded centre crop,
 * then FFmpeg's chroma rounding) cut at y=4 and kept a 1 px near-black padding row. Delivery must now remove EXACTLY
 * the recorded transport padding, while requests without a transport keep the generic conform.
 */
vi.setConfig({ testTimeout: 90_000, hookTimeout: 90_000 });

const CANON = "e6ea3f97-6da1-523b-b573-b3a1c852fbb1";
const shot3aRequestOptions = {
  resolutionTier: "default",
  prismStartFrameTransport: {
    version: 1,
    policy: "contain-pad-v1",
    sourceAssetId: CANON,
    targetCanvas: { width: 1584, height: 672 },
    background: "black",
  },
};
const sizes: Record<string, { width: number; height: number }> = { [CANON]: { width: 1536, height: 642 } };
const shot3aTransport = () =>
  attemptTransportGeometry({
    providerOptions: shot3aRequestOptions,
    inputAssetIds: [CANON],
    sourceSize: (id) => sizes[id] ?? null,
  });
const plan = buildConformPlan({ targetAspectRatio: "2.39:1", framing: "crop", trimToMs: 4500 });
const probe = { width: 1584, height: 672, durationMs: 5000 };

describe("transport-aware delivery conform (pure)", () => {
  it("Shot 3A: transport is 1584×662 at x0 y5 inside the 1584×672 provider canvas", () => {
    expect(shot3aTransport()).toEqual({
      policy: "contain-pad-v1",
      sourceAssetId: CANON,
      canvas: { width: 1584, height: 672 },
      content: { x: 0, y: 5, width: 1584, height: 662 },
    });
  });

  it("removes exactly the transport padding (y=5, not y=4), ≈2.39:1, trimmed to 4.5 s", () => {
    const r = resolveConform(plan, probe, { transport: shot3aTransport() });
    expect(r.crop).toEqual({ x: 0, y: 5, width: 1584, height: 662 });
    expect(r.output).toEqual({ width: 1584, height: 662 });
    expect(Math.abs(1584 / 662 - 2.39)).toBeLessThan(0.01);
    expect(r.trimMs).toBe(4500);
    expect(r.warnings).toEqual([]);
    expect(r.notes.join(" ")).toContain("transport padding");
  });

  it("without a transport the generic conform is unchanged (even centre crop)", () => {
    expect(resolveConform(plan, probe).crop).toEqual({ x: 0, y: 4, width: 1584, height: 662 });
    expect(resolveConform(plan, probe, { transport: null }).crop).toEqual({
      x: 0,
      y: 4,
      width: 1584,
      height: 662,
    });
    expect(resolveConform(plan, { width: 1280, height: 720, durationMs: 5000 }).crop).toEqual({
      x: 0,
      y: 92,
      width: 1280,
      height: 536,
    });
  });

  it("an output that is not the transport canvas falls back to the generic crop, with a warning", () => {
    const r = resolveConform(
      plan,
      { width: 1280, height: 544, durationMs: 5000 },
      { transport: shot3aTransport() },
    );
    expect(r.crop).toEqual(resolveConform(plan, { width: 1280, height: 544, durationMs: 5000 }).crop);
    expect(r.warnings.join(" ")).toContain("transport canvas");
  });

  it("content that is not already the target ratio is centre-cropped INSIDE the transport content", () => {
    const t: ProviderTransportGeometry = {
      policy: "contain-pad-v1",
      sourceAssetId: "x",
      canvas: { width: 1584, height: 672 },
      content: { x: 0, y: 5, width: 1584, height: 662 },
    };
    const r = resolveConform(
      buildConformPlan({ targetAspectRatio: "16:9", framing: "crop", trimToMs: null }),
      probe,
      { transport: t },
    );
    expect(r.crop).toEqual({ x: 204, y: 5, width: 1176, height: 662 });
  });

  it("an unbound or forged transport source yields no transport geometry (generic conform)", () => {
    expect(
      attemptTransportGeometry({
        providerOptions: {
          prismStartFrameTransport: {
            ...shot3aRequestOptions.prismStartFrameTransport,
            sourceAssetId: "forged",
          },
        },
        inputAssetIds: [CANON],
        sourceSize: (id) => sizes[id] ?? null,
      }),
    ).toBeNull();
    expect(
      attemptTransportGeometry({ providerOptions: {}, inputAssetIds: [CANON], sourceSize: () => null }),
    ).toBeNull();
    expect(
      attemptTransportGeometry({
        providerOptions: shot3aRequestOptions,
        inputAssetIds: [CANON],
        sourceSize: () => null,
      }),
    ).toBeNull();
  });
});

const processor = new FfmpegMediaProcessor({ limits: { timeoutMs: 60_000 } });
const available = await processor.available();
const suite = available ? describe : describe.skip;
const dir = mkdtempSync(path.join(tmpdir(), "prism-transport-conform-"));
const f = (n: string) => path.join(dir, n);
const ff = (args: string[]) =>
  execFileSync("ffmpeg", ["-v", "error", "-y", ...args], { stdio: "pipe", windowsHide: true });

beforeAll(() => {
  if (!available) return;
  // A provider-shaped original: bright 1584×662 content at x0 y5 on black 1584×672 (5 px padding), 5 s at 24 fps.
  // Padded in RGB: on yuv420p FFmpeg would round the odd y=5 down to 4, as it does for crop.
  ff([
    "-f",
    "lavfi",
    "-i",
    "color=c=0xC8C8C8:size=1584x662:rate=24:duration=5",
    "-vf",
    "format=rgb24,pad=1584:672:0:5:color=black",
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    "-preset",
    "ultrafast",
    "-crf",
    "18",
    f("provider.mp4"),
  ]);
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** Mean luma of one row of the first frame of `file`. */
function rowLuma(file: string, row: number, width: number): number {
  const raw = execFileSync(
    "ffmpeg",
    [
      "-v",
      "error",
      "-i",
      file,
      "-frames:v",
      "1",
      "-vf",
      `format=gray,crop=${width}:1:0:${row}`,
      "-f",
      "rawvideo",
      "-",
    ],
    { stdio: ["ignore", "pipe", "pipe"], windowsHide: true, maxBuffer: 1 << 20 },
  );
  return raw.reduce((a, b) => a + b, 0) / raw.length;
}

suite("transport-aware delivery conform (real FFmpeg)", () => {
  it("the delivery master has no transport row, is 1584×662 and 4.5 s / 108 frames, and the original is untouched", async () => {
    const original = new Uint8Array(readFileSync(f("provider.mp4")));
    const before = Buffer.from(original);
    const r = resolveConform(plan, probe, { transport: shot3aTransport() });
    const out = await processor.conform(original, { crop: r.crop, pad: r.pad, trimMs: r.trimMs });
    const outFile = f("delivery.mp4");
    writeFileSync(outFile, out.bytes);
    const meta = JSON.parse(
      execFileSync(
        "ffprobe",
        [
          "-v",
          "error",
          "-select_streams",
          "v:0",
          "-count_frames",
          "-show_entries",
          "stream=width,height,nb_read_frames,r_frame_rate",
          "-of",
          "json",
          outFile,
        ],
        { windowsHide: true },
      ).toString(),
    ) as { streams: Array<{ width: number; height: number; nb_read_frames: string; r_frame_rate: string }> };
    const s = meta.streams[0]!;
    expect([s.width, s.height]).toEqual([1584, 662]);
    expect(s.r_frame_rate).toBe("24/1");
    expect(Number(s.nb_read_frames)).toBe(108);
    // the first and last rows are picture, not transport padding (padding is ~16 luma; content ~200)
    expect(rowLuma(outFile, 0, 1584)).toBeGreaterThan(150);
    expect(rowLuma(outFile, 661, 1584)).toBeGreaterThan(150);
    // the provider original is immutable
    expect(Buffer.from(original).equals(before)).toBe(true);
  });

  it("the old generic crop of the same file DID keep a dark padding row (the bug this fixes)", async () => {
    const original = new Uint8Array(readFileSync(f("provider.mp4")));
    const r = resolveConform(plan, probe);
    const out = await processor.conform(original, { crop: r.crop, pad: r.pad, trimMs: r.trimMs });
    writeFileSync(f("generic.mp4"), out.bytes);
    expect(rowLuma(f("generic.mp4"), 0, 1584)).toBeLessThan(60);
  });
});

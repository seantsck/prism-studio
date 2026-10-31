import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { FfmpegMediaProcessor } from "../ffmpeg";
import { MediaError } from "../types";

/**
 * Phase 3A.4D `extractWindow`: the exact cut-edge window, re-encoded (no stream copy), audio stripped. Synthetic media
 * generated at test time (24 fps with a 440 Hz tone). No network. Byte-identical output is only claimed within one
 * tool build, never across ffmpeg versions.
 */
vi.setConfig({ testTimeout: 90_000, hookTimeout: 90_000 });
const processor = new FfmpegMediaProcessor({ limits: { timeoutMs: 60_000 } });
const available = await processor.available();
const dir = mkdtempSync(path.join(tmpdir(), "prism-window-"));
let clip: Uint8Array;

beforeAll(() => {
  if (!available) return;
  const out = path.join(dir, "src.mp4");
  execFileSync(
    "ffmpeg",
    [
      "-v",
      "error",
      "-y",
      "-f",
      "lavfi",
      "-i",
      "testsrc2=size=320x180:rate=24:duration=6",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=440:duration=6",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-g",
      "48",
      "-c:a",
      "aac",
      out,
    ],
    { stdio: "pipe", windowsHide: true },
  );
  clip = new Uint8Array(readFileSync(out));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const suite = available ? describe : describe.skip;

/** Average PSNR of `window` against the source starting at `fromSec` (same length). */
function psnr(window: Uint8Array, fromSec: number): number {
  const w = path.join(dir, `w-${fromSec}.mp4`);
  writeFileSync(w, window);
  // ffmpeg reports the PSNR summary on stderr
  const r = spawnSync(
    "ffmpeg",
    [
      "-hide_banner",
      "-i",
      w,
      "-i",
      path.join(dir, "src.mp4"),
      "-lavfi",
      `[1:v]trim=start=${fromSec}:end=${fromSec + 2},setpts=PTS-STARTPTS[r];[0:v][r]psnr`,
      "-f",
      "null",
      "-",
    ],
    { windowsHide: true, encoding: "utf8" },
  );
  const m = /average:(inf|[\d.]+)/.exec(r.stderr ?? "");
  if (!m) throw new Error("ffmpeg reported no PSNR");
  return m[1] === "inf" ? 100 : Number(m[1]);
}

suite("extractWindow (cut-edge-static-v1 clips)", () => {
  it("keeps exactly the requested window, playable, audio stripped", async () => {
    const before = await processor.probe(clip);
    expect(before.hasAudio).toBe(true);
    // a start that is NOT on a keyframe (GOP 48 = 2 s): a stream copy would start early
    const out = await processor.extractWindow(clip, 2500, 4500);
    expect(["video/mp4", "video/webm"]).toContain(out.mime);
    expect(out.probe.kind).toBe("video");
    expect(out.probe.hasAudio).toBe(false);
    // frame-accurate within one frame at 24 fps
    expect(Math.abs((out.probe.durationMs ?? 0) - 2000)).toBeLessThanOrEqual(42);
    // it starts at source 2.5 s, NOT at the 2.0 s keyframe a stream copy would start from: the window matches the
    // source trimmed at 2.5 s far better (PSNR) than the source trimmed at 2.0 s
    const exact = psnr(out.bytes, 2.5);
    expect(exact).toBeGreaterThan(35);
    expect(exact).toBeGreaterThan(psnr(out.bytes, 2.0) + 15); // not the keyframe
    expect(exact).toBeGreaterThan(psnr(out.bytes, 2.5 - 1 / 24) + 10); // not even one frame early
  });

  it("a short side clamps (window shorter than 2 s) and stays bounded", async () => {
    const out = await processor.extractWindow(clip, 5000, 6000);
    expect(out.probe.durationMs!).toBeLessThanOrEqual(1042);
    expect(out.probe.hasAudio).toBe(false);
  });

  it("is deterministic within this tool build", async () => {
    const a = await processor.extractWindow(clip, 1000, 3000);
    const b = await processor.extractWindow(clip, 1000, 3000);
    const h = (x: Uint8Array) => createHash("sha256").update(x).digest("hex");
    expect(h(a.bytes)).toBe(h(b.bytes));
  });

  it("refuses invalid bounds", async () => {
    await expect(processor.extractWindow(clip, 3000, 3000)).rejects.toBeInstanceOf(MediaError);
    await expect(processor.extractWindow(clip, -1, 100)).rejects.toBeInstanceOf(MediaError);
    await expect(processor.extractWindow(clip, 7000, 8000)).rejects.toBeInstanceOf(MediaError);
  });
});

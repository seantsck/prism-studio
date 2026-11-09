import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { MOCK_VIDEO_WEBM_BASE64 } from "@/generation/providers/mock-video-fixture";

/**
 * Real media for the Phase 5B-V4 render tests, made locally with ffmpeg (no network): the free mock video clip (testsrc2
 * WebM, 5 s, no audio), a still PNG, and a 1 kHz tone WAV (a placed take's audio). Bytes + sha256.
 */
export const sha256 = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

export function ffmpegAvailable(): boolean {
  try {
    execFileSync(process.env.PRISM_STUDIO_FFMPEG_PATH ?? "ffmpeg", ["-hide_banner", "-version"], {
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}

function make(args: string[], ext: string): Uint8Array {
  const dir = mkdtempSync(path.join(tmpdir(), "prism-render-fixture-"));
  try {
    const out = path.join(dir, `out.${ext}`);
    execFileSync(process.env.PRISM_STUDIO_FFMPEG_PATH ?? "ffmpeg", [
      "-hide_banner",
      "-v",
      "error",
      ...args,
      "-y",
      out,
    ]);
    return new Uint8Array(readFileSync(out));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export const mockClipBytes = (): Uint8Array => new Uint8Array(Buffer.from(MOCK_VIDEO_WEBM_BASE64, "base64"));

/** A solid-colour still (16:9 unless sized), e.g. a Production Frame. */
export const stillPng = (color = "0x3060c0", w = 640, h = 360): Uint8Array =>
  make(["-f", "lavfi", "-i", `color=c=${color}:s=${w}x${h}`, "-frames:v", "1"], "png");

/** A tone of `ms` milliseconds (48 kHz mono WAV). */
export const toneWav = (ms: number, hz = 1000): Uint8Array =>
  make(
    [
      "-f",
      "lavfi",
      "-i",
      `sine=frequency=${hz}:sample_rate=48000:duration=${ms / 1000}`,
      "-c:a",
      "pcm_s16le",
    ],
    "wav",
  );

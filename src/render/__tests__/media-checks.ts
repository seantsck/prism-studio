import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * Phase 5B-V4 acceptance helpers: decode REAL pictures / sound of a rendered file with ffmpeg and compare them
 * (PSNR between frames, silence detection). Test-only; never used by the renderer.
 */
const FFMPEG = process.env.PRISM_STUDIO_FFMPEG_PATH ?? "ffmpeg";

function ff(args: string[]): string {
  const r = spawnSync(FFMPEG, ["-hide_banner", "-nostdin", ...args], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (r.status !== 0) throw new Error(`ffmpeg failed: ${r.stderr.split(/\r?\n/).slice(-4).join(" | ")}`);
  return r.stderr;
}

export class MediaLab {
  readonly dir = mkdtempSync(path.join(tmpdir(), "prism-render-lab-"));
  private n = 0;
  constructor(
    private readonly width: number,
    private readonly height: number,
  ) {}

  private file(bytes: Uint8Array, ext: string) {
    const f = path.join(this.dir, `in-${this.n++}.${ext}`);
    writeFileSync(f, bytes);
    return f;
  }

  private chain(fps: string | null = "24") {
    const { width: W, height: H } = this;
    return `${fps ? `fps=${fps},` : ""}scale=${W}:${H}:force_original_aspect_ratio=decrease:force_divisible_by=2,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1`;
  }

  /** The decoded frame of `video` at `ms` (PNG path). */
  frameAt(video: Uint8Array | string, ms: number): string {
    const src = typeof video === "string" ? video : this.file(video, "mp4");
    const out = path.join(this.dir, `f-${this.n++}.png`);
    ff(["-v", "error", "-ss", (ms / 1000).toFixed(6), "-i", src, "-frames:v", "1", "-y", out]);
    return out;
  }

  /** An image normalized exactly like a render segment (fit inside the canvas, letterbox). */
  normalizedStill(png: Uint8Array): string {
    const out = path.join(this.dir, `s-${this.n++}.png`);
    ff(["-v", "error", "-i", this.file(png, "png"), "-vf", this.chain(null), "-frames:v", "1", "-y", out]);
    return out;
  }

  /** Every source frame of a clip (at its own rate), normalized; index i is the frame at i / fps seconds. */
  sourceFrames(clip: Uint8Array, ext: string, fps: number): string[] {
    const sub = path.join(this.dir, `frames-${this.n++}`);
    ff([
      "-v",
      "error",
      "-i",
      this.file(clip, ext),
      "-vf",
      this.chain(String(fps)),
      "-start_number",
      "0",
      "-y",
      `${sub}-%03d.png`,
    ]);
    return readdirSync(this.dir)
      .filter((f) => f.startsWith(path.basename(sub)))
      .sort()
      .map((f) => path.join(this.dir, f));
  }

  /** A 50 / 50 blend of two frames (the middle of a linear cross dissolve). */
  blend(a: string, b: string): string {
    const out = path.join(this.dir, `b-${this.n++}.png`);
    ff([
      "-v",
      "error",
      "-i",
      a,
      "-i",
      b,
      "-filter_complex",
      "[0:v][1:v]blend=all_mode=average",
      "-frames:v",
      "1",
      "-y",
      out,
    ]);
    return out;
  }

  black(): string {
    const out = path.join(this.dir, `k-${this.n++}.png`);
    ff([
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      `color=c=black:s=${this.width}x${this.height}`,
      "-frames:v",
      "1",
      "-y",
      out,
    ]);
    return out;
  }

  /** PSNR (dB) of two same-size frames; Infinity when identical. */
  psnr(a: string, b: string): number {
    const err = ff([
      "-i",
      a,
      "-i",
      b,
      "-lavfi",
      "[0:v]format=yuv420p[x];[1:v]format=yuv420p[y];[x][y]psnr",
      "-f",
      "null",
      "-",
    ]);
    const m = /average:(inf|[\d.]+)/.exec(err);
    if (!m) throw new Error("no PSNR");
    return m[1] === "inf" ? Infinity : Number(m[1]);
  }

  /** Index of the candidate frame most similar to `frame`. */
  bestMatch(frame: string, candidates: string[]): number {
    let best = -1;
    let score = -Infinity;
    candidates.forEach((c, i) => {
      const s = this.psnr(frame, c);
      if (s > score) {
        score = s;
        best = i;
      }
    });
    return best;
  }

  /** The [start, end) ms intervals where the file's sound is above −40 dBFS. */
  soundIntervals(file: string): Array<[number, number]> {
    const err = ff(["-i", file, "-af", "silencedetect=n=-40dB:d=0.05", "-f", "null", "-"]);
    const starts = [...err.matchAll(/silence_start: ([\d.]+)/g)].map((m) => Number(m[1]) * 1000);
    const ends = [...err.matchAll(/silence_end: ([\d.]+)/g)].map((m) => Number(m[1]) * 1000);
    const d = /Duration: (\d+):(\d+):([\d.]+)/.exec(err);
    const total = d ? (Number(d[1]) * 3600 + Number(d[2]) * 60 + Number(d[3])) * 1000 : Infinity;
    // sound = between a silence end and the next silence start (or the end of the file); silencedetect also reports a
    // silence "ending" at the end of the stream, which is not sound
    const out: Array<[number, number]> = [];
    ends.forEach((e) => {
      const next = starts.find((s) => s > e) ?? total;
      if (next - e > 60) out.push([e, next]);
    });
    return out;
  }

  write(bytes: Uint8Array, ext: string): string {
    return this.file(bytes, ext);
  }

  read(file: string): Uint8Array {
    return new Uint8Array(readFileSync(file));
  }

  dispose() {
    rmSync(this.dir, { recursive: true, force: true });
  }
}

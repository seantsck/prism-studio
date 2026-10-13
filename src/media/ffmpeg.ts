import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  DEFAULT_MEDIA_LIMITS,
  MediaError,
  type ConformSpec,
  type FrameOutput,
  type MediaFormat,
  type MediaLimits,
  type MediaOutput,
  type MediaProbe,
  type MediaProcessor,
  type MediaProcessorIdentity,
  type PixelRect,
} from "./types";

/**
 * FFmpeg/ffprobe implementation of MediaProcessor.
 *
 * Safety model (media files are untrusted input):
 *  - arguments are ALWAYS an array handed to execFile: there is no shell and no string concatenation of
 *    user-supplied text into a command line. The only strings we place on a command line are numbers we
 *    formatted ourselves and file names we generated inside a private temp directory.
 *  - the container is identified from the file's own magic bytes BEFORE any tool runs and then FORCED with
 *    `-f`, so ffmpeg never auto-detects a text-based demuxer (HLS playlists, concat scripts) that can reference
 *    other files; `-protocol_whitelist file` additionally blocks network protocols.
 *  - every invocation has a wall-clock timeout, input/output size limits and a pixel/duration ceiling.
 *  - temp directories are private (mkdtemp) and removed in `finally`, success or failure.
 */

export const FFMPEG_ADAPTER_NAME = "ffmpeg";
/** Bump when output semantics change (encoder settings, filter chain): part of derivation identity. */
export const FFMPEG_ADAPTER_VERSION = "1";

const DEMUXER: Record<MediaFormat, string> = {
  mp4: "mov,mp4,m4a,3gp,3g2,mj2",
  webm: "matroska,webm",
  png: "image2",
  jpeg: "image2",
  webp: "image2",
};
const EXTENSION: Record<MediaFormat, string> = {
  mp4: "mp4",
  webm: "webm",
  png: "png",
  jpeg: "jpg",
  webp: "webp",
};

/** Identifies a supported container from its first bytes. Anything else is refused. */
export function sniffMediaFormat(b: Uint8Array): MediaFormat | null {
  if (b.length < 12) return null;
  const ascii = (from: number, to: number) => String.fromCharCode(...b.slice(from, to));
  if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return "webm";
  if (ascii(4, 8) === "ftyp") return "mp4";
  if (b[0] === 0x89 && ascii(1, 4) === "PNG") return "png";
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "jpeg";
  if (ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") return "webp";
  return null;
}

const even = (n: number) => 2 * Math.round(n / 2);

interface RunOptions {
  cwd: string;
  timeoutMs: number;
}

export interface FfmpegOptions {
  ffmpegPath?: string;
  ffprobePath?: string;
  limits?: Partial<MediaLimits>;
  /** Parent directory for per-call temp directories (defaults to the OS temp dir). */
  tempRoot?: string;
}

export class FfmpegMediaProcessor implements MediaProcessor {
  private readonly ffmpeg: string;
  private readonly ffprobe: string;
  private readonly limits: MediaLimits;
  private readonly tempRoot: string;
  private cachedIdentity: MediaProcessorIdentity | null = null;
  private encoders: Promise<Set<string>> | null = null;

  constructor(opts: FfmpegOptions = {}) {
    this.ffmpeg = opts.ffmpegPath ?? process.env.PRISM_STUDIO_FFMPEG_PATH ?? "ffmpeg";
    this.ffprobe = opts.ffprobePath ?? process.env.PRISM_STUDIO_FFPROBE_PATH ?? "ffprobe";
    this.limits = { ...DEFAULT_MEDIA_LIMITS, ...opts.limits };
    this.tempRoot = opts.tempRoot ?? tmpdir();
  }

  // ───────────────────────── process plumbing ─────────────────────────

  private childEnv(): NodeJS.ProcessEnv {
    // Tools need PATH (and SystemRoot/TEMP on Windows). They never need credentials.
    const keep = ["PATH", "Path", "SystemRoot", "TEMP", "TMP", "TMPDIR", "HOME", "LANG", "LC_ALL"];
    const env: Record<string, string> = {};
    for (const k of keep) {
      const v = process.env[k];
      if (v !== undefined) env[k] = v;
    }
    return env as NodeJS.ProcessEnv;
  }

  private exec(bin: string, args: string[], run: RunOptions): Promise<{ stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
      execFile(
        bin,
        args,
        {
          cwd: run.cwd,
          timeout: run.timeoutMs,
          maxBuffer: 16 * 1024 * 1024,
          windowsHide: true,
          env: this.childEnv(),
          killSignal: "SIGKILL",
        },
        (err, stdout, stderr) => {
          if (!err) return resolve({ stdout: String(stdout), stderr: String(stderr) });
          const e = err as NodeJS.ErrnoException & { killed?: boolean; signal?: string | null };
          if (e.code === "ENOENT") {
            return reject(
              new MediaError("unavailable", `${path.basename(bin)} is not installed or not on PATH.`),
            );
          }
          if (e.killed || e.signal === "SIGKILL" || e.signal === "SIGTERM") {
            return reject(
              new MediaError("timeout", `Media processing exceeded ${Math.round(run.timeoutMs / 1000)}s.`),
            );
          }
          // Keep a short, path-free tail of the tool's own message.
          const tail = String(stderr || e.message)
            .split(/\r?\n/)
            .filter(Boolean)
            .slice(-3)
            .join(" | ")
            .replace(/[A-Za-z]:\\[^\s"']+|\/[^\s"']+/g, "<path>")
            .slice(0, 300);
          reject(new MediaError("process_failed", `Media tool failed: ${tail}`));
        },
      );
    });
  }

  private async withDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
    const dir = await mkdtemp(path.join(this.tempRoot, "prism-media-"));
    try {
      return await fn(dir);
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  private checkInput(bytes: Uint8Array): MediaFormat {
    if (bytes.length === 0) throw new MediaError("unsupported_media", "The media file is empty.");
    if (bytes.length > this.limits.maxInputBytes) {
      throw new MediaError(
        "too_large",
        `The media file is ${(bytes.length / 1048576).toFixed(0)} MB; the limit is ${(this.limits.maxInputBytes / 1048576).toFixed(0)} MB.`,
      );
    }
    const format = sniffMediaFormat(bytes);
    if (!format) throw new MediaError("unsupported_media", "Unsupported or unrecognised media container.");
    return format;
  }

  // ───────────────────────── identity / availability ─────────────────────────

  async identity(): Promise<MediaProcessorIdentity> {
    if (this.cachedIdentity) return this.cachedIdentity;
    const dir = this.tempRoot;
    const { stdout } = await this.exec(this.ffmpeg, ["-hide_banner", "-version"], {
      cwd: dir,
      timeoutMs: 15_000,
    });
    const m = /version\s+(\S+)/i.exec(stdout.split(/\r?\n/)[0] ?? "");
    this.cachedIdentity = {
      name: FFMPEG_ADAPTER_NAME,
      adapterVersion: FFMPEG_ADAPTER_VERSION,
      toolVersion: m?.[1] ?? "unknown",
    };
    return this.cachedIdentity;
  }

  async available(): Promise<boolean> {
    try {
      await this.identity();
      await this.exec(this.ffprobe, ["-hide_banner", "-version"], { cwd: this.tempRoot, timeoutMs: 15_000 });
      return true;
    } catch {
      return false;
    }
  }

  private encoderSet(): Promise<Set<string>> {
    this.encoders ??= this.exec(this.ffmpeg, ["-hide_banner", "-encoders"], {
      cwd: this.tempRoot,
      timeoutMs: 15_000,
    }).then(({ stdout }) => {
      const out = new Set<string>();
      for (const line of stdout.split(/\r?\n/)) {
        const m = /^\s[VAS][\w.]{5}\s(\S+)/.exec(line);
        if (m) out.add(m[1]!);
      }
      return out;
    });
    return this.encoders;
  }

  /** H.264/AAC MP4 when libx264 exists, otherwise VP9/Opus WebM. */
  private async videoProfile(): Promise<{
    ext: "mp4" | "webm";
    mime: string;
    video: string[];
    audio: string[];
  }> {
    const enc = await this.encoderSet();
    if (enc.has("libx264")) {
      return {
        ext: "mp4",
        mime: "video/mp4",
        video: [
          "-c:v",
          "libx264",
          "-preset",
          "medium",
          "-crf",
          "18",
          "-pix_fmt",
          "yuv420p",
          "-movflags",
          "+faststart",
        ],
        audio: enc.has("aac") ? ["-c:a", "aac", "-b:a", "192k"] : ["-an"],
      };
    }
    if (enc.has("libvpx-vp9")) {
      return {
        ext: "webm",
        mime: "video/webm",
        video: ["-c:v", "libvpx-vp9", "-crf", "30", "-b:v", "0", "-pix_fmt", "yuv420p", "-row-mt", "0"],
        audio: enc.has("libopus") ? ["-c:a", "libopus", "-b:a", "128k"] : ["-an"],
      };
    }
    throw new MediaError("unavailable", "No usable video encoder (libx264 or libvpx-vp9) is available.");
  }

  // ───────────────────────── probe ─────────────────────────

  private async probeFile(
    file: string,
    format: MediaFormat,
    byteSize: number,
    dir: string,
  ): Promise<MediaProbe> {
    const { stdout } = await this.exec(
      this.ffprobe,
      [
        "-v",
        "error",
        "-protocol_whitelist",
        "file",
        "-f",
        DEMUXER[format],
        "-print_format",
        "json",
        "-show_format",
        "-show_streams",
        file,
      ],
      { cwd: dir, timeoutMs: this.limits.timeoutMs },
    );
    let json: {
      format?: { format_name?: string; duration?: string; bit_rate?: string };
      streams?: Array<Record<string, unknown>>;
    };
    try {
      json = JSON.parse(stdout);
    } catch {
      throw new MediaError("unsupported_media", "The media file could not be read.");
    }
    const streams = json.streams ?? [];
    const v = streams.find((s) => s.codec_type === "video");
    const a = streams.find((s) => s.codec_type === "audio");
    if (!v && !a) throw new MediaError("unsupported_media", "The file contains no audio or video stream.");
    const num = (x: unknown) => {
      const n = Number(x);
      return Number.isFinite(n) ? n : null;
    };
    const frac = (x: unknown) => {
      const m = /^(\d+)\/(\d+)$/.exec(String(x ?? ""));
      return m && Number(m[2]) > 0 ? Number(m[1]) / Number(m[2]) : num(x);
    };
    const isImage = format === "png" || format === "jpeg" || format === "webp";
    // The PICTURE's duration is the clip's duration; the container duration can include audio priming.
    const seconds = num(v?.duration) ?? num(json.format?.duration) ?? num(a?.duration);
    const probe: MediaProbe = {
      kind: v ? (isImage ? "image" : "video") : a ? "audio" : "unknown",
      format,
      container: json.format?.format_name ?? null,
      videoCodec: (v?.codec_name as string | undefined) ?? null,
      audioCodec: (a?.codec_name as string | undefined) ?? null,
      width: num(v?.width),
      height: num(v?.height),
      fps: v && !isImage ? frac(v.avg_frame_rate) || frac(v.r_frame_rate) : null,
      durationMs: !isImage && seconds != null ? Math.round(seconds * 1000) : null,
      hasAudio: Boolean(a),
      audioChannels: num(a?.channels),
      audioSampleRate: num(a?.sample_rate),
      bitRate: num(json.format?.bit_rate),
      byteSize,
    };
    this.checkProbe(probe);
    return probe;
  }

  private checkProbe(p: MediaProbe) {
    if (p.width && p.height && p.width * p.height > this.limits.maxPixels) {
      throw new MediaError("too_large", `Frame size ${p.width}×${p.height} exceeds the processing limit.`);
    }
    if (p.durationMs != null && p.durationMs > this.limits.maxDurationMs) {
      throw new MediaError(
        "too_long",
        `Duration ${(p.durationMs / 1000).toFixed(0)}s exceeds the processing limit.`,
      );
    }
  }

  async probe(bytes: Uint8Array): Promise<MediaProbe> {
    const format = this.checkInput(bytes);
    return this.withDir(async (dir) => {
      const file = path.join(dir, `in.${EXTENSION[format]}`);
      await writeFile(file, bytes);
      return this.probeFile(file, format, bytes.length, dir);
    });
  }

  // ───────────────────────── frames / thumbnails ─────────────────────────

  private baseInput(format: MediaFormat, file: string): string[] {
    return [
      "-nostdin",
      "-hide_banner",
      "-loglevel",
      "error",
      "-protocol_whitelist",
      "file",
      "-f",
      DEMUXER[format],
      "-i",
      file,
    ];
  }

  private seconds(ms: number): string {
    return (Math.max(0, ms) / 1000).toFixed(3);
  }

  private async frameFromFile(
    dir: string,
    inFile: string,
    format: MediaFormat,
    atMs: number,
    index: number,
    scaleWidth: number | null,
    image: "png" | "jpg",
  ): Promise<{ bytes: Uint8Array; width: number; height: number }> {
    const out = path.join(dir, `frame-${index}.${image}`);
    const vf = scaleWidth ? ["-vf", `scale=${even(scaleWidth)}:-2:flags=bicubic`] : [];
    const isImage = format === "png" || format === "jpeg" || format === "webp";
    await this.exec(
      this.ffmpeg,
      [
        ...(isImage ? [] : ["-ss", this.seconds(atMs)]),
        ...this.baseInput(format, inFile),
        "-an",
        "-frames:v",
        "1",
        ...vf,
        ...(image === "jpg" ? ["-q:v", "4"] : []),
        "-fflags",
        "+bitexact",
        "-y",
        out,
      ],
      { cwd: dir, timeoutMs: this.limits.timeoutMs },
    );
    const bytes = await readFile(out).catch(() => new Uint8Array(0));
    if (bytes.length === 0)
      throw new MediaError("process_failed", "No frame could be extracted at that position.");
    const dims = await this.probeFile(out, image === "png" ? "png" : "jpeg", bytes.length, dir);
    return { bytes, width: dims.width ?? 0, height: dims.height ?? 0 };
  }

  async extractFrames(bytes: Uint8Array, atMs: number[]): Promise<FrameOutput[]> {
    const format = this.checkInput(bytes);
    if (atMs.length === 0 || atMs.length > 64 || atMs.some((t) => !Number.isFinite(t) || t < 0)) {
      throw new MediaError("invalid_parameters", "Frame positions must be 1–64 non-negative times.");
    }
    return this.withDir(async (dir) => {
      const file = path.join(dir, `in.${EXTENSION[format]}`);
      await writeFile(file, bytes);
      const info = await this.probeFile(file, format, bytes.length, dir);
      const frames: FrameOutput[] = [];
      for (const [i, t] of atMs.entries()) {
        // The last decodable frame STARTS one frame interval (plus slack) before the end of the clip.
        const lastStart =
          info.durationMs != null ? Math.max(0, info.durationMs - 1.5 * (1000 / (info.fps || 24))) : null;
        const clamped = lastStart != null ? Math.min(t, lastStart) : t;
        const f = await this.frameFromFile(dir, file, format, clamped, i, null, "png");
        frames.push({
          atMs: Math.round(clamped),
          bytes: f.bytes,
          mime: "image/png",
          width: f.width,
          height: f.height,
        });
      }
      return frames;
    });
  }

  async extractFrame(bytes: Uint8Array, atMs: number): Promise<FrameOutput> {
    return (await this.extractFrames(bytes, [atMs]))[0]!;
  }

  async generateThumbnail(
    bytes: Uint8Array,
    opts: { atMs?: number; width?: number } = {},
  ): Promise<MediaOutput> {
    const format = this.checkInput(bytes);
    const width = opts.width ?? 320;
    if (!(width >= 16 && width <= 4096))
      throw new MediaError("invalid_parameters", "Thumbnail width out of range.");
    return this.withDir(async (dir) => {
      const file = path.join(dir, `in.${EXTENSION[format]}`);
      await writeFile(file, bytes);
      const info = await this.probeFile(file, format, bytes.length, dir);
      const lastStart =
        info.durationMs != null ? Math.max(0, info.durationMs - 1.5 * (1000 / (info.fps || 24))) : 0;
      const at = Math.min(opts.atMs ?? (info.durationMs ? info.durationMs / 2 : 0), lastStart);
      const f = await this.frameFromFile(dir, file, format, at, 0, width, "jpg");
      const probe = await this.probeFile(path.join(dir, "frame-0.jpg"), "jpeg", f.bytes.length, dir);
      return { bytes: f.bytes, mime: "image/jpeg", extension: "jpg", probe };
    });
  }

  async generateContactSheet(
    frames: Uint8Array[],
    opts: { columns?: number; cellWidth?: number } = {},
  ): Promise<MediaOutput> {
    if (frames.length === 0 || frames.length > 36) {
      throw new MediaError("invalid_parameters", "A contact sheet needs between 1 and 36 frames.");
    }
    const columns = Math.min(Math.max(1, opts.columns ?? 5), frames.length, 8);
    const cellWidth = opts.cellWidth ?? 320;
    if (!(cellWidth >= 32 && cellWidth <= 1024)) {
      throw new MediaError("invalid_parameters", "Contact sheet cell width out of range.");
    }
    for (const f of frames) {
      if (sniffMediaFormat(f) !== "png")
        throw new MediaError("unsupported_media", "Contact sheet frames must be PNG.");
    }
    const rows = Math.ceil(frames.length / columns);
    return this.withDir(async (dir) => {
      for (const [i, f] of frames.entries()) await writeFile(path.join(dir, `f${i}.png`), f);
      const out = path.join(dir, "sheet.png");
      await this.exec(
        this.ffmpeg,
        [
          "-nostdin",
          "-hide_banner",
          "-loglevel",
          "error",
          "-protocol_whitelist",
          "file",
          "-f",
          "image2",
          "-framerate",
          "1",
          "-start_number",
          "0",
          "-i",
          path.join(dir, "f%d.png"),
          "-vf",
          `scale=${even(cellWidth)}:-2,tile=${columns}x${rows}:padding=4:margin=4:color=0x101114`,
          "-frames:v",
          "1",
          "-fflags",
          "+bitexact",
          "-y",
          out,
        ],
        { cwd: dir, timeoutMs: this.limits.timeoutMs },
      );
      const bytes = await readFile(out);
      const probe = await this.probeFile(out, "png", bytes.length, dir);
      return { bytes, mime: "image/png", extension: "png", probe };
    });
  }

  // ───────────────────────── video transforms ─────────────────────────

  private validateRect(r: PixelRect, info: MediaProbe) {
    const ints = [r.x, r.y, r.width, r.height].every((n) => Number.isInteger(n));
    if (
      !ints ||
      r.width < 2 ||
      r.height < 2 ||
      r.x < 0 ||
      r.y < 0 ||
      !info.width ||
      !info.height ||
      r.x + r.width > info.width ||
      r.y + r.height > info.height
    ) {
      throw new MediaError("invalid_parameters", "The crop rectangle is not inside the picture.");
    }
  }

  async conform(bytes: Uint8Array, spec: ConformSpec): Promise<MediaOutput> {
    const format = this.checkInput(bytes);
    return this.withDir(async (dir) => {
      const inFile = path.join(dir, `in.${EXTENSION[format]}`);
      await writeFile(inFile, bytes);
      const info = await this.probeFile(inFile, format, bytes.length, dir);
      if (info.kind !== "video" && info.kind !== "image") {
        throw new MediaError("unsupported_media", "Only picture media can be conformed.");
      }
      const filters: string[] = [];
      if (spec.crop) {
        this.validateRect(spec.crop, info);
        const c = spec.crop;
        filters.push(`crop=${c.width}:${c.height}:${c.x}:${c.y}`);
      }
      if (spec.pad) {
        const { frame, placement } = spec.pad;
        const okSize = [frame.width, frame.height, placement.x, placement.y].every(
          (n) => Number.isInteger(n) && n >= 0,
        );
        if (
          !okSize ||
          frame.width * frame.height > this.limits.maxPixels ||
          frame.width < 2 ||
          frame.height < 2
        ) {
          throw new MediaError("invalid_parameters", "The padded frame size is not valid.");
        }
        filters.push(`pad=${frame.width}:${frame.height}:${placement.x}:${placement.y}:color=black`);
      }
      if (spec.trimMs != null && !(spec.trimMs > 0 && Number.isFinite(spec.trimMs))) {
        throw new MediaError("invalid_parameters", "The trim duration must be positive.");
      }
      const isImage = info.kind === "image";
      const vf = filters.length ? ["-vf", filters.join(",")] : [];
      if (isImage) {
        const out = path.join(dir, "out.png");
        await this.exec(
          this.ffmpeg,
          [...this.baseInput(format, inFile), ...vf, "-frames:v", "1", "-fflags", "+bitexact", "-y", out],
          { cwd: dir, timeoutMs: this.limits.timeoutMs },
        );
        return this.finish(dir, out, "png", "image/png", "png");
      }
      const profile = await this.videoProfile();
      const out = path.join(dir, `out.${profile.ext}`);
      await this.exec(
        this.ffmpeg,
        [
          ...this.baseInput(format, inFile),
          ...vf,
          ...(spec.trimMs != null ? ["-t", this.seconds(spec.trimMs)] : []),
          "-map",
          "0:v:0",
          ...(info.hasAudio ? ["-map", "0:a:0?"] : []),
          ...profile.video,
          ...(info.hasAudio ? profile.audio : ["-an"]),
          "-map_metadata",
          "-1",
          "-fflags",
          "+bitexact",
          "-flags:v",
          "+bitexact",
          "-flags:a",
          "+bitexact",
          "-threads",
          "2",
          "-fs",
          String(this.limits.maxOutputBytes),
          "-y",
          out,
        ],
        { cwd: dir, timeoutMs: this.limits.timeoutMs },
      );
      return this.finish(dir, out, profile.ext, profile.mime, profile.ext);
    });
  }

  private async finish(
    dir: string,
    out: string,
    format: MediaFormat,
    mime: string,
    extension: string,
  ): Promise<MediaOutput> {
    const size = (await stat(out)).size;
    if (size === 0) throw new MediaError("process_failed", "The processed file is empty.");
    if (size > this.limits.maxOutputBytes) {
      throw new MediaError("too_large", "The processed file exceeds the output size limit.");
    }
    const bytes = await readFile(out);
    const probe = await this.probeFile(out, format, bytes.length, dir);
    return { bytes, mime, extension, probe };
  }

  async scaleImage(bytes: Uint8Array, width: number, height: number): Promise<MediaOutput> {
    if (
      !Number.isInteger(width) ||
      !Number.isInteger(height) ||
      width < 2 ||
      height < 2 ||
      width % 2 ||
      height % 2
    ) {
      throw new MediaError("invalid_parameters", "Scale dimensions must be even positive integers.");
    }
    if (width * height > this.limits.maxPixels) {
      throw new MediaError("too_large", "The requested size exceeds the processing limit.");
    }
    const format = this.checkInput(bytes);
    if (format !== "png" && format !== "jpeg" && format !== "webp") {
      throw new MediaError("unsupported_media", "Only still images can be scaled here.");
    }
    return this.withDir(async (dir) => {
      const inFile = path.join(dir, `in.${EXTENSION[format]}`);
      await writeFile(inFile, bytes);
      await this.probeFile(inFile, format, bytes.length, dir);
      const out = path.join(dir, "out.png");
      await this.exec(
        this.ffmpeg,
        [
          ...this.baseInput(format, inFile),
          "-vf",
          `scale=${width}:${height}:flags=bicubic`,
          "-frames:v",
          "1",
          "-fflags",
          "+bitexact",
          "-y",
          out,
        ],
        { cwd: dir, timeoutMs: this.limits.timeoutMs },
      );
      return this.finish(dir, out, "png", "image/png", "png");
    });
  }

  async cropVideo(bytes: Uint8Array, rect: PixelRect): Promise<MediaOutput> {
    return this.conform(bytes, { crop: rect, pad: null, trimMs: null });
  }

  async trimVideo(bytes: Uint8Array, durationMs: number): Promise<MediaOutput> {
    return this.conform(bytes, { crop: null, pad: null, trimMs: durationMs });
  }

  async scaleVideo(bytes: Uint8Array, width: number, height: number): Promise<MediaOutput> {
    if (
      !Number.isInteger(width) ||
      !Number.isInteger(height) ||
      width < 2 ||
      height < 2 ||
      width % 2 ||
      height % 2
    ) {
      throw new MediaError("invalid_parameters", "Scale dimensions must be even positive integers.");
    }
    if (width * height > this.limits.maxPixels) {
      throw new MediaError("too_large", "The requested size exceeds the processing limit.");
    }
    const format = this.checkInput(bytes);
    return this.withDir(async (dir) => {
      const inFile = path.join(dir, `in.${EXTENSION[format]}`);
      await writeFile(inFile, bytes);
      const info = await this.probeFile(inFile, format, bytes.length, dir);
      if (info.kind !== "video") throw new MediaError("unsupported_media", "Only video can be scaled.");
      const profile = await this.videoProfile();
      const out = path.join(dir, `out.${profile.ext}`);
      await this.exec(
        this.ffmpeg,
        [
          ...this.baseInput(format, inFile),
          "-vf",
          `scale=${width}:${height}:flags=bicubic`,
          "-map",
          "0:v:0",
          ...(info.hasAudio ? ["-map", "0:a:0?"] : []),
          ...profile.video,
          ...(info.hasAudio ? profile.audio : ["-an"]),
          "-map_metadata",
          "-1",
          "-fflags",
          "+bitexact",
          "-flags:v",
          "+bitexact",
          "-flags:a",
          "+bitexact",
          "-threads",
          "2",
          "-fs",
          String(this.limits.maxOutputBytes),
          "-y",
          out,
        ],
        { cwd: dir, timeoutMs: this.limits.timeoutMs },
      );
      return this.finish(dir, out, profile.ext, profile.mime, profile.ext);
    });
  }
}

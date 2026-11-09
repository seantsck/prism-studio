import { copyFile, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { execMediaTool } from "@/media/ffmpeg";
import { MediaError } from "@/media/types";
import type { ResolvedFont } from "./fonts";
import type { AudioSource, PictureSource, RenderPiece } from "./plan";
import { AUDIO_SAMPLE_RATE, type RenderProfile } from "./profile";

/**
 * Phase 5B-V4 FFmpeg execution of a render plan. Every call is ONE bounded ffmpeg process with the media layer's
 * safety model (`execMediaTool`: argument array, no shell, timeout, minimal environment, path-free errors; inputs are
 * files WE wrote into a private temp directory, their container identified from their bytes and forced with `-f`;
 * `-protocol_whitelist file`).
 *
 *   picture  ≤ 2 picture inputs → normalized H.264 segment of EXACTLY `frames` frames on the delivery canvas
 *            (fit inside, letterbox / pillarbox, never crop; constant frame rate; yuv420p; identical encoder settings)
 *   sound    ≤ MAX_AUDIO_SOURCES_PER_PIECE inputs → exact-length 48 kHz stereo PCM (`samples` samples): each source
 *            trimmed and placed at its offset, mixed without normalization, then a −1 dBFS limiter (no clipping)
 *   assemble the normalized pieces in order through the concat demuxer (sequential reads: bounded), video stream-copied
 *            (the pieces are verified identical in codec / size / rate / pixel format first), PCM encoded to AAC once
 *   verify   ffprobe the final file: H.264, the canvas, the rate, the exact frame count
 */

export interface RendererOptions {
  ffmpegPath?: string;
  ffprobePath?: string;
  /** per-invocation wall clock */
  timeoutMs?: number;
  /** test seam: observes every ffmpeg / ffprobe argument list (the bounded-rendering guard) */
  onExec?: (bin: "ffmpeg" | "ffprobe", args: string[]) => void;
}

/** A source file written into the job's temp directory. */
export interface LocalSource {
  file: string;
  demuxer: string;
  /** the file has an audio stream (clip audio of a silent clip is skipped, never an error) */
  hasAudio: boolean;
}

export interface SegmentProbe {
  videoCodec: string | null;
  width: number | null;
  height: number | null;
  pixFmt: string | null;
  frameRate: string | null;
  frames: number | null;
  videoDurationMs: number | null;
  audioCodec: string | null;
  sampleRate: number | null;
  channels: number | null;
  durationMs: number | null;
  formatName: string | null;
}

/** The container of a file WE are about to hand to ffmpeg, from its bytes (never its name). */
export function sniffRenderInput(b: Uint8Array): { demuxer: string; ext: string } | null {
  if (b.length < 12) return null;
  const ascii = (from: number, to: number) => String.fromCharCode(...b.slice(from, to));
  if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3)
    return { demuxer: "matroska,webm", ext: "webm" };
  if (ascii(4, 8) === "ftyp") return { demuxer: "mov,mp4,m4a,3gp,3g2,mj2", ext: "mp4" };
  if (b[0] === 0x89 && ascii(1, 4) === "PNG") return { demuxer: "image2", ext: "png" };
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { demuxer: "image2", ext: "jpg" };
  if (ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") return { demuxer: "image2", ext: "webp" };
  if (ascii(0, 4) === "RIFF" && ascii(8, 12) === "WAVE") return { demuxer: "wav", ext: "wav" };
  if (ascii(0, 4) === "OggS") return { demuxer: "ogg", ext: "ogg" };
  if (ascii(0, 4) === "fLaC") return { demuxer: "flac", ext: "flac" };
  if (ascii(0, 3) === "ID3" || (b[0] === 0xff && (b[1]! & 0xe0) === 0xe0))
    return { demuxer: "mp3", ext: "mp3" };
  return null;
}

const sec = (ms: number) => (Math.max(0, ms) / 1000).toFixed(6);
const fpsArg = (p: RenderProfile) => `${p.fps.num}/${p.fps.den}`;
/** mp4 track timescale with an integer frame duration at the rate (24/1 → 24000, 24000/1001 → 24000). */
const timescale = (p: RenderProfile) => (p.fps.den === 1 ? p.fps.num * 1000 : p.fps.num);

export class FfmpegEpisodeRenderer {
  private readonly ffmpeg: string;
  private readonly ffprobe: string;
  private readonly timeoutMs: number;

  constructor(private readonly opts: RendererOptions = {}) {
    this.ffmpeg = opts.ffmpegPath ?? process.env.PRISM_STUDIO_FFMPEG_PATH ?? "ffmpeg";
    this.ffprobe = opts.ffprobePath ?? process.env.PRISM_STUDIO_FFPROBE_PATH ?? "ffprobe";
    this.timeoutMs = opts.timeoutMs ?? 10 * 60_000;
  }

  private run(bin: "ffmpeg" | "ffprobe", args: string[], cwd: string) {
    this.opts.onExec?.(bin, args);
    return execMediaTool(bin === "ffmpeg" ? this.ffmpeg : this.ffprobe, args, {
      cwd,
      timeoutMs: this.timeoutMs,
    });
  }

  async toolVersion(cwd: string): Promise<string> {
    const { stdout } = await this.run("ffmpeg", ["-hide_banner", "-version"], cwd);
    return /version\s+(\S+)/i.exec(stdout.split(/\r?\n/)[0] ?? "")?.[1] ?? "unknown";
  }

  // ───────────────────────── picture ─────────────────────────

  /** The normalization chain every picture goes through: rate, fit inside the canvas, pad, square pixels, yuv420p. */
  private normalize(input: number, label: string, p: RenderProfile): string {
    const { width: W, height: H } = p.canvas;
    return (
      `[${input}:v]fps=${fpsArg(p)},` +
      `scale=${W}:${H}:force_original_aspect_ratio=decrease:force_divisible_by=2:flags=bicubic,` +
      `pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,format=yuv420p,` +
      `tpad=stop_mode=clone:stop=-1[${label}]`
    );
  }

  private pictureInput(src: PictureSource, local: LocalSource, p: RenderProfile): string[] {
    return src.kind === "video"
      ? ["-protocol_whitelist", "file", "-f", local.demuxer, "-ss", sec(src.sourceStartMs), "-i", local.file]
      : [
          "-protocol_whitelist",
          "file",
          "-f",
          "image2",
          "-pattern_type",
          "none",
          "-loop",
          "1",
          "-framerate",
          fpsArg(p),
          "-i",
          local.file,
        ];
  }

  private videoOutput(frames: number, p: RenderProfile, out: string): string[] {
    return [
      "-frames:v",
      String(frames),
      "-c:v",
      "libx264",
      "-preset",
      p.video.preset,
      "-crf",
      String(p.video.crf),
      "-pix_fmt",
      p.video.pixFmt,
      "-r",
      fpsArg(p),
      "-g",
      String(p.video.gopFrames),
      "-keyint_min",
      String(p.video.gopFrames),
      "-sc_threshold",
      "0",
      "-bf",
      "2",
      "-video_track_timescale",
      String(timescale(p)),
      "-an",
      "-map_metadata",
      "-1",
      "-fflags",
      "+bitexact",
      "-flags:v",
      "+bitexact",
      "-threads",
      "2",
      "-y",
      out,
    ];
  }

  /**
   * Renders a piece's PICTURE into `dir/<name>.mp4`. `sources` maps Asset id → the local file; `fonts` is required for a
   * title piece (resolved by the worker, fail-closed).
   */
  async renderPicture(
    piece: RenderPiece,
    p: RenderProfile,
    dir: string,
    name: string,
    sources: ReadonlyMap<string, LocalSource>,
    fonts: { film: ResolvedFont; plain: ResolvedFont } | null,
  ): Promise<string> {
    const out = `${name}.mp4`;
    const base = ["-hide_banner", "-nostdin", "-v", "error"];
    let args: string[];
    if (piece.kind === "title") {
      if (!fonts) throw new MediaError("unavailable", "Title fonts were not resolved.");
      const font = fonts[piece.style];
      const fontFile = `font-${piece.style}${path.extname(font.file) || ".ttf"}`;
      await copyFile(font.file, path.join(dir, fontFile)).catch(async () => undefined);
      await writeFile(path.join(dir, `${name}-title.txt`), piece.title, "utf8");
      await writeFile(path.join(dir, `${name}-subtitle.txt`), piece.subtitle, "utf8");
      const { width: W, height: H } = p.canvas;
      const big = Math.max(12, Math.round(H * (piece.style === "film" ? 0.085 : 0.075)));
      const small = Math.max(8, Math.round(H * 0.038));
      const titleY = piece.subtitle ? `(h-text_h)/2-${Math.round(H * 0.06)}` : "(h-text_h)/2";
      const draw = [
        `drawtext=fontfile=${fontFile}:textfile=${name}-title.txt:expansion=none:fontsize=${big}:fontcolor=white:x=(w-text_w)/2:y=${titleY}`,
      ];
      if (piece.subtitle)
        draw.push(
          `drawtext=fontfile=${fontFile}:textfile=${name}-subtitle.txt:expansion=none:fontsize=${small}:fontcolor=0xB8B8B8:x=(w-text_w)/2:y=(h/2)+${Math.round(H * 0.05)}`,
        );
      args = [
        ...base,
        "-f",
        "lavfi",
        "-i",
        `color=c=black:s=${W}x${H}:r=${fpsArg(p)}`,
        "-filter_complex",
        `[0:v]${draw.join(",")},setsar=1,format=yuv420p[v]`,
        "-map",
        "[v]",
        ...this.videoOutput(piece.frames, p, out),
      ];
    } else if (piece.kind === "body") {
      const src = sources.get(piece.picture.assetId);
      if (!src) throw new MediaError("invalid_parameters", "A picture source is missing.");
      args = [
        ...base,
        ...this.pictureInput(piece.picture, src, p),
        "-filter_complex",
        this.normalize(0, "v", p),
        "-map",
        "[v]",
        ...this.videoOutput(piece.frames, p, out),
      ];
    } else {
      const a = sources.get(piece.from.assetId);
      const b = sources.get(piece.to.assetId);
      if (!a || !b) throw new MediaError("invalid_parameters", "A picture source is missing.");
      const d = sec((piece.frames * 1000 * p.fps.den) / p.fps.num);
      args = [
        ...base,
        ...this.pictureInput(piece.from, a, p),
        ...this.pictureInput(piece.to, b, p),
        "-filter_complex",
        // a LINEAR cross dissolve over the whole piece: the V3 preview's dissolveMix
        `${this.normalize(0, "a", p)};${this.normalize(1, "b", p)};[a][b]xfade=transition=fade:duration=${d}:offset=0[v]`,
        "-map",
        "[v]",
        ...this.videoOutput(piece.frames, p, out),
      ];
    }
    await this.run("ffmpeg", args, dir);
    const probe = await this.probe(dir, out);
    if (probe.frames !== piece.frames || probe.width !== p.canvas.width || probe.height !== p.canvas.height)
      throw new MediaError(
        "process_failed",
        `Segment ${piece.index + 1} was rendered with ${probe.frames ?? "?"} frames at ${probe.width}×${probe.height}; expected ${piece.frames} at ${p.canvas.width}×${p.canvas.height}.`,
      );
    return out;
  }

  // ───────────────────────── sound ─────────────────────────

  /** Renders a piece's SOUND into `dir/<name>.wav`: exactly `piece.samples` samples of 48 kHz stereo PCM. */
  async renderSound(
    piece: RenderPiece,
    dir: string,
    name: string,
    sources: ReadonlyMap<string, LocalSource>,
  ): Promise<string> {
    const out = `${name}.wav`;
    const usable = piece.audio.filter((a) => sources.get(a.assetId)?.hasAudio);
    const args = ["-hide_banner", "-nostdin", "-v", "error"];
    const chains: string[] = [];
    if (usable.length === 0) {
      args.push("-f", "lavfi", "-i", `anullsrc=r=${AUDIO_SAMPLE_RATE}:cl=stereo`);
      chains.push(`[0:a]atrim=end_sample=${piece.samples}[out]`);
    } else {
      usable.forEach((a: AudioSource, k) => {
        const src = sources.get(a.assetId)!;
        args.push("-protocol_whitelist", "file", "-f", src.demuxer, "-i", src.file);
        const delay = Math.round((a.offsetMs * AUDIO_SAMPLE_RATE) / 1000);
        chains.push(
          `[${k}:a]atrim=start=${sec(a.sourceStartMs)}:duration=${sec(a.durationMs)},asetpts=PTS-STARTPTS,` +
            `aresample=${AUDIO_SAMPLE_RATE},aformat=sample_fmts=fltp:channel_layouts=stereo,` +
            `adelay=delays=${delay}S:all=1[s${k}]`,
        );
      });
      // overlapping sounds are SUMMED (no normalization: a lone sound keeps its level), then a −1 dBFS limiter
      const head =
        usable.length === 1
          ? "[s0]"
          : `${usable.map((_, k) => `[s${k}]`).join("")}amix=inputs=${usable.length}:normalize=0:dropout_transition=0,`;
      chains.push(
        `${head}alimiter=limit=0.891:level=false:latency=true,apad,atrim=end_sample=${piece.samples}[out]`,
      );
    }
    args.push(
      "-filter_complex",
      chains.join(";"),
      "-map",
      "[out]",
      "-c:a",
      "pcm_s16le",
      "-ar",
      String(AUDIO_SAMPLE_RATE),
      "-ac",
      "2",
      "-map_metadata",
      "-1",
      "-fflags",
      "+bitexact",
      "-flags:a",
      "+bitexact",
      "-y",
      out,
    );
    await this.run("ffmpeg", args, dir);
    return out;
  }

  // ───────────────────────── assembly / verification ─────────────────────────

  /**
   * Concatenates the normalized pieces IN ORDER (concat demuxer: one piece open at a time). The pictures are
   * stream-copied after checking that every piece has the same codec, canvas, rate and pixel format; the PCM is encoded
   * to AAC once. Returns the output file name.
   */
  async assemble(
    dir: string,
    pieces: Array<{ video: string; audio: string | null }>,
    p: RenderProfile,
    hasAudio: boolean,
    out: string,
  ): Promise<string> {
    const first = await this.probe(dir, pieces[0]!.video);
    for (const piece of pieces) {
      const q = piece.video === pieces[0]!.video ? first : await this.probe(dir, piece.video);
      if (
        q.videoCodec !== "h264" ||
        q.width !== first.width ||
        q.height !== first.height ||
        q.pixFmt !== first.pixFmt ||
        q.frameRate !== first.frameRate
      )
        throw new MediaError(
          "process_failed",
          "The normalized segments are not stream-compatible; nothing was assembled.",
        );
    }
    const list = (files: string[]) => `ffconcat version 1.0\n${files.map((f) => `file ${f}`).join("\n")}\n`;
    await writeFile(path.join(dir, "video.ffconcat"), list(pieces.map((x) => x.video)), "utf8");
    const args = [
      "-hide_banner",
      "-nostdin",
      "-v",
      "error",
      "-protocol_whitelist",
      "file",
      "-f",
      "concat",
      "-safe",
      "1",
      "-i",
      "video.ffconcat",
    ];
    if (hasAudio) {
      await writeFile(path.join(dir, "audio.ffconcat"), list(pieces.map((x) => x.audio!)), "utf8");
      args.push("-protocol_whitelist", "file", "-f", "concat", "-safe", "1", "-i", "audio.ffconcat");
    }
    args.push("-map", "0:v:0", "-c:v", "copy");
    if (hasAudio)
      args.push(
        "-map",
        "1:a:0",
        "-c:a",
        "aac",
        "-b:a",
        p.audio.bitrate,
        "-ar",
        String(AUDIO_SAMPLE_RATE),
        "-ac",
        "2",
      );
    else args.push("-an");
    args.push(
      "-movflags",
      "+faststart",
      "-map_metadata",
      "-1",
      "-fflags",
      "+bitexact",
      "-flags:a",
      "+bitexact",
      "-video_track_timescale",
      String(timescale(p)),
      "-y",
      out,
    );
    await this.run("ffmpeg", args, dir);
    const size = (await stat(path.join(dir, out))).size;
    if (size === 0) throw new MediaError("process_failed", "The assembled file is empty.");
    return out;
  }

  async probe(dir: string, file: string): Promise<SegmentProbe> {
    const { stdout } = await this.run(
      "ffprobe",
      [
        "-v",
        "error",
        "-protocol_whitelist",
        "file",
        "-print_format",
        "json",
        "-show_format",
        "-show_streams",
        file,
      ],
      dir,
    );
    const json = JSON.parse(stdout) as {
      format?: { format_name?: string; duration?: string };
      streams?: Array<Record<string, unknown>>;
    };
    const v = json.streams?.find((s) => s.codec_type === "video");
    const a = json.streams?.find((s) => s.codec_type === "audio");
    const num = (x: unknown) => (x == null || x === "" || Number.isNaN(Number(x)) ? null : Number(x));
    return {
      videoCodec: (v?.codec_name as string) ?? null,
      width: num(v?.width),
      height: num(v?.height),
      pixFmt: (v?.pix_fmt as string) ?? null,
      frameRate: (v?.r_frame_rate as string) ?? null,
      frames: num(v?.nb_frames),
      videoDurationMs: v?.duration != null ? Math.round(Number(v.duration) * 1000) : null,
      audioCodec: (a?.codec_name as string) ?? null,
      sampleRate: num(a?.sample_rate),
      channels: num(a?.channels),
      durationMs: json.format?.duration != null ? Math.round(Number(json.format.duration) * 1000) : null,
      formatName: json.format?.format_name ?? null,
    };
  }

  /** Reads one decoded frame of a rendered file (PNG bytes) at `ms`: the acceptance tests compare pictures with it. */
  async frameAt(dir: string, file: string, ms: number, out: string): Promise<Uint8Array> {
    await this.run(
      "ffmpeg",
      [
        "-hide_banner",
        "-nostdin",
        "-v",
        "error",
        "-protocol_whitelist",
        "file",
        "-ss",
        sec(ms),
        "-i",
        file,
        "-frames:v",
        "1",
        "-y",
        out,
      ],
      dir,
    );
    return readFile(path.join(dir, out));
  }
}

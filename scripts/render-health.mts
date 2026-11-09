// Phase 5B closeout: the render worker's DETERMINISTIC runtime health check. Local only: no database, no Storage, no
// network, no credential. Run it on the render worker host (or inside its image) before starting the worker:
//
//   npm run render:health
//
// ffmpeg present → ffprobe present → required encoders / filters / options → open CJK title fonts (Noto Serif + Sans,
// fail closed) → a REAL smoke render through the production renderer (Film + Plain Japanese titles → H.264 yuv420p MP4
// at the delivery profile's rate, exact frame count) → the title pixels are drawn → the temp directory is removed.
// Prints one PASS / FAIL line per check (no paths, no environment values); exits 0 only when every check passes.
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { EpisodeEdit } from "../src/domain/edit/model";
import { buildRenderManifest } from "../src/domain/edit/render-manifest";
import type { ProjectData } from "../src/domain/schemas";
import { execMediaTool } from "../src/media/ffmpeg";
import { FfmpegEpisodeRenderer } from "../src/render/ffmpeg-renderer";
import { resolveTitleFonts, titleFontIdentity } from "../src/render/fonts";
import { buildRenderPlan } from "../src/render/plan";
import { deliveryProfile } from "../src/render/profile";

const results: Array<[string, boolean, string]> = [];
const check = (name: string, ok: boolean, detail = "") => {
  results.push([name, ok, detail]);
  return ok;
};
const ffmpeg = process.env.PRISM_STUDIO_FFMPEG_PATH || "ffmpeg";
const ffprobe = process.env.PRISM_STUDIO_FFPROBE_PATH || "ffprobe";
const dir = await mkdtemp(
  path.join(process.env.PRISM_STUDIO_RENDER_TEMP_DIR || tmpdir(), "prism-render-health-"),
);
const tool = (bin: string, args: string[]) => execMediaTool(bin, args, { cwd: dir, timeoutMs: 120_000 });
const short = (e: unknown) =>
  (e instanceof Error ? e.message : String(e))
    .replace(/[A-Za-z]:\\[^\s"']+|\/[^\s"']+/g, "<path>")
    .slice(0, 200);

const REQUIRED_FILTERS = [
  "fps",
  "scale",
  "pad",
  "setsar",
  "format",
  "tpad",
  "xfade",
  "drawtext",
  "color",
  "atrim",
  "aresample",
  "adelay",
  "amix",
  "alimiter",
  "apad",
  "anullsrc",
];
const REQUIRED_OPTIONS: Array<[string, string[]]> = [
  ["amix", ["normalize"]],
  ["alimiter", ["latency"]],
  ["drawtext", ["textfile", "expansion", "fontfile"]],
  ["scale", ["force_divisible_by"]],
];

try {
  const version = await tool(ffmpeg, ["-hide_banner", "-version"]).then(
    (r) => /version\s+(\S+)/i.exec(r.stdout)?.[1] ?? "unknown",
    () => null,
  );
  const haveFfmpeg = check(
    "ffmpeg is present",
    version !== null,
    "install ffmpeg or set PRISM_STUDIO_FFMPEG_PATH",
  );
  if (version) console.log(`ffmpeg version: ${version}`);
  const probeVersion = await tool(ffprobe, ["-hide_banner", "-version"]).then(
    (r) => /version\s+(\S+)/i.exec(r.stdout)?.[1] ?? "unknown",
    () => null,
  );
  check("ffprobe is present", probeVersion !== null, "install ffprobe or set PRISM_STUDIO_FFPROBE_PATH");

  if (haveFfmpeg) {
    const encoders = (await tool(ffmpeg, ["-hide_banner", "-encoders"])).stdout;
    check("encoder libx264 (H.264)", /\slibx264\s/.test(encoders));
    check("encoder aac", /\saac\s/.test(encoders));
    const pixFmts = (await tool(ffmpeg, ["-hide_banner", "-pix_fmts"])).stdout;
    check("pixel format yuv420p", /\syuv420p\s/.test(pixFmts));
    const filters = (await tool(ffmpeg, ["-hide_banner", "-filters"])).stdout;
    const missing = REQUIRED_FILTERS.filter((f) => !new RegExp(`\\s${f}\\s`).test(filters));
    check("required filters", missing.length === 0, `missing: ${missing.join(", ")}`);
    for (const [filter, options] of REQUIRED_OPTIONS) {
      const help = await tool(ffmpeg, ["-hide_banner", "-h", `filter=${filter}`]).then(
        (r) => r.stdout,
        () => "",
      );
      const absent = options.filter((o) => !new RegExp(`\\b${o}\\b`).test(help));
      check(`${filter} supports ${options.join(", ")}`, absent.length === 0, `missing: ${absent.join(", ")}`);
    }
    const demuxers = (await tool(ffmpeg, ["-hide_banner", "-demuxers"])).stdout;
    check(
      "demuxers concat, matroska/webm, mov/mp4, image2, wav",
      ["concat", "matroska", "mov", "image2", "wav"].every((d) => new RegExp(`\\s${d}[\\s,]`).test(demuxers)),
    );
  }

  const fonts = await resolveTitleFonts().then(
    (f) => f,
    (e: unknown) => {
      check("open CJK title fonts (Noto Serif + Noto Sans)", false, short(e));
      return null;
    },
  );
  if (fonts) {
    check("open CJK title fonts (Noto Serif + Noto Sans)", true);
    console.log(`title fonts: Film ${fonts.film.family}, Plain ${fonts.plain.family}`);
  }

  if (haveFfmpeg && fonts) {
    // a REAL render through the production renderer: two 1 s Japanese title cards (Film, Plain), no media sources
    const data = {
      assets: [],
      productionFrames: [],
      frames: [],
      shots: [],
      takes: [],
      bible: { aspectRatio: "2.39:1", deliveryWidth: null, deliveryHeight: null },
    } as unknown as ProjectData;
    const edit: EpisodeEdit = {
      id: "health",
      projectId: "health",
      episodeId: "health",
      editRate: { num: 24, den: 1 },
      revision: 1,
      items: [],
      titles: [
        {
          id: "00000000-0000-4000-8000-0000000000a1",
          placement: "opening",
          title: "お嬢様、僕と結婚してください。",
          subtitle: "Render health",
          durationMs: 1000,
          style: "film",
        },
        {
          id: "00000000-0000-4000-8000-0000000000a2",
          placement: "closing",
          title: "終",
          subtitle: "",
          durationMs: 1000,
          style: "plain",
        },
      ],
    };
    const manifest = buildRenderManifest(data, edit);
    const profile = deliveryProfile(manifest.target, { width: 640, preset: "ultrafast" });
    const plan = buildRenderPlan(manifest, profile, titleFontIdentity(fonts));
    const renderer = new FfmpegEpisodeRenderer({
      ffmpegPath: ffmpeg,
      ffprobePath: ffprobe,
      timeoutMs: 120_000,
    });
    const outs: Array<{ video: string; audio: string | null }> = [];
    try {
      for (const piece of plan.pieces)
        outs.push({
          video: await renderer.renderPicture(piece, profile, dir, `p${piece.index}`, new Map(), fonts),
          audio: null,
        });
      const final = await renderer.assemble(dir, outs, profile, false, "health.mp4");
      const probe = await renderer.probe(dir, final);
      check(
        "smoke render: H.264 yuv420p MP4 at the delivery canvas and rate",
        probe.videoCodec === "h264" &&
          probe.pixFmt === "yuv420p" &&
          probe.width === profile.canvas.width &&
          probe.height === profile.canvas.height &&
          probe.frameRate === "24/1",
        JSON.stringify(probe),
      );
      check(
        "smoke render: exact frame count",
        probe.frames === plan.totalFrames,
        `${probe.frames} vs ${plan.totalFrames}`,
      );
      // the Japanese title is drawn: the middle of the Film card has bright (text) pixels on its black ground
      await tool(ffmpeg, [
        "-hide_banner",
        "-nostdin",
        "-v",
        "error",
        "-ss",
        "0.5",
        "-i",
        final,
        "-frames:v",
        "1",
        "-vf",
        "format=gray",
        "-f",
        "rawvideo",
        "-y",
        "frame.gray",
      ]);
      const gray = await readFile(path.join(dir, "frame.gray"));
      const bright = gray.reduce((n, v) => n + (v > 128 ? 1 : 0), 0);
      check("smoke render: the Japanese title is drawn", bright > 200, `${bright} bright pixels`);
    } catch (e) {
      check("smoke render", false, short(e));
    }
  }
} finally {
  await rm(dir, { recursive: true, force: true });
  check("temporary files removed", true);
}

let failed = 0;
for (const [name, ok, detail] of results) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail && !ok ? `  — ${detail}` : ""}`);
  if (!ok) failed++;
}
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);

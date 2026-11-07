// Phase 5A.2 media sizing benchmark. Runs INSIDE the media image under the daemon's resource limits, e.g.
//   docker run --rm --memory=4g --cpus=2 prism-media-worker:5a2 node --import tsx scripts/bench-media.mts
// Offline and free: synthesizes its own inputs (ffmpeg test patterns + tones), touches no database, Storage or provider.
//
// Workloads (real code paths where they exist):
//   conform      FfmpegMediaProcessor.conform: 1920x1080 sources letterboxed into a 2.39:1 frame (one re-encode)
//   qa_frames    FfmpegMediaProcessor.extractFrames: 12 frames per clip
//   contact      FfmpegMediaProcessor.generateContactSheet: 24 frames, 6 columns
//   render       REPRESENTATIVE episode render (5B does not exist yet): concat N conformed clips, dialogue + a faded
//                music bed mixed, H.264/AAC, 1920x804 @ 24 fps
//   shared       render while qa_frames + contact run concurrently (does media + continuity fit one instance?)
// Peak memory is the container's cgroup peak (memory.current sampled every 100 ms), so it includes Node AND ffmpeg.
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { FfmpegMediaProcessor } from "../src/media/ffmpeg";

const run = promisify(execFile);
const CLIPS = Number(process.env.BENCH_CLIPS ?? 12);
const CLIP_S = Number(process.env.BENCH_CLIP_SECONDS ?? 8);
const dir = mkdtempSync(path.join(tmpdir(), "prism-bench-"));
const media = new FfmpegMediaProcessor({ timeoutMs: 15 * 60_000 } as never);

const readCg = (f: string) => {
  try {
    return Number(readFileSync(`/sys/fs/cgroup/${f}`, "utf8").trim());
  } catch {
    return NaN;
  }
};
const limitBytes = readCg("memory.max");
const cpuMax = (() => {
  try {
    const [q, p] = readFileSync("/sys/fs/cgroup/cpu.max", "utf8").trim().split(" ");
    return q === "max" ? "unlimited" : (Number(q) / Number(p)).toFixed(2);
  } catch {
    return "unknown";
  }
})();

async function measure<T>(label: string, fn: () => Promise<T>) {
  let peak = readCg("memory.current");
  const timer = setInterval(() => {
    const v = readCg("memory.current");
    if (v > peak) peak = v;
  }, 100);
  const t0 = Date.now();
  try {
    const value = await fn();
    return { label, ok: true, seconds: (Date.now() - t0) / 1000, peakMiB: Math.round(peak / 1048576), value };
  } catch (e) {
    return {
      label,
      ok: false,
      seconds: (Date.now() - t0) / 1000,
      peakMiB: Math.round(peak / 1048576),
      error: String((e as Error).message).slice(0, 160),
    };
  } finally {
    clearInterval(timer);
  }
}

async function synthesize(i: number) {
  const file = path.join(dir, `src-${i}.mp4`);
  await run("ffmpeg", [
    "-v",
    "error",
    "-y",
    "-f",
    "lavfi",
    "-i",
    `testsrc2=size=1920x1080:rate=24:duration=${CLIP_S}`,
    "-f",
    "lavfi",
    "-i",
    `sine=frequency=${220 + i * 30}:duration=${CLIP_S}`,
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    "-shortest",
    file,
  ]);
  return file;
}

const results: unknown[] = [];
const sources: string[] = [];
for (let i = 0; i < CLIPS; i++) sources.push(await synthesize(i));
const srcBytes = sources.map((f) => new Uint8Array(readFileSync(f)));

// The two explicit delivery plans for a 16:9 source on a 2.39:1 Shot (conform never scales; it crops and/or pads):
//   crop      keep the centre 1920x804 band
//   pillarbox place the full 1920x1080 frame in a 2580x1080 (2.39:1) frame, black bars left and right
const plans = {
  crop: { crop: { x: 0, y: 138, width: 1920, height: 804 }, pad: null, trimMs: null },
  pillarbox: {
    crop: null,
    pad: { frame: { width: 2580, height: 1080 }, placement: { x: 330, y: 0, width: 1920, height: 1080 } },
    trimMs: null,
  },
};
const ONLY = new Set((process.env.BENCH_ONLY ?? "").split(",").filter(Boolean));
const want = (w: string) => ONLY.size === 0 || ONLY.has(w);

const conformed: string[] = [];
const conform = async (plan: keyof typeof plans) => {
  for (let i = 0; i < srcBytes.length; i++) {
    const out = await media.conform(srcBytes[i]!, plans[plan] as never);
    if (plan === "crop") {
      const f = path.join(dir, `conf-${i}.mp4`);
      writeFileSync(f, out.bytes);
      conformed.push(f);
    }
  }
  return { clips: srcBytes.length, plan };
};
const qaFrames = async (n = srcBytes.length) => {
  let frames = 0;
  for (let i = 0; i < n; i++) {
    const at = Array.from({ length: 12 }, (_, k) => Math.round(((k + 0.5) * CLIP_S * 1000) / 12));
    frames += (await media.extractFrames(srcBytes[i]!, at)).length;
  }
  return { frames };
};
const contact = async () => {
  const frames = await media.extractFrames(
    srcBytes[0]!,
    Array.from({ length: 24 }, (_, k) => Math.round(((k + 0.5) * CLIP_S * 1000) / 24)),
  );
  const sheet = await media.generateContactSheet(
    frames.map((f) => f.bytes),
    { columns: 6, cellWidth: 320 },
  );
  return { bytes: sheet.bytes.length };
};
const render = async () => {
  const list = conformed.length ? conformed : sources;
  const out = path.join(dir, "episode.mp4");
  const inputs = list.flatMap((f) => ["-i", f]);
  const n = list.length;
  const total = n * CLIP_S;
  const v = list
    .map(
      (_, i) =>
        `[${i}:v]scale=1920:804:force_original_aspect_ratio=decrease,pad=1920:804:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=24[v${i}]`,
    )
    .join(";");
  const a = list.map((_, i) => `[${i}:a]aresample=48000[a${i}]`).join(";");
  const concat = `${list.map((_, i) => `[v${i}][a${i}]`).join("")}concat=n=${n}:v=1:a=1[vout][dialogue]`;
  const music = `sine=frequency=110:duration=${total},volume=0.25,afade=t=in:st=0:d=2,afade=t=out:st=${total - 3}:d=3[music]`;
  const mix = `[dialogue][music]amix=inputs=2:duration=first:dropout_transition=0[aout]`;
  await run(
    "ffmpeg",
    [
      "-v",
      "error",
      "-y",
      ...inputs,
      "-filter_complex",
      [v, a, concat, music, mix].join(";"),
      "-map",
      "[vout]",
      "-map",
      "[aout]",
      "-c:v",
      "libx264",
      "-preset",
      "medium",
      "-crf",
      "20",
      "-pix_fmt",
      "yuv420p",
      "-movflags",
      "+faststart",
      "-c:a",
      "aac",
      "-b:a",
      "192k",
      out,
    ],
    { maxBuffer: 1 << 20, timeout: 30 * 60_000 },
  );
  return { episodeSeconds: total, outputMiB: +(statSync(out).size / 1048576).toFixed(1) };
};

console.log(
  JSON.stringify({
    limitMiB: Number.isFinite(limitBytes) ? Math.round(limitBytes / 1048576) : "max",
    cpus: cpuMax,
    clips: CLIPS,
    clipSeconds: CLIP_S,
  }),
);
if (want("conform")) {
  results.push(await measure("conform (crop to 2.39:1)", () => conform("crop")));
  results.push(await measure("conform (pillarbox into 2.39:1)", () => conform("pillarbox")));
}
if (want("qa_frames")) results.push(await measure("qa_frames", () => qaFrames()));
if (want("contact")) results.push(await measure("contact_sheet", contact));
if (want("render")) results.push(await measure(`episode_render (${CLIPS} inputs)`, render));
if (want("shared"))
  results.push(
    await measure("shared: render + continuity frames + contact sheets concurrently", async () => {
      const [r, q, c] = await Promise.all([
        render(),
        qaFrames(),
        Promise.all([contact(), contact(), contact()]),
      ]);
      return { render: r, qa: q, contactSheets: c.length };
    }),
  );
for (const r of results) console.log(JSON.stringify(r));
console.log(
  JSON.stringify({
    cgroupPeakMiB: Math.round(readCg("memory.peak") / 1048576),
    oomEvents: (() => {
      try {
        return readFileSync("/sys/fs/cgroup/memory.events", "utf8").match(/oom_kill (\d+)/)?.[1] ?? "?";
      } catch {
        return "?";
      }
    })(),
  }),
);
rmSync(dir, { recursive: true, force: true });

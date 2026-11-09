// Phase 5B-V4 durable EPISODE RENDER worker (Supabase mode). One render at a time, one ffmpeg process at a time.
//
//   npm run worker:render
//
// Required environment (the worker reads NO provider, Story or generation credential):
//   PRISM_STUDIO_RENDER_WORKER_DB_URL        login of a role that is a member of `prism_render_worker` (migration 0059;
//                                            provisioned per environment, like the generation worker's login)
//   NEXT_PUBLIC_SUPABASE_URL + NEXT_PUBLIC_PRISM_STUDIO_ENVIRONMENT / _SUPABASE_REF   the target project
//   PRISM_STUDIO_RENDER_WORKER_SUPABASE_SECRET_KEY   a server secret key for the PRIVATE `prism-assets` bucket (read the
//                                            sources and the segment cache; write segments and the final MP4)
//   ffmpeg + ffprobe on PATH (or PRISM_STUDIO_FFMPEG_PATH / PRISM_STUDIO_FFPROBE_PATH) with libx264, aac, drawtext
//   an open CJK title font (fonts-noto-cjk) or PRISM_STUDIO_RENDER_FONT_DIR
// Optional:
//   PRISM_STUDIO_RENDER_TEMP_DIR             scratch disk (default: OS temp); each render's directory is removed after it
//   PRISM_STUDIO_RENDER_IDLE_POLL_MS         poll interval when idle (default 5000)
// Local disposable only (never production): PRISM_STUDIO_RENDER_WORKER_DEV_ASSUME_ROLE=1 with SUPABASE_DB_URL runs the
// same queries as `set local role prism_render_worker`, and the local disk sink stores media.
//
// Health: one line per claim / completion / failure on stdout; exits non-zero on a configuration error. Concurrency: 1.
// Temp disk: at least ~3× the largest render (sources + segments + the final file) in PRISM_STUDIO_RENDER_TEMP_DIR.
import pg from "pg";
import { createOutputSink, LocalDiskSink } from "../src/generation/sink";
import { PostgresRenderWorkerStore } from "../src/render/postgres";
import { EpisodeRenderWorker } from "../src/render/worker";

const env = process.env;
const production = env.NODE_ENV === "production";
let url: string;
let preamble: string;
if (env.PRISM_STUDIO_RENDER_WORKER_DB_URL) {
  url = env.PRISM_STUDIO_RENDER_WORKER_DB_URL;
  preamble = "begin";
} else if (!production && env.PRISM_STUDIO_RENDER_WORKER_DEV_ASSUME_ROLE === "1" && env.SUPABASE_DB_URL) {
  url = env.SUPABASE_DB_URL;
  preamble = "begin; set local role prism_render_worker";
} else {
  console.error(
    "render worker: set PRISM_STUDIO_RENDER_WORKER_DB_URL (a login of the prism_render_worker role).",
  );
  process.exit(2);
}

const local = !production && env.PRISM_STUDIO_RENDER_WORKER_DEV_ASSUME_ROLE === "1";
const storage = local
  ? new LocalDiskSink()
  : await createOutputSink(
      { ...env, PRISM_STUDIO_WORKER_SUPABASE_SECRET_KEY: env.PRISM_STUDIO_RENDER_WORKER_SUPABASE_SECRET_KEY },
      "supabase",
    );

const pool = new pg.Pool({
  connectionString: url,
  max: 2,
  ssl: local ? undefined : { rejectUnauthorized: false },
});
const worker = new EpisodeRenderWorker({
  store: new PostgresRenderWorkerStore(pool, preamble),
  storage,
  storageProvider: storage.name,
  bucket: storage.bucket,
  workerId: `render-worker-${process.pid}`,
  tempRoot: env.PRISM_STUDIO_RENDER_TEMP_DIR || undefined,
  logger: (line) => console.log(`[render-worker] ${new Date().toISOString()} ${line}`),
});

let stopping = false;
for (const sig of ["SIGINT", "SIGTERM"] as const)
  process.on(sig, () => {
    stopping = true;
  });
const idle =
  Number(env.PRISM_STUDIO_RENDER_IDLE_POLL_MS) > 0 ? Number(env.PRISM_STUDIO_RENDER_IDLE_POLL_MS) : 5000;
console.log(`[render-worker] started (concurrency 1, storage ${storage.name})`);
while (!stopping) {
  const result = await worker.runOnce().catch((err: unknown) => {
    console.error(`[render-worker] loop error: ${(err as Error).message}`);
    return null;
  });
  if (!result) await new Promise((r) => setTimeout(r, idle));
}
await pool.end();
console.log("[render-worker] stopped");

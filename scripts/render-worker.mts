// Phase 5B-V4 durable EPISODE RENDER worker (Supabase mode). One render at a time, one ffmpeg process at a time.
//
//   npm run worker:render
//
// Required environment (the worker reads NO provider, Story or generation credential):
//   PRISM_STUDIO_RENDER_WORKER_DB_URL        the LOGIN of `prism_render_worker` itself (migration 0059 creates it NOLOGIN;
//                                            `npm run render:db:provision` attaches the login, like the other workers)
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
import { RENDER_WORKER_ROLE } from "./lib/render-worker-role";
import {
  assertProjectRef,
  disposableLocalTarget,
  installRedactingHandlers,
  printBanner,
} from "./lib/safety.mjs";

installRedactingHandlers();
const env = process.env;
const production = env.NODE_ENV === "production";
let url: string;
let preamble: string;
if (env.PRISM_STUDIO_RENDER_WORKER_DB_URL) {
  url = env.PRISM_STUDIO_RENDER_WORKER_DB_URL;
  // the dedicated project of this environment (or, outside production, a disposable loopback database)
  if (production || !disposableLocalTarget(url)) assertProjectRef(url, "PRISM_STUDIO_RENDER_WORKER_DB_URL");
  preamble = "begin";
} else if (!production && env.PRISM_STUDIO_RENDER_WORKER_DEV_ASSUME_ROLE === "1" && env.SUPABASE_DB_URL) {
  url = env.SUPABASE_DB_URL;
  preamble = `begin; set local role ${RENDER_WORKER_ROLE}`;
} else {
  console.error(
    "render worker: set PRISM_STUDIO_RENDER_WORKER_DB_URL (the prism_render_worker login; npm run render:db:provision).",
  );
  process.exit(2);
}

const local = !production && env.PRISM_STUDIO_RENDER_WORKER_DEV_ASSUME_ROLE === "1";
if (!local && !env.PRISM_STUDIO_RENDER_WORKER_SUPABASE_SECRET_KEY) {
  console.error(
    "render worker: set PRISM_STUDIO_RENDER_WORKER_SUPABASE_SECRET_KEY (its own Storage key; it never borrows another worker's).",
  );
  process.exit(2);
}
// The sink sees ONLY the render worker's own Storage key: never the generation worker's (legacy) key, never a dev
// user sign-in, never a provider credential.
const sinkEnv: NodeJS.ProcessEnv = {
  NODE_ENV: env.NODE_ENV,
  NEXT_PUBLIC_SUPABASE_URL: env.NEXT_PUBLIC_SUPABASE_URL,
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
  NEXT_PUBLIC_PRISM_STUDIO_ENVIRONMENT: env.NEXT_PUBLIC_PRISM_STUDIO_ENVIRONMENT,
  NEXT_PUBLIC_PRISM_STUDIO_SUPABASE_REF: env.NEXT_PUBLIC_PRISM_STUDIO_SUPABASE_REF,
  PRISM_STUDIO_WORKER_SUPABASE_SECRET_KEY: env.PRISM_STUDIO_RENDER_WORKER_SUPABASE_SECRET_KEY,
};
const storage = local ? new LocalDiskSink() : await createOutputSink(sinkEnv, "supabase");
printBanner({ mode: "episode render worker", url });

const pool = new pg.Pool({
  connectionString: url,
  max: 2,
  ssl: local ? undefined : { rejectUnauthorized: false },
});
// startup self-check: the connection really runs as the dedicated least-privilege role
{
  const c = await pool.connect();
  try {
    await c.query(preamble);
    const who = (await c.query("select current_user as u")).rows[0].u as string;
    await c.query("rollback");
    if (who !== RENDER_WORKER_ROLE) {
      console.error(
        `render worker: the connection runs as a different database role than ${RENDER_WORKER_ROLE}; refusing.`,
      );
      c.release();
      await pool.end();
      process.exit(2);
    }
  } finally {
    c.release();
  }
}
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

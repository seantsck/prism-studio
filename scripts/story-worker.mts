// Prism Studio Story Intelligence worker (Phase 5B-S1; runs OUTSIDE Next.js).
//   npm run worker:story                 run until SIGINT/SIGTERM
//   npm run worker:story -- --once       one tick, then exit
//
// The ONLY process that calls a Story Intelligence provider in Supabase mode, and the only one that holds its key
// (PRISM_STUDIO_PROVIDER_OPENAI_STORY_API_KEY). It claims queued Production Proposals (FOR UPDATE SKIP LOCKED + lease),
// re-checks the spend gate against the frozen estimate and confirmation, calls the provider, validates the answer and
// writes the result once. It reads no project content and never creates Characters, Locations, Scenes or Shots.
// Phase 5B-S2: it also claims writing proposals (writing_proposals, 0055) and writes their result once; it never
// writes a screenplay (accepting a revision is the creator's action on the web).
//
// Database credential — fail CLOSED:
//   PRISM_STUDIO_STORY_WORKER_DB_URL               a login for the least-privilege role prism_story_worker (0054);
//                                                  provisioned with `npm run story:db:provision` (docs/phase-5b-s2-…)
//   PRISM_STUDIO_STORY_WORKER_DEV_ASSUME_ROLE=1    DEVELOPMENT only: the admin SUPABASE_DB_URL with every session forced
//                                                  into prism_story_worker (never in production)
// Nothing secret is printed.
import pg from "pg";
import { PostgresStoryWorkerStore } from "../src/data/story-postgres";
import { PostgresWritingWorkerStore } from "../src/data/writing-postgres";
import { createStoryRegistry } from "../src/story/registry";
import { StoryWorker } from "../src/story/worker";
import { installRedactingHandlers } from "./lib/safety.mjs";

installRedactingHandlers();
const once = process.argv.includes("--once");
const production = process.env.NODE_ENV === "production";
let config: pg.PoolConfig;
if (process.env.PRISM_STUDIO_STORY_WORKER_DB_URL) {
  config = { connectionString: process.env.PRISM_STUDIO_STORY_WORKER_DB_URL };
} else if (
  !production &&
  process.env.PRISM_STUDIO_STORY_WORKER_DEV_ASSUME_ROLE === "1" &&
  process.env.SUPABASE_DB_URL
) {
  config = { connectionString: process.env.SUPABASE_DB_URL, options: "-c role=prism_story_worker" };
} else {
  console.error(
    "story-worker refuses to start: set PRISM_STUDIO_STORY_WORKER_DB_URL (the prism_story_worker login), or in development PRISM_STUDIO_STORY_WORKER_DEV_ASSUME_ROLE=1.",
  );
  process.exit(2);
}
const pool = new pg.Pool({ ...config, ssl: { rejectUnauthorized: false }, max: 2 });
const role = (await pool.query("select current_user as u")).rows[0]?.u as string;
if (role !== "prism_story_worker") {
  console.error(`story-worker refuses to run as ${role}: it must be prism_story_worker.`);
  await pool.end();
  process.exit(2);
}
const registry = createStoryRegistry(process.env);
const worker = new StoryWorker({
  store: new PostgresStoryWorkerStore(pool),
  writing: new PostgresWritingWorkerStore(pool),
  registry,
  workerId: `story-${process.pid}`,
});
console.log(
  `story-worker: role ${role}; models ${registry
    .models()
    .map((m) => `${m.provider}/${m.modelId}${m.available ? "" : " (unavailable)"}`)
    .join(", ")}`,
);
if (once) {
  console.log(`processed ${await worker.tick()}`);
  await pool.end();
} else {
  const controller = new AbortController();
  for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => controller.abort());
  await worker.run(controller.signal, 2000);
  await pool.end();
}

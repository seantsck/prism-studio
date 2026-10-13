// Prism Studio continuity ANALYSIS worker (runs OUTSIDE Next.js; deployable to any host that can run Node).
//   npm run continuity:worker                      run until SIGINT/SIGTERM
//   npm run continuity:worker -- --until-idle      process everything due, then exit (CI / one-shot)
//   npm run continuity:worker -- --once            a single tick, then exit
//   npm run continuity:worker -- --dry-run         show what is due without claiming or calling anything
//
// Connects as the dedicated least-privilege role `prism_continuity_worker` (PRISM_STUDIO_CONTINUITY_DB_URL):
// it can claim jobs, read the assets a frozen job names, and write execution state + normalized findings. It
// never falls back to the admin database credential. Credentials come from the environment ONLY; nothing secret
// is printed.
import pg from "pg";
import { PostgresAnalysisWorkerStore } from "../src/data/continuity-analysis-postgres";
import {
  analyzerStatuses,
  createAnalysisProviders,
  readAnalysisConfig,
} from "../src/continuity/analysis/registry";
import { ContinuityAnalysisWorker } from "../src/continuity/analysis/worker";
import { consoleLogger } from "../src/generation/log";
import { createOutputSink, SinkConfigError } from "../src/generation/sink";
import { FfmpegMediaProcessor } from "../src/media/ffmpeg";
import { PRISM_STUDIO_REF, assertProjectRef, installRedactingHandlers, printBanner } from "./lib/safety.mjs";

installRedactingHandlers();

const ROLE = "prism_continuity_worker";
const args = new Set(process.argv.slice(2));
const dryRun = args.has("--dry-run");
const once = args.has("--once");
const untilIdle = args.has("--until-idle");

const url = process.env.PRISM_STUDIO_CONTINUITY_DB_URL;
if (!url) {
  console.error(
    "PRISM_STUDIO_CONTINUITY_DB_URL is not set. The continuity worker never falls back to the admin database " +
      "credential. Provision the role with `npm run continuity:db:provision` and set the URL on this host.",
  );
  process.exit(2);
}
assertProjectRef(url, "PRISM_STUDIO_CONTINUITY_DB_URL");
if (process.env.PRISM_STUDIO_PERSISTENCE === "memory") {
  throw new Error(
    "The continuity worker needs PRISM_STUDIO_PERSISTENCE=supabase (memory mode has no shared state).",
  );
}
printBanner({
  mode: `continuity analysis worker${dryRun ? " (dry run)" : once ? " (single tick)" : untilIdle ? " (until idle)" : ""}`,
  url,
});

const config = readAnalysisConfig(process.env);
const pool = new pg.Pool({ connectionString: url, ssl: { rejectUnauthorized: false }, max: 4 });

{
  const c = await pool.connect();
  try {
    await c.query("begin");
    const who = (await c.query("select current_user as u, session_user as s")).rows[0] as {
      u: string;
      s: string;
    };
    await c.query("rollback");
    if (who.u !== ROLE || who.s !== ROLE) {
      console.error(`The connection runs as a different database role than ${ROLE}; refusing.`);
      c.release();
      await pool.end();
      process.exit(2);
    }
  } finally {
    c.release();
  }
}

console.log(`DB role:           ${ROLE} (PRISM_STUDIO_CONTINUITY_DB_URL)`);
console.log(`Supabase project:  ${PRISM_STUDIO_REF}`);
for (const a of analyzerStatuses(process.env)) {
  console.log(
    `  analyzer ${a.id}/${a.model}: ${a.state}${a.kind === "model" ? `, paid analysis ${a.spend === "enabled" ? "ENABLED" : "OFF"}` : ", free"}${a.usable ? " → usable" : ""}`,
  );
}
console.log(`Paid analysis:     ${config.paid.enabled ? "ENABLED" : "disabled"}`);
console.log(
  `Per-run ceiling:   ${config.paid.maxUsdPerRun == null ? "not set (paid analysis blocked)" : `$${config.paid.maxUsdPerRun.toFixed(4)}`}`,
);
console.log(
  `Daily ceiling:     ${config.paid.maxUsdPerDay == null ? "not set" : `$${config.paid.maxUsdPerDay.toFixed(2)}`}`,
);

const store = new PostgresAnalysisWorkerStore(pool);
if (dryRun) {
  const due = await pool.query(
    `select status, count(*)::int as n from continuity_analysis_jobs
      where status in ('queued','claimed','processing','cancel_requested') and next_run_at <= now()
      group by status order by status`,
  );
  console.log("due jobs:", due.rows.length ? due.rows : "none");
  await pool.end();
  process.exit(0);
}

let sink;
try {
  sink = await createOutputSink(process.env as Record<string, string | undefined>, "supabase");
  console.log(`Storage:           ${sink.name} (private bucket ${sink.bucket}, read-only use)`);
} catch (err) {
  if (err instanceof SinkConfigError) {
    console.error(`Storage is not configured for this worker: ${err.message}`);
    await pool.end();
    process.exit(2);
  }
  throw err;
}

const worker = new ContinuityAnalysisWorker({
  store,
  providers: createAnalysisProviders(process.env),
  media: { read: async (ref) => (ref.objectPath ? sink.get(ref.objectPath) : null) },
  processor: new FfmpegMediaProcessor(),
  logger: consoleLogger,
  paid: config.paid,
});
const controller = new AbortController();
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    console.log(`${signal}: finishing in-flight work, then exiting`);
    controller.abort();
  });
}

if (once) {
  console.log(`processed ${await worker.tick()} job(s)`);
} else if (untilIdle) {
  const deadline = Date.now() + 10 * 60_000;
  while (!controller.signal.aborted && Date.now() < deadline) {
    const n = await worker.tick();
    const active = await pool.query(
      "select count(*)::int as n from continuity_analysis_jobs where status in ('queued','claimed','processing','cancel_requested')",
    );
    if (active.rows[0].n === 0) break;
    if (n === 0) await new Promise((r) => setTimeout(r, 1500));
  }
} else {
  console.log(`worker ${worker.workerId} running; Ctrl+C to stop`);
  await worker.run(controller.signal);
}
await pool.end();
console.log("worker stopped");

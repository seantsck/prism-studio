// Prism Studio generation worker (runs OUTSIDE Next.js; deployable to any host that can run Node).
//   npm run worker:generation                      run until SIGINT/SIGTERM
//   npm run worker:generation -- --until-idle      process everything due, then exit (CI / one-shot)
//   npm run worker:generation -- --once            a single tick (claim + one step per job), then exit
//   npm run worker:generation -- --dry-run         show what is due without claiming or calling providers
//
// It claims jobs through Postgres (FOR UPDATE SKIP LOCKED + leases), drives provider adapters, ingests
// outputs into Prism's private Storage, and records every transition. Credentials come from the
// environment ONLY; nothing secret is printed.
import pg from "pg";
import { PostgresGenerationData } from "../src/data/generation-postgres";
import { readGenerationConfig } from "../src/generation/config";
import { consoleLogger } from "../src/generation/log";
import { createRegistry } from "../src/generation/registry";
import { createOutputSink, SinkConfigError } from "../src/generation/sink";
import { GenerationWorker } from "../src/generation/worker";
import { assertProjectRef, startScript } from "./lib/safety.mjs";

const args = new Set(process.argv.slice(2));
const dryRun = args.has("--dry-run");
const once = args.has("--once");
const untilIdle = args.has("--until-idle");

const url = startScript({
  mode: `generation worker${dryRun ? " (dry run)" : once ? " (single tick)" : untilIdle ? " (until idle)" : ""}`,
});
assertProjectRef(url);
if (process.env.PRISM_STUDIO_PERSISTENCE === "memory") {
  throw new Error("The worker needs PRISM_STUDIO_PERSISTENCE=supabase (memory mode has no shared state).");
}

const config = readGenerationConfig(process.env);
const registry = createRegistry(process.env, config);
const pool = new pg.Pool({
  connectionString: url,
  ssl: { rejectUnauthorized: false },
  max: config.worker.concurrency + 2,
});
const store = new PostgresGenerationData(pool, "begin");

console.log(
  `enabled providers: ${config.enabledProviders.join(", ") || "(none)"} | models: ${registry
    .availability()
    .filter((m) => m.available)
    .map((m) => `${m.provider}/${m.modelId}`)
    .join(", ")}`,
);

if (dryRun) {
  const due = await pool.query(
    `select status, count(*)::int as n from generation_jobs
     where status in ('queued','submitting','submitted','processing','ingesting','cancel_requested')
       and next_run_at <= now() group by status order by status`,
  );
  console.log("due jobs:", due.rows.length ? due.rows : "none");
  await pool.end();
  process.exit(0);
}

let sink;
try {
  // Dev/test fallback sink signs in as the test user; application code never reads PRISM_STUDIO_DEV_USER_*.
  const sinkEnv = { ...process.env };
  sinkEnv.PRISM_STUDIO_TEST_EMAIL ??= process.env.PRISM_STUDIO_DEV_USER_EMAIL;
  sink = await createOutputSink(sinkEnv, "supabase");
} catch (err) {
  if (err instanceof SinkConfigError) {
    console.error(`Storage is not configured for this worker: ${err.message}`);
    await pool.end();
    process.exit(2);
  }
  throw err;
}

const worker = new GenerationWorker({ store, registry, sink, config, logger: consoleLogger });
const controller = new AbortController();
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    console.log(`${signal}: finishing in-flight work, then exiting`);
    controller.abort();
  });
}

if (once) {
  const n = await worker.tick();
  console.log(`processed ${n} job step(s)`);
} else if (untilIdle) {
  // Jobs poll providers on a cadence, so "idle" = nothing active remains (or the safety limit is hit).
  const deadline = Date.now() + 15 * 60_000;
  while (!controller.signal.aborted && Date.now() < deadline) {
    const n = await worker.tick();
    const active = await pool.query(
      `select count(*)::int as n from generation_jobs
       where status in ('queued','submitting','submitted','processing','ingesting','cancel_requested')`,
    );
    if (active.rows[0].n === 0) break;
    if (n === 0) await new Promise((r) => setTimeout(r, config.worker.idlePollMs));
  }
} else {
  console.log(`worker ${worker.workerId} running; Ctrl+C to stop`);
  await worker.run(controller.signal);
}

await pool.end();
console.log("worker stopped");

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
import { WORKER_ROLE } from "./lib/worker-role-spec.mjs";
import { PRISM_STUDIO_REF, assertProjectRef, installRedactingHandlers, printBanner } from "./lib/safety.mjs";

installRedactingHandlers();

const args = new Set(process.argv.slice(2));
const dryRun = args.has("--dry-run");
const once = args.has("--once");
const untilIdle = args.has("--until-idle");
const production = process.env.NODE_ENV === "production";

// ── which database credential? Fail CLOSED: the dedicated least-privilege role, or an explicit dev opt-in. ──
let url: string;
let preamble = "begin";
let dbMode: string;
if (process.env.PRISM_STUDIO_WORKER_DB_URL) {
  url = process.env.PRISM_STUDIO_WORKER_DB_URL;
  assertProjectRef(url, "PRISM_STUDIO_WORKER_DB_URL");
  dbMode = `dedicated role ${WORKER_ROLE} (PRISM_STUDIO_WORKER_DB_URL)`;
} else if (!production && process.env.PRISM_STUDIO_WORKER_DEV_ASSUME_ROLE === "1") {
  // DEV/TEST: the admin connection, but every statement runs as the least-privilege role (SET LOCAL ROLE).
  url = process.env.SUPABASE_DB_URL ?? "";
  assertProjectRef(url, "SUPABASE_DB_URL");
  preamble = `begin; set local role ${WORKER_ROLE}`;
  dbMode = `${WORKER_ROLE} via SET ROLE on the admin connection (development)`;
} else if (!production && process.env.PRISM_STUDIO_WORKER_DEV_ADMIN_DB === "1") {
  url = process.env.SUPABASE_DB_URL ?? "";
  assertProjectRef(url, "SUPABASE_DB_URL");
  console.warn("WARNING: running the worker on the ADMIN database credential (development only).");
  dbMode = "ADMIN credential (development opt-in)";
} else {
  console.error(
    "PRISM_STUDIO_WORKER_DB_URL is not set. The generation worker never falls back to the admin database " +
      "credential. Provision the role (npm run worker:db:provision) and set PRISM_STUDIO_WORKER_DB_URL on the " +
      "worker host. Development only: PRISM_STUDIO_WORKER_DEV_ASSUME_ROLE=1.",
  );
  process.exit(2);
}
if (process.env.PRISM_STUDIO_PERSISTENCE === "memory") {
  throw new Error("The worker needs PRISM_STUDIO_PERSISTENCE=supabase (memory mode has no shared state).");
}
printBanner({
  mode: `generation worker${dryRun ? " (dry run)" : once ? " (single tick)" : untilIdle ? " (until idle)" : ""}`,
  url,
});

const config = readGenerationConfig(process.env);
const registry = createRegistry(process.env, config);
const pool = new pg.Pool({
  connectionString: url,
  ssl: { rejectUnauthorized: false },
  max: config.worker.concurrency + 2,
});

// ── startup self-check: the role really is the dedicated one, and what is enabled ──
{
  const c = await pool.connect();
  try {
    await c.query(preamble);
    const who = (await c.query("select current_user as u")).rows[0].u as string;
    if (dbMode.startsWith("dedicated") || dbMode.includes("SET ROLE")) {
      if (who !== WORKER_ROLE) {
        console.error(
          `The worker connection runs as a different database role than ${WORKER_ROLE}; refusing.`,
        );
        await c.query("rollback");
        c.release();
        await pool.end();
        process.exit(2);
      }
    }
    await c.query("rollback");
  } finally {
    c.release();
  }
}
const available = registry.availability();
console.log(`DB role:           ${WORKER_ROLE} — ${dbMode}`);
console.log(`Supabase project:  ${PRISM_STUDIO_REF}`);
console.log(`Providers enabled: ${config.enabledProviders.join(", ") || "(none)"}`);
for (const m of available) {
  const state = m.available
    ? "configured"
    : !m.enabled
      ? "disabled"
      : `missing credential (${m.missingConfig.length})`;
  console.log(`  ${m.provider}/${m.modelId}: ${state}`);
}
console.log(
  `Paid generation:   ${config.paid.enabled ? "ENABLED" : "disabled"}${
    config.paid.enabled
      ? ` (max $${config.paid.maxUsd ?? "— not set: paid generation is blocked"} per generation)`
      : ""
  }`,
);

const store = new PostgresGenerationData(pool, preamble);

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
  // The dev-only test-user sink additionally needs PRISM_STUDIO_WORKER_DEV_STORAGE=1 (never in production).
  const sinkEnv = { ...process.env };
  sinkEnv.PRISM_STUDIO_TEST_EMAIL ??= process.env.PRISM_STUDIO_DEV_USER_EMAIL;
  sink = await createOutputSink(sinkEnv, "supabase");
  console.log(`Storage:           ${sink.name} (private bucket ${sink.bucket})`);
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

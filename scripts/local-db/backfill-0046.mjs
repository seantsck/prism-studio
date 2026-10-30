// DISPOSABLE LOCAL ONLY: proves migration 0046 rewrites no history (Phase 3A.4C, §53 of the gate).
//   node --env-file=<disposable env> scripts/local-db/backfill-0046.mjs before   (ledger at 0045) inserts attempt runs,
//        findings, overrides, jobs (one per status family), costs and events into the seeded project, and saves every
//        row as JSON next to this database's name in the OS temp directory
//   node --env-file=<disposable env> scripts/db-migrate.mjs                      applies 0046
//   node --env-file=<disposable env> scripts/local-db/backfill-0046.mjs after    (ledger at 0046) every saved row is
//        unchanged except the new subject_kind, which is 'attempt' on every run and job
import { readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import pg from "pg";
import { disposableLocalTarget, installRedactingHandlers, printBanner } from "../lib/safety.mjs";

installRedactingHandlers();
const url = process.env.SUPABASE_DB_URL;
if (!disposableLocalTarget(url))
  throw new Error("backfill-0046 runs on a disposable local database only; refusing.");
const mode = process.argv[2];
printBanner({ mode: `0046 backfill proof (${mode})`, url });
const file = path.join(os.tmpdir(), `${new URL(url).pathname.slice(1)}-backfill-0046.json`);
const c = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
await c.connect();
// close the connection on every path, so a refused or failed proof exits instead of hanging on the open socket
try {
  const head = (await c.query("select max(name) as n from prism_migrations")).rows[0].n;
  const TABLES = [
    "continuity_runs",
    "continuity_findings",
    "continuity_overrides",
    "continuity_analysis_jobs",
    "continuity_analysis_costs",
    "continuity_analysis_events",
  ];
  const rowsOf = async (table) =>
    (await c.query(`select to_jsonb(t) as j from ${table} t order by id`)).rows.map((r) => r.j);

  if (mode === "before") {
    if (!head.startsWith("0045")) throw new Error(`expected the ledger at 0045, found ${head}`);
    await c.query("begin");
    const project = (await c.query("select id from projects order by created_at limit 1")).rows[0].id;
    const attempts = (
      await c.query("select id from generation_attempts where project_id = $1 order by id", [project])
    ).rows;
    const asset = (
      await c.query("select id from assets where project_id = $1 order by id limit 1", [project])
    ).rows[0].id;
    let n = 0;
    for (const [i, a] of attempts.entries()) {
      for (let k = 1; k <= 2; k++) {
        const run = (
          await c.query(
            `insert into continuity_runs (project_id, attempt_id, run_number, subject_asset_id, original_asset_id, analyzer,
             analyzer_version, analyzer_kind, rules_version, analysis_status, package_fingerprint, subject_fingerprint,
             criteria_fingerprint, reference_fingerprint, reference_set, automation_key, model, prompt_version)
           values ($1, $2, $3, $4, $4, 'mock', '1', 'mock', '3a.1', $5, 'pf', 'sf', 'cf', 'rf', '{"items":[]}',
                   $6, 'mock-1', 'p1')
           returning id`,
            [
              project,
              a.id,
              k,
              asset,
              k === 1 ? "complete" : "queued",
              i === 0 && k === 1 ? "auto-key-backfill-0046" : null,
            ],
          )
        ).rows[0].id;
        const finding = (
          await c.query(
            `insert into continuity_findings (project_id, run_id, criterion_key, category, severity, title, result)
           values ($1, $2, 'wardrobe:c1', 'wardrobe', 'major', 'Wardrobe', 'warn') returning id`,
            [project, run],
          )
        ).rows[0].id;
        await c.query(
          "insert into continuity_overrides (project_id, run_id, finding_id, result, notes) values ($1, $2, $3, 'pass', 'ok')",
          [project, run, finding],
        );
        const job = (
          await c.query(
            `insert into continuity_analysis_jobs (project_id, run_id, attempt_id, analyzer, model, status, input_snapshot,
             input_asset_ids, idempotency_key, completed_at)
           values ($1, $2, $3, 'mock', 'mock-1', $4, '{"v":1}', array[$5]::uuid[], $6, $7) returning id`,
            [
              project,
              run,
              a.id,
              k === 1 ? "succeeded" : "queued",
              asset,
              `backfill-0046-${i}-${k}`,
              k === 1 ? new Date() : null,
            ],
          )
        ).rows[0].id;
        await c.query(
          `insert into continuity_analysis_costs (project_id, run_id, job_id, analyzer, model, kind, amount_usd)
         values ($1, $2, $3, 'mock', 'mock-1', 'estimated', 0.01)`,
          [project, run, job],
        );
        await c.query(
          "insert into continuity_analysis_events (project_id, job_id, run_id, to_status, note) values ($1, $2, $3, 'queued', 'x')",
          [project, job, run],
        );
        n++;
      }
    }
    await c.query("commit");
    const snapshot = {};
    for (const t of TABLES) snapshot[t] = await rowsOf(t);
    writeFileSync(file, JSON.stringify(snapshot));
    console.log(
      `0045: ${n} runs (+ findings, overrides, jobs, costs, events) recorded for the backfill proof.`,
    );
  } else if (mode === "after") {
    if (!head.startsWith("0046")) throw new Error(`expected the ledger at 0046, found ${head}`);
    const before = JSON.parse(readFileSync(file, "utf8"));
    let ok = true;
    for (const t of TABLES) {
      const now = await rowsOf(t);
      const strip = (rows) =>
        rows.map((r) => {
          const { subject_kind, ...rest } = r;
          if ((t === "continuity_runs" || t === "continuity_analysis_jobs") && subject_kind !== "attempt")
            ok = false;
          return rest;
        });
      const same = JSON.stringify(strip(now)) === JSON.stringify(before[t]);
      const kinds =
        t === "continuity_runs" || t === "continuity_analysis_jobs"
          ? ` subject_kind: ${[...new Set(now.map((r) => r.subject_kind))].join(",")}`
          : "";
      console.log(`${same ? "PASS" : "FAIL"}  ${t}: ${now.length} rows unchanged by 0046.${kinds}`);
      if (!same) ok = false;
    }
    // the fixture is test data: remove it (runs cascade to findings, overrides, jobs, costs, events)
    await c.query(
      "delete from continuity_runs where package_fingerprint = 'pf' and subject_fingerprint = 'sf'",
    );
    console.log(ok ? "BACKFILL OK" : "BACKFILL PROBLEMS");
    if (!ok) process.exitCode = 1;
  } else throw new Error("usage: backfill-0046.mjs before | after");
} finally {
  await c.end();
}

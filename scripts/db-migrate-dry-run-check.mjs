// Proves `db:migrate -- --dry-run` can NEVER commit, against the real database:
//   npm run db:migrate:dry-run-check
//
// It copies supabase/migrations into a temporary directory, adds a harmless probe migration (it creates a table and
// inserts a row), and runs the REAL migration runner there with --dry-run. Afterwards it asserts that nothing
// persisted: no probe table, no ledger row for the probe, and the ledger is exactly as it was. Writes nothing itself.
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import pg from "pg";
import { startScript } from "./lib/safety.mjs";

const url = startScript({ mode: "migrate --dry-run check (rolled back; nothing persists)" });
const PROBE = "9998_dry_run_probe.sql";
const client = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
await client.connect();
const ledger = async () =>
  (
    await client.query("select name, checksum, applied_at from public.prism_migrations order by name")
  ).rows.map((r) => `${r.name}|${r.checksum}|${new Date(r.applied_at).toISOString()}`);
const out = [];
const check = (name, ok, detail = "") => out.push([name, ok, detail]);

const tmp = mkdtempSync(path.join(os.tmpdir(), "prism-dry-run-"));
try {
  const before = await ledger();
  cpSync(path.join(process.cwd(), "supabase", "migrations"), path.join(tmp, "supabase", "migrations"), {
    recursive: true,
  });
  writeFileSync(
    path.join(tmp, "supabase", "migrations", PROBE),
    "create table public.prism_dry_run_probe (id int primary key);\ninsert into public.prism_dry_run_probe values (1);\n",
  );
  const run = spawnSync(
    process.execPath,
    [path.join(process.cwd(), "scripts", "db-migrate.mjs"), "--dry-run"],
    { cwd: tmp, env: process.env, encoding: "utf8" },
  );
  const text = `${run.stdout}${run.stderr}`;
  check(
    "the dry run succeeded and says it rolled back",
    run.status === 0 && /ROLLED BACK \(dry run\)/.test(text),
    text.slice(-300),
  );
  check("…and applied the probe inside its transaction", text.includes(`applied  ${PROBE}`));
  check("…and never printed 'committed'", !/committed/.test(text));
  const table = await client.query("select to_regclass('public.prism_dry_run_probe') as t");
  check("the probe table does NOT exist afterwards", table.rows[0].t === null);
  const after = await ledger();
  check(
    "the migration ledger is byte-for-byte what it was",
    JSON.stringify(after) === JSON.stringify(before),
  );
  check("…and has no row for the probe", !after.some((l) => l.startsWith(PROBE)));
  // --check and --dry-run are exclusive (a mistyped command cannot do something else)
  const both = spawnSync(
    process.execPath,
    [path.join(process.cwd(), "scripts", "db-migrate.mjs"), "--check", "--dry-run"],
    { cwd: tmp, env: process.env, encoding: "utf8" },
  );
  check(
    "--check with --dry-run is refused",
    both.status !== 0 && /either --check or --dry-run/.test(`${both.stdout}${both.stderr}`),
  );
} finally {
  await client.query("drop table if exists public.prism_dry_run_probe").catch(() => undefined);
  rmSync(tmp, { recursive: true, force: true });
  await client.end();
}
let failed = 0;
for (const [name, ok, detail] of out) {
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : ` — ${detail}`}`);
}
console.log(`\n${out.length - failed}/${out.length} passed`);
process.exit(failed ? 1 : 0);

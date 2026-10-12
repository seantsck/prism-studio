// Applies supabase/migrations/*.sql in order, all pending files in ONE transaction.
// Integrity: every applied file's SHA-256 is recorded in public.prism_migrations and re-verified on every run.
//   npm run db:migrate              apply pending migrations (refuses if an applied file changed on disk)
//   npm run db:migrate -- --check   verify only; exits non-zero on any problem, writes nothing
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import pg from "pg";
import { assertPlanSafe, checksumOf, planMigrations } from "./lib/migrations.mjs";
import { startScript } from "./lib/safety.mjs";

const checkOnly = process.argv.includes("--check");
const url = startScript({ mode: checkOnly ? "migrate --check (read-only)" : "migrate" });

const dir = path.join(process.cwd(), "supabase", "migrations");
const files = readdirSync(dir)
  .filter((f) => f.endsWith(".sql"))
  .sort()
  .map((name) => ({ name, sql: readFileSync(path.join(dir, name), "utf8") }));

const client = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
await client.connect();
try {
  if (checkOnly) {
    const exists = (await client.query("select to_regclass('public.prism_migrations') t")).rows[0].t;
    const hasChecksum = exists
      ? (
          await client.query(
            "select 1 from information_schema.columns where table_schema='public' and table_name='prism_migrations' and column_name='checksum'",
          )
        ).rowCount > 0
      : false;
    const applied = exists
      ? (
          await client.query(
            `select name, ${hasChecksum ? "checksum" : "null::text as checksum"} from public.prism_migrations`,
          )
        ).rows
      : [];
    const plan = planMigrations(files, applied);
    for (const f of files) {
      const state = plan.mismatched.includes(f.name)
        ? "CHANGED ON DISK"
        : plan.unrecorded.includes(f.name)
          ? "applied, no checksum recorded yet"
          : plan.pending.some((p) => p.name === f.name)
            ? "pending"
            : "ok";
      console.log(`${state === "ok" ? "ok     " : "PROBLEM"}  ${f.name}  ${state}`);
    }
    assertPlanSafe(plan);
    if (plan.unrecorded.length)
      throw new Error("Some applied migrations have no recorded checksum; run npm run db:migrate once.");
    if (plan.pending.length)
      throw new Error(`Pending migrations: ${plan.pending.map((p) => p.name).join(", ")}`);
    console.log("MIGRATION CHECKSUMS OK");
  } else {
    await client.query("begin");
    await client.query(
      "create table if not exists public.prism_migrations (name text primary key, applied_at timestamptz not null default now())",
    );
    await client.query("alter table public.prism_migrations enable row level security"); // no policies: not exposed via API
    await client.query("alter table public.prism_migrations add column if not exists checksum text");
    await client.query(
      "alter table public.prism_migrations add column if not exists checksum_baseline boolean not null default false",
    );
    const applied = (await client.query("select name, checksum from public.prism_migrations")).rows;
    const plan = planMigrations(files, applied);
    assertPlanSafe(plan);

    // Migrations applied before checksum tracking: record today's file content as the BASELINE.
    // This does not prove the file equals what was originally executed (0005 was edited after it was
    // applied; see docs/migration-policy.md). It guarantees no further silent drift.
    for (const name of plan.unrecorded) {
      const f = files.find((x) => x.name === name);
      await client.query(
        "update public.prism_migrations set checksum = $2, checksum_baseline = true where name = $1",
        [name, checksumOf(f.sql)],
      );
      console.log("baseline", name);
    }
    for (const f of files) {
      if (!plan.pending.some((p) => p.name === f.name)) {
        if (!plan.unrecorded.includes(f.name)) console.log("skip    ", f.name);
        continue;
      }
      await client.query(f.sql);
      await client.query("insert into public.prism_migrations (name, checksum) values ($1, $2)", [
        f.name,
        checksumOf(f.sql),
      ]);
      console.log("applied ", f.name);
    }
    await client.query("commit");
    console.log("committed");
  }
} catch (err) {
  await client.query("rollback").catch(() => undefined);
  throw err;
} finally {
  await client.end();
}

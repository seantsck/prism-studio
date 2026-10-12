// Applies supabase/migrations/*.sql in order, all pending files in ONE transaction.
// Guarded to the dedicated Prism Studio project ref. Tracks applied files in public.prism_migrations.
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import pg from "pg";

const REF = "lyqdxiyjperhniwhzsvg";
const url = process.env.SUPABASE_DB_URL;
if (!url?.includes(REF))
  throw new Error("SUPABASE_DB_URL does not point at the Prism Studio project; refusing.");

const dir = path.join(process.cwd(), "supabase", "migrations");
const files = readdirSync(dir)
  .filter((f) => f.endsWith(".sql"))
  .sort();

const client = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
await client.connect();
try {
  await client.query("begin");
  await client.query(
    "create table if not exists public.prism_migrations (name text primary key, applied_at timestamptz not null default now())",
  );
  await client.query("alter table public.prism_migrations enable row level security"); // no policies: not exposed via API
  const done = new Set(
    (await client.query("select name from public.prism_migrations")).rows.map((r) => r.name),
  );
  for (const f of files) {
    if (done.has(f)) {
      console.log("skip   ", f);
      continue;
    }
    await client.query(readFileSync(path.join(dir, f), "utf8"));
    await client.query("insert into public.prism_migrations (name) values ($1)", [f]);
    console.log("applied", f);
  }
  await client.query("commit");
  console.log("committed");
} catch (err) {
  await client.query("rollback").catch(() => undefined);
  console.error("ROLLED BACK:", err.message);
  process.exitCode = 1;
} finally {
  await client.end();
}

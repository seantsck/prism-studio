// Read-only: confirms we are connected to the dedicated Prism Studio project and shows what exists.
import pg from "pg";

const EXPECTED_REF = "lyqdxiyjperhniwhzsvg";
const url = process.env.SUPABASE_DB_URL;
if (!url) throw new Error("SUPABASE_DB_URL is not set");
if (!url.includes(EXPECTED_REF))
  throw new Error("SUPABASE_DB_URL does not point at the Prism Studio project; refusing.");

const client = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
await client.connect();
const q = async (sql) => (await client.query(sql)).rows;
console.log("db:", (await q("select current_database() d, version() v"))[0].d);
console.log(
  "public tables:",
  (await q("select table_name from information_schema.tables where table_schema='public' order by 1")).map(
    (r) => r.table_name,
  ),
);
console.log("auth.users count:", (await q("select count(*)::int c from auth.users"))[0].c);
console.log(
  "storage buckets:",
  (await q("select id from storage.buckets")).map((r) => r.id),
);
await client.end();

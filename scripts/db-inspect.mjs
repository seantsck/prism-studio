// Read-only: confirms we are connected to the dedicated Prism Studio project and shows what exists.
import pg from "pg";

import { startScript } from "./lib/safety.mjs";

const url = startScript({ mode: "inspect (read-only)" });

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

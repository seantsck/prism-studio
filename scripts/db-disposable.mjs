// A DISPOSABLE LOCAL PostgreSQL for verifying an UNAPPLIED migration with the real db:* scripts, never touching the
// hosted project (Phase 3A.4C). Refuses anything but an explicit opt-in loopback target (scripts/lib/safety.mjs):
//   PRISM_STUDIO_DISPOSABLE_DB=1
//   SUPABASE_DB_URL=postgresql://postgres:<pw>@127.0.0.1:<port>/prism_disposable<suffix>
//
//   node --env-file=<disposable env> scripts/db-disposable.mjs reset   drop + create the database, apply the Supabase
//                                                                      shim, create the dev user in auth.users
//   node --env-file=<disposable env> scripts/db-migrate.mjs            the REAL migration runner (0001..N)
//   node --env-file=<disposable env> scripts/db-disposable.mjs roles   give the worker roles a LOCAL login (from the
//                                                                      worker URLs) so db:worker-role logs in for real
// See docs/local-supabase.md. Nothing here ever reads or writes the hosted project.
import { readFileSync } from "node:fs";
import path from "node:path";
import pg from "pg";
import { disposableLocalTarget, installRedactingHandlers, printBanner } from "./lib/safety.mjs";

installRedactingHandlers();
const url = process.env.SUPABASE_DB_URL;
if (!disposableLocalTarget(url))
  throw new Error(
    "db-disposable refuses: set PRISM_STUDIO_DISPOSABLE_DB=1 and a loopback SUPABASE_DB_URL whose database is prism_disposable*.",
  );
const command = process.argv[2];
printBanner({ mode: `disposable ${command}`, url });

const target = new URL(url);
const database = target.pathname.slice(1);
const connect = async (u) => {
  const c = new pg.Client({ connectionString: u, ssl: { rejectUnauthorized: false } });
  await c.connect();
  return c;
};
const ident = (s) => `"${String(s).replace(/"/g, '""')}"`;
const literal = (s) => `'${String(s).replace(/'/g, "''")}'`;

if (command === "reset") {
  const admin = new URL(url);
  admin.pathname = "/postgres";
  const server = await connect(admin.toString());
  await server.query(`drop database if exists ${ident(database)} with (force)`);
  await server.query(`create database ${ident(database)}`);
  await server.end();

  const db = await connect(url);
  try {
    await db.query(
      readFileSync(path.join(process.cwd(), "scripts", "local-db", "supabase-shim.sql"), "utf8"),
    );
  } catch (err) {
    // close the connection so a failed reset exits instead of hanging on the open socket
    await db.end();
    throw err;
  }
  const users = [
    [process.env.PRISM_STUDIO_DEV_USER_ID, process.env.PRISM_STUDIO_DEV_USER_EMAIL ?? null],
    ...(process.env.PRISM_STUDIO_DISPOSABLE_EXTRA_USERS ?? "")
      .split(",")
      .filter(Boolean)
      .map((id) => [id, null]),
  ].filter(([id]) => id);
  for (const [id, email] of users)
    await db.query("insert into auth.users (id, email) values ($1, $2) on conflict do nothing", [id, email]);
  await db.end();
  console.log(`Database ${database} recreated with the Supabase shim; auth users: ${users.length}.`);
} else if (command === "roles") {
  const db = await connect(url);
  let n = 0;
  for (const key of ["PRISM_STUDIO_WORKER_DB_URL", "PRISM_STUDIO_CONTINUITY_DB_URL"]) {
    const workerUrl = process.env[key];
    if (!workerUrl) continue;
    if (!disposableLocalTarget(workerUrl))
      throw new Error(`${key} is not a disposable local target; refusing.`);
    const u = new URL(workerUrl);
    const role = decodeURIComponent(u.username);
    if (!/^prism_[a-z_]+_worker$/.test(role)) throw new Error(`${key} names an unexpected role; refusing.`);
    await db.query(`alter role ${ident(role)} login password ${literal(decodeURIComponent(u.password))}`);
    n += 1;
  }
  await db.end();
  console.log(`Local logins set for ${n} worker role(s).`);
} else {
  throw new Error("usage: db-disposable.mjs reset | roles");
}

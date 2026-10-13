// Provisions the LOGIN credential of the continuity analysis worker's least-privilege database role.
//
//   PRISM_STUDIO_CONTINUITY_DB_PASSWORD=<new secret> npm run continuity:db:provision
//   PRISM_STUDIO_CONTINUITY_DB_PASSWORD=<new secret> npm run continuity:db:provision -- --rotate
//
// Migration 0022 creates `prism_continuity_worker` NOLOGIN with no password. This script is the ONLY place a
// secret is attached to it, and the secret comes from the environment: never in a migration, never printed.
// Existing credentials are NOT replaced unless --rotate is passed. Independent of the generation worker role.
import pg from "pg";
import { PRISM_STUDIO_REF, redact, safeTarget, startScript } from "./lib/safety.mjs";

const ROLE = "prism_continuity_worker";
const rotate = process.argv.includes("--rotate");

const url = startScript({ mode: `provision ${ROLE} login${rotate ? " (rotate)" : ""}` });
const password = process.env.PRISM_STUDIO_CONTINUITY_DB_PASSWORD ?? "";

if (password.length < 24) {
  console.error(
    "PRISM_STUDIO_CONTINUITY_DB_PASSWORD must be set to a generated secret of at least 24 characters. Nothing was changed.",
  );
  process.exit(2);
}

const client = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
await client.connect();
try {
  const role = await client.query(
    "select rolcanlogin, rolsuper, rolbypassrls, rolcreaterole, rolcreatedb, rolreplication from pg_roles where rolname = $1",
    [ROLE],
  );
  if (role.rowCount === 0) {
    console.error(`Role ${ROLE} does not exist. Apply migration 0022 first (npm run db:migrate).`);
    process.exit(2);
  }
  const r = role.rows[0];
  if (r.rolsuper || r.rolbypassrls || r.rolcreaterole || r.rolcreatedb || r.rolreplication) {
    console.error(`Role ${ROLE} has elevated attributes; refusing to enable LOGIN.`);
    process.exit(2);
  }
  if (r.rolcanlogin && !rotate) {
    console.log(`${ROLE} already has LOGIN enabled. No change made (pass --rotate to replace its password).`);
  } else {
    const stmt = await client.query(
      "select format('alter role %I with login password %L connection limit 10', $1::text, $2::text) as sql",
      [ROLE, password],
    );
    await client.query(stmt.rows[0].sql);
    console.log(`${ROLE}: LOGIN ${r.rolcanlogin ? "password rotated" : "enabled"} (connection limit 10).`);
  }
  console.log(`Pooler login name: ${ROLE}.${PRISM_STUDIO_REF}  (admin URL targets ${safeTarget(url)})`);
  console.log(
    "Set on the continuity worker host ONLY: PRISM_STUDIO_CONTINUITY_DB_URL=postgresql://<login>:<password>@<session-pooler-host>:5432/postgres",
  );
} catch (err) {
  console.error(redact(err instanceof Error ? err.message : String(err)));
  process.exitCode = 1;
} finally {
  await client.end();
}

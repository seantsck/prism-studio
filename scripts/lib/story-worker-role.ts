// Phase 5B-S2: the Story worker's least-privilege database role (`prism_story_worker`, migrations 0054 + 0055).
//
// Shared by `scripts/story-db-provision.mts` (the ONLY place a secret is attached to the role) and the disposable
// verifier `scripts/db-story-worker-login.mts`. Nothing here prints, logs or returns the password.
import type pg from "pg";

export const STORY_WORKER_ROLE = "prism_story_worker";
export const STORY_WORKER_CONNECTION_LIMIT = 5;
export const MIN_STORY_DB_PASSWORD = 24;

/** The tables the Story worker may READ (only rows in flight, by RLS) and nothing else. */
export const STORY_WORKER_READABLE = ["story_proposals", "writing_proposals"] as const;
/** Columns the worker may UPDATE (the result and its lease), per table. */
export const STORY_WORKER_UPDATABLE: Record<(typeof STORY_WORKER_READABLE)[number], string[]> = {
  story_proposals: [
    "status",
    "proposal",
    "usage",
    "actual_usd",
    "provider_calls",
    "error",
    "attempts",
    "next_run_at",
    "lease_owner",
    "lease_expires_at",
    "completed_at",
  ],
  writing_proposals: [
    "status",
    "result",
    "usage",
    "actual_usd",
    "provider_calls",
    "error",
    "attempts",
    "next_run_at",
    "lease_owner",
    "lease_expires_at",
    "completed_at",
  ],
};
/** Project content the worker must never read (a representative, checked list). */
export const STORY_WORKER_FORBIDDEN = [
  "projects",
  "episodes",
  "scenes",
  "characters",
  "locations",
  "shots",
  "assets",
  "dialogue_lines",
  "script_revisions",
  "writing_sessions",
  "scene_story_changes",
  "generation_attempts",
] as const;

export type ProvisionOutcome = "enabled" | "rotated" | "unchanged";

export class ProvisionRefused extends Error {}

/**
 * Attaches LOGIN + a password to `prism_story_worker`. Idempotent: an existing login is left alone unless `rotate`.
 * Refuses a short secret, a missing role (apply the migrations first) and a role with elevated attributes. The
 * statement is built server-side with format(%L) so the secret never appears in client-side SQL text or a log line.
 */
export async function provisionStoryWorkerLogin(
  client: Pick<pg.Client, "query">,
  password: string,
  opts: { rotate?: boolean } = {},
): Promise<ProvisionOutcome> {
  if (password.length < MIN_STORY_DB_PASSWORD)
    throw new ProvisionRefused(
      `PRISM_STUDIO_STORY_DB_PASSWORD must be a generated secret of at least ${MIN_STORY_DB_PASSWORD} characters. Nothing was changed.`,
    );
  const role = await client.query(
    "select rolcanlogin, rolsuper, rolbypassrls, rolcreaterole, rolcreatedb, rolreplication from pg_roles where rolname = $1",
    [STORY_WORKER_ROLE],
  );
  if (role.rowCount === 0)
    throw new ProvisionRefused(
      `Role ${STORY_WORKER_ROLE} does not exist. Apply migrations 0054 and 0055 first (npm run db:migrate).`,
    );
  const r = role.rows[0] as Record<string, boolean>;
  if (r.rolsuper || r.rolbypassrls || r.rolcreaterole || r.rolcreatedb || r.rolreplication)
    throw new ProvisionRefused(
      `Role ${STORY_WORKER_ROLE} has elevated attributes; refusing to enable LOGIN.`,
    );
  if (r.rolcanlogin && !opts.rotate) return "unchanged";
  const stmt = await client.query(
    "select format('alter role %I with login password %L connection limit %s', $1::text, $2::text, $3::int) as sql",
    [STORY_WORKER_ROLE, password, STORY_WORKER_CONNECTION_LIMIT],
  );
  await client.query((stmt.rows[0] as { sql: string }).sql);
  return r.rolcanlogin ? "rotated" : "enabled";
}

/** Read-only audit of the role (admin connection): attributes, memberships and every table privilege it holds. */
export async function auditStoryWorkerRole(client: Pick<pg.Client, "query">) {
  const failures: string[] = [];
  const role = (
    await client.query(
      `select rolsuper, rolinherit, rolcreaterole, rolcreatedb, rolcanlogin, rolreplication, rolbypassrls, rolconnlimit
         from pg_roles where rolname = $1`,
      [STORY_WORKER_ROLE],
    )
  ).rows[0] as Record<string, unknown> | undefined;
  if (!role) return { role: null, failures: [`role ${STORY_WORKER_ROLE} is missing`] };
  if (role.rolsuper) failures.push("superuser");
  if (role.rolbypassrls) failures.push("BYPASSRLS");
  if (role.rolcreaterole) failures.push("CREATEROLE");
  if (role.rolcreatedb) failures.push("CREATEDB");
  if (role.rolreplication) failures.push("REPLICATION");
  if (role.rolinherit) failures.push("INHERIT (must be NOINHERIT)");
  const members = await client.query(
    "select count(*)::int as n from pg_auth_members m join pg_roles r on r.oid = m.member where r.rolname = $1",
    [STORY_WORKER_ROLE],
  );
  if ((members.rows[0] as { n: number }).n !== 0) failures.push("member of another role");
  const tables = await client.query(
    `select table_name, privilege_type from information_schema.role_table_grants
      where grantee = $1 and table_schema = 'public' order by 1, 2`,
    [STORY_WORKER_ROLE],
  );
  for (const t of tables.rows as Array<{ table_name: string; privilege_type: string }>) {
    const readable = (STORY_WORKER_READABLE as readonly string[]).includes(t.table_name);
    if (!readable) failures.push(`${t.privilege_type} on ${t.table_name}`);
    else if (t.privilege_type !== "SELECT")
      failures.push(`table-wide ${t.privilege_type} on ${t.table_name}`);
  }
  const cols = await client.query(
    `select table_name, column_name from information_schema.column_privileges
      where grantee = $1 and table_schema = 'public' and privilege_type = 'UPDATE'`,
    [STORY_WORKER_ROLE],
  );
  for (const c of cols.rows as Array<{ table_name: string; column_name: string }>) {
    const allowed = STORY_WORKER_UPDATABLE[c.table_name as keyof typeof STORY_WORKER_UPDATABLE] ?? [];
    if (!allowed.includes(c.column_name)) failures.push(`UPDATE (${c.column_name}) on ${c.table_name}`);
  }
  const create = await client.query("select has_schema_privilege($1, 'public', 'CREATE') as c", [
    STORY_WORKER_ROLE,
  ]);
  if ((create.rows[0] as { c: boolean }).c) failures.push("CREATE on schema public");
  return { role, failures };
}

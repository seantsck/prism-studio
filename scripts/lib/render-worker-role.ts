// Phase 5B closeout: the render worker's least-privilege database role (`prism_render_worker`, migration 0059).
//
// Shared by `scripts/render-db-provision.mts` (the ONLY place a secret is attached to the role) and `db:renders`
// (which verifies a real login on a disposable database). Nothing here prints, logs or returns the password.
// Same model as the generation and Story workers: the role ITSELF receives LOGIN (it stays NOINHERIT and a member of
// nothing), so the worker's `current_user` is `prism_render_worker` and its grants and RLS policies apply directly.
import type pg from "pg";

export const RENDER_WORKER_ROLE = "prism_render_worker";
/** One render at a time per process (pool max 2); room for a second worker host and a check connection. */
export const RENDER_WORKER_CONNECTION_LIMIT = 5;
export const MIN_RENDER_DB_PASSWORD = 24;

/** Table → the table-wide privileges the role may hold (0059). Anything else is a failure. */
export const RENDER_WORKER_TABLES: Record<string, string[]> = {
  episode_renders: ["SELECT"],
  render_segment_cache: ["SELECT", "INSERT", "DELETE"],
  assets: ["INSERT"],
};
export const RENDER_WORKER_UPDATABLE: Record<string, string[]> = {
  episode_renders: [
    "status",
    "segments_done",
    "lease_owner",
    "lease_token",
    "lease_expires_at",
    "heartbeat_at",
    "output_asset_id",
    "output",
    "error_code",
    "error_message",
    "started_at",
    "completed_at",
    "failed_at",
  ],
};
export const RENDER_WORKER_ASSET_COLUMNS = [
  "id",
  "project_id",
  "type",
  "purpose",
  "storage_provider",
  "bucket",
  "object_path",
  "mime",
  "checksum",
  "channels",
  "duration_ms",
];

export type ProvisionOutcome = "enabled" | "rotated" | "unchanged";
export class ProvisionRefused extends Error {}

/**
 * Attaches LOGIN + a password to `prism_render_worker`. Idempotent: an existing login is left alone unless `rotate`.
 * Refuses a short secret, a missing role (apply 0059 first) and a role with elevated attributes. The statement is
 * built server-side with format(%L) so the secret never appears in client-side SQL text or a log line.
 */
export async function provisionRenderWorkerLogin(
  client: Pick<pg.Client, "query">,
  password: string,
  opts: { rotate?: boolean } = {},
): Promise<ProvisionOutcome> {
  if (password.length < MIN_RENDER_DB_PASSWORD)
    throw new ProvisionRefused(
      `PRISM_STUDIO_RENDER_DB_PASSWORD must be a generated secret of at least ${MIN_RENDER_DB_PASSWORD} characters. Nothing was changed.`,
    );
  const role = await client.query(
    "select rolcanlogin, rolsuper, rolbypassrls, rolcreaterole, rolcreatedb, rolreplication, rolinherit from pg_roles where rolname = $1",
    [RENDER_WORKER_ROLE],
  );
  if (role.rowCount === 0)
    throw new ProvisionRefused(
      `Role ${RENDER_WORKER_ROLE} does not exist. Apply migration 0059 first (npm run db:migrate).`,
    );
  const r = role.rows[0] as Record<string, boolean>;
  if (r.rolsuper || r.rolbypassrls || r.rolcreaterole || r.rolcreatedb || r.rolreplication || r.rolinherit)
    throw new ProvisionRefused(
      `Role ${RENDER_WORKER_ROLE} has elevated attributes; refusing to enable LOGIN.`,
    );
  if (r.rolcanlogin && !opts.rotate) return "unchanged";
  const stmt = await client.query(
    "select format('alter role %I with login password %L connection limit %s', $1::text, $2::text, $3::int) as sql",
    [RENDER_WORKER_ROLE, password, RENDER_WORKER_CONNECTION_LIMIT],
  );
  await client.query((stmt.rows[0] as { sql: string }).sql);
  return r.rolcanlogin ? "rotated" : "enabled";
}

/** Read-only audit (admin connection): attributes, memberships and every privilege the role holds. */
export async function auditRenderWorkerRole(client: Pick<pg.Client, "query">) {
  const failures: string[] = [];
  const role = (
    await client.query(
      `select rolsuper, rolinherit, rolcreaterole, rolcreatedb, rolcanlogin, rolreplication, rolbypassrls, rolconnlimit
         from pg_roles where rolname = $1`,
      [RENDER_WORKER_ROLE],
    )
  ).rows[0] as Record<string, unknown> | undefined;
  if (!role) return { role: null, failures: [`role ${RENDER_WORKER_ROLE} is missing`] };
  if (role.rolsuper) failures.push("superuser");
  if (role.rolbypassrls) failures.push("BYPASSRLS");
  if (role.rolcreaterole) failures.push("CREATEROLE");
  if (role.rolcreatedb) failures.push("CREATEDB");
  if (role.rolreplication) failures.push("REPLICATION");
  if (role.rolinherit) failures.push("INHERIT (must be NOINHERIT)");
  const members = await client.query(
    "select count(*)::int as n from pg_auth_members m join pg_roles r on r.oid = m.member where r.rolname = $1",
    [RENDER_WORKER_ROLE],
  );
  if ((members.rows[0] as { n: number }).n !== 0) failures.push("member of another role");
  const tables = await client.query(
    `select table_name, privilege_type from information_schema.role_table_grants
      where grantee = $1 and table_schema = 'public' order by 1, 2`,
    [RENDER_WORKER_ROLE],
  );
  for (const t of tables.rows as Array<{ table_name: string; privilege_type: string }>)
    if (!(RENDER_WORKER_TABLES[t.table_name] ?? []).includes(t.privilege_type))
      failures.push(`${t.privilege_type} on ${t.table_name}`);
  const cols = await client.query(
    `select table_name, column_name, privilege_type from information_schema.column_privileges
      where grantee = $1 and table_schema = 'public'`,
    [RENDER_WORKER_ROLE],
  );
  for (const c of cols.rows as Array<{ table_name: string; column_name: string; privilege_type: string }>) {
    if ((RENDER_WORKER_TABLES[c.table_name] ?? []).includes(c.privilege_type)) continue; // implied by a table grant
    const ok =
      c.privilege_type === "UPDATE"
        ? (RENDER_WORKER_UPDATABLE[c.table_name] ?? []).includes(c.column_name)
        : c.privilege_type === "SELECT" && c.table_name === "assets"
          ? RENDER_WORKER_ASSET_COLUMNS.includes(c.column_name)
          : false;
    if (!ok) failures.push(`${c.privilege_type} (${c.column_name}) on ${c.table_name}`);
  }
  const create = await client.query("select has_schema_privilege($1, 'public', 'CREATE') as c", [
    RENDER_WORKER_ROLE,
  ]);
  if ((create.rows[0] as { c: boolean }).c) failures.push("CREATE on schema public");
  return { role, failures };
}

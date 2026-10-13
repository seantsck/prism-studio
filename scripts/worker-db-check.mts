// Audits the generation worker's database role against its specification (read-only).
//
//   npm run worker:db:check
//
// 1. (admin connection) role attributes, every table/column privilege in every non-system schema, schema
//    CREATE rights, sequence privileges, and the residual privileges inherited through PUBLIC.
// 2. (only when PRISM_STUDIO_WORKER_DB_URL is set) connects AS the worker and proves what it can and cannot do.
// Never prints credentials.
import pg from "pg";
import { EXPECTED, FORBIDDEN_TABLES, WORKER_ROLE } from "./lib/worker-role-spec.mjs";
import { assertProjectRef, redact, safeTarget, startScript } from "./lib/safety.mjs";

const url = startScript({ mode: "worker role audit (read-only)" });
const failures: string[] = [];
const ok = (name: string, pass: boolean, detail = "") => {
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${pass || !detail ? "" : `  → ${detail}`}`);
  if (!pass) failures.push(name);
};

const admin = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
await admin.connect();
try {
  // ── role attributes ──
  const role = (
    await admin.query(
      `select rolsuper, rolinherit, rolcreaterole, rolcreatedb, rolcanlogin, rolreplication, rolbypassrls, rolconnlimit
       from pg_roles where rolname = $1`,
      [WORKER_ROLE],
    )
  ).rows[0];
  ok(`role ${WORKER_ROLE} exists`, Boolean(role));
  if (!role) throw new Error("role missing");
  ok("not superuser", !role.rolsuper);
  ok("not BYPASSRLS", !role.rolbypassrls);
  ok("cannot create roles", !role.rolcreaterole);
  ok("cannot create databases", !role.rolcreatedb);
  ok("no replication", !role.rolreplication);
  ok("NOINHERIT (inherits nothing through memberships)", !role.rolinherit);
  const members = (
    await admin.query(
      `select r.rolname from pg_auth_members m join pg_roles r on r.oid = m.roleid
       where m.member = (select oid from pg_roles where rolname = $1)`,
      [WORKER_ROLE],
    )
  ).rows.map((r) => r.rolname);
  ok("is a member of no other role", members.length === 0, members.join(", "));
  console.log(`      login enabled: ${role.rolcanlogin} | connection limit: ${role.rolconnlimit}`);

  // ── table + column privileges ──
  const cols = (
    await admin.query(
      `select n.nspname || '.' || c.relname as rel, a.attname, a.attnum, c.oid as reloid,
              has_column_privilege($1, c.oid, a.attnum, 'SELECT') as sel,
              has_column_privilege($1, c.oid, a.attnum, 'INSERT') as ins,
              has_column_privilege($1, c.oid, a.attnum, 'UPDATE') as upd,
              has_column_privilege($1, c.oid, a.attnum, 'REFERENCES') as ref
       from pg_class c
       join pg_namespace n on n.oid = c.relnamespace
       join pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
       where c.relkind in ('r', 'p', 'v', 'm', 'f')
         and n.nspname not in ('pg_catalog', 'information_schema', 'pg_toast')`,
      [WORKER_ROLE],
    )
  ).rows;
  const wanted = (spec: string[] | string, col: string) => (spec === "*" ? true : spec.includes(col));
  const unexpected: string[] = [];
  const missing: string[] = [];
  // Supabase-managed extension views (pg_stat_statements, ...) are SELECT-able by PUBLIC. They expose
  // statistics only (query text is hidden from non-privileged roles). Reported, not "fixed": revoking
  // PUBLIC would break managed tooling.
  const residualManaged = new Set<string>();
  for (const c of cols) {
    if (String(c.rel).startsWith("extensions.") && !(c.rel in EXPECTED)) {
      if (c.sel || c.ins || c.upd) residualManaged.add(c.rel);
      continue;
    }
    const e = EXPECTED[c.rel as keyof typeof EXPECTED];
    const exp = {
      sel: e ? wanted(e.select, c.attname) : false,
      ins: e ? wanted(e.insert, c.attname) : false,
      upd: e ? wanted(e.update, c.attname) : false,
      ref: false,
    };
    for (const [k, label] of [
      ["sel", "SELECT"],
      ["ins", "INSERT"],
      ["upd", "UPDATE"],
      ["ref", "REFERENCES"],
    ] as const) {
      if (c[k] && !exp[k]) unexpected.push(`${c.rel}.${c.attname}: ${label}`);
      if (!c[k] && exp[k]) missing.push(`${c.rel}.${c.attname}: ${label}`);
    }
  }
  if (residualManaged.size)
    console.log(`      residual managed relations readable via PUBLIC: ${[...residualManaged].join(", ")}`);
  ok(
    "no column privilege beyond the specification",
    unexpected.length === 0,
    unexpected.slice(0, 8).join("; "),
  );
  ok("every specified privilege is granted", missing.length === 0, missing.slice(0, 8).join("; "));

  const relPriv = (
    await admin.query(
      `select n.nspname || '.' || c.relname as rel
       from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where c.relkind in ('r', 'p', 'v', 'm', 'f') and n.nspname not in ('pg_catalog', 'information_schema', 'pg_toast')
         and (has_table_privilege($1, c.oid, 'DELETE') or has_table_privilege($1, c.oid, 'TRUNCATE')
              or has_table_privilege($1, c.oid, 'TRIGGER'))`,
      [WORKER_ROLE],
    )
  ).rows.map((r) => r.rel);
  ok("no DELETE / TRUNCATE / TRIGGER on any table", relPriv.length === 0, relPriv.join(", "));

  for (const t of FORBIDDEN_TABLES) {
    const r = (
      await admin.query(
        `select has_table_privilege($1, $2::regclass, 'SELECT,INSERT,UPDATE,DELETE') as any_priv,
                exists (select 1 from pg_attribute a where a.attrelid = $2::regclass and a.attnum > 0
                        and (has_column_privilege($1, $2::regclass, a.attnum, 'SELECT')
                          or has_column_privilege($1, $2::regclass, a.attnum, 'UPDATE')
                          or has_column_privilege($1, $2::regclass, a.attnum, 'INSERT'))) as any_col`,
        [WORKER_ROLE, t],
      )
    ).rows[0];
    ok(`no access to ${t}`, !r.any_priv && !r.any_col);
  }

  // ── sequences, schemas, database ──
  const seq = (
    await admin.query(
      `select n.nspname || '.' || c.relname as rel from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where c.relkind = 'S' and n.nspname not in ('pg_catalog', 'information_schema')
         and (has_sequence_privilege($1, c.oid, 'USAGE') or has_sequence_privilege($1, c.oid, 'UPDATE'))`,
      [WORKER_ROLE],
    )
  ).rows;
  ok("no sequence privileges", seq.length === 0, seq.map((r) => r.rel).join(", "));

  const schemas = (
    await admin.query(
      `select nspname, has_schema_privilege($1, oid, 'USAGE') as usage, has_schema_privilege($1, oid, 'CREATE') as create
       from pg_namespace where nspname not like 'pg\\_%' and nspname <> 'information_schema' order by 1`,
      [WORKER_ROLE],
    )
  ).rows;
  ok(
    "CREATE on no schema",
    schemas.every((s) => !s.create),
    schemas
      .filter((s) => s.create)
      .map((s) => s.nspname)
      .join(", "),
  );
  console.log(
    `      residual schema USAGE (via PUBLIC/managed defaults): ${
      schemas
        .filter((s) => s.usage)
        .map((s) => s.nspname)
        .join(", ") || "none"
    }`,
  );

  const db = (
    await admin.query(
      `select has_database_privilege($1, current_database(), 'CREATE') as create,
              has_database_privilege($1, current_database(), 'TEMPORARY') as temp`,
      [WORKER_ROLE],
    )
  ).rows[0];
  ok("cannot CREATE in the database", !db.create);
  console.log(`      TEMPORARY objects allowed (PUBLIC default): ${db.temp}`);

  const fns = (
    await admin.query(
      `select n.nspname || '.' || p.proname as fn, p.prosecdef
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname not in ('pg_catalog', 'information_schema') and p.prokind = 'f'
         and has_function_privilege($1, p.oid, 'EXECUTE') and p.prosecdef
       order by 1`,
      [WORKER_ROLE],
    )
  ).rows;
  console.log(
    `      residual EXECUTE on SECURITY DEFINER functions (PUBLIC default, none grant table access to this role): ${fns.length}`,
  );
  for (const f of fns.slice(0, 12)) console.log(`        - ${f.fn}`);

  // ── policies ──
  const pol = (
    await admin.query(
      `select tablename, policyname, cmd from pg_policies where $1 = any (roles::text[]) order by 1, 2`,
      [WORKER_ROLE],
    )
  ).rows;
  console.log(`      worker RLS policies: ${pol.length}`);
  for (const p of pol) console.log(`        - ${p.tablename}.${p.policyname} (${p.cmd})`);
  const rlsOff = (
    await admin.query(
      `select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relname = any ($1::text[]) and not c.relrowsecurity`,
      [Object.keys(EXPECTED).map((k) => k.split(".")[1])],
    )
  ).rows;
  ok(
    "RLS is enabled on every table the worker can touch",
    rlsOff.length === 0,
    rlsOff.map((r) => r.relname).join(", "),
  );
} catch (err) {
  ok("audit completed", false, redact(err instanceof Error ? err.message : String(err)));
} finally {
  await admin.end();
}

// ── as the worker, when a real worker credential is configured ──
const workerUrl = process.env.PRISM_STUDIO_WORKER_DB_URL;
if (workerUrl) {
  console.log("\n— connecting AS the worker role —");
  try {
    assertProjectRef(workerUrl, "PRISM_STUDIO_WORKER_DB_URL");
    console.log(`      target: ${safeTarget(workerUrl)}`);
    const w = new pg.Client({ connectionString: workerUrl, ssl: { rejectUnauthorized: false } });
    await w.connect();
    try {
      const who = (await w.query("select current_user as u, session_user as s")).rows[0];
      ok(
        "connected as prism_generation_worker",
        who.u === WORKER_ROLE && who.s === WORKER_ROLE,
        `${who.u}/${who.s}`,
      );
      const denied = async (sql: string) => {
        try {
          await w.query("begin");
          await w.query(sql);
          return false;
        } catch {
          return true;
        } finally {
          await w.query("rollback").catch(() => undefined);
        }
      };
      ok("cannot read auth.users", await denied("select id from auth.users limit 1"));
      ok("cannot read characters", await denied("select id from characters limit 1"));
      ok("cannot update shots", await denied("update shots set title = title"));
      ok("cannot create a table", await denied("create table prism_worker_probe (x int)"));
      ok("cannot create a role", await denied("create role prism_worker_probe_role"));
    } finally {
      await w.end();
    }
  } catch (err) {
    ok("worker connection", false, redact(err instanceof Error ? err.message : String(err)));
  }
} else {
  console.log("\n(PRISM_STUDIO_WORKER_DB_URL is not set: skipped the connect-as-worker section.)");
}

console.log(failures.length ? `\n${failures.length} FAILURE(S)` : "\nWORKER ROLE OK");
process.exit(failures.length ? 1 : 0);

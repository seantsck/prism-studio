// Phase 5B-S2: proves the Story worker LOGIN provisioning on a DISPOSABLE local database only.
//   node --env-file=<disposable env> scripts/db-disposable.mjs reset && db-migrate.mjs && db-seed.mts
//   npx tsx --env-file=<disposable env> scripts/db-story-worker-login.mts
//
// 1. provisions `prism_story_worker` with a secret GENERATED IN THIS PROCESS (never printed, never written to disk);
// 2. proves idempotency (a second run is a no-op; --rotate replaces the secret and the old one stops working);
// 3. connects with a GENUINE login as prism_story_worker (no SET ROLE) and proves what it can and cannot do;
// 4. audits the role's attributes and every grant (nothing beyond story/writing proposals in flight);
// 5. runs the real `scripts/story-worker.mts --once` with PRISM_STUDIO_STORY_WORKER_DB_URL (the provisioned login).
// Refuses anything but the opt-in loopback disposable target. The role is left with LOGIN on the disposable DB only.
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import pg from "pg";
import {
  auditStoryWorkerRole,
  provisionStoryWorkerLogin,
  STORY_WORKER_CONNECTION_LIMIT,
  STORY_WORKER_ROLE,
} from "./lib/story-worker-role";

const url = process.env.SUPABASE_DB_URL ?? "";
if (process.env.PRISM_STUDIO_DISPOSABLE_DB !== "1" || !/@127\.0\.0\.1:\d+\/prism_disposable/.test(url)) {
  console.error(
    "db-story-worker-login refuses: PRISM_STUDIO_DISPOSABLE_DB=1 and a loopback prism_disposable* URL are required.",
  );
  process.exit(2);
}
const TSX = "node_modules/tsx/dist/cli.mjs"; // run the worker with this Node, no shell
const results: Array<[string, boolean, string]> = [];
const check = (name: string, ok: boolean, detail = "") => results.push([name, ok, detail]);
const secret = () => randomBytes(24).toString("base64url"); // 32 characters, never printed
const loginUrl = (password: string) => {
  const u = new URL(url);
  u.username = STORY_WORKER_ROLE;
  u.password = password;
  return u.toString();
};
const scrub = (s: string, ...secrets: string[]) =>
  secrets.reduce((acc, x) => acc.split(x).join("<redacted>"), s);

const admin = new pg.Client({ connectionString: url });
await admin.connect();
const first = secret();
const second = secret();
try {
  // ── provisioning: enable, idempotent, rotate ──
  await admin.query(`alter role ${STORY_WORKER_ROLE} nologin password null`); // start from the migration's state
  check(
    "enable LOGIN from the migration's NOLOGIN state",
    (await provisionStoryWorkerLogin(admin, first)) === "enabled",
  );
  check(
    "a second run is a no-op (idempotent)",
    (await provisionStoryWorkerLogin(admin, second)) === "unchanged",
  );
  const role = (
    await admin.query("select rolcanlogin, rolconnlimit from pg_roles where rolname = $1", [
      STORY_WORKER_ROLE,
    ])
  ).rows[0];
  check(
    "LOGIN with a connection limit",
    role.rolcanlogin === true && role.rolconnlimit === STORY_WORKER_CONNECTION_LIMIT,
  );

  // ── a GENUINE login as the worker ──
  const worker = new pg.Client({ connectionString: loginUrl(first) });
  await worker.connect();
  try {
    const who = (await worker.query("select current_user as c, session_user as s")).rows[0];
    check(
      "authenticates AS prism_story_worker (current_user = session_user)",
      who.c === STORY_WORKER_ROLE && who.s === STORY_WORKER_ROLE,
    );
    for (const t of ["story_proposals", "writing_proposals"]) {
      const r = await worker.query(`select count(*)::int as n from ${t}`).then(
        () => "ok",
        (e: Error) => e.message,
      );
      check(`can read ${t} (rows in flight only, by RLS)`, r === "ok", r);
    }
    for (const t of [
      "characters",
      "episodes",
      "scenes",
      "script_revisions",
      "writing_sessions",
      "scene_story_changes",
      "assets",
      "projects",
    ]) {
      const r = await worker.query(`select 1 from ${t} limit 1`).then(
        () => "read",
        (e: Error) => e.message,
      );
      check(`cannot read ${t}`, /permission denied/.test(r), r);
    }
    const ins = await worker
      .query(
        "insert into writing_sessions (id, project_id, episode_id) values (gen_random_uuid(), gen_random_uuid(), gen_random_uuid())",
      )
      .then(
        () => "inserted",
        (e: Error) => e.message,
      );
    check("cannot insert anything", /permission denied/.test(ins), ins);
    const del = await worker.query("delete from writing_proposals").then(
      () => "deleted",
      (e: Error) => e.message,
    );
    check("cannot delete proposals", /permission denied/.test(del), del);
    const ddl = await worker.query("create table worker_probe (x int)").then(
      () => "created",
      (e: Error) => e.message,
    );
    check("cannot create tables", /permission denied/.test(ddl), ddl);
    const esc = await worker.query("set role postgres").then(
      () => "escalated",
      (e: Error) => e.message,
    );
    check("cannot switch to another role", /permission denied/.test(esc), esc);
  } finally {
    await worker.end();
  }

  // ── rotation: the old secret stops working ──
  check(
    "--rotate replaces the secret",
    (await provisionStoryWorkerLogin(admin, second, { rotate: true })) === "rotated",
  );
  const old = new pg.Client({ connectionString: loginUrl(first) });
  const oldResult = await old.connect().then(
    () => "connected",
    (e: Error) => e.message,
  );
  if (oldResult === "connected") await old.end();
  check(
    "the previous secret no longer authenticates",
    oldResult !== "connected",
    scrub(oldResult, first, second),
  );

  // ── audit: attributes and every grant ──
  const audit = await auditStoryWorkerRole(admin);
  check(
    "privilege audit: minimal (no superuser/bypassrls/createrole/createdb/replication, NOINHERIT, no memberships, only proposal grants)",
    audit.failures.length === 0,
    audit.failures.join("; "),
  );

  // ── the real worker script with the provisioned login ──
  const run = spawnSync(process.execPath, [TSX, "scripts/story-worker.mts", "--once"], {
    env: {
      ...process.env,
      SUPABASE_DB_URL: "",
      PRISM_STUDIO_STORY_WORKER_DEV_ASSUME_ROLE: "",
      PRISM_STUDIO_STORY_WORKER_DB_URL: loginUrl(second),
      PRISM_STUDIO_PROVIDER_OPENAI_STORY_API_KEY: "",
    },
    encoding: "utf8",
    timeout: 120_000,
  });
  const out = scrub(`${run.stdout ?? ""}${run.stderr ?? ""}`, first, second);
  check(
    "story-worker --once runs on the provisioned login as prism_story_worker",
    run.status === 0 && /role prism_story_worker/.test(out) && /processed \d+/.test(out),
    out.slice(-400),
  );
  check(
    "the worker output never contains the secret",
    !`${run.stdout}${run.stderr}`.includes(second) && !`${run.stdout}${run.stderr}`.includes(first),
  );
  const closed = spawnSync(process.execPath, [TSX, "scripts/story-worker.mts", "--once"], {
    env: {
      ...process.env,
      SUPABASE_DB_URL: "",
      PRISM_STUDIO_STORY_WORKER_DEV_ASSUME_ROLE: "",
      PRISM_STUDIO_STORY_WORKER_DB_URL: "",
    },
    encoding: "utf8",
    timeout: 120_000,
  });
  check(
    "without its credential the worker refuses to start (fail closed)",
    closed.status === 2 && /refuses to start/.test(`${closed.stdout}${closed.stderr}`),
  );
} finally {
  await admin.end();
}
const failed = results.filter(([, ok]) => !ok);
for (const [name, ok, detail] of results)
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail && !ok ? ` — ${detail}` : ""}`);
console.log(`${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);

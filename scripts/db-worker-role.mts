// Live validation of the generation worker's least-privilege database role (migration 0015).
//   npm run db:worker-role
//
// Every statement below runs AS `prism_generation_worker` (SET LOCAL ROLE inside a transaction on the admin
// connection: same privileges, same RLS, no credential needed). It proves:
//   • the worker CAN claim, heartbeat, read the frozen attempt, advance a job, write outputs/costs/assets;
//   • the worker CANNOT touch creative content, auth, other projects' data, history, or the schema;
//   • a full queue → worker → MockProvider → ingest flow works under the role.
// Rows it creates are removed afterwards. Never touches another project.
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import pg from "pg";
import { PostgresGenerationData } from "../src/data/generation-postgres";
import { AdminRepository, rlsPreamble } from "../src/data/postgres-repository";
import { readGenerationConfig } from "../src/generation/config";
import { consoleLogger } from "../src/generation/log";
import { createRegistry } from "../src/generation/registry";
import { LocalDiskSink } from "../src/generation/sink";
import { prepareSubmission } from "../src/generation/submission";
import { GenerationWorker } from "../src/generation/worker";
import { assertDevUserExists, readDevUserEnv } from "./lib/dev-user.mjs";
import { startScript } from "./lib/safety.mjs";
import { WORKER_ROLE } from "./lib/worker-role-spec.mjs";

const dev = readDevUserEnv();
startScript({
  mode: `worker-role privilege tests as ${WORKER_ROLE} (rows created, then removed)`,
  devOwner: dev.id,
});
const pool = new pg.Pool({ connectionString: dev.url, ssl: { rejectUnauthorized: false }, max: 6 });
await assertDevUserExists(pool, dev);

// The managed `postgres` role must be allowed to SET ROLE to the worker role to impersonate it in tests
// (PostgreSQL 16+ creators get ADMIN OPTION only). This grants the admin the ability to act as the worker;
// it adds no privilege to the worker role itself.
// REAL-LOGIN mode (default when PRISM_STUDIO_WORKER_DB_URL is set; force the impersonation path with
// `--set-role`): every worker statement runs on a genuine connection authenticated AS the worker role, so no
// SET ROLE and no admin credential is involved in the worker's own operations.
const workerUrl = process.env.PRISM_STUDIO_WORKER_DB_URL;
const REAL_LOGIN = Boolean(workerUrl) && !process.argv.includes("--set-role");
if (!REAL_LOGIN) {
  try {
    await pool.query(`grant ${WORKER_ROLE} to current_user with set true`);
  } catch {
    await pool.query(`grant ${WORKER_ROLE} to current_user`);
  }
}
const workerPool = REAL_LOGIN
  ? new pg.Pool({ connectionString: workerUrl, ssl: { rejectUnauthorized: false }, max: 4 })
  : pool;
console.log(
  `worker connection: ${REAL_LOGIN ? "REAL LOGIN (PRISM_STUDIO_WORKER_DB_URL)" : "SET ROLE (impersonation)"}`,
);

const results: Array<[string, boolean, string]> = [];
const check = (name: string, ok: boolean, detail = "") => results.push([name, ok, detail]);

const env = {
  NODE_ENV: "test",
  PRISM_STUDIO_MOCK_STAGE_DELAY_MS: "0",
  PRISM_STUDIO_GENERATION_MAX_ACTIVE_PER_PROJECT: "10",
};
const config = readGenerationConfig(env);
const registry = createRegistry(env, config);
const admin = new AdminRepository(pool, dev.id);
const ownerGen = new PostgresGenerationData(pool, rlsPreamble({ sub: dev.id }));
const WORKER_PREAMBLE = REAL_LOGIN ? "begin" : `begin; set local role ${WORKER_ROLE}`;
const workerStore = new PostgresGenerationData(workerPool, WORKER_PREAMBLE);

const sinkRoot = mkdtempSync(path.join(tmpdir(), "prism-wrole-"));
const sink = new LocalDiskSink(sinkRoot);
const createdAttemptIds: string[] = [];

/** One statement as the worker role, in its own transaction (always rolled back). */
async function asWorker(sql: string, params: unknown[] = []) {
  const c = await workerPool.connect();
  try {
    await c.query(WORKER_PREAMBLE);
    const r = await c.query(sql, params);
    return { rows: r.rows, count: r.rowCount ?? 0, error: null as string | null };
  } catch (e) {
    return { rows: [], count: 0, error: (e as Error).message };
  } finally {
    await c.query("rollback").catch(() => undefined);
    c.release();
  }
}
const mustFail = async (
  name: string,
  sql: string,
  params: unknown[] = [],
  pattern = /permission denied|row-level security|violates|must be owner/i,
) => {
  const r = await asWorker(sql, params);
  check(name, r.error !== null && pattern.test(r.error), r.error ?? "statement unexpectedly succeeded");
};
const mustTouchNothing = async (name: string, sql: string, params: unknown[] = []) => {
  const r = await asWorker(sql, params);
  check(name, r.error === null && r.count === 0, r.error ?? `${r.count} row(s) affected`);
};

try {
  const data = (await admin.loadProject("ojousama"))!;
  const projectId = data.project.id;
  const shot = data.shots.find((s) => s.shotCode === "3A")!;
  const submit = () => {
    const key = `wrole-${randomUUID()}`;
    const first = prepareSubmission({
      data,
      shotId: shot.id,
      registry,
      provider: "mock",
      modelId: "mock-video-1",
      acknowledged: [],
      userId: dev.id,
      idempotencyKey: key,
      config,
    });
    const ack = first.evaluation.compatibility?.ignoredFeatures.map((f) => f.id) ?? [];
    return prepareSubmission({
      data,
      shotId: shot.id,
      registry,
      provider: "mock",
      modelId: "mock-video-1",
      acknowledged: ack,
      userId: dev.id,
      idempotencyKey: key,
      config,
    });
  };

  // ── identity ──
  const who = await asWorker(
    "select current_user as u, (select rolbypassrls from pg_roles where rolname = current_user) as bypass, (select rolsuper from pg_roles where rolname = current_user) as su",
  );
  check("runs as the dedicated role", who.rows[0]?.u === WORKER_ROLE, JSON.stringify(who.rows[0]));
  if (REAL_LOGIN) {
    const id = await asWorker("select current_user as u, session_user as s");
    check(
      "REAL LOGIN: current_user = session_user = prism_generation_worker",
      id.rows[0]?.u === WORKER_ROLE && id.rows[0]?.s === WORKER_ROLE,
      JSON.stringify(id.rows[0]),
    );
  }
  check(
    "role is not superuser and not BYPASSRLS",
    who.rows[0]?.bypass === false && who.rows[0]?.su === false,
  );

  // ── queue visibility starts empty for the role: nothing active ⇒ no projects / attempts / assets visible ──
  const idle = await asWorker(
    "select (select count(*) from projects)::int as p, (select count(*) from assets)::int as a, (select count(*) from generation_attempts)::int as t",
  );
  const idleActive = (
    await pool.query(
      "select count(*)::int as n from generation_jobs where status in ('queued','submitting','submitted','processing','ingesting','cancel_requested')",
    )
  ).rows[0].n;
  if (idleActive === 0) {
    check(
      "with no active work the worker sees no project, asset or attempt rows",
      idle.rows[0]?.p === 0 && idle.rows[0]?.a === 0 && idle.rows[0]?.t === 0,
      JSON.stringify(idle.rows[0]),
    );
  }

  // ── a real queued job, created through the authorised user path ──
  const p1 = submit();
  check("gate allows 3A", Boolean(p1.input), JSON.stringify(p1.evaluation.gate.blockers));
  const created = await ownerGen.createAttemptWithJob(p1.input!);
  createdAttemptIds.push(created.attempt.id);
  const jobId = created.job.id;

  // CAN: claim, heartbeat, read the frozen attempt
  const claimed = await workerStore.claim({
    workerId: "wrole-test",
    now: new Date().toISOString(),
    leaseMs: 30_000,
    limit: 5,
  });
  const mine = claimed.find((c) => c.job.id === jobId);
  const others = claimed.filter((c) => c.job.id !== jobId).map((c) => c.job.id);
  if (others.length) {
    // never hold other (real) work hostage for the length of this test's lease
    await pool.query(
      "update generation_jobs set lease_owner = null, lease_token = null, lease_expires_at = null where id = any($1::uuid[])",
      [others],
    );
  }
  check(
    "worker can claim the queued job (and sees the frozen attempt)",
    Boolean(mine) && mine!.attempt.id === created.attempt.id,
  );
  check(
    "worker can read the frozen package snapshot + request",
    Boolean(mine?.attempt.packageSnapshot) && Boolean(mine?.attempt.request),
  );
  check("worker resolves the project owner for asset attribution", mine?.ownerUserId === dev.id);
  const token = mine!.job.leaseToken!;
  check(
    "worker can heartbeat its lease",
    await workerStore.heartbeat(jobId, token, new Date().toISOString(), 30_000),
  );
  check(
    "a wrong lease token cannot heartbeat",
    !(await workerStore.heartbeat(jobId, "not-the-token", new Date().toISOString(), 30_000)),
  );
  const sub = await workerStore.update(
    jobId,
    token,
    { status: "submitting", attemptCount: 1, note: "role test" },
    new Date().toISOString(),
  );
  check("worker can advance job execution state", sub.status === "submitting");

  // CANNOT: things outside the execution contract
  const A = created.attempt.id;
  await mustFail(
    "cannot create jobs",
    "insert into generation_jobs (project_id, attempt_id, provider, model, idempotency_key) values ($1, $2, 'x', 'y', 'abcdefgh12')",
    [projectId, A],
  );
  await mustFail(
    "cannot change a job's project/attempt/provider/model",
    "update generation_jobs set provider = 'other' where id = $1",
    [jobId],
  );
  await mustFail(
    "cannot change the idempotency key",
    "update generation_jobs set idempotency_key = 'zzzzzzzz00' where id = $1",
    [jobId],
  );
  await mustFail(
    "cannot change the estimated cost",
    "update generation_jobs set estimated_cost = 0 where id = $1",
    [jobId],
  );
  await mustFail("cannot delete jobs", "delete from generation_jobs where id = $1", [jobId]);
  await mustFail(
    "cannot rewrite the frozen package snapshot",
    "update generation_attempts set package_snapshot = '{}'::jsonb where id = $1",
    [A],
  );
  await mustFail(
    "cannot rewrite the frozen request / prompt plan",
    "update generation_attempts set request = '{}'::jsonb, prompt_plan = '{}'::jsonb where id = $1",
    [A],
  );
  await mustFail(
    "cannot approve or review an attempt",
    "update generation_attempts set review_status = 'approved', approved = true where id = $1",
    [A],
  );
  await mustFail("cannot delete attempts", "delete from generation_attempts where id = $1", [A]);
  await mustFail("cannot alter characters", "update characters set name = name");
  await mustFail("cannot alter Looks", "update character_looks set name = name");
  await mustFail("cannot alter dialogue", "update dialogue_lines set original_text = original_text");
  await mustFail("cannot alter scripts / action blocks", "update action_blocks set text = text");
  await mustFail("cannot change Shot creative data", "update shots set title = 'x' where id = $1", [shot.id]);
  await mustFail("cannot read Shot creative data", "select title from shots limit 1");
  await mustFail("cannot read characters", "select id from characters limit 1");
  await mustFail("cannot read auth.users", "select id from auth.users limit 1");
  await mustFail("cannot read Storage object metadata", "select id from storage.objects limit 1");
  await mustFail("cannot read the migration ledger", "select * from public.prism_migrations limit 1");
  // Phase 3A.2 (0044): no access to the Project QA policy or to continuity runs (automation identity included)
  await mustFail("cannot read Project QA policies", "select * from project_qa_policies limit 1");
  await mustFail(
    "cannot write Project QA policies",
    "update project_qa_policies set semantic_mode = 'automatic'",
  );
  await mustFail("cannot read continuity runs", "select automation_key from continuity_runs limit 1");
  await mustFail("cannot alter projects", "update projects set title = title");
  await mustFail("cannot read project secrets/columns beyond id+owner", "select title from projects limit 1");
  await mustFail("cannot create tables", "create table prism_worker_probe (x int)");
  await mustFail("cannot alter schema objects", "alter table assets add column probe int");
  await mustFail("cannot create roles", "create role prism_worker_probe_role", [], /permission denied/i);
  await mustFail(
    "cannot alter its own role",
    `alter role ${WORKER_ROLE} superuser`,
    [],
    /permission denied/i,
  );
  await mustFail(
    "cannot alter storyboard frames (creative truth)",
    "update storyboard_frames set approved = approved",
  );
  // CREATE DATABASE cannot run inside a transaction block: issue it on its own (autocommit).
  {
    let denied = "";
    try {
      await workerPool.query("create database prism_worker_probe_db");
    } catch (e) {
      denied = (e as Error).message;
    }
    check(
      "cannot create a database",
      /permission denied/i.test(denied),
      denied || "statement unexpectedly succeeded",
    );
  }
  await mustFail(
    "cannot drop roles",
    "drop role prism_worker_probe_role",
    [],
    /permission denied|does not exist/i,
  );
  await mustFail("cannot truncate generation tables", "truncate generation_jobs", [], /permission denied/i);
  await mustFail("cannot truncate attempts", "truncate generation_attempts", [], /permission denied/i);
  await mustFail(
    "cannot alter the migration ledger",
    "insert into public.prism_migrations (name) values ('x')",
  );
  await mustFail("cannot disable RLS", "alter table assets disable row level security");
  await mustFail(
    "cannot insert a non-generated asset",
    "insert into assets (project_id, type, name, purpose, source) values ($1, 'image', 'x', 'reference_image', 'upload')",
    [projectId],
  );
  await mustFail(
    "cannot insert a user-estimated cost record",
    "insert into generation_costs (project_id, attempt_id, job_id, provider, model, kind, amount, currency) values ($1, $2, $3, 'mock', 'm', 'estimated', 1, 'USD')",
    [projectId, A, jobId],
  );
  await mustFail(
    "cannot write output relations before ingestion",
    "insert into generation_outputs (project_id, attempt_id, asset_id, role, position) values ($1, $2, $3, 'primary', 0)",
    [projectId, A, randomUUID()],
  );
  await mustFail(
    "cannot rewrite job events (append-only: no update privilege)",
    "update generation_job_events set note = 'x'",
  );

  // ── full flow under the role: submit → poll → ingest → finalize, through the real worker ──
  const worker = new GenerationWorker({
    store: workerStore,
    registry,
    sink,
    config,
    logger: consoleLogger,
    workerId: "wrole-worker",
    heartbeatMs: 0,
  });
  // The job is mid-lease from the checks above; release it by letting the lease lapse, then run for real.
  await pool.query(
    "update generation_jobs set lease_owner = null, lease_token = null, lease_expires_at = null, status = 'queued', attempt_count = 0, next_run_at = now() where id = $1",
    [jobId],
  );
  let final = (await workerStore.getJob(jobId))!;
  for (let i = 0; i < 12 && !["succeeded", "failed", "cancelled"].includes(final.status); i++) {
    await worker.tick();
    final = (await workerStore.getJob(jobId))!;
  }
  check(
    "queue → worker → MockProvider → ingest → succeeded, entirely as the worker role",
    final.status === "succeeded",
    `${final.status} ${final.lastErrorCode ?? ""}`,
  );
  const view = await ownerGen.getAttemptView(A);
  check(
    "outputs, assets and an actual cost were written under the role",
    (view?.outputs.length ?? 0) >= 1 && (view?.costs.some((c) => c.kind === "actual") ?? false),
  );
  check("generated assets are attributed to the project owner", view?.outputs[0]?.asset.createdBy === dev.id);
  check(
    "the frozen package and review state are untouched by execution",
    view?.attempt.packageFingerprint === created.attempt.packageFingerprint &&
      view?.attempt.reviewStatus === "unreviewed" &&
      view?.attempt.approved === false,
  );

  // terminal history is out of the worker's reach
  await mustTouchNothing(
    "cannot update a terminal job",
    "update generation_jobs set provider_status = 'x' where id = $1",
    [jobId],
  );
  const seeTerminal = await asWorker("select count(*)::int as n from generation_attempts where id = $1", [A]);
  check(
    "a finished attempt is no longer visible to the worker",
    seeTerminal.rows[0]?.n === 0,
    JSON.stringify(seeTerminal.rows[0]),
  );
  await mustTouchNothing(
    "cannot update a finished attempt",
    "update generation_attempts set status = 'failed' where id = $1",
    [A],
  );
  await mustFail(
    "cannot add an asset to a project with no ingesting job",
    "insert into assets (project_id, type, name, purpose, source) values ($1, 'video', 'late.webm', 'generation_output', 'provider_output')",
    [projectId],
  );
} finally {
  if (createdAttemptIds.length) {
    const assets = (
      await pool.query("select asset_id from generation_outputs where attempt_id = any($1::uuid[])", [
        createdAttemptIds,
      ])
    ).rows.map((r) => r.asset_id);
    await pool.query("delete from generation_attempts where id = any($1::uuid[])", [createdAttemptIds]);
    if (assets.length) await pool.query("delete from assets where id = any($1::uuid[])", [assets]);
  }
  rmSync(sinkRoot, { recursive: true, force: true });
  if (REAL_LOGIN) await workerPool.end();
}

let failed = 0;
for (const [name, ok, detail] of results) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail && !ok ? `  — ${detail}` : ""}`);
  if (!ok) failed++;
}
console.log(`\n${results.length - failed}/${results.length} passed`);
await pool.end();
process.exit(failed ? 1 : 0);

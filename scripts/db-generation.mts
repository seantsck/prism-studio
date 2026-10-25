// Integration tests for the generation system against the REAL dedicated Prism Studio database.
//   npm run db:generation
//
// Exercises (with real rows, cleaned up afterwards):
//   - atomic attempt+job creation, idempotent replay, duplicate/stale protection, RLS (owner/stranger/anon)
//   - the real worker + MockProvider through the Postgres store (claim, lease, ingest, finalize)
//   - review (approve/reject/supersede), history immutability, cost records, ordered outputs
//   - the DB-level job state machine, compared pair-by-pair with the TypeScript one
//   - structural invariants: one active job per attempt, same-project foreign keys, cost checks
//   - the approval purpose guard: a Production Frame candidate can never take the Shot's approval (own project)
// Requires `npm run db:seed` first (uses the demo project's shot 3A). Never touches another existing project (section 9
// creates its own throwaway project and deletes it).
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import pg from "pg";
import { GenerationSubmitError, NOT_SHOT_OUTPUT_APPROVAL_MESSAGE } from "../src/data/generation-repository";
import { PostgresGenerationData } from "../src/data/generation-postgres";
import { AdminRepository, rlsPreamble } from "../src/data/postgres-repository";
import { PostgresProductionFrameData } from "../src/data/production-frame-postgres";
import { buildShotContext } from "../src/domain/context";
import { allowedTransitions, canTransition } from "../src/domain/generation/job-state";
import { JOB_STATUSES } from "../src/domain/generation/schemas";
import { draftProductionFrame } from "../src/domain/production-frame";
import { assetSchema, type ProjectData } from "../src/domain/schemas";
import { readGenerationConfig } from "../src/generation/config";
import { silentLogger } from "../src/generation/log";
import { createRegistry } from "../src/generation/registry";
import { LocalDiskSink } from "../src/generation/sink";
import { prepareSubmission } from "../src/generation/submission";
import { GenerationWorker } from "../src/generation/worker";
import { assertDevUserExists, readDevUserEnv } from "./lib/dev-user.mjs";
import { startScript } from "./lib/safety.mjs";

const dev = readDevUserEnv();
startScript({ mode: "generation integration tests (rows created, then removed)", devOwner: dev.id });
const pool = new pg.Pool({ connectionString: dev.url, ssl: { rejectUnauthorized: false }, max: 6 });
await assertDevUserExists(pool, dev);

const results: Array<[string, boolean, string]> = [];
const check = (name: string, ok: boolean, detail = "") => results.push([name, ok, detail]);
const stranger = randomUUID();

const env = {
  NODE_ENV: "test",
  PRISM_STUDIO_MOCK_STAGE_DELAY_MS: "0",
  PRISM_STUDIO_GENERATION_MAX_ACTIVE_PER_PROJECT: "10",
};
const config = readGenerationConfig(env);
const registry = createRegistry(env, config);
const admin = new AdminRepository(pool, dev.id);
const ownerGen = new PostgresGenerationData(pool, rlsPreamble({ sub: dev.id }));
const strangerGen = new PostgresGenerationData(pool, rlsPreamble({ sub: stranger }));
const anonGen = new PostgresGenerationData(pool, rlsPreamble(null, "anon"));
const adminGen = new PostgresGenerationData(pool, "begin");

const sinkRoot = mkdtempSync(path.join(tmpdir(), "prism-dbgen-"));
const sink = new LocalDiskSink(sinkRoot);
const createdAttemptIds: string[] = [];
const createdAssetIds: string[] = [];
const createdFrameIds: string[] = [];
let originalSelection: Record<string, unknown> | null = null;
// section 9 runs in its own throwaway project (deleted in `finally`; its rows cascade)
const approvalProjectId = randomUUID();

async function raw(
  asUser: string | null,
  role: "authenticated" | "anon",
  sql: string,
  params: unknown[] = [],
): Promise<{ rows: Record<string, unknown>[]; error: string | null }> {
  const c = await pool.connect();
  try {
    await c.query(rlsPreamble(asUser ? { sub: asUser } : null, role));
    const r = await c.query(sql, params);
    return { rows: r.rows, error: null };
  } catch (e) {
    return { rows: [], error: (e as Error).message };
  } finally {
    await c.query("rollback").catch(() => undefined);
    c.release();
  }
}

try {
  const data = (await admin.loadProject("ojousama"))!;
  const projectId = data.project.id;
  const shot = data.shots.find((s) => s.shotCode === "3A")!;

  // Package-input revision, read BEFORE the data was loaded in production (see startGeneration).
  const rev = await ownerGen.projectRevision("ojousama");
  check(
    "projectRevision() returns a stable digest for the owner",
    Boolean(rev) && rev!.projectId === projectId,
  );
  check(
    "projectRevision() is deterministic across reads",
    (await ownerGen.projectRevision("ojousama"))!.revision === rev!.revision,
  );
  check(
    "a stranger cannot read another user's project revision",
    (await strangerGen.projectRevision("ojousama")) === null,
  );

  const submit = (key: string, modelId = "mock-video-1") => {
    const first = prepareSubmission({
      data,
      shotId: shot.id,
      registry,
      provider: "mock",
      modelId,
      acknowledged: [],
      userId: dev.id,
      idempotencyKey: key,
      config,
      projectRevision: rev!.revision,
    });
    const ack = first.evaluation.compatibility?.ignoredFeatures.map((f) => f.id) ?? [];
    return prepareSubmission({
      data,
      shotId: shot.id,
      registry,
      provider: "mock",
      modelId,
      acknowledged: ack,
      userId: dev.id,
      idempotencyKey: key,
      config,
      projectRevision: rev!.revision,
    });
  };

  // ── 1. submission: atomic attempt + job, idempotency, duplicate, stale, RLS ──
  const p1 = submit(`dbgen-${randomUUID()}`);
  check("gate allows 3A for mock-video-1", Boolean(p1.input), JSON.stringify(p1.evaluation.gate.blockers));
  let staleCode = "";
  try {
    await ownerGen.createAttemptWithJob({
      ...p1.input!,
      expectedProjectRevision: "0".repeat(64),
      job: { ...p1.input!.job, id: randomUUID(), idempotencyKey: `dbgen-${randomUUID()}` },
    });
  } catch (e) {
    staleCode = e instanceof GenerationSubmitError ? e.code : String(e);
  }
  check("a changed package dependency is refused (stale_package)", staleCode === "stale_package", staleCode);
  const created = await ownerGen.createAttemptWithJob(p1.input!);
  createdAttemptIds.push(created.attempt.id);
  check(
    "attempt is numbered atomically and queued",
    created.attempt.attemptNumber === 1 && created.attempt.status === "queued",
  );
  check(
    "job is queued with an estimated cost",
    created.job.status === "queued" && created.job.estimatedCost! > 0,
  );

  const replay = await ownerGen.createAttemptWithJob({
    ...p1.input!,
    job: { ...p1.input!.job, id: randomUUID() },
  });
  check(
    "same idempotency key replays the existing attempt",
    replay.duplicate && replay.attempt.id === created.attempt.id,
  );

  let dupCode = "";
  try {
    const p = submit(`dbgen-${randomUUID()}`);
    await ownerGen.createAttemptWithJob(p.input!);
  } catch (e) {
    dupCode = e instanceof GenerationSubmitError ? e.code : String(e);
  }
  check("second active generation for the same shot is refused", dupCode === "duplicate_active", dupCode);

  let strangerCode = "";
  try {
    await strangerGen.createAttemptWithJob({
      ...p1.input!,
      job: { ...p1.input!.job, id: randomUUID(), idempotencyKey: `x-${randomUUID()}` },
    });
  } catch (e) {
    strangerCode = e instanceof GenerationSubmitError ? e.code : (e as Error).message;
  }
  check(
    "a stranger cannot create generations on someone else's project",
    strangerCode === "not_found",
    strangerCode,
  );

  // ── 2. RLS on the new tables with REAL rows ──
  for (const table of ["generation_jobs", "generation_job_events", "generation_costs"]) {
    const own = await raw(
      dev.id,
      "authenticated",
      `select count(*)::int n from ${table} where project_id = $1`,
      [projectId],
    );
    const other = await raw(
      stranger,
      "authenticated",
      `select count(*)::int n from ${table} where project_id = $1`,
      [projectId],
    );
    const anon = await raw(null, "anon", `select count(*)::int n from ${table} where project_id = $1`, [
      projectId,
    ]);
    check(
      `${table}: owner sees rows, stranger and anon see none`,
      (own.rows[0]?.n as number) >= 1 &&
        other.rows[0]?.n === 0 &&
        (anon.rows[0]?.n === 0 || anon.error !== null),
      `${own.rows[0]?.n}/${other.rows[0]?.n}/${anon.error ?? anon.rows[0]?.n}`,
    );
  }
  check(
    "stranger cannot read the job through the repository",
    (await strangerGen.getJob(created.job.id)) === null,
  );
  check("stranger sees no attempts of the shot", (await strangerGen.listShotAttempts(shot.id)).length === 0);
  const anonRead = await anonGen.getJob(created.job.id).catch(() => "denied");
  check("anon cannot read the job", anonRead === null || anonRead === "denied");

  // ── 3. worker + MockProvider through the Postgres store ──
  const offset = { ms: 0 };
  const worker = new GenerationWorker({
    store: adminGen,
    registry,
    sink,
    config,
    logger: silentLogger,
    clock: () => new Date(Date.now() + offset.ms),
    workerId: "db-generation-test",
    retryPolicy: { baseDelayMs: 50, maxDelayMs: 200, jitter: 0 },
    heartbeatMs: 0,
  });
  const drive = async (jobId: string) => {
    for (let i = 0; i < 12; i++) {
      const j = await adminGen.getJob(jobId);
      if (j && ["succeeded", "failed", "cancelled"].includes(j.status)) return j;
      await worker.tick();
      offset.ms += 1500;
    }
    return (await adminGen.getJob(jobId))!;
  };

  const done = await drive(created.job.id);
  check(
    "worker drives the job to succeeded",
    done.status === "succeeded",
    `${done.status} ${done.lastErrorCode ?? ""}`,
  );
  check("lease released on completion", done.leaseToken === null && done.leaseOwner === null);
  const view = (await ownerGen.getAttemptView(created.attempt.id))!;
  for (const o of view.outputs) createdAssetIds.push(o.asset.id);
  check(
    "outputs are ordered and role-tagged (primary video, preview image)",
    view.outputs.length === 2 &&
      view.outputs[0]!.output.role === "primary" &&
      view.outputs[0]!.asset.type === "video" &&
      view.outputs[1]!.output.role === "preview" &&
      view.outputs[1]!.asset.type === "image",
  );
  check(
    "output assets belong to the project and are private-storage records",
    view.outputs.every(
      (o) =>
        o.asset.projectId === projectId &&
        o.asset.purpose === "generation_output" &&
        Boolean(o.asset.checksum),
    ),
  );
  check("attempt points at the primary output", view.attempt.outputAssetId === view.outputs[0]!.asset.id);
  check(
    "estimated and actual costs are recorded separately",
    view.costs.some((c) => c.kind === "estimated") &&
      view.costs.some((c) => c.kind === "actual" && c.amount! > 0),
  );
  const events = await ownerGen.listJobEvents(created.job.id);
  check(
    "event timeline ends in succeeded",
    events.at(-1)?.toStatus === "succeeded" && events[0]?.toStatus === "queued",
  );

  // ── 4. review: approve → supersede, reject with categories ──
  const approved = await ownerGen.reviewAttempt(created.attempt.id, {
    status: "approved",
    categories: [],
    reason: "",
    notes: "good",
    now: new Date().toISOString(),
  });
  check("attempt 1 approved", approved?.approved === true && approved.reviewStatus === "approved");

  const p2 = submit(`dbgen-${randomUUID()}`);
  const second = await ownerGen.createAttemptWithJob(p2.input!);
  createdAttemptIds.push(second.attempt.id);
  check("attempt 2 gets number 2", second.attempt.attemptNumber === 2);
  const done2 = await drive(second.job.id);
  const view2 = (await ownerGen.getAttemptView(second.attempt.id))!;
  for (const o of view2.outputs) createdAssetIds.push(o.asset.id);
  check("attempt 2 completes", done2.status === "succeeded");

  const rejected = await ownerGen.reviewAttempt(second.attempt.id, {
    status: "rejected",
    categories: ["identity_drift", "bad_motion"],
    reason: "face changes",
    notes: "",
    now: new Date().toISOString(),
  });
  check(
    "rejection stores structured categories and keeps attempt 1 approved",
    rejected?.reviewStatus === "rejected" &&
      rejected.rejectionCategories.join() === "identity_drift,bad_motion" &&
      (await ownerGen.getAttemptView(created.attempt.id))!.attempt.approved === true,
  );
  await ownerGen.reviewAttempt(second.attempt.id, {
    status: "approved",
    categories: [],
    reason: "",
    notes: "",
    now: new Date().toISOString(),
  });
  const after = await ownerGen.listShotAttempts(shot.id);
  const approvedNow = after.filter((v) => v.attempt.approved);
  check(
    "approving attempt 2 supersedes attempt 1; exactly one approved per shot; history intact",
    approvedNow.length === 1 && approvedNow[0]!.attempt.attemptNumber === 2 && after.length === 2,
  );
  // jsonb normalises key order, so compare canonical (sorted-key) forms.
  const canon = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(canon)
      : v && typeof v === "object"
        ? Object.fromEntries(
            Object.entries(v as Record<string, unknown>)
              .sort(([x], [y]) => x.localeCompare(y))
              .map(([k, x]) => [k, canon(x)]),
          )
        : v;
  const frozenBefore = JSON.stringify(canon(created.attempt.packageSnapshot));
  const frozenAfter = JSON.stringify(
    canon((await ownerGen.getAttemptView(created.attempt.id))!.attempt.packageSnapshot),
  );
  check("attempt 1 package snapshot is byte-identical after all of that", frozenBefore === frozenAfter);

  // ── 5. immutability guard ──
  for (const [label, sql] of [
    ["package_snapshot", "update generation_attempts set package_snapshot = '{}'::jsonb where id = $1"],
    ["request", "update generation_attempts set request = '{}'::jsonb where id = $1"],
    ["prompt_plan", "update generation_attempts set prompt_plan = '{}'::jsonb where id = $1"],
    ["compatibility", "update generation_attempts set compatibility = '{}'::jsonb where id = $1"],
    ["provider", "update generation_attempts set provider = 'other' where id = $1"],
  ] as const) {
    const c = await pool.connect();
    let error = "";
    try {
      await c.query("begin");
      await c.query(sql, [created.attempt.id]);
    } catch (e) {
      error = (e as Error).message;
    } finally {
      await c.query("rollback");
      c.release();
    }
    check(`attempt ${label} is immutable`, /append-only/.test(error), error);
  }

  // ── 6. DB state machine == TypeScript state machine, for every pair ──
  const matrix = await pool.connect();
  let mismatches = 0;
  try {
    await matrix.query("begin");
    const proj = projectId;
    for (const from of JOB_STATUSES) {
      const attemptId = randomUUID();
      await matrix.query(
        `insert into generation_attempts (id, project_id, shot_id, attempt_number, provider, model, modality, package_snapshot, status)
         values ($1, $2, $3, $4, 'mock', 'mock-video-1', 'video', '{}'::jsonb, 'queued')`,
        [attemptId, proj, shot.id, 900 + JOB_STATUSES.indexOf(from)],
      );
      const jobId = randomUUID();
      // Insert directly in the `from` state satisfying the terminal-state check constraints.
      await matrix.query(
        `insert into generation_jobs (id, project_id, attempt_id, provider, model, status, idempotency_key,
           completed_at, failed_at, cancelled_at, cancel_outcome)
         values ($1, $2, $3, 'mock', 'mock-video-1', $4, $5,
           case when $4 = 'succeeded' then now() end, case when $4 = 'failed' then now() end,
           case when $4 = 'cancelled' then now() end, case when $4 = 'cancelled' then 'local_only' end)`,
        [jobId, proj, attemptId, from, `matrix-${jobId}`],
      );
      for (const to of JOB_STATUSES) {
        if (to === from) continue;
        await matrix.query("savepoint s");
        let ok = true;
        try {
          await matrix.query(
            `update generation_jobs set status = $2,
               completed_at = case when $2 = 'succeeded' then now() else completed_at end,
               failed_at = case when $2 = 'failed' then now() else failed_at end,
               cancelled_at = case when $2 = 'cancelled' then now() else cancelled_at end,
               cancel_outcome = case when $2 = 'cancelled' then 'local_only' else cancel_outcome end
             where id = $1`,
            [jobId, to],
          );
        } catch {
          ok = false;
        }
        await matrix.query("rollback to savepoint s");
        if (ok !== canTransition(from, to)) mismatches++;
      }
    }
  } finally {
    await matrix.query("rollback");
    matrix.release();
  }
  check(
    `database transition table matches the TypeScript state machine (${JOB_STATUSES.length * (JOB_STATUSES.length - 1)} pairs)`,
    mismatches === 0,
    `${mismatches} mismatches; terminal states allow ${allowedTransitions("succeeded").length}`,
  );

  // ── 7. structural invariants (inside a rolled-back transaction) ──
  const c = await pool.connect();
  const expectErr = async (name: string, sql: string, params: unknown[], pattern: RegExp) => {
    await c.query("savepoint e");
    let err = "";
    try {
      await c.query(sql, params);
    } catch (e) {
      err = (e as Error).message;
    }
    await c.query("rollback to savepoint e");
    check(name, pattern.test(err), err || "no error raised");
  };
  try {
    await c.query("begin");
    const A = randomUUID();
    await c.query(
      `insert into generation_attempts (id, project_id, shot_id, attempt_number, provider, model, modality, package_snapshot)
       values ($1, $2, $3, 950, 'mock', 'mock-video-1', 'video', '{}'::jsonb)`,
      [A, projectId, shot.id],
    );
    const J = randomUUID();
    await c.query(
      `insert into generation_jobs (id, project_id, attempt_id, provider, model, idempotency_key) values ($1,$2,$3,'mock','m',$4)`,
      [J, projectId, A, `inv-${J}`],
    );
    await expectErr(
      "only one active job per attempt",
      `insert into generation_jobs (project_id, attempt_id, provider, model, idempotency_key) values ($1,$2,'mock','m',$3)`,
      [projectId, A, `inv2-${randomUUID()}`],
      /unique|duplicate/i,
    );
    await expectErr(
      "idempotency key is unique per project",
      `insert into generation_jobs (project_id, attempt_id, provider, model, idempotency_key, status, failed_at) values ($1,$2,'mock','m',$3,'failed',now())`,
      [projectId, A, `inv-${J}`],
      /unique|duplicate/i,
    );
    // a second project with its own attempt: a job cannot mix projects
    const P2 = randomUUID();
    await c.query("insert into projects (id, user_id, title, slug) values ($1,$2,'Other',$3)", [
      P2,
      dev.id,
      `other-${P2.slice(0, 8)}`,
    ]);
    await expectErr(
      "a job cannot reference another project's attempt",
      `insert into generation_jobs (project_id, attempt_id, provider, model, idempotency_key) values ($1,$2,'mock','m',$3)`,
      [P2, A, `inv3-${randomUUID()}`],
      /foreign key|violates/i,
    );
    await expectErr(
      "job identity columns are immutable",
      "update generation_jobs set provider = 'other' where id = $1",
      [J],
      /immutable/,
    );
    await expectErr(
      "terminal check: succeeded needs completed_at",
      `insert into generation_jobs (project_id, attempt_id, provider, model, idempotency_key, status) values ($1,$2,'mock','m',$3,'succeeded')`,
      [projectId, A, `inv4-${randomUUID()}`],
      /check/i,
    );
    await expectErr(
      "lease owner and token travel together",
      "update generation_jobs set lease_owner = 'w' where id = $1",
      [J],
      /check/i,
    );

    // outputs
    const asset = randomUUID();
    await c.query(
      `insert into assets (id, project_id, type, purpose, source, name, original_filename) values ($1,$2,'image','generation_output','provider_output','x.png','x.png')`,
      [asset, projectId],
    );
    await c.query(
      `insert into generation_outputs (project_id, attempt_id, asset_id, role, position) values ($1,$2,$3,'primary',0)`,
      [projectId, A, asset],
    );
    const asset2 = randomUUID();
    await c.query(
      `insert into assets (id, project_id, type, purpose, source, name, original_filename) values ($1,$2,'image','generation_output','provider_output','y.png','y.png')`,
      [asset2, projectId],
    );
    await expectErr(
      "one primary output per attempt",
      `insert into generation_outputs (project_id, attempt_id, asset_id, role, position) values ($1,$2,$3,'primary',1)`,
      [projectId, A, asset2],
      /unique|duplicate/i,
    );
    await expectErr(
      "output positions are unique per attempt",
      `insert into generation_outputs (project_id, attempt_id, asset_id, role, position) values ($1,$2,$3,'variant',0)`,
      [projectId, A, asset2],
      /unique|duplicate/i,
    );
    const foreignAsset = randomUUID();
    await c.query(
      `insert into assets (id, project_id, type, purpose, source, name, original_filename) values ($1,$2,'image','other','upload','z.png','z.png')`,
      [foreignAsset, P2],
    );
    await expectErr(
      "an output cannot point at another project's asset",
      `insert into generation_outputs (project_id, attempt_id, asset_id, role, position) values ($1,$2,$3,'variant',5)`,
      [projectId, A, foreignAsset],
      /foreign key|violates/i,
    );

    // costs
    await c.query(
      `insert into generation_costs (project_id, attempt_id, provider, model, kind, amount) values ($1,$2,'mock','m','estimated',0.25)`,
      [projectId, A],
    );
    await expectErr(
      "one estimate per attempt",
      `insert into generation_costs (project_id, attempt_id, provider, model, kind, amount) values ($1,$2,'mock','m','estimated',0.5)`,
      [projectId, A],
      /unique|duplicate/i,
    );
    await expectErr(
      "an actual cost needs an amount (unknown billing is its own kind)",
      `insert into generation_costs (project_id, attempt_id, provider, model, kind, amount) values ($1,$2,'mock','m','actual',null)`,
      [projectId, A],
      /check/i,
    );
    await expectErr(
      "negative cost rejected",
      `insert into generation_costs (project_id, attempt_id, provider, model, kind, amount) values ($1,$2,'mock','m','actual',-1)`,
      [projectId, A],
      /check/i,
    );
    await expectErr(
      "cost records are append-only",
      "update generation_costs set amount = 99 where attempt_id = $1",
      [A],
      /append-only/,
    );
    await expectErr(
      "approved flag must match review status",
      "update generation_attempts set approved = true where id = $1",
      [A],
      /check/i,
    );
    await expectErr(
      "attempt execution status vocabulary is closed",
      "update generation_attempts set status = 'approved' where id = $1",
      [A],
      /check/i,
    );
  } finally {
    await c.query("rollback");
    c.release();
  }

  // ── 8. Animate Production Frame: the selection is confirmed atomically with the insert, under a row lock ──
  // (the selection table is not in projectRevision and moving it does not touch shots.updated_at)
  originalSelection =
    (await pool.query("select * from shot_production_frame_selections where shot_id = $1", [shot.id]))
      .rows[0] ?? null;
  const pfOwner = new PostgresProductionFrameData(pool, rlsPreamble({ sub: dev.id }));
  const attachedData = async (): Promise<ProjectData> => {
    const d = (await admin.loadProject("ojousama"))!;
    const pf = await pfOwner.listForProject(projectId);
    return { ...d, productionFrames: pf.frames, productionFrameSelections: pf.selections };
  };
  const makeFrame = async (name: string) => {
    const d = await attachedData();
    const id = randomUUID();
    const stamp = new Date().toISOString();
    const asset = assetSchema.parse({
      id,
      projectId,
      createdBy: dev.id,
      type: "image",
      purpose: "production_frame",
      source: "upload",
      name,
      originalFilename: `${name}.png`,
      storageProvider: "local",
      bucket: null,
      objectPath: `${projectId}/${id}/${name}.png`,
      mime: "image/png",
      byteSize: 1234,
      checksum: createHash("sha256").update(`${name}-${id}`).digest("hex"),
      width: 1912,
      height: 800,
      durationMs: null,
      frameRate: null,
      sampleRate: null,
      channels: null,
      tags: [],
      notes: "",
      metadata: {},
      createdAt: stamp,
      updatedAt: stamp,
    });
    createdAssetIds.push(asset.id);
    const drafted = draftProductionFrame(buildShotContext(d, shot.id), {
      id: randomUUID(),
      now: stamp,
      userId: dev.id,
      source: "upload",
      asset,
    });
    if (!drafted.ok) throw new Error(`draft refused: ${drafted.problem.message}`);
    const r = await pfOwner.create({
      draft: drafted.draft,
      newAsset: asset,
      select: true,
      userId: dev.id,
      now: stamp,
    });
    createdFrameIds.push(r.frame.id);
    return r.frame;
  };
  const animateInput = (d: ProjectData, key: string) => {
    const args = {
      data: d,
      shotId: shot.id,
      registry,
      provider: "mock",
      modelId: "mock-video-1",
      purpose: "animate_production_frame" as const,
      userId: dev.id,
      idempotencyKey: key,
      config,
      projectRevision: null,
    };
    const first = prepareSubmission({ ...args, acknowledged: [] });
    const ack = first.evaluation.compatibility?.ignoredFeatures.map((f) => f.id) ?? [];
    const p = prepareSubmission({ ...args, acknowledged: ack });
    if (!p.input)
      throw new Error(`animate blocked: ${p.evaluation.gate.blockers.map((b) => b.message).join(" | ")}`);
    // other generations of this Shot from the sections above may still be active
    return {
      ...p.input,
      allowConcurrentOnShot: true,
      limits: { maxActivePerProject: 100, maxSubmitsPerMinutePerUser: 100 },
    };
  };
  const tally = async () =>
    JSON.stringify(
      (
        await pool.query(
          `select (select count(*)::int from generation_attempts where project_id = $1) a,
                  (select count(*)::int from generation_jobs where project_id = $1) j,
                  (select count(*)::int from generation_costs where project_id = $1) c,
                  (select count(*)::int from generation_job_events where project_id = $1) e`,
          [projectId],
        )
      ).rows[0],
    );
  const codeOf = (e: unknown) => (e instanceof GenerationSubmitError ? e.code : String(e));
  const selectionNow = async () =>
    ((
      await pool.query(
        "select production_frame_id from shot_production_frame_selections where shot_id = $1",
        [shot.id],
      )
    ).rows[0]?.production_frame_id as string | undefined) ?? null;

  check(
    "D. a generic Shot-output submission carries no expected animation frame",
    p1.input!.expectedAnimationProductionFrameId === null,
  );

  const v1 = await makeFrame("db:gen animate pf v1");
  const atV1 = await attachedData();
  const inA = animateInput(atV1, `dbgen-anim-${randomUUID()}`);
  const inB = animateInput(atV1, `dbgen-anim-${randomUUID()}`);
  check(
    "prepareSubmission derives the expected animation frame from the frozen package",
    inA.expectedAnimationProductionFrameId === v1.id && inB.expectedAnimationProductionFrameId === v1.id,
  );
  const accepted = await ownerGen.createAttemptWithJob(inA);
  createdAttemptIds.push(accepted.attempt.id);
  check(
    "A. expected frame = selected frame: attempt + job created",
    !accepted.duplicate && accepted.job.attemptId === accepted.attempt.id,
  );

  const v2 = await makeFrame("db:gen animate pf v2");
  check("the selection moved to v2 (no shots.updated_at involved)", (await selectionNow()) === v2.id);
  const t0 = await tally();
  const replayed = await ownerGen.createAttemptWithJob(inA);
  check(
    "F. idempotent replay after the frame changed returns the accepted attempt, nothing new",
    replayed.duplicate && replayed.attempt.id === accepted.attempt.id && (await tally()) === t0,
  );
  let codeB = "";
  try {
    createdAttemptIds.push((await ownerGen.createAttemptWithJob(inB)).attempt.id);
  } catch (e) {
    codeB = codeOf(e);
  }
  check(
    "B. prepared from v1, v2 selected before insert: refused (stale_animation_source)",
    codeB === "stale_animation_source",
    codeB,
  );
  check("B. no attempt, job, cost or event was written", (await tally()) === t0, `${t0} → ${await tally()}`);

  // lock regression 1: the production SQL's FOR SHARE keeps the selection row from moving until commit
  {
    const a = await pool.connect();
    const b = await pool.connect();
    try {
      await a.query("begin");
      await a.query(
        "select production_frame_id from shot_production_frame_selections where project_id = $1 and shot_id = $2 for share",
        [projectId, shot.id],
      );
      await b.query("begin");
      await b.query("set local lock_timeout = '400ms'");
      const upd = await b
        .query("update shot_production_frame_selections set production_frame_id = $1 where shot_id = $2", [
          v1.id,
          shot.id,
        ])
        .then(
          () => "updated",
          (e: Error) => e.message,
        );
      await b.query("rollback");
      await b.query("begin");
      await b.query("set local lock_timeout = '400ms'");
      const del = await b
        .query("delete from shot_production_frame_selections where shot_id = $1", [shot.id])
        .then(
          () => "deleted",
          (e: Error) => e.message,
        );
      check(
        "row lock: while the check holds the selection, another transaction can neither update nor delete it",
        /lock timeout/i.test(upd) && /lock timeout/i.test(del),
        `${upd} / ${del}`,
      );
    } finally {
      await a.query("rollback").catch(() => undefined);
      await b.query("rollback").catch(() => undefined);
      a.release();
      b.release();
    }
  }

  // lock regression 2: createAttemptWithJob itself waits on the selection row, then sees the committed move
  {
    const atV2 = await attachedData();
    const inV2 = animateInput(atV2, `dbgen-anim-${randomUUID()}`);
    const holder = await pool.connect();
    try {
      await holder.query("begin");
      await holder.query("select 1 from shot_production_frame_selections where shot_id = $1 for update", [
        shot.id,
      ]);
      let settled = false;
      const pending = ownerGen.createAttemptWithJob(inV2).then(
        (r) => {
          settled = true;
          createdAttemptIds.push(r.attempt.id);
          return "created";
        },
        (e: unknown) => {
          settled = true;
          return codeOf(e);
        },
      );
      await new Promise((r) => setTimeout(r, 1500));
      check("row lock: the animation insert waits while another transaction holds the selection", !settled);
      await holder.query(
        "update shot_production_frame_selections set production_frame_id = $1 where shot_id = $2",
        [v1.id, shot.id],
      );
      await holder.query("commit");
      const outcome = await pending;
      check(
        "row lock: a selection moved by the concurrent transaction is seen at the insert boundary: refused",
        outcome === "stale_animation_source",
        outcome,
      );
    } finally {
      await holder.query("rollback").catch(() => undefined);
      holder.release();
    }
    check(
      "row lock: no attempt, job, cost or event was written",
      (await tally()) === t0,
      `${t0} → ${await tally()}`,
    );
  }

  // C. selection cleared before insert
  await pool.query("delete from shot_production_frame_selections where shot_id = $1", [shot.id]);
  let codeC = "";
  try {
    createdAttemptIds.push(
      (await ownerGen.createAttemptWithJob(animateInput(atV1, `dbgen-anim-${randomUUID()}`))).attempt.id,
    );
  } catch (e) {
    codeC = codeOf(e);
  }
  check(
    "C. selection cleared before insert: refused (stale_animation_source)",
    codeC === "stale_animation_source",
    codeC,
  );
  check("C. no attempt, job, cost or event was written", (await tally()) === t0, `${t0} → ${await tally()}`);
  // ── 9. approval purpose guard (2I.1B regression of `fix: restrict generation approval to shot outputs`) ──
  // Creative approval is one per Shot across purposes, so the repository write path (reviewAttempt, used by
  // reviewGeneration and promoteCandidate) must refuse a Production Frame candidate. A throwaway project keeps the demo
  // Shot's approval untouched; every row here cascades away with it.
  {
    const P9 = approvalProjectId;
    const E9 = randomUUID(),
      S9 = randomUUID(),
      SH9 = randomUUID();
    await pool.query("insert into projects (id, user_id, slug, title, purpose) values ($1,$2,$3,$4,'test')", [
      P9,
      dev.id,
      `db-gen-approval-${P9.slice(0, 8)}`,
      "db:generation approval guard",
    ]);
    await pool.query("insert into project_bibles (project_id) values ($1)", [P9]);
    await pool.query(
      "insert into episodes (id, project_id, number, slug, title) values ($1,$2,1,'ep-1','E')",
      [E9, P9],
    );
    await pool.query(
      "insert into scenes (id, project_id, episode_id, scene_number, slugline, int_ext) values ($1,$2,$3,'1','INT. X','INT')",
      [S9, P9, E9],
    );
    await pool.query(
      "insert into shots (id, project_id, episode_id, scene_id, shot_code, title) values ($1,$2,$3,$4,'1A','S')",
      [SH9, P9, E9, S9],
    );
    let n9 = 0;
    const attempt9 = async (purpose: string | null) => {
      n9 += 1;
      const attemptId = randomUUID();
      await pool.query(
        `insert into generation_attempts (id, project_id, shot_id, attempt_number, provider, model, modality,
           package_snapshot, approved, status, review_status, request)
         values ($1,$2,$3,$4,'mock','mock-video-1','video','{}'::jsonb,false,'succeeded','unreviewed',$5::jsonb)`,
        [attemptId, P9, SH9, n9, purpose === null ? null : JSON.stringify({ purpose })],
      );
      return attemptId;
    };
    const shotOutput = await attempt9("shot_output");
    const frameCandidate = await attempt9("production_frame");
    const animation = await attempt9("animate_production_frame");
    const legacy = await attempt9(null);
    const reviewState = async () =>
      JSON.stringify(
        (
          await pool.query(
            `select id, approved, review_status, reviewed_at, notes from generation_attempts where shot_id = $1
              order by attempt_number`,
            [SH9],
          )
        ).rows,
      );
    const approve = (attemptId: string) =>
      ownerGen.reviewAttempt(attemptId, {
        status: "approved",
        categories: [],
        reason: "",
        notes: "db:generation approval guard",
        now: new Date().toISOString(),
      });

    const a1 = await approve(shotOutput);
    check("9. a Shot-output attempt is approved through the real repository", a1?.approved === true);
    const before = await reviewState();
    let refusal = "";
    try {
      await approve(frameCandidate);
    } catch (e) {
      refusal = (e as Error).message;
    }
    check(
      "9. approving a Production Frame candidate is refused with the guard's message",
      refusal === NOT_SHOT_OUTPUT_APPROVAL_MESSAGE,
      refusal,
    );
    check(
      "9. …and writes no approval change: the Shot's approval and every review field are exactly as before",
      (await reviewState()) === before,
    );
    const approvedNow = (
      await pool.query("select id from generation_attempts where shot_id = $1 and approved", [SH9])
    ).rows.map((r) => r.id);
    check(
      "9. the non-Shot-output attempt did not replace the Shot's approval",
      approvedNow.length === 1 && approvedNow[0] === shotOutput,
      JSON.stringify(approvedNow),
    );
    const rejected = await ownerGen.reviewAttempt(frameCandidate, {
      status: "rejected",
      categories: [],
      reason: "not this one",
      notes: "",
      now: new Date().toISOString(),
    });
    check(
      "9. rejecting a Production Frame candidate is unchanged (allowed; the approval stays)",
      rejected?.reviewStatus === "rejected" &&
        (await pool.query("select approved from generation_attempts where id = $1", [shotOutput])).rows[0]
          .approved === true,
    );
    const a3 = await approve(animation);
    check(
      "9. an animation (Shot output) still approves and supersedes the previous approval",
      a3?.approved === true &&
        (await pool.query("select approved from generation_attempts where id = $1", [shotOutput])).rows[0]
          .approved === false,
    );
    const a4 = await approve(legacy);
    check("9. purpose-less history keeps approving as before (compatibility)", a4?.approved === true);
    const del = await pool.query("delete from projects where id = $1", [P9]).then(
      () => null,
      (e: Error) => e.message,
    );
    check("9. the throwaway project is removed (cascade)", del === null, del ?? "");
  }
} finally {
  // Remove everything this run created: attempts cascade to jobs/events/outputs/costs, then the assets.
  if (createdAttemptIds.length) {
    await pool.query("delete from generation_attempts where id = any($1::uuid[])", [createdAttemptIds]);
  }
  // section 8: frames are append-only for users, so this runs as the database owner; the Shot's own selection
  // (if it had one) is restored exactly
  if (createdFrameIds.length) {
    const shot3a = (await admin.loadProject("ojousama"))!.shots.find((s) => s.shotCode === "3A")!.id;
    await pool.query(
      "delete from shot_production_frame_selections where shot_id = $1 and production_frame_id = any($2::uuid[])",
      [shot3a, createdFrameIds],
    );
    if (originalSelection) {
      const cols = Object.keys(originalSelection);
      await pool.query(
        `insert into shot_production_frame_selections (${cols.join(", ")}) values (${cols.map((_, i) => `$${i + 1}`).join(", ")})
         on conflict (shot_id) do nothing`,
        cols.map((k) => originalSelection![k]),
      );
    }
    await pool.query("delete from shot_production_frames where id = any($1::uuid[])", [createdFrameIds]);
  }
  if (createdAssetIds.length) {
    await pool.query("delete from assets where id = any($1::uuid[])", [createdAssetIds]);
  }
  await pool.query("delete from projects where id = $1", [approvalProjectId]).catch(() => undefined);
  rmSync(sinkRoot, { recursive: true, force: true });
}

let failed = 0;
for (const [name, ok, detail] of results) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail && !ok ? `  — ${detail}` : ""}`);
  if (!ok) failed++;
}
console.log(`\n${results.length - failed}/${results.length} passed`);
await pool.end();
process.exit(failed ? 1 : 0);

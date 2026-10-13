// Integration tests for durable continuity ANALYSIS against the REAL dedicated Prism Studio database
// (Phase 2D: migrations 0022-0024), including the dedicated least-privilege worker role connected through its
// REAL login (no SET ROLE, no admin credential).
//   npm run db:continuity-analysis
//
// Requires: `npm run db:seed`, and PRISM_STUDIO_CONTINUITY_DB_URL (provisioned with
// `npm run continuity:db:provision`). Everything it creates is removed afterwards.
import { randomUUID } from "node:crypto";
import pg from "pg";
import { PostgresAnalysisWorkerStore } from "../src/data/continuity-analysis-postgres";
import { PostgresMediaQaData } from "../src/data/media-qa-postgres";
import { AnalysisLeaseLostError, MediaQaError } from "../src/data/media-qa-repository";
import { AdminRepository, rlsPreamble } from "../src/data/postgres-repository";
import { ANALYSIS_JOB_STATUSES, canAnalysisTransition } from "../src/domain/continuity/analysis/job-state";
import { buildAnalysisPlan } from "../src/domain/continuity/analysis/plan";
import {
  ANALYSIS_SCHEMA_VERSION,
  PROMPT_VERSIONS,
  RUBRIC_VERSION,
  type AnalysisMedia,
  type ContinuityAnalysisInput,
} from "../src/domain/continuity/analysis/types";
import { assertDevUserExists, readDevUserEnv } from "./lib/dev-user.mjs";
import { startScript } from "./lib/safety.mjs";

const dev = readDevUserEnv();
startScript({ mode: "continuity analysis integration tests (rows created, then removed)", devOwner: dev.id });
const workerUrl = process.env.PRISM_STUDIO_CONTINUITY_DB_URL;
if (!workerUrl) {
  console.error("PRISM_STUDIO_CONTINUITY_DB_URL is not set (run npm run continuity:db:provision).");
  process.exit(2);
}
const pool = new pg.Pool({ connectionString: dev.url, ssl: { rejectUnauthorized: false }, max: 5 });
const wpool = new pg.Pool({ connectionString: workerUrl, ssl: { rejectUnauthorized: false }, max: 4 });
await assertDevUserExists(pool, dev);

const results: Array<[string, boolean, string]> = [];
const check = (name: string, ok: boolean, detail = "") => results.push([name, ok, detail]);
const stranger = randomUUID();
const owner = new PostgresMediaQaData(pool, rlsPreamble({ sub: dev.id }));
const other = new PostgresMediaQaData(pool, rlsPreamble({ sub: stranger }));
const anon = new PostgresMediaQaData(pool, rlsPreamble(null, "anon"));
const worker = new PostgresAnalysisWorkerStore(wpool);
const admin = new AdminRepository(pool, dev.id);

const attemptIds: string[] = [];
const assetIds: string[] = [];
let projectId = "";

async function sqlAs(
  client: pg.Pool,
  sql: string,
  params: unknown[] = [],
): Promise<{ rows: Record<string, unknown>[]; rowCount: number; error: string }> {
  const c = await client.connect();
  try {
    await c.query("begin");
    const r = await c.query(sql, params);
    return { rows: r.rows, rowCount: r.rowCount ?? 0, error: "" };
  } catch (e) {
    return { rows: [], rowCount: 0, error: (e as Error).message };
  } finally {
    await c.query("rollback").catch(() => undefined);
    c.release();
  }
}
const workerErr = async (sql: string, params: unknown[] = []) => (await sqlAs(wpool, sql, params)).error;
const denied = (e: string) => /permission denied|row-level security|violates row-level/i.test(e);

const mkAsset = (name: string) => {
  const id = randomUUID();
  assetIds.push(id);
  const now = new Date().toISOString();
  return {
    id,
    projectId,
    createdBy: dev.id,
    type: "image" as const,
    purpose: "generation_output" as const,
    source: "derived" as const,
    name,
    originalFilename: name,
    storageProvider: "none" as const,
    bucket: null,
    objectPath: null,
    mime: "image/png",
    byteSize: 100,
    checksum: randomUUID().replace(/-/g, "").padEnd(64, "0"),
    width: 64,
    height: 36,
    durationMs: null,
    frameRate: null,
    sampleRate: null,
    channels: null,
    tags: [],
    notes: "",
    metadata: {},
    createdAt: now,
    updatedAt: now,
  };
};

async function newAttempt(shotId: string, n: number) {
  const id = randomUUID();
  attemptIds.push(id);
  await pool.query(
    `insert into generation_attempts (id, project_id, shot_id, attempt_number, provider, model, modality,
       package_snapshot, status) values ($1, $2, $3, $4, 'mock', 'mock-video-1', 'video', '{}'::jsonb, 'succeeded')`,
    [id, projectId, shotId, n],
  );
  return id;
}

function snapshot(
  attemptId: string,
  subjectId: string,
  refId: string,
  frameId: string,
): ContinuityAnalysisInput {
  const media: AnalysisMedia[] = [
    {
      inputId: "ref:identity:1",
      kind: "reference",
      role: "identity",
      label: "Character A",
      assetId: refId,
      checksum: "a".repeat(64),
      mime: "image/png",
      width: 64,
      height: 36,
      byteSize: 100,
      durationMs: null,
      atMs: null,
    },
    {
      inputId: "frame:0",
      kind: "output_frame",
      role: "output_frame",
      label: "frame",
      assetId: frameId,
      checksum: "b".repeat(64),
      mime: "image/png",
      width: 64,
      height: 36,
      byteSize: 100,
      durationMs: null,
      atMs: 0,
    },
  ];
  const criteria = [
    {
      key: "identity:A",
      category: "identity" as const,
      severity: "critical" as const,
      title: "A identity",
      sourceRef: "refs",
      expected: "dark hair",
      capability: "image_identity" as const,
    },
    {
      key: "wardrobe:A",
      category: "wardrobe" as const,
      severity: "major" as const,
      title: "A wardrobe",
      sourceRef: "Look",
      expected: "black dress",
      capability: "wardrobe" as const,
    },
  ];
  const plan = buildAnalysisPlan({
    analyzer: {
      id: "gemini",
      model: "gemini-3.8-flash",
      capabilities: ["image_identity", "wardrobe"],
      modes: ["image_set"],
      videoCapabilities: [],
    },
    criteria: criteria.map((c, i) => ({ ...c, handler: "analyzer" as const, position: i })),
    media: [
      { ...media[0]!, role: "identity" },
      { ...media[0]!, inputId: "ref:look:1", role: "look" },
      media[1]!,
    ],
  });
  return {
    version: 1,
    runKey: "db-test",
    attemptId,
    subjectAssetId: subjectId,
    providerOriginalAssetId: null,
    criteria,
    media,
    framing: {
      productionAspectRatio: "2.39:1",
      deliveryWidth: null,
      deliveryHeight: null,
      providerCanvas: null,
      strategy: null,
    },
    analyzer: "gemini",
    analyzerVersion: "1",
    model: "gemini-3.8-flash",
    promptVersions: PROMPT_VERSIONS,
    rubricVersion: RUBRIC_VERSION,
    schemaVersion: ANALYSIS_SCHEMA_VERSION,
    plan,
  };
}

const newRun = (attemptId: string, subjectId: string, originalId: string) => ({
  projectId,
  attemptId,
  subjectAssetId: subjectId,
  originalAssetId: originalId,
  analyzer: "gemini",
  analyzerVersion: "1",
  analyzerKind: "model" as const,
  rulesVersion: "2c.1",
  analysisStatus: "queued" as const,
  packageFingerprint: "p".repeat(64),
  subjectFingerprint: "s".repeat(64),
  criteriaFingerprint: "c".repeat(64),
  referenceFingerprint: "r".repeat(64),
  referenceSet: { items: [] },
  createdBy: dev.id,
  now: new Date().toISOString(),
  analysisPlan: null,
  externalManifest: null,
  promptVersion: "continuity-gemini-image-v1",
  rubricVersion: RUBRIC_VERSION,
  model: "gemini-3.8-flash",
});
const finding = (
  key: string,
  category: "identity" | "wardrobe",
  severity: "critical" | "major",
  position: number,
) => ({
  criterionKey: key,
  category,
  severity,
  title: key,
  sourceRef: "Look",
  expected: "expected",
  actual: "",
  result: "unchecked" as const,
  resultSource: "none" as const,
  confidence: null,
  notes: "",
  evidence: {},
  position,
});

try {
  const data = (await admin.loadProject("ojousama"))!;
  projectId = data.project.id;
  const shot = data.shots.find((s) => s.shotCode === "3A")!;
  const [subject, original, ref, frame, other1] = [
    "subject.mp4",
    "original.webm",
    "ref.png",
    "frame.png",
    "unrelated.png",
  ].map(mkAsset);
  for (const a of [subject!, original!, ref!, frame!, other1!])
    await admin.upsert(projectId, "assets", a as never);

  // ── submission (user path) ──
  const attemptId = await newAttempt(shot.id, 9200);
  const snap = snapshot(attemptId, subject!.id, ref!.id, frame!.id);
  const findings = [
    finding("identity:A", "identity", "critical", 0),
    finding("wardrobe:A", "wardrobe", "major", 1),
  ];
  const submit = (idem: string, aId = attemptId, max = 3) =>
    owner.createAnalysisRunWithJob({
      run: { ...newRun(aId, subject!.id, original!.id), now: new Date().toISOString() },
      findings,
      job: {
        idempotencyKey: idem,
        analyzer: "gemini",
        model: "gemini-3.8-flash",
        snapshot: { ...snap, attemptId: aId },
        inputAssetIds: [ref!.id, frame!.id],
        maxAttempts: 3,
        estimate: {
          maxUsd: 0.0123,
          expectedUsd: 0.004,
          usage: { tokens: {} },
          pricingVersion: "gemini-2026-10-13",
        },
      },
      limits: { maxActivePerProject: max },
    });
  const a = await submit("db-analysis-key-0001");
  check(
    "submission creates run + frozen job + estimate + event atomically",
    a.job.status === "queued" && a.run.run.analysisStatus === "queued" && !a.duplicate,
  );
  check(
    "the run freezes model + prompt/rubric versions",
    a.run.run.model === "gemini-3.8-flash" &&
      a.run.run.promptVersion === "continuity-gemini-image-v1" &&
      a.run.run.rubricVersion === RUBRIC_VERSION,
  );
  const replay = await submit("db-analysis-key-0001");
  check("same idempotency key replays (no second paid job)", replay.duplicate && replay.job.id === a.job.id);
  check(
    "estimate is recorded in analysis costs (not generation costs)",
    (await owner.listAnalysisCosts(a.run.run.id)).map((c) => c.kind).join() === "estimated",
  );
  const genCostsForAttempt = await pool.query(
    "select count(*)::int n from generation_costs where attempt_id = $1",
    [attemptId],
  );
  check("no generation_costs row is written for analysis", genCostsForAttempt.rows[0].n === 0);
  let limitErr = "";
  try {
    await submit("db-analysis-key-0002", attemptId, 1);
  } catch (e) {
    limitErr = e instanceof MediaQaError ? e.code : String(e);
  }
  check("per-project active analysis limit is enforced", limitErr === "invalid", limitErr);

  // ── ownership / RLS ──
  check(
    "stranger cannot read the job, costs or events",
    (await other.getAnalysisJob(a.job.id)) === null &&
      (await other.listAnalysisCosts(a.run.run.id)).length === 0 &&
      (await other.listAnalysisEvents(a.job.id)).length === 0,
  );
  check("anon cannot read jobs", (await anon.getAnalysisJob(a.job.id)) === null);
  let strangerSubmit = "";
  try {
    await other.createAnalysisRunWithJob({
      run: { ...newRun(attemptId, subject!.id, original!.id), createdBy: stranger },
      findings,
      job: {
        idempotencyKey: "stranger-key-0001",
        analyzer: "gemini",
        model: "m",
        snapshot: snap,
        inputAssetIds: [],
        maxAttempts: 1,
        estimate: { maxUsd: 0, expectedUsd: 0, usage: {}, pricingVersion: "x" },
      },
      limits: { maxActivePerProject: 5 },
    });
  } catch (e) {
    strangerSubmit = (e as Error).message;
  }
  check(
    "stranger cannot submit an analysis for another user's attempt",
    strangerSubmit !== "",
    strangerSubmit,
  );

  // ── claim / SKIP LOCKED / lease (REAL worker login) ──
  const who = await sqlAs(wpool, "select current_user as u, session_user as s");
  check(
    "worker connection is the dedicated role (not SET ROLE)",
    who.rows[0]?.u === "prism_continuity_worker" && who.rows[0]?.s === "prism_continuity_worker",
  );
  const now0 = new Date();
  const [c1, c2] = await Promise.all([
    worker.claim({ workerId: "w1", now: now0.toISOString(), leaseMs: 30_000, limit: 5 }),
    worker.claim({ workerId: "w2", now: now0.toISOString(), leaseMs: 30_000, limit: 5 }),
  ]);
  const mine = [...c1, ...c2].filter((c) => c.job.id === a.job.id);
  check(
    "two concurrent workers: exactly one claims the job (SKIP LOCKED + lease)",
    mine.length === 1,
    `${mine.length}`,
  );
  const claimed = mine[0]!.job;
  check(
    "claim moves queued → claimed with a lease token",
    claimed.status === "claimed" && Boolean(claimed.leaseToken),
  );
  check(
    "a live lease cannot be claimed again",
    (await worker.claim({ workerId: "w3", now: now0.toISOString(), leaseMs: 1000, limit: 5 })).filter(
      (c) => c.job.id === a.job.id,
    ).length === 0,
  );

  // ── narrow asset read ──
  const okRef = await worker.findInputAsset(a.job.id, ref!.id);
  check(
    "worker can read the assets named by the frozen job",
    okRef?.assetId === ref!.id && okRef?.checksum === ref!.checksum,
  );
  check(
    "worker cannot read an asset the job does not name",
    (await worker.findInputAsset(a.job.id, other1!.id)) === null,
  );
  check(
    "worker cannot read assets directly (RLS hides everything but job inputs)",
    ((await sqlAs(wpool, "select count(*)::int n from assets where project_id = $1", [projectId])).rows[0]
      ?.n as number) === 2,
  );

  // ── execution state, fencing, reclaim ──
  const token = claimed.leaseToken!;
  const t0 = new Date().toISOString();
  const proc = await worker.update(
    a.job.id,
    token,
    { status: "processing", attemptCount: 1, startedAt: t0, providerState: "sending" },
    t0,
  );
  check(
    "worker marks processing / provider_state=sending",
    proc.status === "processing" && proc.providerState === "sending",
  );
  await worker.startRun(a.run.run.id, t0);
  check("worker marks the run running", (await owner.getRun(a.run.run.id))!.run.analysisStatus === "running");
  let fenced = "";
  try {
    await worker.update(a.job.id, "wrong-token", { batchesDone: 1 }, t0);
  } catch (e) {
    fenced = e instanceof AnalysisLeaseLostError ? "lease_lost" : String(e);
  }
  check("a wrong lease token is fenced out", fenced === "lease_lost", fenced);
  const later = new Date(Date.now() + 120_000).toISOString();
  const reclaimed = (await worker.claim({ workerId: "w9", now: later, leaseMs: 30_000, limit: 5 })).find(
    (c) => c.job.id === a.job.id,
  );
  check(
    "an expired lease is reclaimed by another worker with a NEW token",
    Boolean(reclaimed) && reclaimed!.job.leaseToken !== token && reclaimed!.job.providerState === "sending",
  );
  let stale = "";
  try {
    await worker.update(a.job.id, token, { batchesDone: 1 }, later);
  } catch (e) {
    stale = e instanceof AnalysisLeaseLostError ? "lease_lost" : String(e);
  }
  check(
    "the previous lease holder can no longer write",
    stale === "lease_lost" && !(await worker.heartbeat(a.job.id, token, later, 1000)),
  );

  // ── final result: one transaction, exactly once ──
  const tok2 = reclaimed!.job.leaseToken!;
  const fin = await worker.finalizeSuccess({
    jobId: a.job.id,
    leaseToken: tok2,
    runId: a.run.run.id,
    findings: [
      {
        criterionKey: "identity:A",
        result: "pass",
        confidence: 0.9,
        summary: "Consistent.",
        evidence: [
          { input: "frame:0", assetId: frame!.id, atMs: 0, observation: "visible", source: "output_frame" },
        ],
        contradictions: [],
        limitations: [],
      },
      {
        criterionKey: "wardrobe:A",
        result: "fail",
        confidence: 0.8,
        summary: "Dress is ivory.",
        evidence: [],
        contradictions: ["Look shows black"],
        limitations: [],
      },
    ],
    cost: {
      kind: "actual",
      amountUsd: 0.0031,
      usage: { inputTokens: 1000, outputTokens: 200, thoughtsTokens: 10, totalTokens: 1210, calls: [] },
      pricingVersion: "gemini-2026-10-13",
      analyzer: "gemini",
      model: "gemini-3.8-flash",
    },
    providerRef: "resp-1",
    correctionCount: 0,
    note: "2 criteria judged",
    now: new Date().toISOString(),
  });
  check(
    "finalizeSuccess: job succeeded, run complete",
    fin.status === "succeeded" && (await owner.getRun(a.run.run.id))!.run.analysisStatus === "complete",
  );
  const done = (await owner.getRun(a.run.run.id))!;
  const wf = done.findings.find((f) => f.finding.criterionKey === "wardrobe:A")!;
  check(
    "findings carry the normalized result + evidence + provenance",
    wf.finding.result === "fail" &&
      wf.finding.resultSource === "analyzer" &&
      JSON.stringify(wf.finding.evidence).includes("Look shows black"),
  );
  check(
    "the actual cost is a separate append-only record",
    (await owner.listAnalysisCosts(a.run.run.id))
      .map((c) => c.kind)
      .sort()
      .join() === "actual,estimated",
  );
  const again = await worker
    .finalizeSuccess({
      ...{
        jobId: a.job.id,
        leaseToken: tok2,
        runId: a.run.run.id,
        findings: [],
        cost: {
          kind: "actual" as const,
          amountUsd: 9,
          usage: { inputTokens: 1, outputTokens: 1, thoughtsTokens: 0, totalTokens: 2, calls: [] },
          pricingVersion: "x",
          analyzer: "gemini",
          model: "m",
        },
        providerRef: null,
        correctionCount: 0,
        note: "dup",
        now: new Date().toISOString(),
      },
    })
    .catch((e) => e);
  check(
    "a duplicate finish cannot add a second result or cost",
    (await owner.listAnalysisCosts(a.run.run.id)).filter((c) => c.kind !== "estimated").length === 1,
    again instanceof Error ? again.message : "",
  );
  check(
    "terminal jobs are history: worker cannot update them",
    denied(
      await workerErr("update continuity_analysis_jobs set last_error_message = 'x' where id = $1", [
        a.job.id,
      ]),
    ) ||
      (
        await sqlAs(wpool, "update continuity_analysis_jobs set last_error_message = 'x' where id = $1", [
          a.job.id,
        ])
      ).rowCount === 0,
  );
  check(
    "the analysis spend ledger sums actuals (and estimates for unknown)",
    (await owner.analysisSpentSince(projectId, new Date(Date.now() - 3600_000).toISOString())) >= 0.0031,
  );
  check(
    "worker can read the global analysis spend (daily ceiling)",
    (await worker.spentSince(new Date(Date.now() - 3600_000).toISOString())) >= 0.0031,
  );

  // ── frozen history ──
  const adminErr = async (sql: string, params: unknown[] = []) => (await sqlAs(pool, sql, params)).error;
  check(
    "the frozen input snapshot cannot change (trigger)",
    /frozen/.test(
      await adminErr("update continuity_analysis_jobs set input_snapshot = '{}'::jsonb where id = $1", [
        a.job.id,
      ]),
    ),
  );
  check(
    "a terminal job cannot change state",
    /terminal|illegal/.test(
      await adminErr("update continuity_analysis_jobs set status = 'queued' where id = $1", [a.job.id]),
    ),
  );
  check(
    "analysis costs are append-only",
    /append-only/.test(
      await adminErr("update continuity_analysis_costs set amount_usd = 0 where job_id = $1", [a.job.id]),
    ),
  );
  check(
    "analysis events are append-only",
    /append-only/.test(
      await adminErr("update continuity_analysis_events set note = 'x' where job_id = $1", [a.job.id]),
    ),
  );
  check(
    "a run's plan / manifest / model are frozen",
    /frozen snapshot/.test(
      await adminErr("update continuity_runs set model = 'other' where id = $1", [a.run.run.id]),
    ),
  );

  // ── worker privileges: what it must NOT be able to do ──
  check(
    "cannot write human overrides",
    denied(
      await workerErr(
        "insert into continuity_overrides (project_id, run_id, finding_id, result) values ($1, $2, $3, 'pass')",
        [projectId, a.run.run.id, wf.finding.id],
      ),
    ),
  );
  check("cannot read human overrides", denied(await workerErr("select 1 from continuity_overrides limit 1")));
  check(
    "cannot create findings",
    denied(
      await workerErr(
        "insert into continuity_findings (project_id, run_id, criterion_key, category, severity, title) values ($1, $2, 'x', 'other', 'minor', 'x')",
        [projectId, a.run.run.id],
      ),
    ),
  );
  check(
    "cannot change a finding's expected value / severity (column grants)",
    denied(
      await workerErr("update continuity_findings set expected = 'x' where run_id = $1", [a.run.run.id]),
    ) &&
      denied(
        await workerErr("update continuity_findings set severity = 'minor' where run_id = $1", [
          a.run.run.id,
        ]),
      ),
  );
  check(
    "cannot create jobs or delete anything",
    denied(
      await workerErr(
        "insert into continuity_analysis_jobs (project_id, run_id, attempt_id, analyzer, model, input_snapshot, idempotency_key) values ($1, $2, $3, 'a', 'm', '{}'::jsonb, 'xxxxxxxx')",
        [projectId, a.run.run.id, attemptId],
      ),
    ) && denied(await workerErr("delete from continuity_analysis_jobs where id = $1", [a.job.id])),
  );
  check(
    "cannot write estimated costs (user submission only)",
    denied(
      await workerErr(
        "insert into continuity_analysis_costs (project_id, run_id, job_id, analyzer, model, kind, amount_usd) values ($1, $2, $3, 'a', 'm', 'estimated', 0)",
        [projectId, a.run.run.id, a.job.id],
      ),
    ),
  );
  for (const table of [
    "shots",
    "scenes",
    "episodes",
    "characters",
    "character_looks",
    "character_identity_refs",
    "locations",
    "props",
    "project_bibles",
    "storyboard_frames",
    "dialogue_lines",
    "action_blocks",
    "performance_takes",
    "projects",
    "generation_attempts",
    "generation_jobs",
    "generation_costs",
    "generation_outputs",
    "asset_derivations",
    "attempt_deliveries",
    "continuity_checks",
    "prism_migrations",
  ]) {
    const e = await workerErr(`select 1 from ${table} limit 1`);
    check(`cannot read ${table}`, denied(e) || /does not exist/.test(e), e);
  }
  check(
    "cannot create or alter schema objects",
    denied(await workerErr("create table zz_continuity_probe (id int)")),
  );
  check("cannot truncate", denied(await workerErr("truncate continuity_findings")));
  const attrs = (
    await sqlAs(
      pool,
      "select rolsuper, rolbypassrls, rolcreaterole, rolcreatedb, rolreplication, rolinherit from pg_roles where rolname = 'prism_continuity_worker'",
    )
  ).rows[0]!;
  check(
    "role is not superuser / BYPASSRLS / createrole / createdb / replication, NOINHERIT",
    !attrs.rolsuper &&
      !attrs.rolbypassrls &&
      !attrs.rolcreaterole &&
      !attrs.rolcreatedb &&
      !attrs.rolreplication &&
      !attrs.rolinherit,
  );
  const members = (
    await sqlAs(
      pool,
      "select count(*)::int n from pg_auth_members m where m.member = (select oid from pg_roles where rolname = 'prism_continuity_worker')",
    )
  ).rows[0]!.n;
  check("role is a member of no other role", members === 0);

  // ── cancellation ──
  const att2 = await newAttempt(shot.id, 9201);
  const q = await submit("db-analysis-key-0003", att2);
  const cancelled = (await owner.requestAnalysisCancel(q.job.id, new Date().toISOString()))!;
  check(
    "a queued analysis cancels locally (no request ever)",
    cancelled.status === "cancelled" && (await owner.getRun(q.run.run.id))!.run.analysisStatus === "failed",
  );
  const att3 = await newAttempt(shot.id, 9202);
  const r3 = await submit("db-analysis-key-0004", att3);
  const c3 = (
    await worker.claim({ workerId: "w4", now: new Date().toISOString(), leaseMs: 30_000, limit: 5 })
  ).find((c) => c.job.id === r3.job.id)!;
  const req = (await owner.requestAnalysisCancel(r3.job.id, new Date().toISOString()))!;
  check("a claimed analysis becomes cancel_requested", req.status === "cancel_requested");
  const stopped = await worker.finalizeFailure({
    jobId: r3.job.id,
    leaseToken: c3.job.leaseToken!,
    runId: r3.run.run.id,
    errorCode: "cancelled",
    errorCategory: "cancelled",
    errorMessage: "Analysis cancelled.",
    cost: null,
    cancelled: true,
    now: new Date().toISOString(),
  });
  check("the worker ends it `cancelled` (not failed)", stopped.status === "cancelled");

  // ── failure path: unknown cost recorded, run failed ──
  const att4 = await newAttempt(shot.id, 9203);
  const r4 = await submit("db-analysis-key-0005", att4);
  const c4 = (
    await worker.claim({ workerId: "w5", now: new Date().toISOString(), leaseMs: 30_000, limit: 5 })
  ).find((c) => c.job.id === r4.job.id)!;
  await worker.update(
    r4.job.id,
    c4.job.leaseToken!,
    { status: "processing", attemptCount: 1 },
    new Date().toISOString(),
  );
  const failed = await worker.finalizeFailure({
    jobId: r4.job.id,
    leaseToken: c4.job.leaseToken!,
    runId: r4.run.run.id,
    errorCode: "timeout",
    errorCategory: "outcome_unknown",
    errorMessage: "ambiguous",
    cost: {
      kind: "unknown",
      amountUsd: null,
      usage: { inputTokens: null, outputTokens: null, thoughtsTokens: null, totalTokens: null, calls: [] },
      pricingVersion: "x",
      analyzer: "gemini",
      model: "gemini-3.8-flash",
    },
    now: new Date().toISOString(),
  });
  check(
    "failure: job failed, run failed, unknown cost recorded (never invented)",
    failed.status === "failed" &&
      failed.lastErrorCategory === "outcome_unknown" &&
      (await owner.listAnalysisCosts(r4.run.run.id)).some(
        (c) => c.kind === "unknown" && c.amountUsd === null,
      ),
  );

  // ── DB state machine == TypeScript state machine ──
  const matrix = await pool.connect();
  let mismatches = 0;
  try {
    await matrix.query("begin");
    for (const from of ANALYSIS_JOB_STATUSES) {
      const runId = randomUUID();
      await matrix.query(
        `insert into continuity_runs (id, project_id, attempt_id, run_number, subject_asset_id, analyzer, analyzer_version, analyzer_kind, rules_version, package_fingerprint, subject_fingerprint, criteria_fingerprint, reference_fingerprint)
         values ($1, $2, $3, $4, $5, 'gemini', '1', 'model', 'x', 'p', 's', 'c', 'r')`,
        [runId, projectId, attemptId, 800 + ANALYSIS_JOB_STATUSES.indexOf(from), subject!.id],
      );
      const jobId = randomUUID();
      await matrix.query(
        `insert into continuity_analysis_jobs (id, project_id, run_id, attempt_id, analyzer, model, status, input_snapshot, idempotency_key, completed_at, failed_at, cancelled_at)
         values ($1, $2, $3, $4, 'gemini', 'm', $5, '{}'::jsonb, $6,
           case when $5 = 'succeeded' then now() end, case when $5 = 'failed' then now() end, case when $5 = 'cancelled' then now() end)`,
        [jobId, projectId, runId, attemptId, from, `matrix-${jobId}`],
      );
      for (const to of ANALYSIS_JOB_STATUSES) {
        if (to === from) continue;
        await matrix.query("savepoint s");
        let ok = true;
        try {
          await matrix.query(
            `update continuity_analysis_jobs set status = $2,
               completed_at = case when $2 = 'succeeded' then now() else completed_at end,
               failed_at = case when $2 = 'failed' then now() else failed_at end,
               cancelled_at = case when $2 = 'cancelled' then now() else cancelled_at end where id = $1`,
            [jobId, to],
          );
        } catch {
          ok = false;
        }
        await matrix.query("rollback to savepoint s");
        if (ok !== canAnalysisTransition(from, to)) mismatches++;
      }
    }
  } finally {
    await matrix.query("rollback");
    matrix.release();
  }
  check(
    `database transition table matches the TypeScript state machine (${ANALYSIS_JOB_STATUSES.length * (ANALYSIS_JOB_STATUSES.length - 1)} pairs)`,
    mismatches === 0,
    `${mismatches} mismatches`,
  );

  // ── cascade ──
  await pool.query("delete from generation_attempts where id = any($1::uuid[])", [attemptIds]);
  const left = await pool.query(
    "select (select count(*) from continuity_analysis_jobs where attempt_id = any($1::uuid[]))::int as jobs, (select count(*) from continuity_runs where attempt_id = any($1::uuid[]))::int as runs",
    [attemptIds],
  );
  check(
    "deleting the attempts cascades runs, findings, jobs, costs and events",
    left.rows[0].jobs === 0 && left.rows[0].runs === 0,
    JSON.stringify(left.rows[0]),
  );
} finally {
  await pool
    .query("delete from generation_attempts where id = any($1::uuid[])", [attemptIds])
    .catch(() => undefined);
  for (const id of [...assetIds].reverse())
    await pool.query("delete from assets where id = $1", [id]).catch(() => undefined);
  const leftover = await pool.query("select count(*)::int n from assets where id = any($1::uuid[])", [
    assetIds,
  ]);
  check("cleanup: no test assets remain", leftover.rows[0].n === 0);
  await wpool.end();
  await pool.end();
}

let failed = 0;
for (const [name, ok, detail] of results) {
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : `  → ${detail}`}`);
}
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);

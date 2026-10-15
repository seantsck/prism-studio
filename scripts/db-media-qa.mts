// Integration tests for derived media lineage, delivery masters and continuity QA against the REAL dedicated
// Prism Studio database (Phase 2C: migrations 0019-0021).
//   npm run db:media-qa
//
// Exercises (real rows, always cleaned up):
//   - generation_attempts.adaptation_plan: stored, parsed, immutable
//   - asset_derivations: atomic asset+lineage insert, idempotent on the derivation key, versioning, append-only
//   - attempt_deliveries: one selected master per attempt, switching keeps history
//   - continuity_runs / findings / overrides: frozen snapshots, analysis lifecycle, append-only overrides,
//     human override precedence, finalize
//   - RLS: a stranger and anon see/do nothing; deleting an attempt cascades through all of it
//   - the generation worker role has NO access to any of the new tables (when its login is configured)
// Requires `npm run db:seed` first (uses the demo project's Shot 3A). Never touches another project.
import { randomUUID } from "node:crypto";
import pg from "pg";
import { PostgresMediaQaData } from "../src/data/media-qa-postgres";
import { AdminRepository, rlsPreamble } from "../src/data/postgres-repository";
import { MediaQaError } from "../src/data/media-qa-repository";
import { assertDevUserExists, readDevUserEnv } from "./lib/dev-user.mjs";
import { startScript } from "./lib/safety.mjs";

const dev = readDevUserEnv();
startScript({ mode: "media/QA integration tests (rows created, then removed)", devOwner: dev.id });
const pool = new pg.Pool({ connectionString: dev.url, ssl: { rejectUnauthorized: false }, max: 4 });
await assertDevUserExists(pool, dev);

const results: Array<[string, boolean, string]> = [];
const check = (name: string, ok: boolean, detail = "") => results.push([name, ok, detail]);
const stranger = randomUUID();

const owner = new PostgresMediaQaData(pool, rlsPreamble({ sub: dev.id }));
const other = new PostgresMediaQaData(pool, rlsPreamble({ sub: stranger }));
const anon = new PostgresMediaQaData(pool, rlsPreamble(null, "anon"));
const admin = new AdminRepository(pool, dev.id);

async function sqlError(sql: string, params: unknown[] = [], role?: string): Promise<string> {
  const c = await pool.connect();
  try {
    await c.query("begin");
    if (role) await c.query(`set local role ${role}`);
    await c.query(sql, params);
    return "";
  } catch (e) {
    return (e as Error).message;
  } finally {
    await c.query("rollback").catch(() => undefined);
    c.release();
  }
}

const attemptId = randomUUID();
const assetIds: string[] = [];
let projectId = "";

const mkAsset = (name: string, over: Record<string, unknown> = {}) => {
  const id = randomUUID();
  assetIds.push(id);
  const now = new Date().toISOString();
  return {
    id,
    projectId,
    createdBy: dev.id,
    type: "video" as const,
    purpose: "generation_output" as const,
    source: "derived" as const,
    name,
    originalFilename: name,
    storageProvider: "none" as const,
    bucket: null,
    objectPath: null,
    mime: "video/mp4",
    byteSize: 1000,
    checksum: randomUUID().replace(/-/g, "").padEnd(64, "0"),
    width: 1280,
    height: 536,
    durationMs: 4500,
    frameRate: 24,
    sampleRate: null,
    channels: null,
    tags: [],
    notes: "",
    metadata: {},
    createdAt: now,
    updatedAt: now,
    ...over,
  };
};

try {
  const data = (await admin.loadProject("ojousama"))!;
  projectId = data.project.id;
  const shot = data.shots.find((s) => s.shotCode === "3A")!;

  // ── attempt with a frozen adaptation plan ──
  const plan = { planVersion: 1, status: "adapted", fingerprint: "f".repeat(64) };
  await pool.query(
    `insert into generation_attempts (id, project_id, shot_id, attempt_number, provider, model, modality,
       package_snapshot, status, adaptation_plan)
     values ($1, $2, $3, 9100, 'mock', 'mock-video-169', 'video', '{}'::jsonb, 'succeeded', $4::jsonb)`,
    [attemptId, projectId, shot.id, JSON.stringify(plan)],
  );
  const stored = (
    await pool.query("select adaptation_plan from generation_attempts where id = $1", [attemptId])
  ).rows[0].adaptation_plan;
  check("adaptation_plan is stored on the attempt", stored?.fingerprint === plan.fingerprint);
  check(
    "adaptation_plan is immutable (history guard)",
    /append-only/.test(
      await sqlError("update generation_attempts set adaptation_plan = '{}'::jsonb where id = $1", [
        attemptId,
      ]),
    ),
  );
  check(
    "execution fields of an attempt remain writable (status)",
    (await sqlError("update generation_attempts set status = 'succeeded' where id = $1", [attemptId])) === "",
  );

  // ── derivations ──
  const original = mkAsset("original.webm", {
    source: "provider_output",
    width: 1280,
    height: 720,
    durationMs: 5000,
  });
  await admin.upsert(projectId, "assets", original as never);
  const key = "k".repeat(64);
  const child1 = mkAsset("delivery-v1.mp4");
  const r1 = await owner.recordDerivation({
    asset: child1 as never,
    parentAssetId: original.id,
    operation: "conform",
    derivationKey: key,
    parameters: { crop: { x: 0, y: 92, width: 1280, height: 536 } },
    processor: "ffmpeg",
    processorVersion: "1 (9.0.1)",
    attemptId,
    slot: "delivery",
    createdBy: dev.id,
    now: new Date().toISOString(),
  });
  check(
    "recordDerivation inserts the asset and its lineage atomically",
    r1.created && r1.derivation.version === 1,
  );
  const dup = mkAsset("delivery-v1-dup.mp4");
  const r1b = await owner.recordDerivation({
    asset: dup as never,
    parentAssetId: original.id,
    operation: "conform",
    derivationKey: key,
    parameters: {},
    processor: "ffmpeg",
    processorVersion: "1",
    attemptId,
    slot: "delivery",
    createdBy: dev.id,
    now: new Date().toISOString(),
  });
  check(
    "the same derivation key is idempotent: existing child returned, no duplicate asset",
    !r1b.created && r1b.asset.id === child1.id,
  );
  const dupRow = (await pool.query("select 1 from assets where id = $1", [dup.id])).rowCount;
  check("no second asset row was written for a replayed derivation", dupRow === 0);

  const child2 = mkAsset("delivery-v2.mp4");
  const r2 = await owner.recordDerivation({
    asset: child2 as never,
    parentAssetId: original.id,
    operation: "conform",
    derivationKey: "m".repeat(64),
    parameters: { crop: { x: 0, y: 100, width: 1280, height: 520 } },
    processor: "ffmpeg",
    processorVersion: "1 (9.0.1)",
    attemptId,
    slot: "delivery",
    createdBy: dev.id,
    now: new Date().toISOString(),
  });
  check("a changed conform is a NEW version, the old one is kept", r2.created && r2.derivation.version === 2);
  check(
    "lineage queries: by attempt, by parent, by child",
    (await owner.listAttemptDerivations(attemptId)).length === 2 &&
      (await owner.listDerivationsByParent(original.id)).length === 2 &&
      (await owner.getDerivationOfAsset(child2.id))?.parentAssetId === original.id,
  );
  check(
    "a derivation row is append-only",
    /append-only/.test(
      await sqlError("update asset_derivations set operation = 'trim' where child_asset_id = $1", [
        child1.id,
      ]),
    ),
  );
  check(
    "a derivation cannot be its own parent",
    /check|violates/i.test(
      await sqlError(
        `insert into asset_derivations (project_id, parent_asset_id, child_asset_id, operation, derivation_key, processor, processor_version)
         values ($1, $2, $2, 'crop', $3, 'x', '1')`,
        [projectId, original.id, "z".repeat(40)],
      ),
    ),
  );
  check(
    "the original cannot be deleted while derivations exist (lineage is never orphaned)",
    /foreign key|violates/i.test(await sqlError("delete from assets where id = $1", [original.id])),
  );
  check("assetPins explains why", (await owner.assetPins(original.id)).join(" ").includes("derived file"));

  // ── delivery master selection ──
  const sel1 = await owner.selectDelivery({
    attemptId,
    projectId,
    assetId: child1.id,
    originalAssetId: original.id,
    conform: { version: 1 },
    selectedBy: dev.id,
    now: new Date().toISOString(),
  });
  const sel2 = await owner.selectDelivery({
    attemptId,
    projectId,
    assetId: child2.id,
    originalAssetId: original.id,
    conform: { version: 2 },
    selectedBy: dev.id,
    now: new Date().toISOString(),
  });
  check(
    "exactly one delivery master per attempt; re-selecting replaces the selection, not the files",
    sel1.assetId === child1.id &&
      sel2.assetId === child2.id &&
      (await owner.listProjectDeliveries(projectId)).filter((d) => d.attemptId === attemptId).length === 1 &&
      (await owner.listAttemptDerivations(attemptId)).length === 2,
  );
  check(
    "a selected delivery master pins its asset",
    (await owner.assetPins(child2.id)).join(" ").includes("delivery master"),
  );

  // ── continuity runs ──
  const runSeed = {
    projectId,
    attemptId,
    subjectAssetId: child2.id,
    originalAssetId: original.id,
    analyzer: "mock-continuity",
    analyzerVersion: "1",
    analyzerKind: "mock" as const,
    rulesVersion: "2c.1",
    analysisStatus: "queued" as const,
    packageFingerprint: "p".repeat(64),
    subjectFingerprint: "s".repeat(64),
    criteriaFingerprint: "c".repeat(64),
    referenceFingerprint: "r".repeat(64),
    referenceSet: { items: [] },
    createdBy: dev.id,
    now: new Date().toISOString(),
  };
  const finding = (key: string, over: Record<string, unknown> = {}) => ({
    criterionKey: key,
    category: "wardrobe" as const,
    severity: "critical" as const,
    title: key,
    sourceRef: "Look",
    expected: "black dress",
    actual: "",
    result: "unchecked" as const,
    resultSource: "none" as const,
    confidence: null,
    notes: "",
    evidence: {},
    position: 0,
    ...over,
  });
  const run1 = await owner.createRun(runSeed, [
    finding("wardrobe:a"),
    finding("duration", {
      category: "duration",
      severity: "major",
      result: "pass",
      resultSource: "deterministic",
      position: 1,
    }),
  ]);
  check(
    "a run is created with numbered, ordered findings",
    run1.run.runNumber === 1 && run1.findings.length === 2,
  );
  const run2 = await owner.createRun(runSeed, [finding("wardrobe:a")]);
  check(
    "re-running creates run 2; run 1 is untouched",
    run2.run.runNumber === 2 && (await owner.getRun(run1.run.id))!.findings.length === 2,
  );

  await owner.setAnalysisStatus(run1.run.id, "running", new Date().toISOString());
  await owner.applyAnalysis(run1.run.id, [
    {
      criterionKey: "wardrobe:a",
      result: "warn",
      actual: "MOCK",
      confidence: 0.7,
      notes: "MOCK ANALYSIS",
      evidence: {},
    },
  ]);
  const analysed = (await owner.getRun(run1.run.id))!.findings.find(
    (f) => f.finding.criterionKey === "wardrobe:a",
  )!;
  check(
    "analyzer results are written while the run is analysing",
    analysed.finding.result === "warn" && analysed.finding.resultSource === "analyzer",
  );
  await owner.setAnalysisStatus(run1.run.id, "complete", new Date().toISOString());
  let closedErr = "";
  try {
    await owner.applyAnalysis(run1.run.id, [
      { criterionKey: "wardrobe:a", result: "pass", actual: "", confidence: null, notes: "", evidence: {} },
    ]);
  } catch (e) {
    closedErr = e instanceof MediaQaError ? e.code : String(e);
  }
  check("a completed run cannot be re-analysed (frozen snapshot)", closedErr === "run_closed", closedErr);
  check(
    "the database also refuses to rewrite a completed run's finding result",
    /completed run|override/.test(
      await sqlError("update continuity_findings set result = 'pass' where id = $1", [analysed.finding.id]),
    ),
  );
  check(
    "expected values / criteria of a finding are frozen",
    /frozen/.test(
      await sqlError("update continuity_findings set expected = 'red dress' where id = $1", [
        analysed.finding.id,
      ]),
    ),
  );
  check(
    "a run's subject and fingerprints are frozen",
    /frozen snapshot/.test(
      await sqlError("update continuity_runs set subject_fingerprint = 'x' where id = $1", [run1.run.id]),
    ),
  );

  const o1 = await owner.addOverride({
    runId: run1.run.id,
    findingId: analysed.finding.id,
    result: "fail",
    notes: "dress is red",
    createdBy: dev.id,
    now: "2026-10-12T10:00:00.000Z",
  });
  await owner.addOverride({
    runId: run1.run.id,
    findingId: analysed.finding.id,
    result: "pass",
    notes: "re-checked: it is black",
    createdBy: dev.id,
    now: "2026-10-12T11:00:00.000Z",
  });
  const withOverrides = (await owner.getRun(run1.run.id))!.findings.find(
    (f) => f.finding.id === analysed.finding.id,
  )!;
  check(
    "human overrides are appended (newest first) and the system result is untouched",
    withOverrides.overrides.length === 2 &&
      withOverrides.overrides[0]!.result === "pass" &&
      withOverrides.finding.result === "warn",
  );
  check(
    "an override is append-only",
    /append-only/.test(
      await sqlError("update continuity_overrides set result = 'fail' where id = $1", [o1.id]),
    ),
  );
  const fin = await owner.finalizeRun(run1.run.id, {
    by: dev.id,
    note: "accepted",
    now: new Date().toISOString(),
  });
  check(
    "a person closes the review: finalized_at / finalized_by / note recorded",
    Boolean(fin?.finalizedAt) && fin?.finalizeNote === "accepted",
  );
  let earlyErr = "";
  try {
    await owner.finalizeRun(run2.run.id, { by: dev.id, note: "", now: new Date().toISOString() });
  } catch (e) {
    earlyErr = e instanceof MediaQaError ? e.code : String(e);
  }
  check("a run still being analysed cannot be closed", earlyErr === "run_in_progress", earlyErr);
  check(
    "latest run per attempt for the dashboard",
    (await owner.listLatestProjectRuns(projectId)).filter((r) => r.run.attemptId === attemptId).length ===
      1 &&
      (await owner.listLatestProjectRuns(projectId)).find((r) => r.run.attemptId === attemptId)!.run
        .runNumber === 2,
  );

  // ── RLS ──
  check("stranger cannot read the derivation", (await other.findDerivationByKey(projectId, key)) === null);
  check("stranger cannot read the delivery selection", (await other.getDelivery(attemptId)) === null);
  check(
    "stranger cannot read runs",
    (await other.getRun(run1.run.id)) === null && (await other.listAttemptRuns(attemptId)).length === 0,
  );
  check(
    "anon cannot read runs or derivations",
    (await anon.listAttemptRuns(attemptId)).length === 0 &&
      (await anon.listAttemptDerivations(attemptId)).length === 0,
  );
  let strangerWrite = "";
  try {
    await other.addOverride({
      runId: run1.run.id,
      findingId: analysed.finding.id,
      result: "pass",
      notes: "",
      createdBy: stranger,
      now: new Date().toISOString(),
    });
  } catch (e) {
    strangerWrite = (e as Error).message;
  }
  check("stranger cannot add an override", strangerWrite !== "", strangerWrite);
  let strangerDerive = "";
  try {
    await other.recordDerivation({
      asset: mkAsset("evil.mp4") as never,
      parentAssetId: original.id,
      operation: "crop",
      derivationKey: "e".repeat(64),
      parameters: {},
      processor: "x",
      processorVersion: "1",
      attemptId,
      slot: "",
      createdBy: stranger,
      now: new Date().toISOString(),
    });
  } catch (e) {
    strangerDerive = (e as Error).message;
  }
  check(
    "stranger cannot record a derivation in someone else's project",
    strangerDerive !== "",
    strangerDerive,
  );

  // ── worker role: least privilege ──
  const workerUrl = process.env.PRISM_STUDIO_WORKER_DB_URL;
  if (workerUrl) {
    const wp = new pg.Pool({ connectionString: workerUrl, ssl: { rejectUnauthorized: false }, max: 1 });
    try {
      for (const t of [
        "asset_derivations",
        "attempt_deliveries",
        "continuity_runs",
        "continuity_findings",
        "continuity_overrides",
      ]) {
        const r = await wp.query(`select 1 from ${t} limit 1`).then(
          () => "allowed",
          (e: Error) => e.message,
        );
        check(`worker role has no access to ${t}`, /permission denied/.test(r), r);
      }
    } finally {
      await wp.end();
    }
  } else {
    check("worker role check skipped (PRISM_STUDIO_WORKER_DB_URL not set)", true);
  }

  // ── cascade ──
  await pool.query("delete from generation_attempts where id = $1", [attemptId]);
  const left = await pool.query(
    `select (select count(*) from continuity_runs where attempt_id = $1)::int as runs,
            (select count(*) from asset_derivations where attempt_id = $1)::int as derivs,
            (select count(*) from attempt_deliveries where attempt_id = $1)::int as deliveries,
            (select count(*) from continuity_findings where project_id = $2 and run_id in ($3, $4))::int as findings`,
    [attemptId, projectId, run1.run.id, run2.run.id],
  );
  check(
    "deleting an attempt cascades runs, findings, overrides, derivations and delivery selection",
    left.rows[0].runs === 0 &&
      left.rows[0].derivs === 0 &&
      left.rows[0].deliveries === 0 &&
      left.rows[0].findings === 0,
    JSON.stringify(left.rows[0]),
  );
} finally {
  await pool.query("delete from generation_attempts where id = $1", [attemptId]).catch(() => undefined);
  // children first (derived), then the original
  const ordered = [...assetIds].reverse();
  for (const id of ordered) await pool.query("delete from assets where id = $1", [id]).catch(() => undefined);
  const leftover = await pool.query("select count(*)::int n from assets where id = any($1::uuid[])", [
    assetIds,
  ]);
  check("cleanup: no test assets remain", leftover.rows[0].n === 0);
  await pool.end();
}

let failed = 0;
for (const [name, ok, detail] of results) {
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : `  → ${detail}`}`);
}
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);

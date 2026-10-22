// Integration tests for Phase 2G.2 (Image Shot Generator) against the REAL dedicated Prism Studio database. NO migration
// (0039 already anticipated `generation_output`).
//   npm run db:image-shot-generator
//
// Exercises (with real rows, cleaned up afterwards): a Production Frame candidate set of still images through the real
// queue and worker store (MockProvider only: REAL IMAGE-MODEL CALLS 0, PAID CALLS 0), the purpose frozen on the immutable
// request, the Shot untouched by generating, "Use as Production Frame" from a generated attempt (existing Asset reused,
// versions, duplicate, re-selection), the stale-candidate refusal, the production conform for a provider canvas that is not
// the Shot's aspect, and owner-only RLS (a stranger can neither see nor use another user's candidate).
// Requires `npm run db:seed` first (uses the demo project's shot 3A, temporarily set to 16:9 and restored).
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import pg from "pg";
import { PostgresCandidateData } from "../src/data/candidates-postgres";
import { PostgresGenerationData } from "../src/data/generation-postgres";
import { PostgresMediaQaData } from "../src/data/media-qa-postgres";
import { AdminRepository, rlsPreamble } from "../src/data/postgres-repository";
import { PostgresProductionFrameData } from "../src/data/production-frame-postgres";
import { buildShotContext } from "../src/domain/context";
import { parseAdaptationPlan } from "../src/domain/framing/adaptation";
import { candidateSetPurpose } from "../src/domain/generation/candidates";
import { ofPurpose } from "../src/domain/generation/performance";
import type { ProjectData } from "../src/domain/schemas";
import { submitCandidateSet, type CandidateSelection } from "../src/generation/candidate-set";
import { readGenerationConfig } from "../src/generation/config";
import { silentLogger } from "../src/generation/log";
import { createRegistry } from "../src/generation/registry";
import { LocalDiskSink } from "../src/generation/sink";
import { GenerationWorker } from "../src/generation/worker";
import { conformAttemptOutput } from "../src/media/delivery";
import { FfmpegMediaProcessor } from "../src/media/ffmpeg";
import { GeneratedFrameRefused, promoteGeneratedFrame } from "../src/server/production-frame-generated";
import { assertDevUserExists, readDevUserEnv } from "./lib/dev-user.mjs";
import { startScript } from "./lib/safety.mjs";

const dev = readDevUserEnv();
startScript({
  mode: "image shot generator integration tests (rows created, then removed)",
  devOwner: dev.id,
});
const pool = new pg.Pool({ connectionString: dev.url, ssl: { rejectUnauthorized: false }, max: 8 });
await assertDevUserExists(pool, dev);

const results: Array<[string, boolean, string]> = [];
const check = (name: string, ok: boolean, detail = "") => results.push([name, ok, detail]);
const stranger = randomUUID();
const nowIso = () => new Date().toISOString();

const env = {
  NODE_ENV: "test",
  PRISM_STUDIO_MOCK_STAGE_DELAY_MS: "0",
  PRISM_STUDIO_GENERATION_MAX_ACTIVE_PER_PROJECT: "10",
  PRISM_STUDIO_MAX_CANDIDATES_PER_SET: "6",
};
const config = readGenerationConfig(env);
const registry = createRegistry(env, config);
const admin = new AdminRepository(pool, dev.id);
const ownerGen = new PostgresGenerationData(pool, rlsPreamble({ sub: dev.id }));
const strangerGen = new PostgresGenerationData(pool, rlsPreamble({ sub: stranger }));
const adminGen = new PostgresGenerationData(pool, "begin");
const ownerCand = new PostgresCandidateData(pool, rlsPreamble({ sub: dev.id }));
const ownerFrames = new PostgresProductionFrameData(pool, rlsPreamble({ sub: dev.id }));
const strangerFrames = new PostgresProductionFrameData(pool, rlsPreamble({ sub: stranger }));
const ownerQa = new PostgresMediaQaData(pool, rlsPreamble({ sub: dev.id }));
const strangerQa = new PostgresMediaQaData(pool, rlsPreamble({ sub: stranger }));
const processor = new FfmpegMediaProcessor({ limits: { timeoutMs: 60_000 } });
const ffmpeg = await processor.available();

const sinkRoot = mkdtempSync(path.join(tmpdir(), "prism-dbimg-"));
const sink = new LocalDiskSink(sinkRoot);
const createdAttemptIds: string[] = [];
const createdSetIds: string[] = [];
const mock = (modelId: string): CandidateSelection => ({ provider: "mock", modelId });

async function runWorker() {
  const offset = { ms: 0 };
  const worker = new GenerationWorker({
    store: adminGen,
    registry,
    sink,
    config,
    logger: silentLogger,
    clock: () => new Date(Date.now() + offset.ms),
    workerId: "db-image-shot-generator",
    retryPolicy: { baseDelayMs: 50, maxDelayMs: 200, jitter: 0 },
    heartbeatMs: 0,
  });
  for (let i = 0; i < 24; i++) {
    const st = await pool.query(
      "select count(*)::int n from generation_jobs where attempt_id = any($1::uuid[]) and status not in ('succeeded','failed','cancelled')",
      [createdAttemptIds],
    );
    if (st.rows[0].n === 0) break;
    await worker.tick(10);
    offset.ms += 1500;
  }
}

/** The project as the server loaders see it: the repository data plus the Production Frame attachments. */
async function load(): Promise<ProjectData> {
  const data = (await admin.loadProject("ojousama"))!;
  const { frames, selections } = await ownerFrames.listForProject(data.project.id);
  return { ...data, productionFrames: frames, productionFrameSelections: selections };
}
const ctxOf = async (shotId: string) => buildShotContext(await load(), shotId);
const deps = { frames: ownerFrames, generation: ownerGen, qa: ownerQa };
const refusal = (p: Promise<unknown>) =>
  p.then(
    () => null,
    (e: unknown) => (e instanceof GeneratedFrameRefused ? e.code : `other:${(e as Error).message}`),
  );

let originalShot: ProjectData["shots"][number] | null = null;
let projectId = "";

try {
  const data0 = (await admin.loadProject("ojousama"))!;
  projectId = data0.project.id;
  const shot0 = data0.shots.find((s) => s.shotCode === "3A")!;
  originalShot = structuredClone(shot0);
  const shotId = shot0.id;
  const modalityBefore = (
    await pool.query("select generation->>'modality' m from shots where id = $1", [shotId])
  ).rows[0].m as string;
  const startBefore = (
    await pool.query("select generation->>'startFrameAssetId' s from shots where id = $1", [shotId])
  ).rows[0].s as string | null;

  // a 16:9 production frame so the free image models are native (restored in `finally`)
  await admin.upsert(projectId, "shots", {
    ...shot0,
    composition: { ...shot0.composition, aspectRatio: "16:9" },
    updatedAt: new Date(Date.now() - 2000).toISOString(),
  });
  const revision = (await ownerGen.projectRevision("ojousama"))!;
  // the EXACT Shot row (every column) before generating: compared again after the candidates exist
  const shotRow = async () =>
    JSON.stringify(
      (await pool.query("select row_to_json(s) r from shots s where id = $1", [shotId])).rows[0].r,
    );
  const shotRowBefore = await shotRow();
  const assetsBefore = (
    await pool.query("select count(*)::int n from assets where project_id = $1", [projectId])
  ).rows[0].n as number;

  // ── 1. a Production Frame candidate set through the real queue ──
  const out = await submitCandidateSet({
    data: (await admin.loadProject("ojousama"))!,
    shotId,
    registry,
    config,
    generation: ownerGen,
    candidates: ownerCand,
    selections: [mock("mock-image-1"), mock("mock-image-lite"), mock("mock-image-wide")],
    acknowledgeAll: true,
    confirmedTotalUsd: null,
    title: "db:image-shot-generator",
    purpose: "integration test",
    userId: dev.id,
    projectRevision: revision.revision,
    generationPurpose: "production_frame",
  });
  createdSetIds.push(out.view.set.id);
  for (const m of out.view.members) if (m.attemptId) createdAttemptIds.push(m.attemptId);
  check(
    "three still-image candidates were submitted, none failed",
    out.submitted === 3 && out.failed.length === 0,
    JSON.stringify(out.failed),
  );
  const frozen = await pool.query(
    `select request->>'purpose' purpose, request_modality, modality, (model_settings->>'purpose') ms_purpose, approved
       from generation_attempts where id = any($1::uuid[])`,
    [createdAttemptIds],
  );
  check(
    "the purpose is frozen on every immutable request (and in model settings); the request modality is a still",
    frozen.rows.length === 3 &&
      frozen.rows.every((r) => r.purpose === "production_frame" && r.ms_purpose === "production_frame") &&
      frozen.rows.every(
        (r) => r.request_modality === "text_to_image" || r.request_modality === "image_to_image",
      ),
    JSON.stringify(frozen.rows[0]),
  );
  check(
    "the Shot's own modality is NOT the request modality and no attempt is approved",
    frozen.rows.every((r) => r.modality === modalityBefore && r.approved === false),
  );
  check(
    "the set carries the machine-readable purpose (no schema change)",
    candidateSetPurpose(out.view.set) === "production_frame",
  );
  check(
    "one job per candidate attempt",
    (
      await pool.query("select count(*)::int n from generation_jobs where attempt_id = any($1::uuid[])", [
        createdAttemptIds,
      ])
    ).rows[0].n === 3,
  );
  const req = await pool.query(
    "select request->'providerOptions' po, jsonb_array_length(request->'references') refs from generation_attempts where id = $1",
    [createdAttemptIds[0]],
  );
  check(
    "a Shot with no stored reference images is text-to-image (no placeholder asset sent)",
    req.rows[0].refs === 0,
  );

  await runWorker();
  const done = await pool.query("select status from generation_attempts where id = any($1::uuid[])", [
    createdAttemptIds,
  ]);
  check(
    "all three candidates completed independently",
    done.rows.every((r) => r.status === "succeeded"),
  );
  const outputs = await pool.query(
    `select o.attempt_id, a.id asset_id, a.type, a.purpose, a.source
       from generation_outputs o join assets a on a.id = o.asset_id
      where o.attempt_id = any($1::uuid[])`,
    [createdAttemptIds],
  );
  check(
    "each candidate produced exactly one private still image (generation_output / provider_output)",
    outputs.rows.length === 3 &&
      outputs.rows.every(
        (r) => r.type === "image" && r.purpose === "generation_output" && r.source === "provider_output",
      ),
  );
  check(
    "the exact Shot row is unchanged by generating candidates (every column)",
    (await shotRow()) === shotRowBefore,
  );
  check(
    "generating candidates did not touch the Shot: modality and start-frame override unchanged, no frame selected",
    (
      await pool.query(
        "select generation->>'modality' m, generation->>'startFrameAssetId' s from shots where id = $1",
        [shotId],
      )
    ).rows.every((r) => r.m === modalityBefore && (r.s ?? null) === (startBefore ?? null)) &&
      (await ctxOf(shotId)).selectedProductionFrame === null,
  );

  // ── 2. image history is separate from video history ──
  const outcomes = await ownerCand.listOutcomeRecords(projectId);
  const mine = outcomes.filter((o) => createdAttemptIds.includes(o.attemptId));
  check(
    "outcome records of the image candidates carry purpose production_frame and are excluded from the video purpose",
    mine.length === 3 &&
      mine.every((o) => o.purpose === "production_frame") &&
      ofPurpose(outcomes, "shot_output").every((o) => !createdAttemptIds.includes(o.attemptId)),
  );

  // ── 3. Use as Production Frame ──
  const [a, b, c] = createdAttemptIds as [string, string, string];
  const attemptOf = async (id: string) => (await ownerGen.getAttemptView(id))!;
  const attemptOfModel = async (model: string) => {
    for (const id of createdAttemptIds) if ((await attemptOf(id)).attempt.model === model) return id;
    throw new Error(`no attempt for ${model}`);
  };
  const aId = await attemptOfModel("mock-image-1");
  const bId = await attemptOfModel("mock-image-lite");
  const cId = await attemptOfModel("mock-image-wide");
  void a;
  void b;
  void c;
  const attemptRowBefore = JSON.stringify(
    (await pool.query("select * from generation_attempts where id = $1", [aId])).rows[0],
  );

  const v1 = await promoteGeneratedFrame(deps, await ctxOf(shotId), { attemptId: aId, userId: dev.id });
  check(
    "a native-aspect provider original is promoted directly: v1, generation_output, the attempt id",
    v1.created &&
      v1.frame.version === 1 &&
      v1.frame.source === "generation_output" &&
      v1.frame.sourceGenerationAttemptId === aId &&
      v1.image === "provider_original",
  );
  const aAsset = (await attemptOf(aId)).outputs[0]!.asset;
  check(
    "the attempt's EXISTING Asset is reused: no duplicate Asset, no copied bytes",
    v1.frame.assetId === aAsset.id &&
      (await pool.query("select count(*)::int n from assets where project_id = $1", [projectId])).rows[0]
        .n ===
        assetsBefore + 3,
  );
  check(
    "it is the one canonical selection; the Shot's start-frame override was never written",
    (await ctxOf(shotId)).selectedProductionFrame?.id === v1.frame.id &&
      ((await pool.query("select generation->>'startFrameAssetId' s from shots where id = $1", [shotId]))
        .rows[0].s ?? null) === (startBefore ?? null),
  );
  check(
    "the attempt itself was never mutated (and attempt.approved is not the canonical pointer)",
    JSON.stringify((await pool.query("select * from generation_attempts where id = $1", [aId])).rows[0]) ===
      attemptRowBefore,
  );

  const v2 = await promoteGeneratedFrame(deps, await ctxOf(shotId), { attemptId: bId, userId: dev.id });
  check(
    "choosing candidate B makes v2 canonical; v1 is immutable history",
    v2.created && v2.frame.version === 2 && (await ctxOf(shotId)).selectedProductionFrame?.id === v2.frame.id,
  );
  const v1Row = (await pool.query("select * from shot_production_frames where id = $1", [v1.frame.id]))
    .rows[0];
  await ownerFrames.select({
    projectId,
    shotId,
    productionFrameId: v1.frame.id,
    userId: dev.id,
    now: nowIso(),
  });
  check(
    "switching back to v1 works without touching any attempt; v1's row is unchanged",
    (await ctxOf(shotId)).selectedProductionFrame?.id === v1.frame.id &&
      JSON.stringify(
        (await pool.query("select * from shot_production_frames where id = $1", [v1.frame.id])).rows[0],
      ) === JSON.stringify(v1Row),
  );
  const again = await promoteGeneratedFrame(deps, await ctxOf(shotId), { attemptId: aId, userId: dev.id });
  check(
    "using the same candidate twice returns the existing frame (no duplicate version, no duplicate Asset)",
    !again.created && again.frame.id === v1.frame.id && (await ctxOf(shotId)).productionFrames.length === 2,
  );

  // ── 4. the provider canvas is not the production frame: refused until the conform exists ──
  const wide = await refusal(
    promoteGeneratedFrame(deps, await ctxOf(shotId), { attemptId: cId, userId: dev.id }),
  );
  check(
    "a wrong-shaped provider original (21:9 canvas, 16:9 frame) is refused: 'Create the production conform first.'",
    wide === "needs_conform",
    String(wide),
  );
  if (ffmpeg) {
    const view = await attemptOf(cId);
    const plan = parseAdaptationPlan(view.attempt.adaptationPlan);
    check("the candidate recorded its explicit adaptation plan", plan != null);
    const conformed = await conformAttemptOutput({
      attemptId: cId,
      attemptLabel: "dbimg-c",
      original: view.outputs[0]!.asset,
      plan: plan!.conform,
      deps: { processor, storage: sink, qa: ownerQa, userId: dev.id },
    });
    const ratioOk =
      Math.abs(conformed.deliveryAsset.width! / conformed.deliveryAsset.height! / (16 / 9) - 1) < 0.01;
    check("the deterministic delivery conform is production-shaped", conformed.derived != null && ratioOk);
    const v3 = await promoteGeneratedFrame(deps, await ctxOf(shotId), { attemptId: cId, userId: dev.id });
    check(
      "now the CONFORM becomes the Production Frame; the provider original stays untouched history",
      v3.created &&
        v3.image === "delivery_conform" &&
        v3.frame.assetId === conformed.deliveryAsset.id &&
        v3.frame.version === 3,
    );
  } else {
    check("ffmpeg not installed: the conform step is covered by the unit suite (skipped here)", true);
  }

  // ── 5. the stale-candidate rule ──
  await admin.upsert(projectId, "shots", {
    ...(await admin.loadProject("ojousama"))!.shots.find((s) => s.id === shotId)!,
    composition: { ...shot0.composition, aspectRatio: "16:9", lens: "135mm" },
    updatedAt: nowIso(),
  });
  const staleBefore = JSON.stringify(
    (await pool.query("select * from generation_attempts where id = $1", [bId])).rows[0],
  );
  const framesBefore = (await ctxOf(shotId)).productionFrames.length;
  const stale = await refusal(
    promoteGeneratedFrame(deps, await ctxOf(shotId), { attemptId: bId, userId: dev.id }),
  );
  check(
    "after the Shot changed, a candidate is refused as stale and nothing is created",
    stale === "stale" && (await ctxOf(shotId)).productionFrames.length === framesBefore,
    String(stale),
  );
  check(
    "the stale candidate stays valid history (the attempt row is unchanged)",
    JSON.stringify((await pool.query("select * from generation_attempts where id = $1", [bId])).rows[0]) ===
      staleBefore,
  );

  // ── 6. owner-only: another user can neither see nor use the candidate ──
  check("a stranger cannot read the attempt (RLS)", (await strangerGen.getAttemptView(aId)) === null);
  const strangerCtx = await ctxOf(shotId);
  const strangerResult = await refusal(
    promoteGeneratedFrame({ frames: strangerFrames, generation: strangerGen, qa: strangerQa }, strangerCtx, {
      attemptId: aId,
      userId: stranger,
    }),
  );
  check(
    "a stranger cannot use another user's candidate as a Production Frame",
    strangerResult === "no_attempt",
    String(strangerResult),
  );
  const reviewDirect = await pool.query(
    "select count(*)::int n from shot_production_frames where project_id = $1 and created_by = $2",
    [projectId, stranger],
  );
  check("…and no frame was created in the owner's project by anyone else", reviewDirect.rows[0].n === 0);
} finally {
  // restore the Shot exactly, then remove everything this run created (frames pin their Assets, so they go first)
  if (originalShot) {
    await admin.upsert(projectId, "shots", originalShot).catch(() => undefined);
  }
  if (createdAttemptIds.length) {
    await pool.query(
      `delete from shot_production_frame_selections where production_frame_id in
         (select id from shot_production_frames where source = 'generation_output' and source_generation_attempt_id = any($1::uuid[]))`,
      [createdAttemptIds],
    );
    await pool.query(
      "delete from shot_production_frames where source = 'generation_output' and source_generation_attempt_id = any($1::uuid[])",
      [createdAttemptIds],
    );
  }
  const derived = createdAttemptIds.length
    ? (
        await pool.query(
          "select child_asset_id id from asset_derivations where attempt_id = any($1::uuid[])",
          [createdAttemptIds],
        )
      ).rows.map((r) => String(r.id))
    : [];
  const outputAssets = createdAttemptIds.length
    ? (
        await pool.query("select asset_id id from generation_outputs where attempt_id = any($1::uuid[])", [
          createdAttemptIds,
        ])
      ).rows.map((r) => String(r.id))
    : [];
  if (createdSetIds.length)
    await pool.query("delete from generation_candidate_sets where id = any($1::uuid[])", [createdSetIds]);
  if (createdAttemptIds.length)
    await pool.query("delete from generation_attempts where id = any($1::uuid[])", [createdAttemptIds]);
  if (derived.length) await pool.query("delete from assets where id = any($1::uuid[])", [derived]);
  if (outputAssets.length) await pool.query("delete from assets where id = any($1::uuid[])", [outputAssets]);
  rmSync(sinkRoot, { recursive: true, force: true });
}

// cleanup is part of the contract
const left = await pool.query(
  `select (select count(*) from generation_candidate_sets where title like 'db:image-shot-generator%')::int sets,
          (select count(*) from generation_attempts where id = any($1::uuid[]))::int attempts,
          (select count(*) from shot_production_frames where source_generation_attempt_id = any($1::uuid[]))::int frames`,
  [createdAttemptIds],
);
check(
  "cleanup: no test sets, attempts or generated frames remain",
  left.rows[0].sets === 0 && left.rows[0].attempts === 0 && left.rows[0].frames === 0,
  JSON.stringify(left.rows[0]),
);
const shotNow = (
  await pool.query(
    "select composition->>'aspectRatio' ar, composition->>'lens' lens from shots where id = $1",
    [originalShot?.id],
  )
).rows[0];
check(
  "the demo Shot is restored exactly",
  shotNow?.ar === (originalShot?.composition.aspectRatio ?? null) &&
    (shotNow?.lens ?? null) === (originalShot?.composition.lens ?? null),
  JSON.stringify(shotNow),
);

let failed = 0;
for (const [name, ok, detail] of results) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail && !ok ? `  — ${detail}` : ""}`);
  if (!ok) failed++;
}
console.log(`\n${results.length - failed}/${results.length} passed`);
await pool.end();
process.exit(failed ? 1 : 0);

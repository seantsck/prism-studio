import pg from "pg";
import { AdminRepository } from "../src/data/postgres-repository";
import { PostgresGenerationData } from "../src/data/generation-postgres";
import { createRegistry } from "../src/generation/registry";
import { readGenerationConfig } from "../src/generation/config";
import { evaluateShotForModel, prepareSubmission } from "../src/generation/submission";

const url = process.env.SUPABASE_DB_URL;
if (!url) throw new Error("SUPABASE_DB_URL missing");
const pool = new pg.Pool({ connectionString: url, ssl: { rejectUnauthorized: false }, max: 3 });
const slug = "runway-smoke-test";
const key = "phase5b-live-runway-gen4-turbo-2s-20261109-v1";
try {
  const ownerQ = await pool.query("select user_id from projects where slug=$1 and purpose='benchmark' limit 1", [slug]);
  const owner = ownerQ.rows[0]?.user_id ? String(ownerQ.rows[0].user_id) : "";
  if (!owner) throw new Error("benchmark project not found");
  const admin = new AdminRepository(pool, owner);
  const gen = new PostgresGenerationData(pool, "begin");
  const rev = await gen.projectRevision(slug);
  if (!rev) throw new Error("benchmark project revision missing");
  const data = await admin.loadProject(slug);
  if (!data) throw new Error("benchmark project data missing");
  const shot = data.shots.find((s) => s.shotCode === "SMOKE-1");
  if (!shot) throw new Error("SMOKE-1 missing");
  if (shot.targetDurationMs !== 2000) throw new Error("SMOKE-1 must be exactly 2000ms");
  if (shot.composition.aspectRatio !== "16:9") throw new Error("SMOKE-1 must be 16:9");
  const active = await pool.query(
    `select count(*)::int n from generation_jobs
      where status in ('queued','submitting','submitted','processing','ingesting','cancel_requested')`
  );
  if (Number(active.rows[0]?.n ?? -1) !== 0) throw new Error("active generation jobs exist; refusing live smoke");

  const env = {
    ...process.env,
    PRISM_STUDIO_GENERATION_PROVIDERS: "runway",
    PRISM_STUDIO_WORKER_BACKED_PROVIDERS: "runway",
    PRISM_STUDIO_ALLOW_PAID_GENERATION: "true",
    PRISM_STUDIO_MAX_GENERATION_USD: "0.10",
    PRISM_STUDIO_MAX_CANDIDATE_SET_USD: "0.10",
    PRISM_STUDIO_MAX_CANDIDATES_PER_SET: "1",
  };
  const config = readGenerationConfig(env);
  const registry = createRegistry(env, config);
  const first = evaluateShotForModel({data,shotId:shot.id,registry,provider:"runway",modelId:"gen4_turbo"});
  const acknowledgements = first.compatibility?.ignoredFeatures.map((x)=>x.id) ?? [];
  const ev = evaluateShotForModel({
    data,shotId:shot.id,registry,provider:"runway",modelId:"gen4_turbo",acknowledged:acknowledgements
  });
  console.log("PREP=" + JSON.stringify({
    compatible:ev.compatibility?.compatible,
    modality:ev.compatibility?.modality,
    ignored:acknowledgements,
    estimate:ev.estimate,
    gateAllowed:ev.gate.allowed,
    blockers:ev.gate.blockers.map((b)=>({code:b.code,message:b.message}))
  }));
  if (!ev.gate.allowed) throw new Error("generation gate refused");
  if (ev.estimate?.currency !== "USD" || ev.estimate.amount !== 0.10) {
    throw new Error("expected exact $0.10 estimate, got " + JSON.stringify(ev.estimate));
  }
  const prepared = prepareSubmission({
    data,
    shotId:shot.id,
    registry,
    provider:"runway",
    modelId:"gen4_turbo",
    acknowledged:acknowledgements,
    userId:owner,
    idempotencyKey:key,
    config,
    projectRevision:rev.revision,
  });
  if (!prepared.input) throw new Error("prepareSubmission refused after gate passed");
  if (prepared.input.estimate.amount !== 0.10) throw new Error("prepared estimate changed");
  const created = await gen.createAttemptWithJob(prepared.input);
  console.log("QUEUED=" + JSON.stringify({
    duplicate:created.duplicate,
    attemptId:created.attempt.id,
    attemptNumber:created.attempt.attemptNumber,
    jobId:created.job.id,
    provider:created.job.provider,
    model:created.job.model,
    status:created.job.status,
    estimatedCost:created.job.estimatedCost
  }));
} finally {
  await pool.end();
}

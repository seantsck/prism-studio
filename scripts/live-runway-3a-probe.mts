import pg from "pg";
import { AdminRepository } from "../src/data/postgres-repository";
import { createRegistry } from "../src/generation/registry";
import { readGenerationConfig } from "../src/generation/config";
import { evaluateShotForModel } from "../src/generation/submission";
import { buildShotContext } from "../src/domain/context";
import { runPreflight } from "../src/domain/preflight";

const url = process.env.SUPABASE_DB_URL;
if (!url) throw new Error("SUPABASE_DB_URL missing");
const pool = new pg.Pool({ connectionString: url, ssl: { rejectUnauthorized: false }, max: 2 });
try {
  const owner = await pool.query("select user_id from projects where slug = 'ojousama' limit 1");
  if (!owner.rows[0]?.user_id) throw new Error("ojousama owner not found");
  const repo = new AdminRepository(pool, String(owner.rows[0].user_id));
  const data = await repo.loadProject("ojousama");
  if (!data) throw new Error("ojousama not found");
  const shot = data.shots.find((s) => s.shotCode === "3A");
  if (!shot) throw new Error("Shot 3A not found");
  const env = {
    ...process.env,
    PRISM_STUDIO_GENERATION_PROVIDERS: "runway",
    PRISM_STUDIO_WORKER_BACKED_PROVIDERS: "runway",
    PRISM_STUDIO_ALLOW_PAID_GENERATION: "true",
    PRISM_STUDIO_MAX_GENERATION_USD: "0.10",
  };
  const config = readGenerationConfig(env);
  const registry = createRegistry(env, config);
  const pre = runPreflight(buildShotContext(data, shot.id));
  console.log(JSON.stringify({
    shotId: shot.id,
    targetDurationMs: shot.targetDurationMs,
    aspectRatio: shot.composition.aspectRatio,
    modality: shot.generation.modality,
    approvedFrameAssetId: buildShotContext(data, shot.id).approvedFrame?.assetId ?? null,
    preflightReady: pre.ready,
    preflightBlockers: pre.blockers.map((b)=>b.ruleId),
  }));
  for (const purpose of ["shot_output","animate_production_frame"] as const) {
    const ev = evaluateShotForModel({
      data,
      shotId: shot.id,
      registry,
      provider: "runway",
      modelId: "gen4_turbo",
      purpose,
    });
    console.log(JSON.stringify({
      purpose,
      gateAllowed: ev.gate.allowed,
      blockers: ev.gate.blockers.map((b)=>({code:b.code,message:b.message})),
      unacknowledged: ev.gate.unacknowledged,
      compatibility: ev.compatibility ? {
        compatible: ev.compatibility.compatible,
        modality: ev.compatibility.modality,
        ignored: ev.compatibility.ignoredFeatures.map((x)=>x.id),
        adaptation: ev.compatibility.adaptation,
      } : null,
      estimate: ev.estimate,
      availability: ev.availability,
    }));
  }
} finally {
  await pool.end();
}

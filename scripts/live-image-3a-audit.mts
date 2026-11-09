import pg from "pg";
import { AdminRepository } from "../src/data/postgres-repository";
import { createRegistry } from "../src/generation/registry";
import { readGenerationConfig } from "../src/generation/config";
import { evaluateShotForModel } from "../src/generation/submission";
import { productionFrameInputs, fitProductionFrameToModel } from "../src/domain/generation/production-frame-inputs";

const url=process.env.SUPABASE_DB_URL;
if(!url) throw new Error("SUPABASE_DB_URL missing");
const pool=new pg.Pool({connectionString:url,ssl:{rejectUnauthorized:false},max:2});
try {
  const ownerQ=await pool.query("select user_id from projects where slug='ojousama' limit 1");
  const owner=String(ownerQ.rows[0]?.user_id??"");
  if(!owner) throw new Error("Ojou-sama owner not found");
  const repo=new AdminRepository(pool,owner);
  const data=await repo.loadProject("ojousama");
  if(!data) throw new Error("Ojou-sama not found");
  const shot=data.shots.find(s=>s.shotCode==="3A");
  if(!shot) throw new Error("Shot 3A not found");

  const env={
    ...process.env,
    PRISM_STUDIO_GENERATION_PROVIDERS:"openai-image",
    PRISM_STUDIO_WORKER_BACKED_PROVIDERS:"openai-image",
    PRISM_STUDIO_ALLOW_PAID_GENERATION:"false",
    PRISM_STUDIO_MAX_GENERATION_USD:"0.50",
  };
  const config=readGenerationConfig(env);
  const registry=createRegistry(env,config);
  const model=registry.model("openai-image","gpt-image-2.5-flare");
  if(!model) throw new Error("GPT Image 2.5 Flare is not in Prism registry");

  const ev=evaluateShotForModel({
    data,
    shotId:shot.id,
    registry,
    provider:"openai-image",
    modelId:"gpt-image-2.5-flare",
    purpose:"production_frame",
  });
  const inputs=productionFrameInputs(ev.pkg);
  const fit=fitProductionFrameToModel(ev.pkg,model);

  console.log("IMAGE_3A_AUDIT="+JSON.stringify({
    shot:{id:shot.id,code:shot.shotCode,aspectRatio:shot.composition.aspectRatio,targetDurationMs:shot.targetDurationMs},
    ready:inputs.ready,
    essentialCount:inputs.essentialCount,
    references:inputs.references.map(r=>({assetId:r.assetId,label:r.label,role:r.role,tier:r.tier})),
    model:{
      provider:model.provider,modelId:model.modelId,displayName:model.displayName,
      maxReferences:model.capabilities.references.maxReferences,
      fitRefusal:fit.refusal,
      sent:fit.sent.map(r=>({label:r.label,role:r.role,tier:r.tier,assetId:r.assetId})),
      omitted:fit.omitted.map(r=>({label:r.label,tier:r.tier,assetId:r.assetId})),
    },
    compatibility:ev.compatibility?{
      compatible:ev.compatibility.compatible,
      modality:ev.compatibility.modality,
      ignored:ev.compatibility.ignoredFeatures.map(x=>({id:x.id,label:x.label,impact:x.impact})),
      errors:ev.compatibility.errors,
    }:null,
    estimate:ev.estimate,
    availability:ev.availability,
    gate:{
      allowed:ev.gate.allowed,
      blockers:ev.gate.blockers.map(b=>({code:b.code,message:b.message})),
      unacknowledged:ev.gate.unacknowledged.map(x=>({id:x.id,label:x.label,impact:x.impact}))
    }
  }));
} finally { await pool.end(); }

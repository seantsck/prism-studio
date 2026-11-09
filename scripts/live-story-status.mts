import pg from "pg";
const url=process.env.SUPABASE_DB_URL;
if(!url) throw new Error("SUPABASE_DB_URL missing");
const pool=new pg.Pool({connectionString:url,ssl:{rejectUnauthorized:false},max:2});
try {
  const id="aca5ce82-c39a-49ce-ab0a-ef1e06e55d3a";
  const q=await pool.query(`
    select id,status,provider,model,estimate,confirmed_usd,spend_authorization,
           usage,actual_usd,provider_calls,error,result,completed_at,
           accepted_alternative,accepted_revision_id,decided_at
      from writing_proposals where id=$1
  `,[id]);
  const r=q.rows[0]||null;
  if(!r) throw new Error("Story acceptance proposal not found");
  const episode=await pool.query(`
    select e.id,e.script_text
      from episodes e
      join writing_proposals w on w.episode_id=e.id
     where w.id=$1
  `,[id]);
  console.log("STORY_ACCEPTANCE_STATUS="+JSON.stringify({
    id:r.id,
    status:r.status,
    provider:r.provider,
    model:r.model,
    estimate:r.estimate,
    confirmedUsd:r.confirmed_usd,
    spendAuthorization:r.spend_authorization,
    usage:r.usage,
    actualUsd:r.actual_usd,
    providerCalls:r.provider_calls,
    error:r.error,
    result:r.result ? {
      message:r.result.message,
      alternativeCount:Array.isArray(r.result.alternatives)?r.result.alternatives.length:0,
      firstLabel:r.result.alternatives?.[0]?.label??null,
      firstTextPreview:String(r.result.alternatives?.[0]?.text??"").slice(0,240)
    }:null,
    completedAt:r.completed_at,
    acceptedAlternative:r.accepted_alternative,
    acceptedRevisionId:r.accepted_revision_id,
    decidedAt:r.decided_at,
    canonicalScriptStillPresent:Boolean(episode.rows[0]?.script_text)
  }));
} finally { await pool.end(); }

import pg from "pg";
const url=process.env.SUPABASE_DB_URL;
if(!url) throw new Error("SUPABASE_DB_URL missing");
const pool=new pg.Pool({connectionString:url,ssl:{rejectUnauthorized:false},max:2});
try{
  const jobId="ec497898-3324-43d4-b109-d9be62bc72be";
  const attemptId="94d3b08c-f45c-48a3-b122-c5ba2481245a";
  const jq=await pool.query("select to_jsonb(g) j from generation_jobs g where id=$1",[jobId]);
  const aq=await pool.query("select to_jsonb(a) j from generation_attempts a where id=$1",[attemptId]);
  const j=jq.rows[0]?.j||null, a=aq.rows[0]?.j||null;
  const outputId=a?.output_asset_id||null;
  let asset=null;
  if(outputId){
    const x=await pool.query("select id,mime,byte_size,checksum,storage_provider,bucket,object_path from assets where id=$1",[outputId]);
    if(x.rows[0]) asset={id:x.rows[0].id,mime:x.rows[0].mime,byteSize:x.rows[0].byte_size,checksumPrefix:String(x.rows[0].checksum||"").slice(0,16),stored:Boolean(x.rows[0].bucket&&x.rows[0].object_path&&x.rows[0].storage_provider==="supabase")};
  }
  const oq=await pool.query("select count(*)::int n from generation_outputs where attempt_id=$1",[attemptId]);
  console.log("STATUS="+JSON.stringify({
    job:{
      id:j?.id,status:j?.status,provider:j?.provider,model:j?.model,
      providerJobIdSet:Boolean(j?.provider_job_id),providerJobId:j?.provider_job_id||null,
      estimatedCost:j?.estimated_cost,actualCost:j?.actual_cost,
      errorCode:j?.error_code||null,errorMessage:j?.error_message||null,
      leaseOwnerSet:Boolean(j?.lease_owner),finishedAt:j?.finished_at||null
    },
    attempt:{
      status:a?.status,costUsd:a?.cost_usd,outputAssetId:a?.output_asset_id||null,durationMs:a?.duration_ms
    },
    outputRows:Number(oq.rows[0]?.n||0),
    asset
  }));
}finally{await pool.end();}

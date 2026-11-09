import pg from "pg";
const url=process.env.SUPABASE_DB_URL;
if(!url) throw new Error("SUPABASE_DB_URL missing");
const pool=new pg.Pool({connectionString:url,ssl:{rejectUnauthorized:false},max:2});
try{
  const attemptId="fe9e0a8c-a627-489a-971b-5be956adb502";
  const a=await pool.query(`
    select id,project_id,character_id,location_id,provider,model,modality,status,
           attempt_number,prompt,model_settings,input_asset_ids,output_asset_id,
           approved,created_at
    from generation_attempts where id=$1
  `,[attemptId]);
  const j=await pool.query(`
    select id,status,provider,model,provider_job_id,provider_status,idempotency_key,
           attempt_count,max_attempts,poll_count,submitted_at,started_at,completed_at,failed_at,
           last_error_code,last_error_category,last_error_message,estimated_cost,actual_cost,currency,
           created_at,updated_at
    from generation_jobs where attempt_id=$1 order by created_at
  `,[attemptId]);
  const ev=await pool.query(`
    select at,from_status,to_status,note
    from generation_job_events where attempt_id=$1 order by at
  `,[attemptId]);
  const costs=await pool.query(`
    select kind,amount,currency,basis,units,recorded_at
    from generation_costs where attempt_id=$1 order by recorded_at
  `,[attemptId]);
  const outs=await pool.query(`
    select role,position,asset_id,provenance,created_at
    from generation_outputs where attempt_id=$1 order by position
  `,[attemptId]);
  console.log("IMAGE_FAILURE_AUDIT="+JSON.stringify({
    attempt:a.rows[0]??null,
    jobs:j.rows,
    events:ev.rows,
    costs:costs.rows,
    outputs:outs.rows
  }));
}finally{await pool.end();}

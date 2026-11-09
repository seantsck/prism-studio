import pg from "pg";
const url=process.env.SUPABASE_DB_URL;
if(!url) throw new Error("SUPABASE_DB_URL missing");
const pool=new pg.Pool({connectionString:url,ssl:{rejectUnauthorized:false},max:2});
try{
  const attemptId="fe9e0a8c-a627-489a-971b-5be956adb502";
  const j=await pool.query(`
    select id,status,provider_job_id,provider_status,attempt_count,poll_count,
           submitted_at,started_at,failed_at,last_error_code,last_error_category,
           last_error_message,estimated_cost,actual_cost
    from generation_jobs where attempt_id=$1 order by created_at
  `,[attemptId]);
  const ev=await pool.query(`
    select at,from_status,to_status,note
    from generation_job_events where attempt_id=$1 order by at
  `,[attemptId]);
  const costs=await pool.query(`
    select kind,amount,basis,units,recorded_at
    from generation_costs where attempt_id=$1 order by recorded_at
  `,[attemptId]);
  const outs=await pool.query(`select count(*)::int as n from generation_outputs where attempt_id=$1`,[attemptId]);
  console.log("IMAGE_FAILURE_SUMMARY="+JSON.stringify({
    job:j.rows[0]??null,
    events:ev.rows,
    costs:costs.rows,
    outputCount:outs.rows[0]?.n??0
  }));
}finally{await pool.end();}

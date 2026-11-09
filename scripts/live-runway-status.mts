import pg from "pg";
const url=process.env.SUPABASE_DB_URL;
if(!url) throw new Error("SUPABASE_DB_URL missing");
const pool=new pg.Pool({connectionString:url,ssl:{rejectUnauthorized:false},max:2});
try{
  const jobId="ec497898-3324-43d4-b109-d9be62bc72be";
  const attemptId="94d3b08c-f45c-48a3-b122-c5ba2481245a";
  const jq=await pool.query(
    `select id,status,provider,model,provider_job_id,provider_status,attempt_count,poll_count,
            submitted_at,started_at,completed_at,failed_at,last_polled_at,
            last_error_code,last_error_category,last_error_message,
            estimated_cost,actual_cost,currency,lease_owner
       from generation_jobs where id=$1`,[jobId]
  );
  const aq=await pool.query(
    `select id,status,cost_usd,output_asset_id,duration_ms,provider,model
       from generation_attempts where id=$1`,[attemptId]
  );
  const ev=await pool.query(
    `select at,from_status,to_status,note
       from generation_job_events where job_id=$1 order by at,id`,[jobId]
  );
  const costs=await pool.query(
    `select kind,amount,currency,basis,units,recorded_at
       from generation_costs where job_id=$1 order by recorded_at,id`,[jobId]
  );
  const j=jq.rows[0]||null, a=aq.rows[0]||null;
  console.log("FAILURE_DETAIL="+JSON.stringify({
    job:j,
    attempt:a,
    events:ev.rows,
    costs:costs.rows
  }));
} finally { await pool.end(); }

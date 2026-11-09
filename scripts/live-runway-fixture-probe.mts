import pg from "pg";

const url = process.env.SUPABASE_DB_URL;
if (!url) throw new Error("SUPABASE_DB_URL missing");
const pool = new pg.Pool({ connectionString: url, ssl: { rejectUnauthorized: false }, max: 2 });
try {
  const projects = await pool.query(
    "select id, slug, purpose from projects where slug like '%smoke%' or purpose = 'benchmark' order by slug"
  );
  console.log("BENCHMARK_PROJECTS=" + JSON.stringify(projects.rows.map((r) => ({id:r.id,slug:r.slug,purpose:r.purpose}))));
  for (const p of projects.rows) {
    const shots = await pool.query(
      `select sh.id, sh.shot_code, sh.target_duration_ms, sh.updated_at,
              f.id as frame_id, f.asset_id, f.approved,
              a.object_path, a.bucket, a.storage_provider, a.mime, a.byte_size, a.checksum
         from shots sh
         left join storyboard_frames f on f.shot_id = sh.id and f.approved = true
         left join assets a on a.id = f.asset_id
        where sh.project_id = $1
        order by sh.shot_code`,
      [p.id]
    );
    const jobs = await pool.query(
      `select status, provider, model, count(*)::int as n
         from generation_jobs
        where project_id = $1
        group by status, provider, model
        order by status, provider, model`,
      [p.id]
    );
    console.log("PROJECT=" + p.slug + " SHOTS=" + JSON.stringify(shots.rows.map((r)=>({
      shotId:r.id,shotCode:r.shot_code,targetDurationMs:r.target_duration_ms,
      frameId:r.frame_id,assetId:r.asset_id,approved:r.approved,
      hasStoredBytes:Boolean(r.object_path && r.bucket && r.storage_provider === "supabase" && Number(r.byte_size||0)>0),
      mime:r.mime,byteSize:r.byte_size,checksumPrefix:r.checksum ? String(r.checksum).slice(0,12) : null
    }))));
    console.log("PROJECT=" + p.slug + " JOBS=" + JSON.stringify(jobs.rows));
  }
  const active = await pool.query(
    `select provider, model, status, count(*)::int as n
       from generation_jobs
      where status in ('queued','submitting','submitted','processing','ingesting','cancel_requested')
      group by provider, model, status
      order by provider, model, status`
  );
  console.log("ALL_ACTIVE_JOBS=" + JSON.stringify(active.rows));
} finally {
  await pool.end();
}

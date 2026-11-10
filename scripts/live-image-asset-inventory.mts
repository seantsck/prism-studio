import pg from "pg";
const url=process.env.SUPABASE_DB_URL;
if(!url) throw new Error("SUPABASE_DB_URL missing");
const pool=new pg.Pool({connectionString:url,ssl:{rejectUnauthorized:false},max:2});
try {
  const p=await pool.query("select id from projects where slug='ojousama' limit 1");
  const projectId=String(p.rows[0]?.id??"");
  if(!projectId) throw new Error("Ojou-sama missing");

  const cols=await pool.query(`
    select table_name,column_name
    from information_schema.columns
    where table_schema='public'
      and table_name in ('assets','generation_attempts','generation_attempt_outputs')
    order by table_name,ordinal_position
  `);

  const assets=await pool.query(`
    select
      a.id,a.purpose,a.type,a.filename,a.mime,a.width,a.height,a.byte_size,
      a.object_path,a.checksum,a.metadata,a.created_at
    from assets a
    where a.project_id=$1 and a.type='image' and a.object_path is not null
    order by a.created_at,a.id
  `,[projectId]);

  const attempts=await pool.query(`
    select id,shot_id,provider,model,purpose,status,request,result,created_at,completed_at
    from generation_attempts
    where project_id=$1
    order by created_at
  `,[projectId]);

  console.log("IMAGE_ASSET_INVENTORY="+JSON.stringify({
    columns:cols.rows,
    assets:assets.rows,
    attempts:attempts.rows
  }));
} finally { await pool.end(); }

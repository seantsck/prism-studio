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
    select row_to_json(a) as row
    from assets a
    where a.project_id=$1 and a.type='image' and a.object_path is not null
    order by a.created_at,a.id
  `,[projectId]);

  const attempts=await pool.query(`
    select row_to_json(ga) as row
    from generation_attempts ga
    where ga.project_id=$1
    order by ga.created_at
  `,[projectId]);

  const shotMap=await pool.query(`
    select id,shot_code,title from shots where project_id=$1 order by shot_code
  `,[projectId]);

  console.log("IMAGE_ASSET_INVENTORY="+JSON.stringify({
    columns:cols.rows,
    assets:assets.rows.map(x=>x.row),
    attempts:attempts.rows.map(x=>x.row),
    shots:shotMap.rows
  }));
} finally { await pool.end(); }

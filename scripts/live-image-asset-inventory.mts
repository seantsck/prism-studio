import pg from "pg";
const url=process.env.SUPABASE_DB_URL;
if(!url) throw new Error("SUPABASE_DB_URL missing");
const pool=new pg.Pool({connectionString:url,ssl:{rejectUnauthorized:false},max:2});
try {
  const p=await pool.query("select id from projects where slug='ojousama' limit 1");
  const projectId=String(p.rows[0]?.id??"");
  if(!projectId) throw new Error("Ojou-sama missing");

  const assets=await pool.query(`
    select
      id,name,purpose,type,mime,width,height,byte_size,object_path,checksum,source,tags,metadata,notes,created_at
    from assets
    where project_id=$1 and type='image' and object_path is not null
    order by created_at,id
  `,[projectId]);

  const attempts=await pool.query(`
    select row_to_json(ga) as row
    from generation_attempts ga
    where ga.project_id=$1
    order by ga.created_at
  `,[projectId]);

  const shots=await pool.query("select id,shot_code,title from shots where project_id=$1",[projectId]);
  const shotMap=new Map(shots.rows.map(s=>[s.id,{code:s.shot_code,title:s.title}]));

  const compact=attempts.rows.map(({row:a})=>({
    id:a.id,
    shotId:a.shot_id,
    shot:shotMap.get(a.shot_id)??null,
    attemptNumber:a.attempt_number,
    provider:a.provider,
    model:a.model,
    modality:a.modality,
    status:a.status,
    purpose:a.purpose,
    outputAssetId:a.output_asset_id,
    createdAt:a.created_at,
    prompt:String(a.prompt??"").slice(0,900),
    negativePrompt:String(a.negative_prompt??"").slice(0,300),
    modelSettings:a.model_settings??null,
    packageSet:a.package_snapshot?.set??null,
    packageCharacters:a.package_snapshot?.characters??null,
    packageStoryIntent:a.package_snapshot?.storyIntent??null
  })).filter(a=>a.outputAssetId || a.status==="succeeded");

  console.log("IMAGE_ASSET_INVENTORY="+JSON.stringify({assets:assets.rows,attempts:compact}));
} finally { await pool.end(); }

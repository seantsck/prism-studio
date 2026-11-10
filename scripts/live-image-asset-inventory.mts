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
    select
      ga.id,ga.shot_id,sh.shot_code,ga.attempt_number,ga.provider,ga.model,ga.modality,
      ga.status,ga.prompt,ga.negative_prompt,ga.model_settings,ga.package_snapshot,
      ga.output_asset_id,ga.created_at,ga.completed_at
    from generation_attempts ga
    left join shots sh on sh.id=ga.shot_id
    where ga.project_id=$1
      and ga.output_asset_id is not null
    order by ga.created_at
  `,[projectId]);

  console.log("IMAGE_ASSET_INVENTORY="+JSON.stringify({
    assets:assets.rows,
    attempts:attempts.rows.map(a=>({
      id:a.id,shotId:a.shot_id,shotCode:a.shot_code,attemptNumber:a.attempt_number,
      provider:a.provider,model:a.model,modality:a.modality,status:a.status,
      outputAssetId:a.output_asset_id,createdAt:a.created_at,completedAt:a.completed_at,
      prompt:String(a.prompt??"").slice(0,1200),
      negativePrompt:String(a.negative_prompt??"").slice(0,500),
      modelSettings:a.model_settings,
      packageShot:a.package_snapshot?.shot??null,
      packageStoryIntent:a.package_snapshot?.storyIntent??null,
      packageSet:a.package_snapshot?.set??null,
      packageCharacters:a.package_snapshot?.characters??null
    }))
  }));
} finally { await pool.end(); }

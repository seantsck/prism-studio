import pg from "pg";
const url=process.env.SUPABASE_DB_URL;
if(!url) throw new Error("SUPABASE_DB_URL missing");
const pool=new pg.Pool({connectionString:url,ssl:{rejectUnauthorized:false},max:2});
try {
  const p=await pool.query("select id from projects where slug='ojousama' limit 1");
  const projectId=String(p.rows[0]?.id??"");
  if(!projectId) throw new Error("Ojou-sama missing");
  const q=await pool.query(`
    select
      a.id as asset_id,
      a.name,
      a.mime,
      a.width,
      a.height,
      a.checksum,
      a.object_path,
      a.created_at as asset_created_at,
      go.role as output_role,
      go.position as output_position,
      ga.id as attempt_id,
      ga.shot_id,
      sh.shot_code,
      sh.title as shot_title,
      ga.attempt_number,
      ga.provider,
      ga.model,
      ga.modality,
      ga.prompt,
      ga.negative_prompt,
      ga.model_settings,
      ga.input_asset_ids,
      ga.status,
      ga.approved,
      ga.notes,
      ga.created_at as attempt_created_at,
      gc.kind as cost_kind,
      gc.amount as cost_amount,
      gc.basis as cost_basis
    from assets a
    join generation_outputs go on go.asset_id=a.id
    join generation_attempts ga on ga.id=go.attempt_id
    left join shots sh on sh.id=ga.shot_id
    left join generation_costs gc on gc.attempt_id=ga.id and gc.kind in ('actual','unknown')
    where a.project_id=$1
      and a.type='image'
      and a.purpose='generation_output'
      and a.object_path is not null
      and a.byte_size>0
    order by ga.created_at, go.position
  `,[projectId]);
  for (const r of q.rows) {
    console.log("STORED_IMAGE_ROW="+JSON.stringify({
      assetId:r.asset_id,
      name:r.name,
      width:r.width,
      height:r.height,
      attemptId:r.attempt_id,
      shotCode:r.shot_code,
      shotTitle:r.shot_title,
      attemptNumber:r.attempt_number,
      provider:r.provider,
      model:r.model,
      modality:r.modality,
      status:r.status,
      approved:r.approved,
      promptPreview:String(r.prompt??"").slice(0,220),
      inputAssetIds:r.input_asset_ids,
      modelSettings:r.model_settings,
      costKind:r.cost_kind,
      costAmount:r.cost_amount
    }));
  }
} finally { await pool.end(); }

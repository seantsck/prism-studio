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
  console.log("STORED_IMAGE_AUDIT="+JSON.stringify(q.rows.map(r=>({
    assetId:r.asset_id,
    name:r.name,
    mime:r.mime,
    width:r.width,
    height:r.height,
    checksum:r.checksum,
    stored:Boolean(r.object_path),
    outputRole:r.output_role,
    outputPosition:r.output_position,
    attemptId:r.attempt_id,
    shotId:r.shot_id,
    shotCode:r.shot_code,
    shotTitle:r.shot_title,
    attemptNumber:r.attempt_number,
    provider:r.provider,
    model:r.model,
    modality:r.modality,
    prompt:r.prompt,
    negativePrompt:r.negative_prompt,
    modelSettings:r.model_settings,
    inputAssetIds:r.input_asset_ids,
    status:r.status,
    approved:r.approved,
    notes:r.notes,
    attemptCreatedAt:r.attempt_created_at,
    costKind:r.cost_kind,
    costAmount:r.cost_amount,
    costBasis:r.cost_basis
  }))));
} finally { await pool.end(); }

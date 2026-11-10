import pg from "pg";
const url=process.env.SUPABASE_DB_URL;
if(!url) throw new Error("SUPABASE_DB_URL missing");
const pool=new pg.Pool({connectionString:url,ssl:{rejectUnauthorized:false},max:2});
try {
  const p=await pool.query("select id from projects where slug='ojousama' limit 1");
  const projectId=String(p.rows[0]?.id??"");
  if(!projectId) throw new Error("Ojou-sama missing");

  const rows=await pool.query(`
    select
      a.id as asset_id,
      a.name,
      a.width,
      a.height,
      a.byte_size,
      a.object_path,
      a.metadata #>> '{generation,attemptId}' as attempt_id,
      a.metadata #>> '{generation,provider}' as asset_provider,
      a.metadata #>> '{generation,model}' as asset_model,
      ga.shot_id,
      sh.shot_code,
      sh.title as shot_title,
      ga.provider,
      ga.model,
      ga.modality,
      ga.status,
      ga.prompt,
      ga.package_snapshot
    from assets a
    left join generation_attempts ga
      on ga.id::text = a.metadata #>> '{generation,attemptId}'
    left join shots sh on sh.id=ga.shot_id
    where a.project_id=$1
      and a.type='image'
      and a.object_path is not null
    order by a.created_at,a.id
  `,[projectId]);

  for (const r of rows.rows) {
    console.log("IMAGE_ASSET_ROW="+JSON.stringify({
      assetId:r.asset_id,
      name:r.name,
      size:[r.width,r.height],
      bytes:r.byte_size,
      attemptId:r.attempt_id,
      shotId:r.shot_id,
      shotCode:r.shot_code,
      shotTitle:r.shot_title,
      provider:r.provider??r.asset_provider,
      model:r.model??r.asset_model,
      modality:r.modality,
      status:r.status,
      prompt:String(r.prompt??"").slice(0,700),
      set:r.package_snapshot?.set?{
        id:r.package_snapshot.set.id,
        name:r.package_snapshot.set.name,
        description:r.package_snapshot.set.description,
        zone:r.package_snapshot.set.zone
      }:null,
      characters:Array.isArray(r.package_snapshot?.characters)
        ? r.package_snapshot.characters.map((c:any)=>({name:c.name,look:c.look?.name??null}))
        : [],
      story:r.package_snapshot?.storyIntent?{
        beat:r.package_snapshot.storyIntent.storyBeat,
        purpose:r.package_snapshot.storyIntent.dramaticPurpose,
        scene:r.package_snapshot.storyIntent.scene
      }:null
    }));
  }
} finally { await pool.end(); }

import pg from "pg";
const url=process.env.SUPABASE_DB_URL;
if(!url) throw new Error("SUPABASE_DB_URL missing");
const pool=new pg.Pool({connectionString:url,ssl:{rejectUnauthorized:false},max:2});
try {
  const p=await pool.query("select id from projects where slug='ojousama' limit 1");
  const projectId=String(p.rows[0]?.id??"");
  if(!projectId) throw new Error("Ojou-sama missing");

  const chars=await pool.query(`
    select c.id,c.name,
      coalesce(jsonb_agg(distinct jsonb_build_object(
        'id',ir.id,'slot',ir.slot,'label',ir.label,'assetId',ir.asset_id,
        'visualRole',ir.metadata->>'visualRole',
        'stored',case when a.object_path is not null and a.byte_size>0 then true else false end
      )) filter (where ir.id is not null),'[]'::jsonb) as identity_refs
    from characters c
    left join character_identity_refs ir on ir.character_id=c.id
    left join assets a on a.id=ir.asset_id
    where c.project_id=$1 and lower(c.name)='yumeko'
    group by c.id,c.name
  `,[projectId]);

  const looks=await pool.query(`
    select l.id,l.name,l.episode_id,l.reference_asset_ids,
      coalesce((
        select jsonb_agg(jsonb_build_object(
          'assetId',x.asset_id,
          'stored',case when a.object_path is not null and a.byte_size>0 then true else false end
        ) order by x.ord)
        from unnest(l.reference_asset_ids) with ordinality x(asset_id,ord)
        left join assets a on a.id=x.asset_id
      ),'[]'::jsonb) as refs
    from character_looks l
    join characters c on c.id=l.character_id
    where l.project_id=$1 and lower(c.name)='yumeko'
    order by l.name
  `,[projectId]);

  const shots=await pool.query(`
    select sh.id,sh.shot_code,sh.location_id,l.name as location_name,
           sel.location_view_id,lv.name as selected_view_name,lv.asset_id as selected_view_asset_id,
           case when va.object_path is not null and va.byte_size>0 then true else false end as selected_view_stored
    from shots sh
    left join locations l on l.id=sh.location_id
    left join shot_location_view_selections sel on sel.shot_id=sh.id
    left join location_views lv on lv.id=sel.location_view_id
    left join assets va on va.id=lv.asset_id
    where sh.project_id=$1 and sh.shot_code='3A'
  `,[projectId]);

  const locs=await pool.query(`
    select l.id,l.name,l.reference_asset_ids,l.visual_bible,
      coalesce((
        select jsonb_agg(jsonb_build_object(
          'assetId',x.asset_id,
          'stored',case when a.object_path is not null and a.byte_size>0 then true else false end
        ) order by x.ord)
        from unnest(l.reference_asset_ids) with ordinality x(asset_id,ord)
        left join assets a on a.id=x.asset_id
      ),'[]'::jsonb) as refs,
      coalesce((
        select jsonb_agg(jsonb_build_object(
          'id',v.id,'name',v.name,'kind',v.kind,'assetId',v.asset_id,
          'stored',case when a.object_path is not null and a.byte_size>0 then true else false end
        ) order by v.created_at)
        from location_views v
        left join assets a on a.id=v.asset_id
        where v.location_id=l.id
      ),'[]'::jsonb) as views
    from locations l
    where l.project_id=$1
      and l.id=(select location_id from shots where project_id=$1 and shot_code='3A' limit 1)
  `,[projectId]);

  const assetSummary=await pool.query(`
    select purpose,type,count(*)::int as n,
           count(*) filter (where object_path is not null and byte_size>0)::int as stored
    from assets where project_id=$1
    group by purpose,type
    order by purpose,type
  `,[projectId]);

  console.log("IMAGE_3A_LINK_AUDIT="+JSON.stringify({
    yumeko:chars.rows,
    looks:looks.rows,
    shot3A:shots.rows,
    location:locs.rows,
    assetSummary:assetSummary.rows
  }));
} finally { await pool.end(); }

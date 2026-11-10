import pg from "pg";
import { AdminRepository } from "../src/data/postgres-repository";
import { draftLocationView } from "../src/domain/location-view";

const IDS = {
  yumekoCanonical: "79d08a5e-b305-5622-9ed4-90fe64e3b839",
  yumekoLook: "53d5f6df-e371-5a1b-af68-d8471dd914ba",
  lobbyCanonical: "cfeede36-7773-5ea0-84d4-d4defe5a77a4",
  lobbyView: "e1896b94-0c9a-58d1-98ee-86fab32e0c21",
  lobbyEstablishing: "dff545d6-1edd-5313-948c-3da13a4c4d77",
  lobbyNight: "3ffb2392-e1ca-572a-ad20-b6c509066133",
  canonicalRef: "775ed152-238d-4e8f-8ec6-70a55be15ce2",
  locationView: "1b3fc6de-a5aa-47d7-867a-df45e76bac4d",
} as const;

const url=process.env.SUPABASE_DB_URL;
if(!url) throw new Error("SUPABASE_DB_URL missing");
const pool=new pg.Pool({connectionString:url,ssl:{rejectUnauthorized:false},max:2});

try {
  const p=await pool.query("select id,user_id from projects where slug='ojousama' limit 1");
  const projectId=String(p.rows[0]?.id??"");
  const owner=String(p.rows[0]?.user_id??"");
  if(!projectId || !owner) throw new Error("Ojou-sama project/owner missing");

  const admin=new AdminRepository(pool,owner);
  const data=await admin.loadProject("ojousama");
  if(!data) throw new Error("Ojou-sama project data missing");

  const yumeko=data.characters.find(c=>c.name.trim().toLowerCase()==="yumeko");
  const episode=data.episodes.find(e=>e.number===1);
  const look=data.looks.find(l=>l.characterId===yumeko?.id && l.episodeId===episode?.id && l.name==="Episode 1 — Formal Black");
  const lobby=data.locations.find(l=>l.name==="Grand Celeste Lobby");
  const shot=data.shots.find(s=>s.shotCode==="3A");
  if(!yumeko || !episode || !look || !lobby || !shot) throw new Error("Required Ojou-sama fixture rows missing");
  if(shot.spatial.locationId!==lobby.id) throw new Error("Shot 3A is not currently in Grand Celeste Lobby");

  const assets=new Map(data.assets.map(a=>[a.id,a]));
  for(const [label,id] of Object.entries(IDS).filter(([k])=>!["canonicalRef","locationView"].includes(k))){
    const a=assets.get(id);
    if(!a || a.projectId!==projectId || a.type!=="image" || !a.objectPath || !a.checksum || !a.width || !a.height)
      throw new Error(label+" is not a stored project image");
  }

  const attempts=await pool.query(
    `select row_to_json(ga) as row from generation_attempts ga
      where ga.project_id=$1 and ga.id in (
        select (metadata #>> '{generation,attemptId}')::uuid
        from assets where id=any($2::uuid[])
      )`,
    [projectId,[IDS.yumekoCanonical,IDS.yumekoLook,IDS.lobbyCanonical,IDS.lobbyView,IDS.lobbyEstablishing,IDS.lobbyNight]]
  );
  const byOutput=new Map<string,any>();
  for(const {row:a} of attempts.rows){
    const out=await pool.query(
      "select id from assets where project_id=$1 and metadata #>> '{generation,attemptId}'=$2 limit 1",
      [projectId,a.id]
    );
    if(out.rows[0]) byOutput.set(String(out.rows[0].id),a);
  }
  const yc=byOutput.get(IDS.yumekoCanonical), yl=byOutput.get(IDS.yumekoLook);
  for(const [name,a] of [["Yumeko canonical",yc],["Yumeko look",yl]] as const){
    if(!a || a.character_id!==yumeko.id) throw new Error(name+" attempt is not owned by Yumeko");
  }
  for(const [name,id] of [["Lobby canonical",IDS.lobbyCanonical],["Lobby view",IDS.lobbyView],["Lobby establishing",IDS.lobbyEstablishing],["Lobby night",IDS.lobbyNight]] as const){
    const a=byOutput.get(id);
    if(!a || a.location_id!==lobby.id) throw new Error(name+" attempt is not owned by Grand Celeste Lobby");
  }

  const currentCanonical=data.identityRefs.find(r=>r.characterId===yumeko.id && (r.metadata as any)?.visualRole==="canonical");
  if(currentCanonical && currentCanonical.assetId!==IDS.yumekoCanonical)
    throw new Error("Yumeko already has a different canonical identity; refusing replacement");
  if(look.referenceAssetIds.length && !look.referenceAssetIds.includes(IDS.yumekoLook))
    throw new Error("Formal Black already has other references; refusing implicit replacement");

  const bible=(lobby.visualBible??{}) as any;
  if(bible.canonicalAssetId && bible.canonicalAssetId!==IDS.lobbyCanonical)
    throw new Error("Lobby already has a different canonical asset; refusing replacement");
  const existingEntries=Array.isArray(bible.entries)?bible.entries:[];
  const desiredEntries=[
    {assetId:IDS.lobbyEstablishing,role:"establishing",label:"lobby wide"},
    {assetId:IDS.lobbyNight,role:"variant",label:"night"},
  ];
  for(const d of desiredEntries){
    const conflict=existingEntries.find((e:any)=>e.role===d.role && e.assetId!==d.assetId);
    if(conflict) throw new Error("Lobby already has a different "+d.role+" designation; refusing replacement");
  }

  const viewAsset=assets.get(IDS.lobbyView)!;
  const drafted=draftLocationView({
    id:IDS.locationView,
    now:new Date().toISOString(),
    userId:owner,
    projectId,
    location:lobby,
    asset:viewAsset,
    source:"location_reference",
    spec:{
      name:"Entrance toward elevators",
      kind:"entrance",
      viewpointDescription:"Camera at the lobby entrance looking toward the elevators.",
      orientation:"Facing toward the north-wall elevator bank.",
      cameraPosition:"Lobby entrance.",
      cameraHeight:"Eye level.",
      cameraAngle:"Level.",
      shotSize:"Wide.",
      framing:"Readable entrance-to-elevators geography.",
      lens:"24mm.",
      geographyNotes:"Preserve entrance, elevator bank, concierge desk and central chandelier relationships.",
      continuityNotes:"Preserve the canonical Grand Celeste Lobby architecture, materials and nighttime practical lighting.",
    }
  });
  if(!drafted.ok) throw new Error("Location View draft refused: "+drafted.message);
  const view=drafted.draft;

  const client=await pool.connect();
  try{
    await client.query("begin");

    const lock=await client.query("select id from projects where id=$1 for update",[projectId]);
    if(!lock.rows[0]) throw new Error("Project disappeared");

    const canon=await client.query(
      "select id,asset_id,metadata,locked from character_identity_refs where character_id=$1 and metadata->>'visualRole'='canonical' for update",
      [yumeko.id]
    );
    if(canon.rows[0] && String(canon.rows[0].asset_id)!==IDS.yumekoCanonical)
      throw new Error("Canonical identity changed during setup");
    if(canon.rows[0]?.locked) throw new Error("Canonical identity is locked");
    if(!canon.rows[0]){
      await client.query(
        `insert into character_identity_refs
          (id,project_id,character_id,slot,asset_id,label,metadata,locked)
         values ($1,$2,$3,'additional',$4,'Canonical identity',$5::jsonb,false)`,
        [IDS.canonicalRef,projectId,yumeko.id,IDS.yumekoCanonical,JSON.stringify({visualRole:"canonical",source:"visual_bible"})]
      );
    }

    const lookRow=await client.query("select reference_asset_ids from character_looks where id=$1 and project_id=$2 for update",[look.id,projectId]);
    const currentLookRefs=(lookRow.rows[0]?.reference_asset_ids??[]) as string[];
    if(currentLookRefs.length && !currentLookRefs.includes(IDS.yumekoLook))
      throw new Error("Formal Black references changed during setup");
    if(!currentLookRefs.includes(IDS.yumekoLook))
      await client.query("update character_looks set reference_asset_ids=$1::uuid[] where id=$2 and project_id=$3",[[IDS.yumekoLook],look.id,projectId]);

    const locRow=await client.query("select reference_asset_ids,visual_bible,locked from locations where id=$1 and project_id=$2 for update",[lobby.id,projectId]);
    if(locRow.rows[0]?.locked) throw new Error("Lobby is locked");
    const currentBible=locRow.rows[0]?.visual_bible??{};
    if(currentBible.canonicalAssetId && currentBible.canonicalAssetId!==IDS.lobbyCanonical)
      throw new Error("Lobby canonical changed during setup");
    const currentEntries=Array.isArray(currentBible.entries)?currentBible.entries:[];
    for(const d of desiredEntries){
      const conflict=currentEntries.find((e:any)=>e.role===d.role && e.assetId!==d.assetId);
      if(conflict) throw new Error("Lobby "+d.role+" changed during setup");
    }
    const mergedEntries=[...currentEntries];
    for(const d of desiredEntries)
      if(!mergedEntries.some((e:any)=>e.assetId===d.assetId && e.role===d.role)) mergedEntries.push(d);
    const locRefs=(locRow.rows[0]?.reference_asset_ids??[]) as string[];
    const mergedRefs=locRefs.includes(IDS.lobbyView)?locRefs:[...locRefs,IDS.lobbyView];
    await client.query(
      "update locations set reference_asset_ids=$1::uuid[], visual_bible=$2::jsonb where id=$3 and project_id=$4",
      [mergedRefs,JSON.stringify({canonicalAssetId:IDS.lobbyCanonical,entries:mergedEntries}),lobby.id,projectId]
    );

    const existingView=await client.query("select * from location_views where id=$1 or (location_id=$2 and view_fingerprint=$3) for update",[IDS.locationView,lobby.id,view.viewFingerprint]);
    let viewId=IDS.locationView;
    if(existingView.rows[0]){
      const r=existingView.rows[0];
      if(String(r.asset_id)!==IDS.lobbyView || String(r.location_id)!==lobby.id)
        throw new Error("Location View id/fingerprint collision");
      viewId=String(r.id);
    } else {
      await client.query(
        `insert into location_views
          (id,project_id,location_id,schema_version,name,kind,asset_id,asset_checksum,width,height,source,
           source_production_frame_id,source_storyboard_frame_id,source_master_frame_id,view_spec,view_fingerprint,created_by,created_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb,$16,$17,$18)`,
        [view.id,view.projectId,view.locationId,view.schemaVersion,view.name,view.kind,view.assetId,view.assetChecksum,
         view.width,view.height,view.source,view.sourceProductionFrameId,view.sourceStoryboardFrameId,view.sourceMasterFrameId,
         JSON.stringify(view.viewSpec),view.viewFingerprint,view.createdBy,view.createdAt]
      );
    }

    const sel=await client.query("select location_view_id from shot_location_view_selections where shot_id=$1 for update",[shot.id]);
    if(sel.rows[0] && String(sel.rows[0].location_view_id)!==viewId)
      throw new Error("Shot 3A already selected a different Location View; refusing replacement");
    await client.query(
      `insert into shot_location_view_selections
         (shot_id,project_id,location_view_id,location_id,selected_by,selected_at)
       values ($1,$2,$3,$4,$5,now())
       on conflict (shot_id) do nothing`,
      [shot.id,projectId,viewId,lobby.id,owner]
    );

    await client.query("commit");
    console.log("VISUAL_BIBLE_LINKED="+JSON.stringify({
      yumekoCanonical:IDS.yumekoCanonical,
      formalBlack:IDS.yumekoLook,
      lobbyCanonical:IDS.lobbyCanonical,
      lobbyView:{id:viewId,assetId:IDS.lobbyView,name:view.name,fingerprint:view.viewFingerprint},
      lobbyEstablishing:IDS.lobbyEstablishing,
      lobbyNight:IDS.lobbyNight,
      shot3A:shot.id
    }));
  }catch(err){
    await client.query("rollback").catch(()=>undefined);
    throw err;
  }finally{
    client.release();
  }
}finally{
  await pool.end();
}

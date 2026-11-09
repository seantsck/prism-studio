import pg from "pg";
import { randomUUID } from "node:crypto";
import { AdminRepository } from "../src/data/postgres-repository";
import { PostgresGenerationData } from "../src/data/generation-postgres";
import { PostgresLocationViewData } from "../src/data/location-view-postgres";
import { prepareSubjectImage } from "../src/generation/subject-submission";
import { readGenerationConfig } from "../src/generation/config";
import { createRegistry } from "../src/generation/registry";
import { locationBibleOf } from "../src/domain/location-visual-bible";
import { visualRoleOf } from "../src/domain/visual-bible";
import { draftLocationView } from "../src/domain/location-view";

const url=process.env.SUPABASE_DB_URL;
if(!url) throw new Error("SUPABASE_DB_URL missing");

const pool=new pg.Pool({connectionString:url,ssl:{rejectUnauthorized:false},max:4});
const sleep=(ms:number)=>new Promise(r=>setTimeout(r,ms));
const STEP_CAP=0.25;
const TOTAL_ESTIMATE_CAP=1.50;
let estimatedTotal=0;
let actualTotal=0;

try {
  const projectQ=await pool.query("select id,user_id from projects where slug='ojousama' limit 1");
  const projectId=String(projectQ.rows[0]?.id??"");
  const owner=String(projectQ.rows[0]?.user_id??"");
  if(!projectId||!owner) throw new Error("Ojou-sama project/owner missing");

  const admin=new AdminRepository(pool,owner);
  const gen=new PostgresGenerationData(pool,"begin");
  const views=new PostgresLocationViewData(pool,"begin");

  const env={
    ...process.env,
    PRISM_STUDIO_GENERATION_PROVIDERS:"openai-image",
    PRISM_STUDIO_WORKER_BACKED_PROVIDERS:"openai-image",
    PRISM_STUDIO_ALLOW_PAID_GENERATION:"true",
    PRISM_STUDIO_MAX_GENERATION_USD:String(STEP_CAP),
  };
  const config=readGenerationConfig(env);
  const registry=createRegistry(env,config);

  async function data() {
    const d=await admin.loadProject("ojousama");
    if(!d) throw new Error("Ojou-sama could not be loaded");
    const lv=await views.listForProject(d.project.id);
    (d as any).locationViews=lv.views;
    (d as any).shotLocationViewSelections=lv.selections;
    return d as any;
  }

  async function waitFor(attemptId:string,label:string) {
    for(let i=0;i<240;i++){
      const v=await gen.getSubjectImageAttempt(attemptId);
      if(!v) throw new Error(label+": attempt disappeared");
      const status=v.attempt.status;
      if(status==="succeeded"){
        const primary=v.outputs.find(o=>o.output.role==="primary")??v.outputs[0];
        if(!primary?.asset?.objectPath) throw new Error(label+": succeeded without stored primary image");
        const final=v.costs.find(c=>c.kind==="actual");
        if(final?.amount!=null) actualTotal+=Number(final.amount);
        console.log("VISUAL_STEP_DONE="+JSON.stringify({
          label,attemptId,status,assetId:primary.asset.id,
          width:primary.asset.width,height:primary.asset.height,
          actualUsd:final?.amount??null
        }));
        return {view:v,asset:primary.asset};
      }
      if(status==="failed"||status==="rejected"){
        throw new Error(label+": "+(v.job?.lastErrorMessage||v.job?.lastErrorCode||status));
      }
      await sleep(1500);
    }
    throw new Error(label+": timed out while waiting for worker");
  }

  async function generate(args:{
    label:string;
    key:string;
    subject:any;
    direction:string;
    aspectRatio:string;
  }){
    const d=await data();
    const prepared=prepareSubjectImage({
      data:d,
      input:{subject:args.subject,direction:args.direction},
      registry,
      provider:"openai-image",
      modelId:"gpt-image-2.5-flare",
      aspectRatio:args.aspectRatio,
      userId:owner,
      idempotencyKey:args.key,
      config,
      options:{quality:"medium"},
    });
    if(!prepared.ok) throw new Error(args.label+": "+prepared.reasons.join(" · "));
    const estimate=prepared.estimate.amount;
    if(estimate==null||estimate>STEP_CAP)
      throw new Error(args.label+": estimate $"+String(estimate)+" exceeds $"+STEP_CAP);
    estimatedTotal+=estimate;
    if(estimatedTotal>TOTAL_ESTIMATE_CAP)
      throw new Error("Visual Bible estimate total exceeds $"+TOTAL_ESTIMATE_CAP);
    const queued=await gen.createSubjectImageAttempt(prepared.input);
    console.log("VISUAL_STEP_QUEUED="+JSON.stringify({
      label:args.label,attemptId:queued.attempt.id,jobId:queued.job.id,
      duplicate:queued.duplicate,estimateUsd:estimate,referencesSent:prepared.referencesSent,
      aspectRatio:args.aspectRatio
    }));
    return waitFor(queued.attempt.id,args.label);
  }

  async function yumekoAndLook() {
    let d=await data();
    const yumeko=d.characters.find((c:any)=>c.name.trim().toLowerCase()==="yumeko");
    if(!yumeko) throw new Error("Yumeko missing");
    const look=d.looks.find((l:any)=>l.characterId===yumeko.id && /formal black/i.test(l.name));
    if(!look) throw new Error("Yumeko Formal Black Look missing");
    if(look.locked) throw new Error("Yumeko Formal Black Look is locked");

    let canonical=d.identityRefs.find((r:any)=>r.characterId===yumeko.id && visualRoleOf(r)==="canonical");
    if(!canonical?.assetId || !d.assets.some((a:any)=>a.id===canonical.assetId&&a.objectPath&&a.checksum)){
      const g=await generate({
        label:"Yumeko canonical identity",
        key:"phase5b-live-yumeko-canonical-v1",
        subject:{kind:"character",characterId:yumeko.id,intent:"character_reference",lookId:null},
        direction:"Canonical identity reference. Natural neutral expression, front-facing, full body, exact character identity and proportions, plain neutral studio background, even light, no text.",
        aspectRatio:"2:3",
      });
      d=await data();
      canonical=d.identityRefs.find((r:any)=>r.characterId===yumeko.id && visualRoleOf(r)==="canonical");
      if(canonical?.assetId && canonical.assetId!==g.asset.id)
        throw new Error("Yumeko already gained a different canonical identity; refusing replacement");
      if(!canonical){
        await admin.upsert(projectId,"identityRefs",{
          id:randomUUID(),
          characterId:yumeko.id,
          slot:"additional",
          assetId:g.asset.id,
          label:"Canonical identity",
          metadata:{visualRole:"canonical",source:"visual_bible"},
          locked:false,
        } as any);
      }
      console.log("VISUAL_DESIGNATED="+JSON.stringify({kind:"character_canonical",assetId:g.asset.id}));
    } else {
      console.log("VISUAL_SKIP="+JSON.stringify({label:"Yumeko canonical identity",assetId:canonical.assetId}));
    }

    d=await data();
    const freshLook=d.looks.find((l:any)=>l.id===look.id)!;
    const storedLookRefs=(freshLook.referenceAssetIds??[]).filter((id:string)=>d.assets.some((a:any)=>a.id===id&&a.objectPath&&a.checksum));
    if(storedLookRefs.length===0){
      const g=await generate({
        label:"Yumeko Formal Black Look",
        key:"phase5b-live-yumeko-formal-black-v1",
        subject:{kind:"character",characterId:yumeko.id,intent:"outfit_variant",lookId:look.id},
        direction:"Preserve Yumeko's canonical face and proportions exactly. Show the complete Episode 1 Formal Black look clearly from head to shoes in a neutral standing pose, plain background, even light, no text.",
        aspectRatio:"2:3",
      });
      const d2=await data();
      const l=d2.looks.find((x:any)=>x.id===look.id)!;
      if(!l.referenceAssetIds.includes(g.asset.id))
        await admin.upsert(projectId,"looks",{...l,referenceAssetIds:[...l.referenceAssetIds,g.asset.id]} as any);
      console.log("VISUAL_DESIGNATED="+JSON.stringify({kind:"look_reference",lookId:look.id,assetId:g.asset.id}));
    } else {
      console.log("VISUAL_SKIP="+JSON.stringify({label:"Yumeko Formal Black Look",assetId:storedLookRefs[0]}));
    }
  }

  async function lobbyBible() {
    let d=await data();
    const shot=d.shots.find((s:any)=>s.shotCode==="3A");
    if(!shot) throw new Error("Shot 3A missing");
    const location=d.locations.find((l:any)=>l.id===shot.spatial.locationId);
    if(!location||!/grand celeste lobby/i.test(location.name)) throw new Error("Shot 3A Lobby missing");
    if(location.locked) throw new Error("Grand Celeste Lobby is locked");

    let bible=locationBibleOf(location);
    const stored=(id:string|null|undefined)=>!!id&&d.assets.some((a:any)=>a.id===id&&a.objectPath&&a.checksum);
    if(!stored(bible.canonicalAssetId)){
      const g=await generate({
        label:"Grand Celeste Lobby canonical",
        key:"phase5b-live-lobby-canonical-v1",
        subject:{kind:"location",locationId:location.id,intent:"location_concept"},
        direction:"Canonical interior appearance of the Grand Celeste Lobby. Establish the exact architecture, materials, entrance geometry, elevator placement and recurring details. Wide clean interior, no people, no text.",
        aspectRatio:"16:9",
      });
      d=await data();
      const loc=d.locations.find((l:any)=>l.id===location.id)!;
      const b=locationBibleOf(loc);
      if(b.canonicalAssetId&&b.canonicalAssetId!==g.asset.id)
        throw new Error("Lobby already gained a different canonical image; refusing replacement");
      await admin.upsert(projectId,"locations",{...loc,visualBible:{...b,canonicalAssetId:g.asset.id}} as any);
      console.log("VISUAL_DESIGNATED="+JSON.stringify({kind:"location_canonical",assetId:g.asset.id}));
    } else {
      console.log("VISUAL_SKIP="+JSON.stringify({label:"Lobby canonical",assetId:bible.canonicalAssetId}));
    }

    d=await data();
    let loc=d.locations.find((l:any)=>l.id===location.id)!;
    let lvState=await views.listForProject(projectId);
    let entranceView=lvState.views.find((v:any)=>v.locationId===loc.id && v.name.trim().toLowerCase()==="entrance toward elevators");
    if(!entranceView){
      const g=await generate({
        label:"Lobby entrance toward elevators view",
        key:"phase5b-live-lobby-entrance-elevators-v1",
        subject:{kind:"location",locationId:loc.id,intent:"interior_view"},
        direction:"Recurring Location View: camera at the lobby entrance looking toward the elevators, eye level, wide composition. Preserve the canonical architecture, materials, entrance geometry and elevator placement exactly. No people, no text.",
        aspectRatio:"16:9",
      });
      d=await data();
      loc=d.locations.find((l:any)=>l.id===location.id)!;
      if(!loc.referenceAssetIds.includes(g.asset.id))
        await admin.upsert(projectId,"locations",{...loc,referenceAssetIds:[...loc.referenceAssetIds,g.asset.id]} as any);
      d=await data();
      loc=d.locations.find((l:any)=>l.id===location.id)!;
      const asset=d.assets.find((a:any)=>a.id===g.asset.id)!;
      const drafted=draftLocationView({
        id:randomUUID(),now:new Date().toISOString(),userId:owner,
        projectId,location:loc,asset,source:"location_reference",
        spec:{
          name:"Entrance toward elevators",
          kind:"entrance",
          viewpointDescription:"From the lobby entrance looking toward the elevators",
          orientation:"Entrance toward elevators",
          cameraPosition:"At lobby entrance",
          cameraHeight:"Eye level",
          cameraAngle:"Level",
          shotSize:"Wide",
          framing:"Readable lobby geography",
          geographyNotes:"Preserve entrance and elevator relationship from the canonical Lobby",
          continuityNotes:"Recurring Shot 3A lobby viewpoint",
        }
      });
      if(!drafted.ok) throw new Error("Location View draft refused: "+drafted.message);
      entranceView=(await views.create({draft:drafted.draft,newAsset:null})).view;
      console.log("VISUAL_DESIGNATED="+JSON.stringify({kind:"location_view",viewId:entranceView.id,assetId:g.asset.id}));
    }
    const current=await views.selectionForShot(projectId,shot.id);
    if(current?.locationViewId!==entranceView.id){
      await views.selectForShot({
        projectId,shotId:shot.id,locationViewId:entranceView.id,
        userId:owner,now:new Date().toISOString(),
        expectedSelectedViewId:current?.locationViewId??null
      });
      console.log("VISUAL_DESIGNATED="+JSON.stringify({kind:"shot_location_view",shotCode:"3A",viewId:entranceView.id}));
    }

    d=await data();
    loc=d.locations.find((l:any)=>l.id===location.id)!;
    bible=locationBibleOf(loc);
    let establishing=bible.entries.find((e:any)=>e.role==="establishing" && /lobby wide/i.test(e.label||""));
    if(!establishing || !stored(establishing.assetId)){
      const g=await generate({
        label:"Lobby wide establishing",
        key:"phase5b-live-lobby-establishing-v1",
        subject:{kind:"location",locationId:loc.id,intent:"establishing_view"},
        direction:"Wide establishing image of the Grand Celeste Lobby, distinct from the entrance-to-elevators recurring view. Preserve the exact canonical architecture, materials and layout. No people, no text.",
        aspectRatio:"16:9",
      });
      d=await data();
      loc=d.locations.find((l:any)=>l.id===location.id)!;
      bible=locationBibleOf(loc);
      const refs=loc.referenceAssetIds.includes(g.asset.id)?loc.referenceAssetIds:[...loc.referenceAssetIds,g.asset.id];
      const entries=bible.entries.some((e:any)=>e.assetId===g.asset.id&&e.role==="establishing")
        ? bible.entries
        : [...bible.entries,{assetId:g.asset.id,role:"establishing",label:"lobby wide"}];
      await admin.upsert(projectId,"locations",{...loc,referenceAssetIds:refs,visualBible:{...bible,entries}} as any);
      console.log("VISUAL_DESIGNATED="+JSON.stringify({kind:"location_establishing",assetId:g.asset.id}));
    } else {
      console.log("VISUAL_SKIP="+JSON.stringify({label:"Lobby establishing",assetId:establishing.assetId}));
    }

    d=await data();
    loc=d.locations.find((l:any)=>l.id===location.id)!;
    bible=locationBibleOf(loc);
    let night=bible.entries.find((e:any)=>e.role==="variant" && (e.label||"").trim().toLowerCase()==="night");
    if(!night || !stored(night.assetId)){
      const g=await generate({
        label:"Lobby night variant",
        key:"phase5b-live-lobby-night-v1",
        subject:{kind:"location",locationId:loc.id,intent:"time_variant"},
        direction:"Time of day / state: night. Preserve the exact canonical architecture, layout and materials. Show the Lobby in its nighttime lighting state, no people, no text.",
        aspectRatio:"16:9",
      });
      d=await data();
      loc=d.locations.find((l:any)=>l.id===location.id)!;
      bible=locationBibleOf(loc);
      const refs=loc.referenceAssetIds.includes(g.asset.id)?loc.referenceAssetIds:[...loc.referenceAssetIds,g.asset.id];
      const entries=bible.entries.some((e:any)=>e.assetId===g.asset.id&&e.role==="variant")
        ? bible.entries
        : [...bible.entries,{assetId:g.asset.id,role:"variant",label:"night"}];
      await admin.upsert(projectId,"locations",{...loc,referenceAssetIds:refs,visualBible:{...bible,entries}} as any);
      console.log("VISUAL_DESIGNATED="+JSON.stringify({kind:"location_variant",label:"night",assetId:g.asset.id}));
    } else {
      console.log("VISUAL_SKIP="+JSON.stringify({label:"Lobby night variant",assetId:night.assetId}));
    }
  }

  await yumekoAndLook();
  await lobbyBible();

  const final=await data();
  const yumeko=final.characters.find((c:any)=>c.name.trim().toLowerCase()==="yumeko")!;
  const look=final.looks.find((l:any)=>l.characterId===yumeko.id&&/formal black/i.test(l.name))!;
  const shot=final.shots.find((s:any)=>s.shotCode==="3A")!;
  const loc=final.locations.find((l:any)=>l.id===shot.spatial.locationId)!;
  const bible=locationBibleOf(loc);
  const canonical=final.identityRefs.find((r:any)=>r.characterId===yumeko.id&&visualRoleOf(r)==="canonical");
  const lvState=await views.listForProject(projectId);
  const sel=lvState.selections.find((s:any)=>s.shotId===shot.id);
  const selected=sel?lvState.views.find((v:any)=>v.id===sel.locationViewId):null;
  const storedLookRefs=look.referenceAssetIds.filter((id:string)=>final.assets.some((a:any)=>a.id===id&&a.objectPath&&a.checksum));
  console.log("VISUAL_BIBLE_COMPLETE="+JSON.stringify({
    yumekoCanonicalAssetId:canonical?.assetId??null,
    formalBlackReferenceAssetIds:storedLookRefs,
    lobbyCanonicalAssetId:bible.canonicalAssetId,
    lobbyEntries:bible.entries,
    selectedLocationView:selected?{id:selected.id,name:selected.name,assetId:selected.assetId}:null,
    estimatedUsd:Math.round(estimatedTotal*1e6)/1e6,
    actualUsd:Math.round(actualTotal*1e6)/1e6
  }));
} finally {
  await pool.end();
}

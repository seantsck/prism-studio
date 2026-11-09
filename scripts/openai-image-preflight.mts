import OpenAI from "openai";

const key=process.env.PRISM_STUDIO_PROVIDER_OPENAI_IMAGE_API_KEY?.trim();
if(!key){
  console.error("OPENAI_IMAGE_PREFLIGHT=missing_key");
  process.exit(2);
}
const client=new OpenAI({apiKey:key,maxRetries:0});
try{
  const model=await client.models.retrieve("gpt-image-2.5-flare",{timeout:15_000,maxRetries:0});
  console.log("OPENAI_IMAGE_PREFLIGHT="+JSON.stringify({
    ok:true,
    id:model.id,
    object:model.object,
    ownedBy:model.owned_by,
    shutdownDate:(model as any).shutdown_date??null
  }));
}catch(err:any){
  const status=typeof err?.status==="number"?err.status:null;
  const code=typeof err?.code==="string"?err.code:null;
  console.error("OPENAI_IMAGE_PREFLIGHT="+JSON.stringify({
    ok:false,
    status,
    code,
    kind:err?.constructor?.name??"Error"
  }));
  process.exit(3);
}

const key=(process.env.PRISM_STUDIO_PROVIDER_OPENAI_IMAGE_API_KEY||"").trim();
if(!key){
  console.error("OPENAI_IMAGE_HTTP_PREFLIGHT="+JSON.stringify({ok:false,reason:"missing_key"}));
  process.exit(2);
}
try{
  const res=await fetch("https://api.openai.com/v1/models/gpt-image-2.5-flare",{
    method:"GET",
    headers:{Authorization:`Bearer ${key}`},
    signal:AbortSignal.timeout(15000)
  });
  let body={};
  try{body=await res.json();}catch{}
  if(!res.ok){
    console.error("OPENAI_IMAGE_HTTP_PREFLIGHT="+JSON.stringify({
      ok:false,status:res.status,
      code:body?.error?.code??null,
      type:body?.error?.type??null
    }));
    process.exit(3);
  }
  console.log("OPENAI_IMAGE_HTTP_PREFLIGHT="+JSON.stringify({
    ok:true,status:res.status,
    id:body.id??null,
    object:body.object??null,
    ownedBy:body.owned_by??null,
    shutdownDate:body.shutdown_date??null
  }));
}catch(err){
  console.error("OPENAI_IMAGE_HTTP_PREFLIGHT="+JSON.stringify({
    ok:false,status:null,kind:err?.constructor?.name??"Error"
  }));
  process.exit(4);
}

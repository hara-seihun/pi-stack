import { readFileSync, writeFileSync, renameSync } from "node:fs";
import { gatewayRequest } from "/srv/pi/pi-orchestrator/dist/core/gateway-request.js";
import { pooledRetryAvailability } from "/srv/pi/pi-orchestrator/dist/extension/routing.js";
const path="/var/lib/pi-stack/opus-fallback/state.json";
const env={...process.env,PI_ORCHESTRATOR_LEDGER:"/home/kenan/.local/share/pi-orchestrator/ledger.sqlite3",PI_ORCHESTRATOR_AUTH:"/home/kenan/.local/share/pi-orchestrator/auth.json"};
const opus="anthropic/claude-opus-5-5",sol="openai-codex/gpt-6.1-sol";
const canonical=m=>m?.replace(/^(anthropic|openai-codex)-\d+\//,"$1/");
async function call(op,body){
 const r=await gatewayRequest({method:"POST",route:"/v1/scopes/remote%3Akenan/thread-owner/"+op,body},env);
 if(!r.ok||!r.value.body?.ok)throw new Error(r.ok?r.value.body?.error?.code??"owner-unavailable":r.error.code);
 return r.value.body.value;
}
let state=JSON.parse(readFileSync(path,"utf8"));
function save(){writeFileSync(path+".tmp",JSON.stringify(state));renameSync(path+".tmp",path);}
async function tick(){
 const ready=pooledRetryAvailability(opus,env).available,solReady=pooledRetryAvailability(sol,env).available;
 const page=await call("list",{archived:false,limit:1000});
 for(const t of page.threads){
  if(t.held||t.metadata?.archived||t.metadata?.raw)continue;
  const model=canonical(t.settings.model),record=state.threads[t.id];
  if(record&&model!==sol&&model!==opus){delete state.threads[t.id];save();continue;}
  let target;
  if(!ready&&solReady&&model===opus)target=sol;
  if(ready&&record&&model===sol)target=opus;
  if(target){
   if(target===sol&&!record){state.threads[t.id]={preferred:opus,since:Date.now()};save();}
   if(t.metadata?.context){
    const ext="/home/kenan/machine/ubuntu-apps/opus-capacity-fallback/index.mjs";
    const context=t.metadata.context;
    if(!(context.extensions??[]).includes(ext))await call("control",{threadId:t.id,action:"update",metadata:{...t.metadata,context:{...context,extensions:[...(context.extensions??[]),ext]}}});
   }
   await call("control",{threadId:t.id,action:"settings",settings:{model:target}});
   console.log(JSON.stringify({threadId:t.id,preferred:opus,effective:target,time:Date.now()}));
  }
  if((target||record)&& (t.metadata?.providerWait||t.metadata?.admissionWait)){
   try{await call("control",{threadId:t.id,action:"retryWaiting"});}catch(e){if(e.message!=="conflict")throw e;}
  }
 }
}
let lastError,reported=false;
while(true){
 try{await tick();lastError=undefined;if(!reported){console.log(JSON.stringify({status:"ready",policy:"Opus 5.5 preferred, Sol 6.1 fallback"}));reported=true;}}catch(e){if(lastError!==e.message){console.log(JSON.stringify({status:"awaiting-owner",reason:e.message}));lastError=e.message;}}
 await new Promise(r=>setTimeout(r,5000));
}

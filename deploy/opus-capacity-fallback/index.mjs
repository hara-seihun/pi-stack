import { readFileSync } from "node:fs";
import { pooledRetryAvailability, resolveSessionModel, baseProvider, POOLED_ACCOUNT_WAIT } from "/srv/pi/pi-orchestrator/dist/extension/routing.js";
import { interruptedTurnPrompt } from "/srv/pi/pi-orchestrator/dist/host/continuations.js";
export default function(pi) {
 const env=globalThis[Symbol.for("pi-stack.session-environment")]?.getStore()??process.env;
 if(process.getuid?.()!==1000||env.PI_ORCHESTRATOR_ASSIGNED==="1")return;
 let preferred=false,changing=false,notice,closed=false;
 const opus="anthropic/claude-opus-5-5",sol="openai-codex/gpt-6.1-sol";
 const isOpus=m=>m?.id==="claude-opus-5-5"&&baseProvider(m.provider)==="anthropic";
 const isSol=m=>m?.id==="gpt-6.1-sol"&&baseProvider(m.provider)==="openai-codex";
 const active=()=>{try{return !!JSON.parse(readFileSync("/var/lib/pi-stack/opus-fallback/state.json","utf8")).threads?.[env.PI_THREAD_ID];}catch{return false;}};
 async function choose(ctx,failure){
  if(closed||!preferred)return false;
  const ready=pooledRetryAvailability(opus,env);
  const target=ready.available?opus:sol;
  if(target===opus&&isOpus(ctx.model)||target===sol&&isSol(ctx.model))return false;
  if(!pooledRetryAvailability(target,env).available)return false;
  const [provider,id]=target.split("/");
  const resolved=await resolveSessionModel(ctx.modelRegistry.getAll(),provider,id,env);
  if(!resolved.ok)return false;
  changing=true;
  try {
   if(!await pi.setModel(resolved.model))return false;
   pi.appendEntry("opus-capacity-fallback",{preferred:opus,effective:target,reason:failure??"provider quota availability",at:Date.now()});
   return true;
  } finally {changing=false;}
 }
 pi.on("session_start",async(_e,ctx)=>{preferred=isOpus(ctx.model)||isSol(ctx.model)&&active();await choose(ctx);});
 pi.on("model_select",(_e,ctx)=>{if(!changing){if(isOpus(ctx.model))preferred=true;else if(!isSol(ctx.model))preferred=false;}});
 pi.on("before_agent_start",async(_e,ctx)=>{await choose(ctx);});
 pi.on("turn_start",async(_e,ctx)=>{await choose(ctx);});
 pi.on("agent_end",async(e,ctx)=>{
  const last=e.messages.at(-1);
  if(!preferred||!isOpus(ctx.model)||last?.stopReason!=="error")return;
  const failure=last.errorMessage??"";
  if(failure!==POOLED_ACCOUNT_WAIT&&!/429|rate.?limit|usage.?limit|quota|capacity/i.test(failure))return;
  if(pooledRetryAvailability(opus,env).available)return;
  if(await choose(ctx,failure))notice=interruptedTurnPrompt(failure,"Anthropic quota is exhausted. Continue the same accepted work on Sol 6.1; Opus 5.5 remains preferred and returns at the first available model-call boundary.");
 });
 pi.on("agent_before_settle",()=>{const content=notice;notice=undefined;if(content)return{entries:[{type:"custom_message",customType:"opus-capacity-fallback",content,display:true}],continue:true};});
 pi.on("session_shutdown",()=>{closed=true;notice=undefined;});
}

import { SessionManager, type AgentSession } from "@earendil-works/pi-coding-agent";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import { join } from "node:path";
import { isolatedContext } from "./host/isolated-context.js";
import { loadConfig } from "./config.js";
import type { Run, RunActivity } from "./domain.js";
import { interruptedTurnPrompt } from "./host/continuations.js";
import { openHostedSession } from "./host/session-lifecycle.js";
import { isCredentialError, isRateLimitError } from "./provider-errors.js";

const BASE=`http://${process.env.PI_ORCHESTRATOR_HOST??"127.0.0.1"}:${process.env.PI_ORCHESTRATOR_PORT??"2460"}`;
async function request(path:string,init?:RequestInit):Promise<any>{const response=await fetch(`${BASE}${path}`,{...init,headers:{"content-type":"application/json",...(init?.headers??{})}});const value=await response.json();if(!response.ok)throw new Error(value.error??`orchestrator ${response.status}`);return value;}
async function post(path:string,value:unknown={}):Promise<any>{return request(path,{method:"POST",body:JSON.stringify(value)});}
function sleep(ms:number):Promise<void>{return new Promise((resolve)=>setTimeout(resolve,ms));}

function modelFor(run:Run):unknown{
  const providers=new Map(builtinProviders().map((provider)=>[provider.id,provider]));
  const model=providers.get(run.provider!)?.getModels().find((candidate)=>candidate.id===run.model);
  if(!model)return undefined;
  return run.accountId===run.provider?model:{...model,provider:run.accountId};
}

export async function work(runId:string):Promise<void>{
  process.env.PI_ORCHESTRATOR_ASSIGNED="1";
  const config=loadConfig();
  const {run}=await request(`/internal/runs/${runId}`) as {run:Run};
  if(!run.accountId||!run.provider||!run.model)throw new Error("run has no account assignment");
  const hosted=await openHostedSession({
    cwd:run.cwd,agentDir:config.agentDir,model:modelFor(run),thinkingLevel:run.thinking,
    provider:run.provider,modelId:run.model,accountId:run.accountId,
    sessionManager:run.sessionFile?SessionManager.open(run.sessionFile,undefined,run.cwd):undefined,
    ...(run.context ? await isolatedContext(run, join(config.agentDir,"sessions")) : {}),
    onExtensionError:(path,error)=>console.error(`extension ${path}:`,error),
  });
  const session=hosted.session;
  let liveText="",liveThinking="",activeTool:string|undefined,lastProgress=0,aborting=false,currentActivity:RunActivity="STARTING";
  const report=(activity:RunActivity,progress=true)=>{currentActivity=activity;const now=Date.now();if(!progress&&now-lastProgress<5000)return;if(progress)lastProgress=now;void post(`/internal/runs/${runId}/heartbeat`,{progress,activity,text:liveText,thinking:liveThinking,tool:activeTool}).catch(console.error);};
  const unsubscribe=session.subscribe((event:any)=>{
    if(event.type==="message_update"){
      const update=event.assistantMessageEvent;
      let activity:RunActivity="WORKING";
      if(update?.type==="text_delta")liveText+=update.delta??"";
      else if(update?.type==="thinking_start"){liveThinking="";activity="THINKING";}
      else if(update?.type==="thinking_delta"){liveThinking+=update.delta??"";activity="THINKING";}
      report(activity);
    }else if(event.type==="tool_execution_start"){activeTool=String(event.toolName??"tool");report("WAITING_ON_TOOL");}
    else if(event.type==="tool_execution_end"){activeTool=undefined;report("WORKING");}
    else if(event.type==="message_end"){liveText="";liveThinking="";report("WORKING");}
    else if(event.type==="compaction_start")report("COMPACTING");
  });
  const heartbeat=setInterval(()=>report(currentActivity,false),15_000);
  const control=setInterval(()=>void (async()=>{
    const value=await request(`/internal/runs/${runId}/control`);
    if(value.abort&&!aborting){aborting=true;await session.abort();}
  })().catch(console.error),2_000);
  try{
    await post(`/internal/runs/${runId}/state`,{state:"running",sessionFile:session.sessionManager.getSessionFile(),progressAt:Date.now(),activity:"STARTING"});
    const message=run.sessionFile?interruptedTurnPrompt("the process hosting this session stopped","I reopened this exact Pi session from its durable JSONL record."):run.prompt;
    await promptAndSettle(session,message);
    const current=(await request(`/internal/runs/${runId}`)).run as Run;
    if(["done","aborted","failed"].includes(current.state))return;
    const last=lastAssistant(session);
    if(last?.stopReason==="error"){
      const detail=last.errorMessage??"provider failed";
      if(isRateLimitError(detail)||isCredentialError(detail))await post(`/internal/runs/${runId}/state`,{state:"failed",failureKind:"account",result:detail,cooldownUntil:Date.now()+30*60_000});
      else await post(`/internal/runs/${runId}/state`,{state:"failed",failureKind:"provider",result:detail});
      return;
    }
    if(last?.stopReason==="aborted"||aborting){await post(`/internal/runs/${runId}/state`,{state:"aborted",failureKind:"operator",result:"aborted"});return;}
    await post(`/internal/runs/${runId}/state`,{state:"done",result:lastAssistantText(session)});
  }finally{clearInterval(heartbeat);clearInterval(control);unsubscribe();hosted.dispose();}
}

async function promptAndSettle(session:AgentSession,message:string):Promise<void>{await session.prompt(message);await sleep(0);for(;;){if(session.isCompacting)await waitForCompaction(session);await sleep(0);if(session.isStreaming){await session.waitForIdle();await sleep(0);continue;}if(!session.isCompacting)return;}}
function waitForCompaction(session:AgentSession):Promise<void>{if(!session.isCompacting)return Promise.resolve();return new Promise((resolve)=>{let unsubscribe=()=>{};let done=false;const finish=()=>{if(done)return;done=true;unsubscribe();resolve();};unsubscribe=session.subscribe((event:any)=>{if(event.type==="compaction_end")finish();});if(!session.isCompacting)finish();});}
function lastAssistant(session:AgentSession):any{return[...session.messages].reverse().find((message)=>message.role==="assistant");}
function lastAssistantText(session:AgentSession):string{const message=lastAssistant(session);return Array.isArray(message?.content)?message.content.filter((part:any)=>part?.type==="text").map((part:any)=>String(part.text??"")).join("").trim():"";}

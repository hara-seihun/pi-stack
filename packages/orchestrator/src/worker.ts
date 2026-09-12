import { SessionManager, type AgentSession } from "@earendil-works/pi-coding-agent";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import { join } from "node:path";
import { isolatedContext } from "./host/isolated-context.js";
import { loadConfig } from "./config.js";
import type { FleetResult, Run, RunActivity } from "./domain.js";
import { isFleetCoordinator } from "./fleet.js";
import { workCompletion } from "./host/completion-worker.js";
import { fleetTools, recoverFleetDispatches } from "./host/fleet-tools.js";
import { FleetResultDelivery, fleetTurnSettled } from "./host/fleet-results.js";
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
  process.env.PI_ORCHESTRATOR_RUN_ID=runId;
  for(const key of Object.keys(process.env))if(/^(PI_REMOTE_|PI_SESSION_)/.test(key))delete process.env[key];
  const config=loadConfig();
  const {run,results=[]}=await request(`/internal/runs/${runId}`) as {run:Run;results?:FleetResult[]};
  if(await workCompletion(run,config,post,request))return;
  if(["done","failed","aborted","waiting"].includes(run.state))return;
  if(!run.accountId||!run.provider||!run.model)throw new Error("run has no account assignment");
  const hosted=await openHostedSession({
    cwd:run.cwd,agentDir:config.agentDir,model:modelFor(run),thinkingLevel:run.thinking,
    provider:run.provider,modelId:run.model,accountId:run.accountId,
    sessionManager:run.sessionFile?SessionManager.open(run.sessionFile,undefined,run.cwd):undefined,
    ...(isFleetCoordinator(run)?{customTools:fleetTools(input=>post(`/internal/runs/${runId}/dispatch`,input))}:{}),
    ...(run.context ? await isolatedContext(run, join(config.agentDir,"sessions")) : {}),
    onExtensionError:(path,error)=>console.error(`extension ${path}:`,error),
  });
  const session=hosted.session;
  const delivery=run.context?undefined:new FleetResultDelivery(session,deliveryIds=>post(`/internal/runs/${runId}/acknowledge`,{deliveryIds}),error=>console.error("fleet result receipt will retry:",error));
  let liveText="",liveThinking="",activeTool:string|undefined,lastProgress=0,aborting=false,currentActivity:RunActivity="STARTING";
  let reportPending=false,progressPending=false,reportInFlight=false;
  let compactionFailure:string|undefined;
  const report=(activity:RunActivity,progress=true)=>{currentActivity=activity;const now=Date.now();if(!progress&&now-lastProgress<5000)return;if(progress)lastProgress=now;reportPending=true;progressPending ||= progress;};
  const reportTimer=setInterval(()=>{
    if(!reportPending||reportInFlight)return;
    const progress=progressPending;reportPending=false;progressPending=false;reportInFlight=true;
    void post(`/internal/runs/${runId}/heartbeat`,{progress,activity:currentActivity,text:liveText,thinking:liveThinking,tool:activeTool})
      .catch(error=>{reportPending=true;progressPending ||= progress;console.error(error);}).finally(()=>{reportInFlight=false;});
  },250);
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
    else if(event.type==="compaction_end"){
      if(event.result)compactionFailure=undefined;
      else if(event.errorMessage)compactionFailure=String(event.errorMessage);
    }
  });
  const heartbeat=setInterval(()=>report(currentActivity,false),15_000);
  const control=setInterval(()=>void (async()=>{
    const value=await request(`/internal/runs/${runId}/control`);
    if(value.abort&&!aborting){aborting=true;await session.abort();}
    else if(!aborting)await delivery?.receive(value.results??[],true);
  })().catch(console.error),2_000);
  try{
    await post(`/internal/runs/${runId}/state`,{state:"running",sessionFile:session.sessionManager.getSessionFile(),progressAt:Date.now(),activity:"STARTING"});
    if(run.sessionFile&&isFleetCoordinator(run))await recoverFleetDispatches(session,input=>post(`/internal/runs/${runId}/dispatch`,input));
    await delivery?.receive(results);
    if(!run.sessionFile||run.context||!fleetTurnSettled(session)){
      const message=results.length?JSON.stringify({type:"fleet-results-ready",runId,deliveryIds:results.map(result=>result.deliveryId)}):run.sessionFile?interruptedTurnPrompt("the process hosting this session stopped","I reopened this exact Pi session from its durable JSONL record."):run.prompt;
      await promptAndSettle(session,message);
    }
    await delivery?.flush();
    const current=(await request(`/internal/runs/${runId}`)).run as Run;
    if(["done","aborted","failed"].includes(current.state))return;
    const last=lastAssistant(session);
    if(compactionFailure&&!aborting){
      await post(`/internal/runs/${runId}/state`,{state:"failed",failureKind:"provider",result:compactionFailure});
      return;
    }
    if(last?.stopReason==="error"){
      const detail=last.errorMessage??"provider failed";
      if(isRateLimitError(detail)||isCredentialError(detail))await post(`/internal/runs/${runId}/state`,{state:"failed",failureKind:"account",result:detail,cooldownUntil:Date.now()+30*60_000});
      else await post(`/internal/runs/${runId}/state`,{state:"failed",failureKind:"provider",result:detail});
      return;
    }
    if(last?.stopReason==="aborted"||aborting){await post(`/internal/runs/${runId}/state`,{state:"aborted",failureKind:"operator",result:"aborted"});return;}
    await post(`/internal/runs/${runId}/state`,{state:"done",result:lastAssistantText(session)});
  }finally{clearInterval(reportTimer);clearInterval(heartbeat);clearInterval(control);unsubscribe();try{await delivery?.close();}finally{hosted.dispose();}}
}

async function promptAndSettle(session:AgentSession,message:string):Promise<void>{await session.prompt(message);await sleep(0);for(;;){if(session.isCompacting)await waitForCompaction(session);await sleep(0);if(session.isStreaming){await session.waitForIdle();await sleep(0);continue;}if(!session.isCompacting)return;}}
function waitForCompaction(session:AgentSession):Promise<void>{if(!session.isCompacting)return Promise.resolve();return new Promise((resolve)=>{let unsubscribe=()=>{};let done=false;const finish=()=>{if(done)return;done=true;unsubscribe();resolve();};unsubscribe=session.subscribe((event:any)=>{if(event.type==="compaction_end")finish();});if(!session.isCompacting)finish();});}
function lastAssistant(session:AgentSession):any{return[...session.messages].reverse().find((message)=>message.role==="assistant");}
function lastAssistantText(session:AgentSession):string{const message=lastAssistant(session);return Array.isArray(message?.content)?message.content.filter((part:any)=>part?.type==="text").map((part:any)=>String(part.text??"")).join("").trim():"";}

import { DefaultResourceLoader, SessionManager, type AgentSession } from "@earendil-works/pi-coding-agent";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import { Type } from "typebox";
import { loadConfig } from "./config.js";
import type { Run, RunActivity } from "./domain.js";
import { interruptedTurnPrompt } from "./host/continuations.js";
import { openHostedSession } from "./host/session-lifecycle.js";
import { isCredentialError, isRateLimitError } from "./provider-errors.js";

const BASE=`http://${process.env.PI_ORCHESTRATOR_HOST??"127.0.0.1"}:${process.env.PI_ORCHESTRATOR_PORT??"2460"}`;
async function request(path:string,init?:RequestInit):Promise<any>{const response=await fetch(`${BASE}${path}`,{...init,headers:{"content-type":"application/json",...(init?.headers??{})}});const value=await response.json();if(!response.ok)throw new Error(value.error??`orchestrator ${response.status}`);return value;}
async function post(path:string,value:unknown={}):Promise<any>{return request(path,{method:"POST",body:JSON.stringify(value)});}
function sleep(ms:number):Promise<void>{return new Promise((resolve)=>setTimeout(resolve,ms));}

function roomTools(run:Run):any[]{
  if(!run.roomId)return[];
  const roomId=run.roomId;
  return [
    {name:"room_feed",label:"Room feed",description:"Read durable room posts after an optional message id.",parameters:Type.Object({after:Type.Optional(Type.Number({minimum:0}))}),execute:async(_id:string,input:any)=>({content:[{type:"text",text:JSON.stringify((await request(`/v1/rooms/${encodeURIComponent(roomId)}/messages?after=${Number(input.after??0)}`)).messages,null,2)}]})},
    {name:"room_members",label:"Room members",description:"List every member of this room and its current state.",parameters:Type.Object({}),execute:async()=>({content:[{type:"text",text:JSON.stringify((await request("/v1/runs")).runs.filter((candidate:Run)=>candidate.roomId===roomId),null,2)}]})},
    {name:"room_post",label:"Post to room",description:"Post to the shared room feed. This does not wake every member unless wake is true.",parameters:Type.Object({message:Type.String({minLength:1}),wake:Type.Optional(Type.Boolean())}),execute:async(_id:string,input:any)=>{await post(`/v1/rooms/${encodeURIComponent(roomId)}/messages`,{senderRunId:run.id,body:input.message,wake:!!input.wake});return{content:[{type:"text",text:"Posted."}]};}},
    {name:"room_message",label:"Message member",description:"Send one room member a durable direct message and wake its Pi session.",parameters:Type.Object({runId:Type.String({minLength:1}),message:Type.String({minLength:1})}),execute:async(_id:string,input:any)=>{await post(`/v1/rooms/${encodeURIComponent(roomId)}/messages`,{senderRunId:run.id,targetRunId:input.runId,body:input.message,wake:true});return{content:[{type:"text",text:"Message queued."}]};}},
    {name:"room_close",label:"Close room",description:"Close this room when its goal is finished or its exact blocking state is in durable custody. Any member may do this.",parameters:Type.Object({summary:Type.String({minLength:1})}),execute:async(_id:string,input:any)=>{await post(`/v1/rooms/${encodeURIComponent(roomId)}/messages`,{senderRunId:run.id,body:`Room closed: ${input.summary}`,wake:true});await post(`/v1/rooms/${encodeURIComponent(roomId)}/close`);return{content:[{type:"text",text:"Room closed. Members will stop without replacement."}]};}},
    {name:"room_leave",label:"Leave room",description:"End your membership in this room after the current turn.",parameters:Type.Object({reason:Type.String({minLength:1})}),execute:async(_id:string,input:any)=>{await post(`/internal/runs/${run.id}/state`,{state:"done",result:`left room: ${input.reason}`});return{content:[{type:"text",text:"Your room membership will end with this turn."}]};}},
  ];
}

function roomPrompt(run:Run):string|undefined{return run.roomId?`# Room ${run.roomId}\n\nYou are ${run.memberName??run.id} in a room of warm peer Pi sessions. Use room_members, room_feed, room_post, and room_message to coordinate. Shared posts persist but wake nobody unless requested. Direct messages wake one member and become an ordinary user turn. You may leave with room_leave. No member has hidden access to another member's reasoning or special completion authority.`:undefined;}

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
  const additions=roomPrompt(run);
  let loader:DefaultResourceLoader|undefined;
  if(additions){loader=new DefaultResourceLoader({cwd:run.cwd,agentDir:config.agentDir,appendSystemPrompt:[additions]});await loader.reload();}
  const hosted=await openHostedSession({
    cwd:run.cwd,agentDir:config.agentDir,model:modelFor(run),thinkingLevel:run.thinking,
    provider:run.provider,modelId:run.model,accountId:run.accountId,customTools:roomTools(run),resourceLoader:loader,
    sessionManager:run.sessionFile?SessionManager.open(run.sessionFile,undefined,run.cwd):undefined,
    onExtensionError:(path,error)=>console.error(`extension ${path}:`,error),
  });
  const session=hosted.session;
  let liveText="",liveThinking="",activeTool:string|undefined,lastProgress=0,aborting=false,leaving=false,currentActivity:RunActivity="STARTING";
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
  const inbox=setInterval(()=>void (async()=>{
    const value=await request(`/internal/runs/${runId}/messages`);
    if(value.abort&&!aborting){aborting=true;session.abort();}
    for(const message of value.messages??[]){
      if(session.isStreaming)session.followUp(message.body);
      await post(`/internal/runs/${runId}/messages/${message.id}`);
    }
  })().catch(console.error),2_000);
  try{
    await post(`/internal/runs/${runId}/state`,{state:"running",sessionFile:session.sessionManager.getSessionFile(),progressAt:Date.now(),activity:"STARTING"});
    let message=run.sessionFile?interruptedTurnPrompt("the process hosting this session stopped","I reopened this exact Pi session from its durable JSONL record."):run.prompt;
    for(;;){
      await promptAndSettle(session,message);
      const current=(await request(`/internal/runs/${runId}`)).run as Run;
      if(["done","aborted","failed"].includes(current.state)){leaving=true;break;}
      const last=lastAssistant(session);
      if(last?.stopReason==="error"){
        const detail=last.errorMessage??"provider failed";
        if(isRateLimitError(detail)||isCredentialError(detail))await post(`/internal/runs/${runId}/state`,{state:"failed",failureKind:"account",result:detail,cooldownUntil:Date.now()+30*60_000});
        else await post(`/internal/runs/${runId}/state`,{state:"failed",failureKind:"provider",result:detail});
        break;
      }
      if(last?.stopReason==="aborted"||aborting){await post(`/internal/runs/${runId}/state`,{state:"aborted",failureKind:"operator",result:"aborted"});break;}
      if(!run.roomId){await post(`/internal/runs/${runId}/state`,{state:"done",result:lastAssistantText(session)});break;}
      currentActivity="IDLE";
      await post(`/internal/runs/${runId}/state`,{state:"parked",progressAt:Date.now(),activity:currentActivity});
      let pending:any[]=[];
      while(!pending.length&&!aborting&&!leaving){const value=await request(`/internal/runs/${runId}/messages`);pending=value.messages??[];if(value.abort)aborting=true;if(!pending.length)await sleep(2000);}
      if(aborting){await post(`/internal/runs/${runId}/state`,{state:"aborted",failureKind:"operator",result:"aborted"});break;}
      if(leaving)break;
      message=pending.map((entry)=>entry.body).join("\n\n");
      for(const entry of pending)await post(`/internal/runs/${runId}/messages/${entry.id}`);
      currentActivity="WORKING";
      await post(`/internal/runs/${runId}/state`,{state:"running",progressAt:Date.now(),activity:currentActivity});
    }
  }finally{clearInterval(heartbeat);clearInterval(inbox);unsubscribe();hosted.dispose();}
}

async function promptAndSettle(session:AgentSession,message:string):Promise<void>{await session.prompt(message);await sleep(0);for(;;){if(session.isCompacting)await waitForCompaction(session);await sleep(0);if(session.isStreaming){await session.waitForIdle();await sleep(0);continue;}if(!session.isCompacting)return;}}
function waitForCompaction(session:AgentSession):Promise<void>{if(!session.isCompacting)return Promise.resolve();return new Promise((resolve)=>{let unsubscribe=()=>{};let done=false;const finish=()=>{if(done)return;done=true;unsubscribe();resolve();};unsubscribe=session.subscribe((event:any)=>{if(event.type==="compaction_end")finish();});if(!session.isCompacting)finish();});}
function lastAssistant(session:AgentSession):any{return[...session.messages].reverse().find((message)=>message.role==="assistant");}
function lastAssistantText(session:AgentSession):string{const message=lastAssistant(session);return Array.isArray(message?.content)?message.content.filter((part:any)=>part?.type==="text").map((part:any)=>String(part.text??"")).join("").trim():"";}

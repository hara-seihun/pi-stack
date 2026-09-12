import { defineTool, type AgentSession } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { SUBAGENT_MODEL_DESCRIPTIONS } from "../catalog.js";
import { DELEGATION_POLICY } from "../delegation-policy.js";
import { syncTranscript } from "./fleet-results.js";
import { FLEET_MODELS, type FleetDispatch, type Run } from "../domain.js";

function dispatchResult(run:Run){
  const details={runId:run.id,parentRunId:run.parentRunId,model:run.requestedModel,state:run.state,delivery:"automatic"};
  return{content:[{type:"text" as const,text:JSON.stringify(details)}],details};
}

export async function recoverFleetDispatches(session:AgentSession,dispatch:(input:FleetDispatch)=>Promise<{run:Run}>):Promise<void>{
  const messages=session.messages;
  let index=messages.length-1;
  while(index>=0&&messages[index]?.role!=="assistant")index--;
  const last=messages[index];
  if(last?.role!=="assistant"||messages.slice(index+1).some(message=>message.role==="user"))return;
  const completed=new Set(messages.slice(index+1).flatMap(message=>message.role==="toolResult"?[message.toolCallId]:[]));
  let repaired=false;
  for(const part of last.content){
    if(part.type!=="toolCall"||part.name!=="fleet_dispatch"||completed.has(part.id))continue;
    const input=part.arguments as unknown as FleetDispatch;
    const {run}=await dispatch({...input,requestId:input.requestId??part.id});
    const message={role:"toolResult" as const,toolCallId:part.id,toolName:part.name,...dispatchResult(run),isError:false,timestamp:Date.now()};
    session.sessionManager.appendMessage(message);
    session.agent.state.messages=[...session.messages,message];
    repaired=true;
  }
  if(repaired)syncTranscript(session);
}

export function fleetTools(dispatch:(input:FleetDispatch)=>Promise<{run:Run}>) {
  return [defineTool({
    name:"fleet_dispatch",
    label:"Fleet dispatch",
    description:`${DELEGATION_POLICY}\n\nCreate a child run and return its ID immediately. Results steer this coordinator after its current tool calls. Delivery survives process restarts. The child model is immutable. Escalation creates a new child with escalatesRunId. Children share this run's cwd and budget, not its transcript.`,
    parameters:Type.Object({
      task:Type.String({minLength:1}),
      model:Type.Union(FLEET_MODELS.map(model=>Type.Literal(model)),{description:SUBAGENT_MODEL_DESCRIPTIONS}),
      requestId:Type.Optional(Type.String({minLength:1,maxLength:256,description:"Idempotency key. Defaults to the tool call ID."})),
      escalatesRunId:Type.Optional(Type.String()),
    },{additionalProperties:false}),
    execute:async(toolCallId,params)=>{
      const {run}=await dispatch({...params,requestId:params.requestId??toolCallId});
      return dispatchResult(run);
    },
  })];
}

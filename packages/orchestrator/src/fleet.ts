import { catalogAgentType, catalogModel } from "./catalog.js";
import { FLEET_MODELS, type FleetDispatch, type FleetResult, type Run } from "./domain.js";
import type { Store } from "./store.js";

export type FleetError = "invalid-dispatch" | "parent-not-found" | "not-coordinator" | "parent-not-running" | "request-conflict" | "invalid-escalation" | "model-unavailable" | "invalid-receipt";
export type FleetOutcome<T> = {ok:true;value:T} | {ok:false;error:FleetError};
const terminal = (run:Run) => ["done","failed","aborted"].includes(run.state);
export function isFleetCoordinator(run:Run):boolean {
  return !run.parentRunId && !run.context && ["astra","sol"].includes(catalogAgentType(run.model??"").key);
}
export function isFleetDispatch(input:unknown):input is FleetDispatch {
  if(!input||typeof input!=="object"||Array.isArray(input))return false;
  const value=input as Record<string,unknown>;
  return Object.keys(value).every(key=>["requestId","task","model","escalatesRunId"].includes(key)) &&
    typeof value.requestId==="string" && value.requestId.length>0 && value.requestId.length<=256 &&
    typeof value.task==="string" && value.task.trim().length>0 &&
    FLEET_MODELS.includes(value.model as FleetDispatch["model"]) &&
    (value.escalatesRunId===undefined || typeof value.escalatesRunId==="string");
}

export class Fleet {
  constructor(private readonly store:Store) {}

  dispatch(parentRunId:string,input:unknown):FleetOutcome<Run> {
    return this.store.transaction(()=>this.dispatchLocked(parentRunId,input));
  }
  private dispatchLocked(parentRunId:string,input:unknown):FleetOutcome<Run> {
    if(!isFleetDispatch(input))return{ok:false,error:"invalid-dispatch"};
    const parent=this.store.run(parentRunId);
    if(!parent)return{ok:false,error:"parent-not-found"};
    if(!isFleetCoordinator(parent))return{ok:false,error:"not-coordinator"};
    const previous=this.store.childRunIds(parentRunId).map(id=>this.store.run(id)!).find(run=>this.store.fleetChild(run.id)?.requestId===input.requestId);
    if(previous){
      const child=this.store.fleetChild(previous.id)!;
      return child.task===input.task&&child.model===input.model&&child.escalatesRunId===input.escalatesRunId
        ?{ok:true,value:previous}:{ok:false,error:"request-conflict"};
    }
    if(parent.state!=="running")return{ok:false,error:"parent-not-running"};
    if(input.escalatesRunId){
      const prior=this.store.fleetChild(input.escalatesRunId);
      if(!prior||prior.parentRunId!==parentRunId||prior.model===input.model)return{ok:false,error:"invalid-escalation"};
    }
    const model=catalogModel(input.model);
    if(!model)return{ok:false,error:"model-unavailable"};
    const [id]=this.store.createRuns({count:1,source:"direct",sourceId:parent.sourceId,prompt:input.task,cwd:parent.cwd,profile:input.model,budget:parent.budget,
      child:{...input,parentRunId,rootRunId:parent.rootRunId??parent.id,assignment:{provider:model.provider,model:model.model,thinking:model.thinking}}});
    return{ok:true,value:this.store.run(id!)!};
  }

  pending(parentRunId:string):FleetResult[] {
    return this.store.childRunIds(parentRunId).flatMap(id=>{
      const run=this.store.run(id)!;
      if(!terminal(run)||this.store.control(`fleet-delivered:${id}`))return[];
      return[{deliveryId:`fleet-result:${id}`,runId:id,parentRunId,model:run.model??this.store.fleetChild(id)!.assignment.model,
        state:run.state as FleetResult["state"],result:run.result??"",failureKind:run.failureKind,sessionFile:run.sessionFile}];
    });
  }

  acknowledge(parentRunId:string,deliveryIds:unknown):FleetOutcome<void> {
    if(!Array.isArray(deliveryIds)||deliveryIds.some(id=>typeof id!=="string"||!id.startsWith("fleet-result:")))return{ok:false,error:"invalid-receipt"};
    const ids=deliveryIds.map(id=>(id as string).slice("fleet-result:".length));
    if(ids.some(id=>{const run=this.store.run(id);return !run||!terminal(run)||run.parentRunId!==parentRunId;}))return{ok:false,error:"invalid-receipt"};
    this.store.transaction(()=>{for(const id of ids)this.store.setControl(`fleet-delivered:${id}`,String(Date.now()));});
    return{ok:true,value:undefined};
  }

  settle(id:string,result:string):Run {
    this.store.transaction(()=>{
      const run=this.store.run(id)!;
      if(terminal(run))return;
      const children=this.store.childRunIds(id).map(child=>this.store.run(child)!);
      const waiting=children.some(child=>!terminal(child)||!this.store.control(`fleet-delivered:${child.id}`));
      this.store.updateRun(id,{state:waiting?"waiting":"done",result});
    });
    return this.store.run(id)!;
  }
}

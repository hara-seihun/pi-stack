import { closeSync, fsyncSync, openSync } from "node:fs";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { FleetResult } from "../domain.js";

export function syncTranscript(session:AgentSession):void {
  const path=session.sessionManager.getSessionFile();
  if(!path)throw new Error("Fleet result delivery requires a durable Pi transcript");
  const fd=openSync(path,"r");
  try{fsyncSync(fd);}finally{closeSync(fd);}
}

function receipts(session:AgentSession):Set<string|undefined>{
  return new Set(session.sessionManager.getBranch().flatMap(entry=>
    entry.type==="custom_message"&&entry.customType==="fleet-result"?[(entry.details as {deliveryId?:string})?.deliveryId]:[]));
}

export class FleetResultDelivery {
  private readonly queued=new Set<string>();
  private readonly pending=new Set<string>();
  private flushing:Promise<void>=Promise.resolve();
  private readonly unsubscribe:()=>void;
  constructor(private readonly session:AgentSession,private readonly acknowledge:(ids:string[])=>Promise<unknown>,onError:(error:unknown)=>void){
    this.unsubscribe=session.subscribe(event=>{
      if(event.type==="message_end"&&event.message.role==="custom"&&event.message.customType==="fleet-result"){
        // Pi notifies subscribers immediately before appending the streamed message.
        void this.flush().catch(onError);
      }
    });
  }
  async receive(results:readonly FleetResult[],activeOnly=false):Promise<void>{
    if(!results.length)return;
    const received=receipts(this.session);
    for(const result of results){
      if(received.has(result.deliveryId)){this.pending.add(result.deliveryId);continue;}
      if(this.queued.has(result.deliveryId))continue;
      if(activeOnly&&!this.session.isStreaming)continue;
      this.queued.add(result.deliveryId);this.pending.add(result.deliveryId);
      try{
        await this.session.sendCustomMessage({customType:"fleet-result",content:JSON.stringify(result),display:true,details:{deliveryId:result.deliveryId}},this.session.isStreaming?{deliverAs:"steer"}:{triggerTurn:false});
      }catch(error){this.queued.delete(result.deliveryId);throw error;}
    }
    await this.flush();
  }
  flush():Promise<void>{
    const operation=this.flushing.then(async()=>{
      if(!this.pending.size)return;
      const received=receipts(this.session),ids=[...this.pending].filter(id=>received.has(id));
      if(!ids.length)return;
      syncTranscript(this.session);
      await this.acknowledge(ids);
      for(const id of ids){this.pending.delete(id);this.queued.delete(id);}
    });
    this.flushing=operation.catch(()=>{});
    return operation;
  }
  async close():Promise<void>{this.unsubscribe();await this.flush();}
}

export function fleetTurnSettled(session:AgentSession):boolean {
  const last=session.messages.at(-1);
  return last?.role==="assistant"&&last.stopReason==="stop";
}

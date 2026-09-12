import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager, type AgentSession } from "@earendil-works/pi-coding-agent";
import { expect, it } from "vitest";
import { FleetResultDelivery, fleetTurnSettled } from "../src/host/fleet-results.js";
import type { FleetResult, Run } from "../src/domain.js";
import { fleetTools, recoverFleetDispatches } from "../src/host/fleet-tools.js";
import { DELEGATION_POLICY } from "../src/delegation-policy.js";

it("registers the shared delegation guidance without dispatching work", () => {
  const [tool] = fleetTools(async () => { throw new Error("registration must not dispatch"); });
  expect(tool.name).toBe("fleet_dispatch");
  expect(tool.description.startsWith(`${DELEGATION_POLICY}\n\n`)).toBe(true);
});

function fakeSession(manager:SessionManager):AgentSession {
  const agent={state:{messages:manager.buildSessionContext().messages}};
  return{sessionManager:manager,agent,subscribe:()=>()=>{},get messages(){return agent.state.messages;},sendCustomMessage:async(message:any)=>{
    manager.appendCustomMessageEntry(message.customType,message.content,message.display,message.details);
    agent.state.messages.push({role:"custom",...message,timestamp:Date.now()});
  }} as unknown as AgentSession;
}
it("steers a busy parent and acknowledges only after the result actually enters its transcript",async()=>{
  const dir=mkdtempSync(join(tmpdir(),"fleet-steer-"));
  try{
    const manager=SessionManager.create(dir,dir);
    manager.appendMessage({role:"assistant",content:[{type:"toolCall",id:"tool",name:"read",arguments:{path:"fixture"}}],stopReason:"toolUse",timestamp:Date.now()} as any);
    const listeners=new Set<(event:any)=>void>(),queue:any[]=[],acks:string[][]=[];
    const session=fakeSession(manager);
    Object.defineProperty(session,"isStreaming",{value:true});
    session.subscribe=((listener:any)=>{listeners.add(listener);return()=>{listeners.delete(listener);};}) as any;
    session.sendCustomMessage=(async(message:any,options:any)=>{expect(options).toEqual({deliverAs:"steer"});queue.push(message);}) as any;
    const delivery=new FleetResultDelivery(session,async ids=>{acks.push(ids);},error=>{throw error;});
    const result:FleetResult={deliveryId:"fleet-result:busy-child",runId:"busy-child",parentRunId:"parent",model:"gpt-5.6-terra",state:"done",result:"available before parent finishes"};
    await delivery.receive([result],true);
    await delivery.receive([result],true);
    expect(queue).toHaveLength(1);
    expect(acks).toEqual([]);
    manager.appendMessage({role:"toolResult",toolCallId:"tool",toolName:"read",content:[{type:"text",text:"read finished"}],isError:false,timestamp:Date.now()});
    const message={role:"custom",...queue[0],timestamp:Date.now()};
    for(const listener of listeners)listener({type:"message_end",message});
    manager.appendCustomMessageEntry(message.customType,message.content,message.display,message.details);
    await delivery.flush();
    expect(session.isStreaming).toBe(true);
    expect(acks).toEqual([[result.deliveryId]]);
    const branch=manager.getBranch(),receipt=branch.at(-1);
    expect(receipt?.type).toBe("custom_message");
    expect(branch.some(entry=>entry.type==="message"&&entry.message.role==="assistant"&&entry.message.stopReason==="stop")).toBe(false);
    await delivery.close();
  }finally{rmSync(dir,{recursive:true,force:true});}
});

it("recovers an accepted dispatch with a lost response under its original tool-call ID",async()=>{
  const dir=mkdtempSync(join(tmpdir(),"fleet-dispatch-recovery-"));
  try{
    const manager=SessionManager.create(dir,dir);
    manager.appendMessage({role:"assistant",content:[{type:"toolCall",id:"call-original",name:"fleet_dispatch",arguments:{task:"work",model:"terra"}}],stopReason:"toolUse",timestamp:Date.now()} as any);
    const accepted=new Map<string,Run>();
    const dispatch=async(input:any)=>{
      let run=accepted.get(input.requestId);
      if(!run){run={id:crypto.randomUUID(),parentRunId:"parent",requestedModel:input.model,state:"queued"} as Run;accepted.set(input.requestId,run);}
      return{run};
    };
    const original=await dispatch({requestId:"call-original",task:"work",model:"terra"});
    const reopened=SessionManager.open(manager.getSessionFile()!);
    await recoverFleetDispatches(fakeSession(reopened),dispatch);
    const second=SessionManager.open(manager.getSessionFile()!);
    await recoverFleetDispatches(fakeSession(second),dispatch);
    expect(accepted.size).toBe(1);
    const results=second.getBranch().filter(entry=>entry.type==="message"&&entry.message.role==="toolResult");
    expect(results).toHaveLength(1);
    expect(JSON.stringify(results[0])).toContain(original.run.id);
    expect(JSON.stringify(results[0])).toContain("call-original");
  }finally{rmSync(dir,{recursive:true,force:true});}
});

it("a restart after transcript receipt but before ledger acknowledgement does not duplicate a result",async()=>{
  const dir=mkdtempSync(join(tmpdir(),"fleet-receipts-"));
  try{
    const manager=SessionManager.create(dir,dir);
    manager.appendMessage({role:"assistant",content:[{type:"text",text:"waiting"}],stopReason:"stop",timestamp:Date.now()} as any);
    const result:FleetResult={deliveryId:"fleet-result:child",runId:"child",parentRunId:"parent",model:"gpt-5.6-terra",state:"done",result:"child answer"};
    const session=fakeSession(manager);
    expect(fleetTurnSettled(session)).toBe(true);
    const interrupted=new FleetResultDelivery(session,async()=>{throw new Error("daemon stopped");},error=>{throw error;});
    await expect(interrupted.receive([result])).rejects.toThrow("daemon stopped");
    await expect(interrupted.close()).rejects.toThrow("daemon stopped");
    const reopened=SessionManager.open(manager.getSessionFile()!);
    const resumed=fakeSession(reopened),acks:string[][]=[];
    expect(fleetTurnSettled(resumed)).toBe(false);
    const delivery=new FleetResultDelivery(resumed,async ids=>{acks.push(ids);},error=>{throw error;});
    await delivery.receive([result]);
    await delivery.close();
    expect(acks).toEqual([[result.deliveryId]]);
    expect(reopened.getBranch().filter(entry=>entry.type==="custom_message")).toHaveLength(1);
    reopened.appendMessage({role:"assistant",content:[{type:"text",text:"combined answer"}],stopReason:"stop",timestamp:Date.now()} as any);
    expect(fleetTurnSettled(fakeSession(SessionManager.open(manager.getSessionFile()!)))).toBe(true);
  }finally{rmSync(dir,{recursive:true,force:true});}
});

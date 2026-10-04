import { afterEach, expect, test, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import routing, { POOLED_ACCOUNT_WAIT } from "../src/extension/routing.js";
import { Store } from "../src/store.js";
import { catalogModel } from "../src/catalog.js";

const roots:string[]=[];
afterEach(()=>{vi.unstubAllEnvs();roots.splice(0).forEach(root=>rmSync(root,{recursive:true}));});

function fixture(assigned=false){
  const root=mkdtempSync(join(tmpdir(),"routing-capacity-"));roots.push(root);
  const ledger=join(root,"ledger.sqlite3"),auth=join(root,"auth.json");
  const accounts=["anthropic-1","anthropic-2","anthropic-3"];
  writeFileSync(auth,JSON.stringify(Object.fromEntries(accounts.map(id=>[id,{type:"oauth",access:"test",refresh:"test",expires:Date.now()+3_600_000}]))));
  const store=Store.open(ledger);
  accounts.forEach(id=>store.upsertAccount({id,provider:"anthropic"}));
  for(const [key,value] of Object.entries({PI_ORCHESTRATOR_LEDGER:ledger,PI_ORCHESTRATOR_AUTH:auth,PI_ORCHESTRATOR_ASSIGNED:assigned?"1":"0",PI_ORCHESTRATOR_RUN_ID:"",PI_ORCHESTRATOR_CONFIG:join(root,"missing"),PI_THREAD_SPEED:"standard"}))vi.stubEnv(key,value);
  vi.stubEnv("PI_SUBAGENT_MODEL",undefined);vi.stubEnv("PI_MODEL_BROKER_URL",undefined);
  const events=new Map<string,Array<(event:any,ctx:any)=>any>>();
  const ctx={model:{id:catalogModel("opus")!.model,provider:accounts[0]},ui:{notify:vi.fn()},modelRegistry:{refresh:vi.fn()},sessionManager:{getSessionId:()=>"fixture"}};
  const pi={on(name:string,handler:any){events.set(name,[...(events.get(name)??[]),handler]);},registerProvider(){},registerTool(){},events:{on:()=>()=>{}},getActiveTools:()=>[],setActiveTools(){},appendEntry:vi.fn(),getThinkingLevel:()=>"high",setThinkingLevel:vi.fn(),setModel:vi.fn(async(model:any)=>{ctx.model=model;return true;})};
  routing(pi as any);
  const emit=async(name:string,event={})=>{const replies=[];for(const handler of events.get(name)??[])replies.push(await handler(event,ctx));return replies;};
  const refuse=async()=>{await emit("agent_end",{messages:[{role:"assistant",stopReason:"error",errorMessage:"429 account rate limit",provider:ctx.model.provider,model:ctx.model.id}]});return emit("agent_before_settle");};
  return{store,ctx,pi,emit,refuse,accounts};
}

test.each([false,true])("each refused account gets at most one request in a round, assigned=%s",async assigned=>{
  const f=fixture(assigned);
  try{
    const seen:string[]=[];
    for(let i=0;i<(assigned?1:3);i++){
      await expect(f.emit("before_provider_request")).resolves.toBeDefined();
      seen.push(f.ctx.model.provider);
      const boundary=await f.refuse();
      expect(boundary.some((result:any)=>result?.continue)).toBe(!assigned&&i<2);
    }
    expect(new Set(seen).size).toBe(seen.length);
    await expect(f.emit("before_provider_request")).rejects.toThrow(POOLED_ACCOUNT_WAIT);
    expect(f.ctx.model.id).toBe(catalogModel("opus")!.model);
    expect(f.pi.setThinkingLevel.mock.calls.every(([level])=>level==="high")).toBe(true);
  }finally{await f.emit("session_shutdown");f.store.close();}
});

test("an internal round guard cannot shorten a provider's monthly refusal hold",async()=>{
  const f=fixture(true);
  try{
    await f.emit("agent_end",{messages:[{role:"assistant",stopReason:"error",errorMessage:"429 monthly spend limit reached",provider:f.ctx.model.provider,model:f.ctx.model.id}]});
    const until=f.store.account(f.ctx.model.provider)!.cooldownUntil;
    await expect(f.emit("before_provider_request")).rejects.toThrow(POOLED_ACCOUNT_WAIT);
    await f.emit("agent_end",{messages:[{role:"assistant",stopReason:"error",errorMessage:POOLED_ACCOUNT_WAIT,provider:f.ctx.model.provider,model:f.ctx.model.id}]});
    expect(f.store.account(f.ctx.model.provider)!.cooldownUntil).toBe(until);
    await f.emit("agent_end",{messages:[{role:"assistant",stopReason:"error",errorMessage:"429 account rate limit",provider:f.ctx.model.provider,model:f.ctx.model.id}]});
    expect(f.store.account(f.ctx.model.provider)!.cooldownUntil).toBe(until);
  }finally{await f.emit("session_shutdown");f.store.close();}
});

test("fresh exhausted siblings cannot hide a cooling account with Opus quota; acceptance ends its round",async()=>{
  const f=fixture();
  try{
    f.store.recordMeter(f.accounts[2],"anthropic-5h",100,Date.now()+3_600_000);
    f.store.recordMeter(f.accounts[1],"anthropic-5h",0,Date.now()+3_600_000);
    f.store.recordMeter(f.accounts[1],"anthropic-7d",72,Date.now()+86_400_000);
    f.store.setCooldown(f.accounts[1],Date.now()+86_400_000,{model:f.ctx.model.id});
    expect(await f.refuse()).toContainEqual(expect.objectContaining({continue:true}));
    expect(f.ctx.model.provider).toBe(f.accounts[1]);
    await f.emit("message_end",{message:{role:"assistant",stopReason:"stop",provider:f.ctx.model.provider,model:f.ctx.model.id,timestamp:Date.now()+1}});
    expect(await f.emit("agent_before_settle")).not.toContainEqual(expect.objectContaining({continue:true}));
    await expect(f.emit("before_provider_request")).resolves.toBeDefined();
  }finally{await f.emit("session_shutdown");f.store.close();}
});

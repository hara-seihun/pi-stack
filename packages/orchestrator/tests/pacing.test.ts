import { describe, expect, it } from "vitest";
import { Store } from "../src/store.js";
import { accountCapacity, assign } from "../src/policy.js";
import { Daemon } from "../src/daemon.js";
import { loadConfig } from "../src/config.js";

const HOUR=3_600_000;
const config={...loadConfig("/missing"),profiles:{standard:[{provider:"openai-codex",model:"gpt-6-astra"}]},meterMaxAgeMs:HOUR};
function account(store:Store){store.upsertAccount({id:"openai-codex",provider:"openai-codex",concurrency:1});}

describe("subscription admission",()=>{
  it("accepts boolean queue readiness and rejects numerical worker demand",async()=>{
    const store=Store.open(":memory:"),daemon=new Daemon(store,config,"/release") as any;
    try{
      daemon.snapshotCommand=`printf '%s' '{"revision":"a","lanes":{"math":{"ready":true}}}'`;
      await daemon.refreshReadiness();expect(daemon.laneReady("math")).toBe(true);
      store.setControl("readiness-admitted:math",String(daemon.readinessAt));expect(daemon.laneReady("math")).toBe(false);
      daemon.snapshotCommand=`printf '%s' '{"revision":"b","lanes":{"math":{"count":30}}}'`;daemon.readinessAt=0;
      await daemon.refreshReadiness();expect(daemon.laneReady("math")).toBe(false);expect(store.control("readiness_error")).toContain("ready: boolean");
    }finally{await daemon.threads.close();await daemon.schedules.close();store.close();}
  });

  it.each(["background","force","live"] as const)("admits %s independent of elapsed window, consumption history and account load",budget=>{
    const store=Store.open(":memory:"),now=Date.now();account(store);
    try{
      for(let i=0;i<48;i++)store.createLease(`active:${i}`,"openai-codex","fleet",undefined,now-4*HOUR);
      store.recordMeter("openai-codex","codex-7d",70,now+167*HOUR,now-20*60_000);
      store.recordMeter("openai-codex","codex-7d",99,now+167*HOUR,now);
      store.recordMeter("openai-codex","codex-5h",99,now+5*HOUR,now);
      for(let i=0;i<3;i++)expect(assign(store,"standard",budget,config,now).assignment?.accountId).toBe("openai-codex");
      expect(accountCapacity(store,"openai-codex",budget,config,now).state).toBe("available");
      store.recordMeter("openai-codex","codex-5h",100,now+5*HOUR,now+1);
      expect(assign(store,"standard",budget,config,now+1).refusals[0]?.reason).toContain("provider quota exhausted");
    }finally{store.close();}
  });

  it.each(["background","force","live"] as const)("does not require calibration readings or fresh sub-exhaustion readings for %s",budget=>{
    const store=Store.open(":memory:"),now=Date.now();account(store);
    try{
      store.createLease("completed","openai-codex","fleet",undefined,now-4*HOUR);store.endLease("completed",now-3*HOUR);
      expect(assign(store,"standard",budget,config,now).assignment).toBeDefined();
      store.recordMeter("openai-codex","codex-7d",99,now+168*HOUR,now-2*HOUR);
      expect(assign(store,"standard",budget,config,now).assignment).toBeDefined();
      store.recordMeter("openai-codex","codex-7d",100,now+168*HOUR,now-HOUR);
      expect(assign(store,"standard",budget,config,now).assignment).toBeUndefined();
      store.recordMeter("openai-codex","codex-7d",0,now+168*HOUR,now);
      expect(assign(store,"standard",budget,config,now).assignment).toBeDefined();
    }finally{store.close();}
  });

  it("cannot revive pacing from persisted multiplier or reserve configuration",()=>{
    const store=Store.open(":memory:");account(store);
    try{
      const cfg={...config,backgroundSpendFraction:0,defaultAccountConcurrency:0};
      for(const multiplier of ["0","1","10","invalid"]){
        store.setControl("boost:openai-codex",multiplier);
        expect(assign(store,"standard","background",cfg).assignment).toBeDefined();
      }
    }finally{store.close();}
  });
});

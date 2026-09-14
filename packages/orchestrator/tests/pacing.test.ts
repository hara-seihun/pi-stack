import { describe, expect, it } from "vitest";
import { Store } from "../src/store.js";
import { accountCapacity } from "../src/policy.js";
import { Daemon } from "../src/daemon.js";
import { loadConfig } from "../src/config.js";

const HOUR=3_600_000;
const config={...loadConfig("/missing"),profiles:{standard:[{provider:"openai-codex",model:"gpt-6-astra"}]},maxConcurrentSessions:10,meterMaxAgeMs:HOUR};
function account(store:Store,id="openai-codex"){store.upsertAccount({id,provider:"openai-codex",concurrency:10});}

describe("quota-paced admission",()=>{
  it("accepts boolean queue readiness and rejects numerical worker demand",async()=>{
    const store=Store.open(":memory:"),daemon=new Daemon(store,config,"/release") as any;
    daemon.snapshotCommand=`printf '%s' '{"revision":"a","lanes":{"math":{"ready":true}}}'`;
    await daemon.refreshReadiness();expect(daemon.laneReady("math")).toBe(true);
    store.setControl("readiness-admitted:math",String(daemon.readinessAt));expect(daemon.laneReady("math")).toBe(false);
    daemon.snapshotCommand=`printf '%s' '{"revision":"b","lanes":{"math":{"count":30}}}'`;daemon.readinessAt=0;
    await daemon.refreshReadiness();expect(daemon.laneReady("math")).toBe(false);expect(store.control("readiness_error")).toContain("ready: boolean");store.close();
  });

  it("does not treat two equal whole-percent readings as permission to spend ahead of plan",()=>{
    const store=Store.open(":memory:"),now=Date.now();account(store);
    store.recordMeter("openai-codex","codex-7d",65,now+144*HOUR,now-5*60_000);
    store.recordMeter("openai-codex","codex-7d",65,now+144*HOUR,now);
    expect(accountCapacity(store,"openai-codex","background",config,now)).toMatchObject({sessions:0,reason:expect.stringContaining("paced allowance")});
    expect(accountCapacity(store,"openai-codex","force",config,now).sessions).toBe(10);store.close();
  });

  it("admits one discrete worker while spend remains within calendar pace",()=>{
    const store=Store.open(":memory:"),now=Date.now(),reset=now+150*HOUR;account(store);
    store.createLease("history","openai-codex","fleet",undefined,now-20*60_000);
    store.endLease("history",now);
    store.recordMeter("openai-codex","codex-7d",3,reset,now-20*60_000);
    store.recordMeter("openai-codex","codex-7d",4,reset,now);
    expect(accountCapacity(store,"openai-codex","background",config,now)).toMatchObject({
      sessions:1,
      reason:expect.stringContaining("% per session-hour"),
    });
    store.recordMeter("openai-codex","codex-7d",10,reset,now+1000);
    expect(accountCapacity(store,"openai-codex","background",config,now+1000)).toMatchObject({
      sessions:0,
      reason:expect.stringContaining("exceeds paced allowance"),
    });
    store.close();
  });

  it("uses hours of consumption and lease exposure, not the last flat sample",()=>{
    const store=Store.open(":memory:"),now=Date.now(),reset=now+84*HOUR;account(store);
    for(let i=0;i<4;i++)store.createLease(`session:${i}`,"openai-codex","fleet",undefined,now-4*HOUR);
    for(let i=0;i<4;i++)store.heartbeatLease(`session:${i}`,now);
    store.recordMeter("openai-codex","codex-7d",10,reset,now-4*HOUR);
    store.recordMeter("openai-codex","codex-7d",18,reset,now-5*60_000);
    store.recordMeter("openai-codex","codex-7d",18,reset,now);
    expect(accountCapacity(store,"openai-codex","background",config,now).sessions).toBe(1);
    store.recordMeter("openai-codex","codex-7d",18,reset,now+1000);
    expect(accountCapacity(store,"openai-codex","background",config,now+1000).sessions).toBe(1);store.close();
  });

  it("does not mix reset windows or let a fresh meter hide a stale binding meter",()=>{
    const store=Store.open(":memory:"),now=Date.now();account(store);
    store.recordMeter("openai-codex","codex-7d",70,now-1000,now-2*HOUR);
    store.recordMeter("openai-codex","codex-7d",0,now+168*HOUR,now);
    expect(accountCapacity(store,"openai-codex","background",config,now).sessions).toBe(1);
    store.recordMeter("openai-codex","codex-5h",5,now+HOUR,now-2*HOUR);
    expect(accountCapacity(store,"openai-codex","background",config,now)).toMatchObject({sessions:0,reason:"meter is stale"});store.close();
  });

  it("multiplies calculated capacity after calibration and fills from one meter even ahead of calendar pace",async()=>{
    const store=Store.open(":memory:"),now=Date.now(),reset=now+144*HOUR;
    store.upsertAccount({id:"openai-codex",provider:"openai-codex",concurrency:4});
    store.createLease("history","openai-codex","fleet",undefined,now-4*HOUR);
    store.endLease("history",now);
    store.recordMeter("openai-codex","codex-7d",8,reset,now-4*HOUR);
    store.recordMeter("openai-codex","codex-7d",9,reset,now);
    const cfg={...config,backgroundSpendFraction:1,maxConcurrentSessions:90};
    expect(accountCapacity(store,"openai-codex","background",cfg,now).sessions).toBe(1);
    store.setControl("boost:openai-codex","10");
    expect(accountCapacity(store,"openai-codex","background",cfg,now)).toMatchObject({sessions:10,reason:expect.stringContaining("1 base × 10 = 10")});
    store.recordMeter("openai-codex","codex-7d",25,reset,now+1000);
    expect(accountCapacity(store,"openai-codex","background",cfg,now+1000).reason).not.toContain("exceeds paced allowance");
    store.setControl("boost:openai-codex","1");
    expect(accountCapacity(store,"openai-codex","background",cfg,now+1000).reason).toContain("exceeds paced allowance");
    store.setControl("boost:openai-codex","10");
    store.recordMeter("openai-codex","codex-7d",100,reset,now+2000);
    expect(accountCapacity(store,"openai-codex","background",cfg,now+2000)).toMatchObject({sessions:0,reason:"provider quota exhausted"});
    store.close();
  });

});

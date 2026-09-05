import { describe, expect, it } from "vitest";
import { Readable } from "node:stream";
import { Store } from "../src/store.js";
import { accountCapacity } from "../src/policy.js";
import { Daemon } from "../src/daemon.js";
import { loadConfig } from "../src/config.js";

const HOUR=3_600_000;
const config={...loadConfig("/missing"),profiles:{standard:[{provider:"openai-codex",model:"gpt-6-astra"}]},maxConcurrentSessions:10,meterMaxAgeMs:HOUR};
const lane=(id:string,weight=1)=>({id,weight,prompt:"work",cwd:"/tmp",profile:"standard"});
function account(store:Store,id="openai-codex"){store.upsertAccount({id,provider:"openai-codex",concurrency:10});}
function run(store:Store,laneId="math",budget:"background"|"force"="background"){
  const [id]=store.createRuns({count:1,source:"lane",sourceId:laneId,prompt:"work",cwd:"/tmp",profile:"standard",budget});
  store.assignRun(id!,{accountId:"openai-codex",provider:"openai-codex",model:"gpt-6-astra",unit:id!,releasePath:"/release"});
  store.updateRun(id!,{state:"running",sessionFile:"/saved.jsonl"});return id!;
}

describe("quota-paced admission",()=>{
  it("still honors explicit operator aborts",async()=>{
    const store=Store.open(":memory:");account(store);const id=run(store);
    const daemon=new Daemon(store,config,"/release") as any;
    const req=Readable.from([JSON.stringify({state:"aborted",failureKind:"operator",result:"aborted"})]) as any;
    req.method="POST";req.url=`/internal/runs/${id}/state`;
    let response="";await daemon.request(req,{writeHead:()=>{},end:(value:string)=>{response=value;}});
    expect(JSON.parse(response)).toEqual({ok:true});
    expect(store.run(id)).toMatchObject({state:"aborted",sessionFile:"/saved.jsonl"});
    expect(store.activeLeases()).toHaveLength(0);store.close();
  });

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

  it("lets admitted workers finish while denying new launches above pacing and machine ceilings",async()=>{
    const store=Store.open(":memory:"),now=Date.now();account(store);store.reconcileLanes([lane("math")]);
    const ids=[run(store),run(store)];store.recordMeter("openai-codex","codex-7d",65,now+144*HOUR,now);
    const daemon=new Daemon(store,{...config,maxConcurrentSessions:1},"/release") as any;
    daemon.loadManifest=async()=>{};daemon.codexMeters.sample=async()=>{};daemon.anthropicMeters.sample=async()=>{};
    daemon.unitIsActive=()=>true;daemon.startUnit=()=>{throw new Error("new launches must be refused");};
    daemon.stopUnit=()=>{throw new Error("existing workers must not stop");};
    await daemon.reconcile();
    expect(store.activeLeases()).toHaveLength(2);expect(store.admittedLaneCount("math")).toBe(2);
    for(const id of ids){
      expect(store.run(id)).toMatchObject({state:"running",sessionFile:"/saved.jsonl"});
      const req={method:"GET",url:`/internal/runs/${id}/control`} as any;
      let response="";await daemon.request(req,{writeHead:()=>{},end:(value:string)=>{response=value;}});
      expect(JSON.parse(response)).toEqual({});
    }
    expect(store.runs()).toHaveLength(2);store.close();
  });

  it("fills weighted lanes without targets or preallocating a worker queue",async()=>{
    const store=Store.open(":memory:");for(let i=0;i<3;i++)account(store,`openai-codex-${i}`);
    store.reconcileLanes([lane("narrow"),lane("wide",2)]);
    const daemon=new Daemon(store,config,"/release") as any;daemon.startUnit=()=>{};
    await daemon.fillCapacity();
    expect(store.admittedLaneCount("narrow")).toBe(1);expect(store.admittedLaneCount("wide")).toBe(2);
    expect(store.runs(["queued"])).toEqual([]);store.close();
  });

  it("recovers already admitted sessions even when quota refuses new work",async()=>{
    const store=Store.open(":memory:"),now=Date.now();account(store);store.reconcileLanes([lane("math")]);
    const id=run(store);store.endLease(`run:${id}`);store.recordMeter("openai-codex","codex-7d",65,now+144*HOUR,now);
    const daemon=new Daemon(store,config,"/release") as any,resumed:string[]=[];
    daemon.unitIsActive=()=>false;daemon.startUnit=(_unit:string,savedId:string)=>resumed.push(savedId);
    daemon.recoverWorkers();await daemon.fillCapacity();
    expect(resumed).toEqual([id]);expect(store.run(id)).toMatchObject({state:"starting",sessionFile:"/saved.jsonl",model:"gpt-6-astra",releasePath:"/release"});
    expect(store.activeLeases()).toHaveLength(1);expect(store.runs()).toHaveLength(1);store.close();
  });
});

import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Daemon } from "../src/daemon.js";
import { loadConfig } from "../src/config.js";
import { accountCapacity } from "../src/policy.js";
import { Store } from "../src/store.js";

const HOUR=3_600_000;
const lanes=["communications","delivery","execution","review","operations"];
const cleanup:(()=>void)[]=[];
afterEach(()=>{for(const close of cleanup.splice(0).reverse())close();});

function fixture(budget:unknown="force",maxConcurrentSessions=10){
  const root=mkdtempSync(join(tmpdir(),"lane-budget-"));
  cleanup.push(()=>rmSync(root,{recursive:true,force:true}));
  const store=Store.open(join(root,"ledger.sqlite3"));cleanup.push(()=>store.close());
  const taskManifest=join(root,"lanes.json"),snapshot=join(root,"readiness.json");
  const config={...loadConfig("/missing"),profiles:{standard:[{provider:"openai-codex",model:"gpt-6-astra"}]},
    maxConcurrentSessions,meterMaxAgeMs:HOUR,taskManifest,authPath:join(root,"auth.json")};
  const manifest={version:2,budget,snapshotCommand:`cat ${JSON.stringify(snapshot)}`,
    lanes:lanes.map(id=>({id,prompt:"work",cwd:root,profile:"standard",weight:1}))};
  let mtime=Date.now();
  const writeManifest=(value:unknown=manifest)=>{writeFileSync(taskManifest,JSON.stringify(value));utimesSync(taskManifest,new Date(mtime+=1000),new Date(mtime));};
  writeManifest();
  const ready=(ids:readonly string[])=>writeFileSync(snapshot,JSON.stringify({revision:nextRevision(),lanes:Object.fromEntries(lanes.map(id=>[id,{ready:ids.includes(id)}]))}));
  ready(lanes);
  store.upsertAccount({id:"work",provider:"openai-codex",concurrency:10});
  store.recordMeter("work","codex-7d",95,Date.now()+167*HOUR,Date.now()-2*HOUR);
  store.setControl("boost:openai-codex","0");
  const daemon=()=>{
    const instance=new Daemon(store,config,"/release") as any;
    instance.codexMeters.sample=async()=>[];instance.anthropicMeters.sample=async()=>[];
    instance.startUnit=(_unit:string,id:string)=>store.updateRun(id,{state:"running"});
    instance.unitIsActive=()=>true;instance.unitIsActiveAsync=async()=>true;
    instance.stopUnit=()=>{throw new Error("admitted workers must survive admission changes");};
    return instance;
  };
  const next=async(instance:any)=>{instance.readinessAt=0;await instance.reconcile();};
  return {store,config,manifest,snapshot,writeManifest,ready,daemon,next};
}
let revision=0;
function nextRevision(){return String(++revision);}

describe("work-driven lane admission",()=>{
  it("runs every ready lane past pacing, reserves, stale meters and boosts, then stops and resumes from readiness",async()=>{
    const f=fixture(),d=f.daemon();
    expect(accountCapacity(f.store,"work","background",f.config).sessions).toBe(0);
    await d.reconcile();
    expect(f.store.runs()).toHaveLength(5);
    expect(f.store.runs().map(r=>r.sourceId).sort()).toEqual([...lanes].sort());
    expect(f.store.runs().every(r=>r.source==="lane"&&r.budget==="force"&&r.state==="running")).toBe(true);
    expect(d.status()).toMatchObject({laneBudget:"force",capacity:[{sessions:10,reason:"urgent spend"}]});
    await d.reconcile();expect(f.store.runs()).toHaveLength(5);
    for(const run of f.store.runs())f.store.updateRun(run.id,{state:"done"});
    f.ready([]);await f.next(d);
    expect(f.store.runs()).toHaveLength(5);expect(f.store.activeLeases()).toHaveLength(0);
    const restarted=f.daemon();await restarted.reconcile();expect(f.store.runs()).toHaveLength(5);
    f.ready(["communications"]);await f.next(restarted);
    expect(f.store.runs()).toHaveLength(6);
    expect(f.store.runs(["running"])).toMatchObject([{sourceId:"communications",budget:"force"}]);
  });

  it("never reuses a positive observation after a failed, malformed or incomplete readiness probe",async()=>{
    const f=fixture(),d=f.daemon();f.ready(["communications"]);await d.reconcile();
    const id=f.store.runs()[0]!.id;
    for(const value of ["not json",JSON.stringify({revision:"bad",lanes:{execution:{count:10}}}),JSON.stringify({revision:"missing",lanes:{}})]){
      writeFileSync(f.snapshot,value);await f.next(d);
      expect(f.store.runs()).toHaveLength(1);expect(f.store.run(id)?.state).toBe("running");
      expect(f.store.control("readiness_error")).toBeTruthy();
    }
    rmSync(f.snapshot);await f.next(d);expect(f.store.runs()).toHaveLength(1);expect(f.store.control("readiness_error")).toBeTruthy();
    f.ready(["execution"]);await f.next(d);expect(f.store.runs()).toHaveLength(2);expect(f.store.control("readiness_error")).toBe("");
  });

  it.each(["exhausted","disabled","cooldown","voice","pause","account-full"])("retains the native %s gate",async gate=>{
    const f=fixture(),now=Date.now();
    if(gate==="exhausted")f.store.recordMeter("work","codex-7d",100,now+167*HOUR,now);
    if(gate==="disabled")f.store.setAccountEnabled("work",false);
    if(gate==="cooldown")f.store.setCooldown("work",now+HOUR);
    if(gate==="voice")f.store.setControl("account-use:work","voice");
    if(gate==="pause")f.store.setControl("launches","paused");
    if(gate==="account-full")for(let i=0;i<10;i++)f.store.createLease(`interactive:${i}`,"work","interactive");
    await f.daemon().reconcile();expect(f.store.runs()).toHaveLength(0);
  });

  it("shares the machine ceiling with existing interactive sessions",async()=>{
    const f=fixture("force",2);f.store.createLease("interactive","work","interactive");
    await f.daemon().reconcile();expect(f.store.runs()).toHaveLength(1);expect(f.store.activeLeases()).toHaveLength(2);
  });

  it("reloads budget changes without stopping existing workers and leaves other manifests paced",async()=>{
    const f=fixture(),d=f.daemon();f.ready(["execution"]);await d.reconcile();
    const id=f.store.runs()[0]!.id;
    f.writeManifest({...f.manifest,budget:"background"});f.ready(lanes);await d.reconcile();
    expect(f.store.runs()).toHaveLength(1);expect(f.store.run(id)?.budget).toBe("force");
    expect(d.status()).toMatchObject({laneBudget:"background",capacity:[{sessions:0}]});
    const {budget:_,...defaultManifest}=f.manifest;f.writeManifest(defaultManifest);
    const restarted=f.daemon();await restarted.reconcile();expect(f.store.runs()).toHaveLength(1);
    f.writeManifest(f.manifest);await restarted.reconcile();expect(f.store.runs().length).toBeGreaterThan(1);
  });

  it.each([
    {budget:"unlimited",snapshotCommand:"true"},
    {budget:3,snapshotCommand:"true"},
    {budget:null,snapshotCommand:"true"},
    {budget:"force"},
    {budget:"force",snapshotCommand:" "},
    {budget:"force",snapshotCommand:3},
  ])("rejects an invalid work-driven manifest before changing lanes: %j",async options=>{
    const f=fixture();f.writeManifest({version:2,lanes:f.manifest.lanes,...options});
    await expect(f.daemon().reconcile()).rejects.toThrow(/budget|snapshotCommand/);
    expect(f.store.lanes()).toHaveLength(0);expect(f.store.runs()).toHaveLength(0);
  });
});

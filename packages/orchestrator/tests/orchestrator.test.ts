import { describe, expect, it } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store.js";
import { assign, commitMeterAdmission } from "../src/policy.js";
import type { OrchestratorConfig } from "../src/domain.js";
import { transactSharedCredential } from "../src/auth/shared-oauth.js";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import { withCustomModels } from "../src/extension/routing.js";
import { catalogModel } from "../src/catalog.js";
import { Daemon } from "../src/daemon.js";
import { loadConfig } from "../src/config.js";

const config:OrchestratorConfig={profiles:{standard:[{provider:"openai-codex",model:"gpt-5.6-sol",thinking:"xhigh"}]},backgroundSpendFraction:.8,maxConcurrentSessions:8,defaultAccountConcurrency:2,meterMaxAgeMs:60_000,snapshotIntervalMs:30_000,reconcileIntervalMs:1000,stallAfterMs:60_000,killAfterMs:120_000,authPath:"/tmp/auth",agentDir:"/tmp/agent"};
function account(store:Store,id="openai-codex-1"){store.upsertAccount({id,provider:"openai-codex",concurrency:2});}

describe("current orchestrator state",()=>{
  it("launches every Fable selection on Claude Fable 5.1",()=>{const anthropic=builtinProviders().find((provider)=>provider.id==="anthropic")!;const models=withCustomModels(anthropic).getModels();expect(models.some((model)=>model.id==="claude-fable-5")).toBe(true);expect(models.find((model)=>model.id==="claude-fable-5-1")?.cost.cacheRead).toBe(.25);expect(catalogModel("fable")?.model).toBe("claude-fable-5-1");});

  it("reconciles lane manifests as desired state",()=>{const store=Store.open(":memory:");store.reconcileLanes([{id:"one",prompt:"a",cwd:"/tmp",profile:"standard",weight:1},{id:"two",prompt:"b",cwd:"/tmp",profile:"standard",weight:2}]);store.reconcileLanes([{id:"two",prompt:"changed",cwd:"/work",profile:"standard",weight:3,fixedDemand:2}]);expect(store.lanes()).toEqual([{id:"two",prompt:"changed",cwd:"/work",profile:"standard",weight:3,fixedDemand:2,priority:0,doctrineUrl:undefined,openingProbe:undefined}]);store.close();});

  it("rolls credential custody back when account import fails",async()=>{const root=mkdtempSync(join(tmpdir(),"orchestrator-auth-")),path=join(root,"auth.json");writeFileSync(path,"{}\n");const credential={type:"oauth" as const,access:"access",refresh:"refresh",expires:Date.now()+60_000};await expect(transactSharedCredential(path,"openai-codex-1",credential,async()=>{throw new Error("ledger unavailable");})).rejects.toThrow("ledger unavailable");expect(JSON.parse(readFileSync(path,"utf8"))).toEqual({});rmSync(root,{recursive:true});});

  it("finds shared OAuth beside the canonical ledger behind a per-user symlink",()=>{
    const root=mkdtempSync(join(tmpdir(),"orchestrator-config-")),canonical=join(root,"canonical"),user=join(root,"user"),configPath=join(root,"config.json");
    mkdirSync(canonical);mkdirSync(user);writeFileSync(join(canonical,"ledger.sqlite3"),"");symlinkSync(join(canonical,"ledger.sqlite3"),join(user,"ledger.sqlite3"));writeFileSync(configPath,"{}\n");
    const oldLedger=process.env.PI_ORCHESTRATOR_LEDGER,oldAuth=process.env.PI_ORCHESTRATOR_AUTH;
    try{
      process.env.PI_ORCHESTRATOR_LEDGER=join(user,"ledger.sqlite3");delete process.env.PI_ORCHESTRATOR_AUTH;
      expect(loadConfig(configPath).authPath).toBe(join(canonical,"auth.json"));
    }finally{
      if(oldLedger===undefined)delete process.env.PI_ORCHESTRATOR_LEDGER;else process.env.PI_ORCHESTRATOR_LEDGER=oldLedger;
      if(oldAuth===undefined)delete process.env.PI_ORCHESTRATOR_AUTH;else process.env.PI_ORCHESTRATOR_AUTH=oldAuth;
      rmSync(root,{recursive:true});
    }
  });

  it("permits one calibration probe, then requires new meter evidence",()=>{const store=Store.open(":memory:");account(store);const first=assign(store,"standard","background",config);expect(first.assignment?.accountId).toBe("openai-codex-1");const [runId]=store.createRuns({count:1,source:"direct",prompt:"x",cwd:"/tmp",profile:"standard",budget:"background"});store.assignRun(runId!,{...first.assignment!,unit:"u",releasePath:"/release/a"});store.updateRun(runId!,{state:"done"});expect(assign(store,"standard","background",config).assignment).toBeUndefined();store.recordMeter("openai-codex-1","codex-5h",10,Date.now()+3_600_000);const next=assign(store,"standard","background",config);expect(next.assignment).toBeDefined();commitMeterAdmission(store,next.assignment!);expect(assign(store,"standard","background",config).assignment).toBeUndefined();store.close();});

  it("keeps urgent work available while ordinary pacing preserves reserve",()=>{const store=Store.open(":memory:");account(store);store.recordMeter("openai-codex-1","codex-5h",85,Date.now()+3_600_000);expect(assign(store,"standard","background",config).refusals[0]?.reason).toContain("reserve");expect(assign(store,"standard","force",config).assignment).toBeDefined();store.setControl("boost:openai-codex","0");expect(assign(store,"standard","force",config).assignment).toBeUndefined();expect(assign(store,"standard","background",config).assignment).toBeUndefined();store.close();});

  it("persists room feed and materializes wakeups for peers",()=>{const store=Store.open(":memory:");const room=store.createRoom({name:"research",prompt:"work",cwd:"/tmp",profile:"standard",budget:"background",members:2});for(const id of room.runIds)store.updateRun(id,{state:"running"});const id=store.postMessage({roomId:room.id,senderRunId:room.runIds[0],body:"new evidence",wake:true});expect(store.roomMessages(room.id).map((message)=>message.id)).toEqual([id]);expect(store.pendingMessages(room.runIds[0]!)).toHaveLength(0);expect(store.pendingMessages(room.runIds[1]!).map((message)=>message.body)).toEqual(["new evidence"]);store.close();});

  it("applies every dynamic lane count and priority as one snapshot revision",()=>{const store=Store.open(":memory:");store.reconcileLanes([{id:"one",prompt:"a",cwd:"/tmp",profile:"standard",weight:1},{id:"two",prompt:"b",cwd:"/tmp",profile:"standard",weight:1}]);store.saveSnapshot({revision:"postgres:42",lanes:{one:{count:3,priority:10},two:{count:1,priority:90}}},1234);expect(store.latestSnapshot()).toEqual({revision:"postgres:42",lanes:{one:{count:3,priority:10},two:{count:1,priority:90}}});expect(store.lanes().map((lane)=>[lane.id,lane.priority])).toEqual([["two",90],["one",10]]);store.close();});

  it("orders lane admission by priority and weighted active share",()=>{
    const store=Store.open(":memory:");
    store.reconcileLanes([
      {id:"urgent",prompt:"u",cwd:"/tmp",profile:"standard",weight:1,priority:20},
      {id:"broad",prompt:"b",cwd:"/tmp",profile:"standard",weight:10,priority:10},
    ]);
    store.createRuns({count:1,source:"lane",sourceId:"broad",prompt:"b",cwd:"/tmp",profile:"standard",budget:"background"});
    store.createRuns({count:1,source:"lane",sourceId:"urgent",prompt:"u",cwd:"/tmp",profile:"standard",budget:"background"});
    expect(store.admissionQueue().map((run)=>run.sourceId)).toEqual(["urgent","broad"]);
    store.close();

    const weighted=Store.open(":memory:");
    weighted.reconcileLanes([
      {id:"narrow",prompt:"n",cwd:"/tmp",profile:"standard",weight:1,priority:10},
      {id:"wide",prompt:"w",cwd:"/tmp",profile:"standard",weight:10,priority:10},
    ]);
    weighted.createRuns({count:1,source:"lane",sourceId:"narrow",prompt:"n",cwd:"/tmp",profile:"standard",budget:"background"});
    weighted.createRuns({count:1,source:"lane",sourceId:"wide",prompt:"w",cwd:"/tmp",profile:"standard",budget:"background"});
    expect(weighted.admissionQueue()[0]?.sourceId).toBe("wide");
    weighted.close();
  });

  it("closing a room stops active members and prevents replacement",()=>{const store=Store.open(":memory:");const room=store.createRoom({name:"research",prompt:"work",cwd:"/tmp",profile:"standard",budget:"background",members:2});for(const id of room.runIds)store.updateRun(id,{state:"running"});store.closeRoom(room.id);expect(store.room(room.id)?.desired_members).toBe(0);for(const id of room.runIds)expect(store.control(`abort:${id}`)).toBe("room closed");store.close();});

  it("expires, heartbeats, and releases voice leases",()=>{const store=Store.open(":memory:");account(store);store.createLease("voice:one","openai-codex-1","voice",undefined,1_000);expect(store.activeLeases(undefined,500,1_600)).toHaveLength(0);store.heartbeatLease("voice:one",1_500);expect(store.activeLeases(undefined,500,1_600)).toHaveLength(1);store.endLease("voice:one",1_700);expect(store.activeLeases(undefined,500,1_700)).toHaveLength(0);store.close();});

  it("pins each launched run to an immutable release path",()=>{const store=Store.open(":memory:");account(store);const [id]=store.createRuns({count:1,source:"direct",prompt:"x",cwd:"/tmp",profile:"standard",budget:"force"});expect(store.assignRun(id!,{accountId:"openai-codex-1",provider:"openai-codex",model:"gpt-5.6-sol",unit:"run-a",releasePath:"/srv/releases/a"})).toBe(true);expect(store.run(id!)?.releasePath).toBe("/srv/releases/a");expect(store.assignRun(id!,{accountId:"openai-codex-1",provider:"openai-codex",model:"gpt-5.6-sol",unit:"run-b",releasePath:"/srv/releases/b"})).toBe(false);expect(store.run(id!)?.releasePath).toBe("/srv/releases/a");store.close();});

  it("resumes an interrupted assigned run without consuming another meter admission",()=>{const store=Store.open(":memory:");account(store);store.recordMeter("openai-codex-1","codex-5h",10,60_000,900);const choice=assign(store,"standard","background",config,1_000).assignment!;commitMeterAdmission(store,choice);const [id]=store.createRuns({count:1,source:"direct",prompt:"x",cwd:"/tmp",profile:"standard",budget:"background"});store.assignRun(id!,{...choice,unit:"run-a",releasePath:"/srv/releases/a"},1_000);store.updateRun(id!,{state:"running",sessionFile:"/sessions/a.jsonl"},1_100);store.endLease(`run:${id}`,1_200);store.updateRun(id!,{state:"queued"},1_200);expect(assign(store,"standard","background",config,1_300).assignment).toBeUndefined();expect(store.resumeAssignedRun(id!,1_300)).toBe(true);expect(store.run(id!)).toMatchObject({accountId:"openai-codex-1",releasePath:"/srv/releases/a",sessionFile:"/sessions/a.jsonl",state:"starting",workerUnit:"run-a"});expect(store.activeLeases(undefined,500,1_300)).toMatchObject([{account_id:"openai-codex-1",run_id:id}]);store.close();});

  it("waits for in-flight reconciliation before releasing ledger custody",async()=>{
    const store=Store.open(":memory:"),daemon=new Daemon(store,config,"/srv/releases/current") as any;
    daemon.reconciling=true;
    let settled=false;const waiting=daemon.waitForReconcile().then(()=>{settled=true;});
    await Promise.resolve();expect(settled).toBe(false);
    daemon.reconciling=false;await waiting;expect(settled).toBe(true);store.close();
  });

  it("restarts an interrupted worker from its recorded release",()=>{
    const root=mkdtempSync(join(tmpdir(),"orchestrator-recovery-")),bin=join(root,"bin"),capture=join(root,"systemd-run.args");
    mkdirSync(bin);
    writeFileSync(join(bin,"systemctl"),'#!/bin/sh\ncase "$*" in *is-active*) exit 3;; esac\nexit 0\n');
    writeFileSync(join(bin,"systemd-run"),`#!/bin/sh\nprintf '%s\\n' "$@" > ${JSON.stringify(capture)}\n`);
    chmodSync(join(bin,"systemctl"),0o755);chmodSync(join(bin,"systemd-run"),0o755);
    const previousPath=process.env.PATH;process.env.PATH=`${bin}:${previousPath}`;
    const store=Store.open(":memory:");
    try{
      account(store);const [id]=store.createRuns({count:1,source:"direct",prompt:"x",cwd:"/tmp",profile:"standard",budget:"force"});
      store.assignRun(id!,{accountId:"openai-codex-1",provider:"openai-codex",model:"gpt-5.6-sol",unit:"run-a",releasePath:"/srv/releases/a"});
      store.updateRun(id!,{state:"queued"});
      (new Daemon(store,config,"/srv/releases/current","/srv/state/ledger.sqlite3") as any).recoverWorkers();
      expect(readFileSync(capture,"utf8")).toContain("--setenv=PI_ORCHESTRATOR_LEDGER=/srv/state/ledger.sqlite3");
      expect(readFileSync(capture,"utf8")).toContain("--property=MemoryMax=8G");
      expect(readFileSync(capture,"utf8")).toContain("/srv/releases/a/dist/cli.js");
      expect(store.run(id!)).toMatchObject({releasePath:"/srv/releases/a",state:"starting",workerUnit:"run-a"});
    }finally{store.close();process.env.PATH=previousPath;rmSync(root,{recursive:true});}
  });
});

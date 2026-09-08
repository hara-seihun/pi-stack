import { describe, expect, it } from "vitest";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store.js";
import { assign, commitMeterAdmission } from "../src/policy.js";
import { allowsAccountUse, type OrchestratorConfig } from "../src/domain.js";
import { transactSharedCredential } from "../src/auth/shared-oauth.js";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import { withCustomModels } from "../src/extension/routing.js";
import { catalogModel } from "../src/catalog.js";
import { Daemon } from "../src/daemon.js";
import { loadConfig } from "../src/config.js";
import { ACCOUNT_USAGE, dispatch } from "../src/commands.js";
import { CACHE_WINDOW_MS, OrchestratorClient } from "../src/client.js";
import { outputLimitContinuation } from "../src/host/continuations.js";

const config:OrchestratorConfig={profiles:{standard:[{provider:"openai-codex",model:"gpt-6-astra",thinking:"xhigh"}]},backgroundSpendFraction:.8,maxConcurrentSessions:8,defaultAccountConcurrency:2,meterMaxAgeMs:60_000,reconcileIntervalMs:1000,stallAfterMs:60_000,killAfterMs:120_000,authPath:"/tmp/auth",agentDir:"/tmp/agent"};
function account(store:Store,id="openai-codex-1"){store.upsertAccount({id,provider:"openai-codex",concurrency:2});}

describe("current orchestrator state",()=>{
  it("reserves voice accounts across restart and excludes even forced or pinned agents",()=>{
    const root=mkdtempSync(join(tmpdir(),"voice-reservation-")),ledger=join(root,"ledger.sqlite3");
    const store=Store.open(ledger);
    account(store,"openai-codex-1");account(store,"openai-codex-2");
    store.setControl("account-use:openai-codex-1","voice");
    expect(assign(store,"standard","force",config).assignment?.accountId).toBe("openai-codex-2");
    expect(assign(store,"standard","force",config,Date.now(),"openai-codex-1").assignment).toBeUndefined();
    expect(allowsAccountUse(store.account("openai-codex-1")!,"interactive")).toBe(false);
    store.close();
    const client=new OrchestratorClient({ledgerPath:ledger});
    expect(client.voiceAccounts().map((a)=>a.id)).toEqual(["openai-codex-1"]);
    const lease=client.beginVoiceLease("openai-codex-1");client.endLease(lease);client.close();
    const reopened=Store.open(ledger);reopened.setControl("account-use:openai-codex-1","shared");
    expect(allowsAccountUse(reopened.account("openai-codex-1")!,"interactive")).toBe(true);
    reopened.close();rmSync(root,{recursive:true});
  });
  it("prints account help without requiring an account id",async()=>{
    const lines:string[]=[];
    const previous=console.log;
    console.log=(value?:unknown)=>lines.push(String(value));
    try{
      await dispatch(["account","--help"]);
    }finally{
      console.log=previous;
    }
    expect(lines).toEqual([ACCOUNT_USAGE]);
  });

  it("launches every Fable selection on Claude Fable 5.1",()=>{const anthropic=builtinProviders().find((provider)=>provider.id==="anthropic")!;const models=withCustomModels(anthropic).getModels();expect(models.some((model)=>model.id==="claude-fable-5")).toBe(true);expect(models.find((model)=>model.id==="claude-fable-5-1")?.cost.cacheRead).toBe(.25);expect(catalogModel("fable")?.model).toBe("claude-fable-5-1");});

  it("offers strict Astra and Opus scheduling profiles",()=>{const profiles=loadConfig("/definitely/missing/pi-orchestrator-config.json").profiles;expect(profiles.astra).toEqual([{provider:"openai-codex",model:"gpt-6-astra",thinking:"xhigh"}]);expect(profiles.opus).toEqual([{provider:"anthropic",model:"claude-opus-5",thinking:"xhigh"}]);});

  it("continues a provider-truncated turn even when rejected tool calls follow it",()=>{
    const prompt=outputLimitContinuation([
      {role:"assistant",stopReason:"length"},
      {role:"toolResult",isError:true},
    ]);
    expect(prompt).toContain("response reached the output-token limit");
    expect(prompt).toContain("pick up exactly where you stopped");
    expect(outputLimitContinuation([{role:"assistant",stopReason:"stop"}])).toBeUndefined();
  });

  it("reports the share of prompt tokens read from cache over the last 24 hours",()=>{
    const now=Date.now(),ledger=join(mkdtempSync(join(tmpdir(),"ledger-")),"ledger.sqlite3");
    const store=Store.open(ledger);
    store.upsertAccount({id:"anthropic-1",provider:"anthropic",concurrency:1});
    const hour=(agoHours:number)=>Math.floor((now-agoHours*3_600_000)/3_600_000)*3_600_000;
    const record=(component:"input"|"output"|"cacheRead"|"cacheWrite",tokens:number,agoHours=1)=>
      store.recordUsage({accountId:"anthropic-1",hour:hour(agoHours),source:"interactive",runId:"r",model:"claude-opus-5",component,tokens});
    record("cacheRead",750);
    record("input",150);
    record("cacheWrite",100);
    record("output",4_000);
    record("input",9_000,30);
    store.close();

    const client=new OrchestratorClient({ledgerPath:ledger});
    const anthropic=client.plans(undefined,now).plans.anthropic!;
    expect(anthropic.metrics.weekly?.cachePercent).toBe(75);
    expect(anthropic.metrics.fable?.cachePercent).toBeNull();
    expect(client.plans(undefined,now+CACHE_WINDOW_MS).plans.anthropic!.metrics.weekly?.cachePercent).toBeNull();
    client.close();
    rmSync(ledger,{force:true});
  });

  it("reconciles lane manifests as desired state",()=>{const store=Store.open(":memory:");store.reconcileLanes([{id:"one",prompt:"a",cwd:"/tmp",profile:"standard",weight:1},{id:"two",prompt:"b",cwd:"/tmp",profile:"standard",weight:2}]);store.reconcileLanes([{id:"two",prompt:"changed",cwd:"/work",profile:"standard",weight:3}]);expect(store.lanes()).toEqual([{id:"two",prompt:"changed",cwd:"/work",profile:"standard",weight:3,priority:0,doctrineUrl:undefined,openingProbe:undefined}]);store.close();});

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

  it("admits operator-requested work through reserves and 0× without bypassing hard stops",()=>{
    const store=Store.open(":memory:");account(store);
    const now=Date.now();
    store.recordMeter("openai-codex-1","codex-5h",85,now+3_600_000,now);
    expect(assign(store,"standard","background",config,now).refusals[0]?.reason).toContain("reserve");
    expect(assign(store,"standard","force",config,now).assignment).toBeDefined();
    store.setControl("boost:openai-codex","0");
    const forced=assign(store,"standard","force",config,now);
    expect(forced.assignment?.accountId).toBe("openai-codex-1");
    commitMeterAdmission(store,forced.assignment!);
    expect(assign(store,"standard","force",config,now+config.meterMaxAgeMs+1).assignment).toBeDefined();
    expect(assign(store,"standard","background",config,now).refusals[0]?.reason).toContain("background launches halted");
    store.setControl("launches","paused");
    expect(assign(store,"standard","force",config,now).refusals[0]?.reason).toBe("emergency halt");
    store.setControl("launches","enabled");
    store.recordMeter("openai-codex-1","codex-5h",100,now+3_600_000,now+1);
    expect(assign(store,"standard","force",config,now+1).refusals[0]?.reason).toContain("provider quota exhausted");
    store.close();
  });

  it("rejects worker targets rather than silently ignoring them",()=>{
    const store=Store.open(":memory:");
    expect(()=>store.reconcileLanes([{id:"work",prompt:"w",cwd:"/tmp",profile:"standard",weight:1,fixedDemand:3} as any])).toThrow("unsupported lane field");
    expect(store.lanes()).toEqual([]);store.close();
  });

  it("withdraws queued lane runs when current demand disappears",()=>{
    const store=Store.open(":memory:");
    store.reconcileLanes([{id:"work",prompt:"w",cwd:"/tmp",profile:"standard",weight:1}]);
    const ids=store.createRuns({count:3,source:"lane",sourceId:"work",prompt:"w",cwd:"/tmp",profile:"standard",budget:"background"});
    expect(store.trimQueuedLane("work",1,1234)).toBe(2);
    expect(store.activeCount("lane","work")).toBe(1);
    const runs=ids.map((id)=>store.run(id)!);
    expect(runs.filter((run)=>run.state==="queued")).toHaveLength(1);
    for(const run of runs.filter((candidate)=>candidate.state==="aborted"))expect(run).toMatchObject({failureKind:"task",result:"unused lane queue entry withdrawn",endedAt:1234});
    store.close();
  });

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

  it("expires, heartbeats, and releases voice leases",()=>{const store=Store.open(":memory:");account(store);store.createLease("voice:one","openai-codex-1","voice",undefined,1_000);expect(store.activeLeases(undefined,500,1_600)).toHaveLength(0);store.heartbeatLease("voice:one",1_500);expect(store.activeLeases(undefined,500,1_600)).toHaveLength(1);store.endLease("voice:one",1_700);expect(store.activeLeases(undefined,500,1_700)).toHaveLength(0);store.close();});

  it("pins each launched run to an immutable release path",()=>{const store=Store.open(":memory:");account(store);const [id]=store.createRuns({count:1,source:"direct",prompt:"x",cwd:"/tmp",profile:"standard",budget:"force"});expect(store.assignRun(id!,{accountId:"openai-codex-1",provider:"openai-codex",model:"gpt-6-astra",unit:"run-a",releasePath:"/srv/releases/a"})).toBe(true);expect(store.run(id!)?.releasePath).toBe("/srv/releases/a");expect(store.assignRun(id!,{accountId:"openai-codex-1",provider:"openai-codex",model:"gpt-6-astra",unit:"run-b",releasePath:"/srv/releases/b"})).toBe(false);expect(store.run(id!)?.releasePath).toBe("/srv/releases/a");store.close();});

  it("resumes an interrupted assigned run without consuming another meter admission",()=>{const store=Store.open(":memory:");account(store);store.recordMeter("openai-codex-1","codex-5h",10,60_000,900);const choice=assign(store,"standard","background",config,1_000).assignment!;commitMeterAdmission(store,choice);const [id]=store.createRuns({count:1,source:"direct",prompt:"x",cwd:"/tmp",profile:"standard",budget:"background"});store.assignRun(id!,{...choice,unit:"run-a",releasePath:"/srv/releases/a"},1_000);store.updateRun(id!,{state:"running",sessionFile:"/sessions/a.jsonl"},1_100);store.endLease(`run:${id}`,1_200);store.updateRun(id!,{state:"queued"},1_200);expect(assign(store,"standard","background",config,1_300).assignment).toBeUndefined();expect(store.resumeAssignedRun(id!,1_300)).toBe(true);expect(store.run(id!)).toMatchObject({accountId:"openai-codex-1",releasePath:"/srv/releases/a",sessionFile:"/sessions/a.jsonl",state:"starting",workerUnit:"run-a"});expect(store.activeLeases(undefined,500,1_300)).toMatchObject([{account_id:"openai-codex-1",run_id:id}]);store.close();});

  it("waits for in-flight reconciliation before releasing ledger custody",async()=>{
    const store=Store.open(":memory:"),daemon=new Daemon(store,config,"/srv/releases/current") as any;
    daemon.reconciling=true;
    let settled=false;const waiting=daemon.waitForReconcile().then(()=>{settled=true;});
    await Promise.resolve();expect(settled).toBe(false);
    daemon.reconciling=false;await waiting;expect(settled).toBe(true);store.close();
  });

  it("reopens an infrastructure-failed row when its worker is still active",()=>{
    const root=mkdtempSync(join(tmpdir(),"orchestrator-active-failed-")),bin=join(root,"bin"),started=join(root,"systemd-run.called");
    mkdirSync(bin);
    writeFileSync(join(bin,"systemctl"),'#!/bin/sh\ncase "$*" in *is-active*) exit 0;; esac\nexit 0\n');
    writeFileSync(join(bin,"systemd-run"),`#!/bin/sh\ntouch ${JSON.stringify(started)}\nexit 1\n`);
    chmodSync(join(bin,"systemctl"),0o755);chmodSync(join(bin,"systemd-run"),0o755);
    const previousPath=process.env.PATH;process.env.PATH=`${bin}:${previousPath}`;
    const store=Store.open(":memory:");
    try{
      account(store);const [id]=store.createRuns({count:1,source:"direct",prompt:"x",cwd:"/tmp",profile:"standard",budget:"force"});
      store.assignRun(id!,{accountId:"openai-codex-1",provider:"openai-codex",model:"gpt-6-astra",unit:"run-a.service",releasePath:"/srv/releases/a"});
      store.updateRun(id!,{state:"failed",failureKind:"infrastructure",result:"worker recovery raced its active unit"});
      (new Daemon(store,config,"/srv/releases/current","/srv/state/ledger.sqlite3") as any).recoverWorkers();
      expect(store.run(id!)).toMatchObject({state:"running",workerUnit:"run-a.service"});
      expect(store.run(id!)?.failureKind).toBeUndefined();
      expect(store.run(id!)?.result).toBeUndefined();
      expect(existsSync(started)).toBe(false);
      expect(store.activeLeases().map((lease)=>lease.run_id)).toContain(id);
    }finally{store.close();process.env.PATH=previousPath;rmSync(root,{recursive:true});}
  });

  it("adopts a still-loaded worker when recovery races systemd",()=>{
    const root=mkdtempSync(join(tmpdir(),"orchestrator-adoption-")),bin=join(root,"bin"),counter=join(root,"is-active.count");
    mkdirSync(bin);writeFileSync(counter,"0\n");
    writeFileSync(join(bin,"systemctl"),`#!/bin/sh
case "$*" in
  *is-active*) n=$(cat ${JSON.stringify(counter)}); n=$((n+1)); printf '%s\\n' "$n" > ${JSON.stringify(counter)}; test "$n" -ge 3;;
  *start*) exit 0;;
  *) exit 0;;
esac
`);
    writeFileSync(join(bin,"systemd-run"),'#!/bin/sh\necho "Unit run-a.service was already loaded or has a fragment file" >&2\nexit 1\n');
    chmodSync(join(bin,"systemctl"),0o755);chmodSync(join(bin,"systemd-run"),0o755);
    const previousPath=process.env.PATH;process.env.PATH=`${bin}:${previousPath}`;
    const store=Store.open(":memory:");
    try{
      account(store);const [id]=store.createRuns({count:1,source:"direct",prompt:"x",cwd:"/tmp",profile:"standard",budget:"force"});
      store.assignRun(id!,{accountId:"openai-codex-1",provider:"openai-codex",model:"gpt-6-astra",unit:"run-a.service",releasePath:"/srv/releases/a"});
      store.updateRun(id!,{state:"failed",failureKind:"infrastructure",result:"old failure"});
      store.updateRun(id!,{state:"queued"});
      (new Daemon(store,config,"/srv/releases/current","/srv/state/ledger.sqlite3") as any).recoverWorkers();
      expect(store.run(id!)).toMatchObject({state:"running",workerUnit:"run-a.service"});
      expect(store.run(id!)?.failureKind).toBeUndefined();
      expect(store.run(id!)?.result).toBeUndefined();
      expect(store.run(id!)?.endedAt).toBeUndefined();
      expect(readFileSync(counter,"utf8").trim()).toBe("3");
    }finally{store.close();process.env.PATH=previousPath;rmSync(root,{recursive:true});}
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
      store.assignRun(id!,{accountId:"openai-codex-1",provider:"openai-codex",model:"gpt-6-astra",unit:"run-a",releasePath:"/srv/releases/a"});
      store.updateRun(id!,{state:"queued"});
      (new Daemon(store,config,"/srv/releases/current","/srv/state/ledger.sqlite3") as any).recoverWorkers();
      expect(readFileSync(capture,"utf8")).toContain("--setenv=PI_ORCHESTRATOR_LEDGER=/srv/state/ledger.sqlite3");
      expect(readFileSync(capture,"utf8")).toContain("--property=MemoryMax=8G");
      expect(readFileSync(capture,"utf8")).toContain("/srv/releases/a/dist/cli.js");
      expect(store.run(id!)).toMatchObject({releasePath:"/srv/releases/a",state:"starting",workerUnit:"run-a"});
    }finally{store.close();process.env.PATH=previousPath;rmSync(root,{recursive:true});}
  });
});

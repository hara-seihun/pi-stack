import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { Daemon } from "../src/daemon.js";
import { Store } from "../src/store.js";
import { loadConfig } from "../src/config.js";
import { assign, assignCompletion } from "../src/policy.js";

const units=vi.hoisted(()=>({calls:[] as {command:string;args:string[]}[],active:new Set<string>(),transitioning:new Set<string>(),loaded:new Set<string>(),failure:false,stopFailure:false}));
vi.mock("node:child_process",async importOriginal=>{
  const actual=await importOriginal<typeof import("node:child_process")>();
  const invoke=(command:string,args:string[])=>{
    units.calls.push({command,args});
    if(units.failure||(units.stopFailure&&args.includes("stop")))return {status:1,stderr:"sudo: authorization denied",stdout:""};
    const operation=command==="sudo"?args[2]:command;
    const unit=operation==="systemd-run"?args.find(arg=>arg.startsWith("--unit="))!.slice(7):args.at(-1)!;
    let status=0;
    if(operation==="systemd-run"){
      if(units.loaded.has(unit))status=1;
      else {units.loaded.add(unit);units.active.add(unit);}
    }else if(args.includes("is-active"))status=!units.transitioning.has(unit)&&units.active.has(unit)?0:3;
    else if(args.includes("stop")){units.active.delete(unit);units.transitioning.delete(unit);}
    else if(args.includes("start"))units.active.add(unit);
    return {status,stderr:status?"unit already loaded":"",stdout:args.includes("is-active")?(units.transitioning.has(unit)?"deactivating":status?"inactive":"active"):""};
  };
  return {...actual,spawnSync:vi.fn(invoke),execFile:vi.fn((command:string,args:string[],options:any,callback:any)=>{
    if(command!=="sudo"&&command!=="systemctl")return (actual.execFile as any)(command,args,options,callback);
    const result=invoke(command,args);callback(result.status?Object.assign(new Error(result.stderr),{code:result.status}):null,result.stdout,result.stderr);
  })};
});
const cleanup:(()=>void)[]=[];
beforeEach(()=>{units.calls=[];units.active.clear();units.transitioning.clear();units.loaded.clear();units.failure=false;units.stopFailure=false;vi.spyOn(process as NodeJS.Process & {getuid:()=>number},"getuid").mockReturnValue(1000);vi.spyOn(process as NodeJS.Process & {getgid:()=>number},"getgid").mockReturnValue(100);});
afterEach(()=>{for(const close of cleanup.splice(0).reverse())close();vi.restoreAllMocks();vi.unstubAllEnvs();});
function fixture(){
  const root=mkdtempSync(join(tmpdir(),"root-repair-"));cleanup.push(()=>rmSync(root,{recursive:true,force:true}));
  const ledger=join(root,"ledger.sqlite3"),store=Store.open(ledger);cleanup.push(()=>store.close());
  const manifestPath=join(root,"lanes.json"),probe=join(root,"repair.json");
  writeFileSync(probe,JSON.stringify({revision:"broken-1",ready:true}));
  const normal={id:"normal",prompt:"ordinary",cwd:root,profile:"luna",weight:1};
  const repair={...normal,id:"repair",profile:"astra",prompt:"repair host",repair:{readinessCommand:`cat ${JSON.stringify(probe)}`}};
  let mtime=Date.now();
  const manifest=(lanes:any[]=[normal,repair],snapshotCommand="exit 19")=>{writeFileSync(manifestPath,JSON.stringify({version:2,lanes,snapshotCommand}));utimesSync(manifestPath,new Date(mtime+=1000),new Date(mtime));};manifest();
  store.upsertAccount({id:"a",provider:"openai-codex",concurrency:5});
  store.recordMeter("a","codex-7d",90,Date.now()+604_800_000,Date.now()-7_200_000);
  store.setControl("boost:openai-codex","0");store.setControl("ordinary-launches","paused");
  const config={...loadConfig("/missing"),taskManifest:manifestPath,agentDir:join(root,"agent"),authPath:join(root,"auth.json"),maxConcurrentSessions:5};
  const daemon=()=>{const d=new Daemon(store,config,"/release",ledger) as any;d.codexMeters.sample=async()=>[];d.anthropicMeters.sample=async()=>[];return d;};
  const direct=()=>store.createRuns({count:1,source:"direct",prompt:"unknown queued work",cwd:root,profile:"luna",budget:"force"})[0]!;
  return {store,root,config,ledger,normal,repair,probe,manifest,daemon,direct};
}

describe("root repair admission",()=>{
  it("admits repair through failed ordinary readiness while unknown direct work stays paused",async()=>{
    const f=fixture(),queued=f.direct(),d=f.daemon();await d.reconcile();
    const repair=f.store.runs().find(run=>run.execution==="root-repair")!;
    expect(repair).toMatchObject({source:"lane",sourceId:"repair",budget:"force",state:"starting",accountId:"a",execution:"root-repair",thinking:"high"});
    expect(f.store.run(queued)).toMatchObject({state:"queued",execution:"user"});
    expect(f.store.control("readiness_error")).toBeTruthy();
    expect(f.store.control("repair-owner")).toBe(repair.id);
    expect(f.store.activeLeases()).toHaveLength(1);
    await d.reconcile();expect(f.store.runs()).toHaveLength(2);
    expect(assign(f.store,"luna","force",f.config).refusals[0]?.reason).toBe("ordinary work paused");
    expect(assignCompletion(f.store,queued,"luna",f.config).refusals[0]?.reason).toBe("ordinary work paused");
  });

  it("accepts a repair-only forced manifest without ordinary readiness and rejects malformed repair declarations",async()=>{
    const f=fixture();
    writeFileSync(f.config.taskManifest,JSON.stringify({version:2,budget:"force",lanes:[f.repair]}));
    await f.daemon().reconcile();expect(f.store.runs()).toHaveLength(1);
    for(const repair of [null,{readinessCommand:""},{readinessCommand:"true",uid:0}])
      expect(()=>f.store.reconcileLanes([{...f.repair,repair} as any])).toThrow(/repair requires/);
  });

  it("does not reuse a repair observation after its probe fails or reports no work",async()=>{
    const f=fixture(),d=f.daemon();
    writeFileSync(f.probe,JSON.stringify({revision:"healthy",ready:false}));await d.reconcile();expect(f.store.runs()).toHaveLength(0);
    writeFileSync(f.probe,"not JSON");d.repairReadiness.clear();await d.reconcile();
    expect(f.store.runs()).toHaveLength(0);expect(f.store.control("repair-readiness-error:repair")).toBeTruthy();
    writeFileSync(f.probe,JSON.stringify({revision:"broken",ready:true}));d.repairReadiness.clear();await d.reconcile();
    expect(f.store.runs()).toHaveLength(1);expect(f.store.control("repair-readiness-error:repair")).toBe("");
  });

  it.each(["exhaustion","reservation","global halt"])("keeps %s enforced for repair",async gate=>{
    const f=fixture();
    if(gate==="exhaustion")f.store.recordMeter("a","codex-7d",100,Date.now()+604_800_000,Date.now());
    if(gate==="reservation")f.store.setControl("account-reservation:a",JSON.stringify({metadata:{caller:"other"},reason:"reserved"}));
    if(gate==="global halt")f.store.setControl("launches","paused");
    await f.daemon().reconcile();expect(f.store.runs()).toHaveLength(0);
  });

  it("keeps a single owner across lanes, daemon restart, manifest edits and a terminal worker still exiting",async()=>{
    const f=fixture();f.manifest([f.repair,{...f.repair,id:"second"}]);
    await f.daemon().reconcile();const run=f.store.runs()[0]!;
    expect(f.store.runs()).toHaveLength(1);
    f.manifest([{...f.repair,repair:undefined},{...f.repair,id:"second"}]);
    const restarted=f.daemon();restarted.recoverWorkers();await restarted.reconcile();
    expect(f.store.run(run.id)?.execution).toBe("root-repair");expect(f.store.runs()).toHaveLength(1);
    f.store.updateRun(run.id,{state:"done"});await restarted.reconcile();expect(f.store.runs()).toHaveLength(1);
    units.active.delete(run.workerUnit!);units.transitioning.add(run.workerUnit!);await restarted.reconcile();
    expect(f.store.runs()).toHaveLength(1);expect(await restarted.unitIsActiveAsync(run.workerUnit)).toBe(true);
    units.transitioning.clear();await restarted.reconcile();
    expect(f.store.runs()).toHaveLength(2);expect(f.store.control("repair-owner")).not.toBe(run.id);
    expect(f.store.runs()[1]).toMatchObject({sourceId:"second",execution:"root-repair"});
  });

  it("persists execution identity and refuses a second repair owner during explicit recovery",async()=>{
    const f=fixture();await f.daemon().reconcile();const first=f.store.runs()[0]!;
    f.store.updateRun(first.id,{nativeSessionId:"native",state:"failed",failureKind:"infrastructure",result:"TypeError: fetch failed"});
    const [second]=f.store.createRuns({count:1,source:"lane",sourceId:"repair",prompt:"next",cwd:f.root,profile:"luna",budget:"force",execution:"root-repair"});
    const assignment={accountId:"a",provider:"openai-codex",model:"gpt-5.6-luna",unit:"second",releasePath:"/release"};
    expect(f.store.assignRun(second!,assignment)).toBe(false);
    units.active.delete(first.workerUnit!);f.daemon().releaseRepairOwner();
    expect(f.store.assignRun(second!,assignment)).toBe(true);
    expect(f.store.recoverInterruptedRun(first.id,"/new")).toBe(false);
    expect(f.store.adoptAssignedRun(first.id)).toBe(false);
    const reopened=Store.open(f.ledger);
    try{expect(reopened.run(first.id)?.execution).toBe("root-repair");expect(reopened.control("repair-owner")).toBe(second);}
    finally{reopened.close();}
  });

  it("does not promote an existing ordinary wave when its lane becomes repair",async()=>{
    const f=fixture();const [id]=f.store.createRuns({count:1,source:"direct",sourceId:"repair",prompt:"existing",cwd:f.root,profile:"luna",budget:"force"});
    await f.daemon().reconcile();expect(f.store.run(id!)).toMatchObject({state:"queued",execution:"user"});
  });
});

describe("root system unit lifecycle",()=>{
  it("uses sudo system units and preserves full config, account custody and the user bus",async()=>{
    vi.stubEnv("HOME","/home/kenan");vi.stubEnv("XDG_RUNTIME_DIR","/run/user/1000");vi.stubEnv("DBUS_SESSION_BUS_ADDRESS","unix:path=/run/user/1000/bus");
    const f=fixture();await f.daemon().reconcile();const run=f.store.runs()[0]!;
    const launch=units.calls.find(call=>call.args.includes("systemd-run"))!;
    expect(launch.command).toBe("sudo");
    expect(launch.args.slice(0,5)).toEqual(["-n","--","systemd-run","--system","--uid=0"]);
    expect(launch.args).not.toContain("--user");
    for(const value of ["HOME=/home/kenan",`PI_CODING_AGENT_DIR=${f.config.agentDir}`,`PI_ORCHESTRATOR_AUTH=${f.config.authPath}`,`PI_ORCHESTRATOR_LEDGER=${f.ledger}`,"PI_ORCHESTRATOR_OWNER_UID=1000","PI_ORCHESTRATOR_OWNER_GID=100","DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus","XDG_RUNTIME_DIR=/run/user/1000"])
      expect(launch.args).toContain(`--setenv=${value}`);
    expect(launch.args.slice(-3)).toEqual(["/release/dist/cli.js","worker",run.id]);
    expect(units.calls.filter(call=>call.args.includes("is-active")).every(call=>call.command==="sudo"&&call.args.includes("--system"))).toBe(true);
  });

  it("adopts active root workers and restarts loaded inactive units under the recorded release and scope",async()=>{
    vi.stubEnv("HOME","/home/kenan");vi.stubEnv("PI_ORCHESTRATOR_CONFIG","/recorded/config.json");
    const f=fixture();await f.daemon().reconcile();const run=f.store.runs()[0]!;
    vi.stubEnv("HOME","/changed-home");vi.stubEnv("PI_ORCHESTRATOR_CONFIG","/changed/config.json");
    units.calls=[];f.daemon().recoverWorkers();expect(units.calls.some(call=>call.args.includes("systemd-run"))).toBe(false);
    units.active.delete(run.workerUnit!);units.calls=[];f.manifest([f.normal]);
    const d=f.daemon();await d.loadManifest();d.recoverWorkers();
    expect(f.store.run(run.id)).toMatchObject({execution:"root-repair",state:"running",releasePath:"/release"});
    expect(units.calls.some(call=>call.command==="sudo"&&call.args.includes("reset-failed"))).toBe(true);
    expect(units.calls.some(call=>call.command==="sudo"&&call.args.includes("start"))).toBe(true);
    expect(units.calls.every(call=>call.command==="sudo")).toBe(true);
    const relaunched=units.calls.find(call=>call.args.includes("systemd-run"))!;
    expect(relaunched.args).toContain("--setenv=HOME=/home/kenan");expect(relaunched.args).toContain("--setenv=PI_ORCHESTRATOR_CONFIG=/recorded/config.json");
    units.active.delete(run.workerUnit!);units.calls=[];f.store.setControl("launches","paused");d.recoverWorkers();
    expect(units.calls.some(call=>call.args.includes("start")||call.args.includes("systemd-run"))).toBe(false);
  });

  it("retires the preceding root unit before launching a recovered release, including after daemon restart",async()=>{
    const f=fixture();await f.daemon().reconcile();const run=f.store.runs()[0]!;
    f.store.updateRun(run.id,{nativeSessionId:"native",state:"failed",failureKind:"infrastructure",result:"TypeError: fetch failed"});
    expect(f.store.recoverInterruptedRun(run.id,"/next")).toBe(true);
    const next=f.store.run(run.id)!;expect(next.workerUnit).not.toBe(run.workerUnit);
    expect(f.store.control(`run-retiring-unit:${run.id}`)).toBe(run.workerUnit);
    units.calls=[];units.stopFailure=true;
    expect(()=>f.daemon().recoverWorkers()).toThrow(/authorization denied/);
    expect(units.calls.some(call=>call.args.includes("systemd-run")||call.args.includes("start"))).toBe(false);
    expect(f.store.control(`run-retiring-unit:${run.id}`)).toBe(run.workerUnit);
    expect(units.active.has(run.workerUnit!)).toBe(true);
    units.calls=[];units.stopFailure=false;f.daemon().recoverWorkers();
    const stop=units.calls.findIndex(call=>call.command==="sudo"&&call.args.includes("stop")&&call.args.at(-1)===run.workerUnit);
    const launch=units.calls.findIndex(call=>call.args.includes("systemd-run"));
    expect(stop).toBeGreaterThanOrEqual(0);expect(launch).toBeGreaterThan(stop);
    expect(units.calls[stop]!.args).toContain("--system");expect(units.calls[launch]!.args).toContain("/next/dist/cli.js");
    expect(units.active.has(run.workerUnit!)).toBe(false);expect(units.active.has(next.workerUnit!)).toBe(true);
    expect(f.store.control(`run-retiring-unit:${run.id}`)).toBe("");expect(f.store.control("repair-owner")).toBe(run.id);
  });

  it.each(["abort","kill"])("settles %s without restarting the root worker or losing ownership early",async action=>{
    const f=fixture(),d=f.daemon();await d.reconcile();const run=f.store.runs()[0]!;
    const server=createServer((req,res)=>void d.request(req,res));await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));
    try{
      const response=await fetch(`http://127.0.0.1:${(server.address() as {port:number}).port}/v1/runs/${run.id}/${action}`,{method:"POST"});expect(response.status).toBe(200);
      if(action==="abort"){
        expect(f.store.control(`abort:${run.id}`)).toBe("abort");expect(units.active.has(run.workerUnit!)).toBe(true);
        expect(f.store.control("repair-owner")).toBe(run.id);
        units.active.delete(run.workerUnit!);d.recoverWorkers();
      }else expect(units.calls.some(call=>call.command==="sudo"&&call.args.includes("--system")&&call.args.includes("stop"))).toBe(true);
      expect(units.active.has(run.workerUnit!)).toBe(false);expect(f.store.run(run.id)?.state).toBe("aborted");
      expect(f.store.recoverInterruptedRun(run.id,"/next")).toBe(false);
      units.calls=[];d.recoverWorkers();expect(units.calls).toHaveLength(0);
    }finally{await new Promise<void>(resolve=>server.close(()=>resolve()));}
  });

  it("fails status closed when sudo fails, rather than treating an inaccessible unit as stopped",async()=>{
    const f=fixture(),d=f.daemon();await d.reconcile();const run=f.store.runs()[0]!;
    f.store.updateRun(run.id,{state:"done"});units.failure=true;
    expect(()=>d.releaseRepairOwner()).toThrow(/authorization denied/);expect(f.store.control("repair-owner")).toBe(run.id);
    await expect(d.unitIsActiveAsync(run.workerUnit)).rejects.toThrow(/authorization denied/);
  });

  it("keeps ordinary unit launches unprivileged",async()=>{
    const f=fixture(),id=f.direct();f.store.setControl("ordinary-launches","enabled");await f.daemon().launch(f.store.run(id));
    expect(units.calls[0]).toMatchObject({command:"systemd-run"});expect(units.calls[0]!.args).toContain("--user");
    expect(units.calls[0]!.args.some(arg=>arg.includes("OWNER_UID"))).toBe(false);
  });
});

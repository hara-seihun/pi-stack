import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { catalogModel } from "../src/catalog.js";
import { OrchestratorClient } from "../src/client.js";
import { Daemon } from "../src/daemon.js";
import { loadConfig } from "../src/config.js";
import { Fleet } from "../src/fleet.js";
import { Store } from "../src/store.js";

function parent(store:Store,model="astra",context?:{tools:string[]}) {
  if(!store.account("account"))store.upsertAccount({id:"account",provider:"openai-codex",concurrency:1});
  const [id]=store.createRuns({count:1,source:"direct",prompt:"coordinate",cwd:"/tmp",profile:model,budget:"force",context});
  store.assignRun(id!,{...catalogModel(model)!,accountId:"account",unit:`unit-${id}`,releasePath:"/release"});
  store.updateRun(id!,{state:"running",sessionFile:`/tmp/${id}.jsonl`});
  return id!;
}
function child(fleet:Fleet,parentId:string,model:"astra"|"sol"|"terra"|"luna"="terra",requestId=model) {
  const outcome=fleet.dispatch(parentId,{task:"child task",model,requestId});
  if(!outcome.ok)throw new Error(outcome.error);
  return outcome.value;
}

it("nested run creation rolls back with its owning transaction",()=>{
  const store=Store.open(":memory:");
  try{
    expect(()=>store.transaction(()=>{
      store.createRuns({count:1,source:"direct",prompt:"fixture",cwd:"/tmp",profile:"luna",budget:"force"});
      store.setControl("fixture","created");
      throw new Error("rollback");
    })).toThrow("rollback");
    expect(store.runs()).toHaveLength(0);
    expect(store.control("fixture")).toBeUndefined();
    store.transaction(()=>store.transaction(()=>store.setControl("fixture","committed")));
    expect(store.control("fixture")).toBe("committed");
  }finally{store.close();}
});

it("observes a bounded page without one relationship scan per historical run",()=>{
  const store=Store.open(":memory:");
  try{
    const id=parent(store);
    store.createRuns({count:2000,source:"direct",prompt:"fixture",cwd:"/tmp",profile:"luna",budget:"force",child:{parentRunId:id,rootRunId:id,requestId:"fixture",task:"fixture",model:"luna",assignment:catalogModel("luna")!}});
    store.db.prepare("UPDATE run SET state='done'").run();
    const prepare=vi.spyOn(store.db,"prepare");
    const rows=store.observedRuns(20);
    expect(rows).toHaveLength(20);
    expect(prepare.mock.calls.length).toBeLessThanOrEqual(3);
    prepare.mockRestore();
  }finally{store.close();}
});

it("Astra and Sol dispatch all four fixed models; replay and escalation keep distinct custody",()=>{
  const store=Store.open(":memory:"),fleet=new Fleet(store);
  try{
    for(const model of ["astra","sol"]){
      const id=parent(store,model);
      for(const target of ["astra","sol","terra","luna"] as const){
        const run=child(fleet,id,target);
        expect(child(fleet,id,target).id).toBe(run.id);
        expect(run.parentRunId).toBe(id);
        expect(run.rootRunId).toBe(id);
        expect(store.fleetChild(run.id)?.assignment.model).toBe(catalogModel(target)?.model);
        expect(store.assignRun(run.id,{...catalogModel(target==="astra"?"sol":"astra")!,accountId:"account",unit:"wrong",releasePath:"/release"})).toBe(false);
        expect(fleet.dispatch(id,{task:"different",model:target,requestId:target})).toEqual({ok:false,error:"request-conflict"});
        expect(store.assignRun(run.id,{...catalogModel(target)!,accountId:"account",unit:`unit-${run.id}`,releasePath:"/release"})).toBe(true);
        store.updateRun(run.id,{state:"running"});
        expect(fleet.dispatch(run.id,{task:"nested",model:"luna",requestId:"nested"})).toEqual({ok:false,error:"not-coordinator"});
        expect(store.childRunIds(run.id)).toEqual([]);
      }
      const prior=child(fleet,id,"terra");
      const escalated=fleet.dispatch(id,{task:"higher effort",model:"astra",requestId:"escalate",escalatesRunId:prior.id});
      expect(escalated.ok).toBe(true);
      if(escalated.ok){expect(escalated.value.id).not.toBe(prior.id);expect(escalated.value.escalatesRunId).toBe(prior.id);}
      expect(store.fleetChild(prior.id)?.model).toBe("terra");
    }
    expect(fleet.dispatch(parent(store,"terra"),{task:"work",model:"luna",requestId:"x"})).toEqual({ok:false,error:"not-coordinator"});
    expect(fleet.dispatch(parent(store,"astra",{tools:[]}),{task:"work",model:"sol",requestId:"x"})).toEqual({ok:false,error:"not-coordinator"});
  }finally{store.close();}
});

it("parked coordinator and terminal result survive reopening; completion/acknowledgement are idempotent",async()=>{
  const dir=mkdtempSync(join(tmpdir(),"fleet-ledger-")),path=join(dir,"ledger.sqlite3");
  let store=Store.open(path),fleet=new Fleet(store);
  try{
    const id=parent(store),run=child(fleet,id);
    fleet.settle(id,"waiting for child");
    expect(store.run(id)?.state).toBe("waiting");
    expect(store.activeLeases()).toHaveLength(0);
    expect(store.runs(["running"])).toHaveLength(0);
    expect(store.admissionQueue().map(run=>run.id)).toEqual([run.id]);
    store.updateRun(run.id,{state:"failed",failureKind:"task",result:"exact child failure"});
    store.close();store=Store.open(path);fleet=new Fleet(store);
    const [delivery]=fleet.pending(id);
    expect(delivery).toMatchObject({runId:run.id,state:"failed",result:"exact child failure"});
    store.updateRun(run.id,{state:"running",result:"late heartbeat"});
    expect(fleet.pending(id)).toEqual([delivery]);
    expect(fleet.acknowledge("other",[delivery!.deliveryId])).toEqual({ok:false,error:"invalid-receipt"});
    expect(store.resumeAssignedRun(id)).toBe(true);
    expect(store.run(id)).toMatchObject({state:"starting",model:catalogModel("astra")!.model,sessionFile:`/tmp/${id}.jsonl`});
    expect(fleet.acknowledge(id,[delivery!.deliveryId]).ok).toBe(true);
    expect(fleet.acknowledge(id,[delivery!.deliveryId]).ok).toBe(true);
    store.updateRun(id,{state:"running"});
    fleet.settle(id,"combined answer");
    expect(store.run(id)?.state).toBe("done");
    const observer=new OrchestratorClient({ledgerPath:path});
    try{
      const listing=await observer.listRuns(100);
      expect(listing.running).toBe(0);
      expect(listing.runs.find(row=>row.id===run.id)).toMatchObject({parentRunId:id,state:"error",deliveryState:"delivered"});
      expect(listing.runs.find(row=>row.id===id)?.state).toBe("done");
    }finally{observer.close();}
  }finally{store.close();rmSync(dir,{recursive:true,force:true});}
});

it("completion racing settlement parks the parent until every result is durably received",()=>{
  const store=Store.open(":memory:"),fleet=new Fleet(store);
  try{
    const id=parent(store),a=child(fleet,id,"sol"),b=child(fleet,id,"luna");
    store.updateRun(a.id,{state:"done",result:"a"});
    expect(fleet.settle(id,"first pass").state).toBe("waiting");
    expect(fleet.acknowledge(id,fleet.pending(id).map(result=>result.deliveryId)).ok).toBe(true);
    expect(fleet.settle(id,"a received").state).toBe("waiting");
    store.updateRun(b.id,{state:"aborted",result:"operator stopped b"});
    expect(fleet.pending(id)).toMatchObject([{runId:b.id,state:"aborted"}]);
  }finally{store.close();}
});

it("daemon wakes from the recorded release, without a new quota admission, and never races the retiring unit",()=>{
  const store=Store.open(":memory:"),fleet=new Fleet(store);
  const cfg={...loadConfig("/missing"),maxConcurrentSessions:1};
  const daemon=new Daemon(store,cfg,"/new-release") as any;
  try{
    const id=parent(store),run=child(fleet,id);
    fleet.settle(id,"wait");store.updateRun(run.id,{state:"done",result:"answer"});
    let active=true;const launches:unknown[][]=[];
    daemon.unitIsActive=()=>active;
    daemon.startUnit=(...args:unknown[])=>launches.push(args);
    daemon.resumeCoordinators();expect(launches).toHaveLength(0);
    active=false;store.setControl("launches","paused");
    daemon.resumeCoordinators();expect(launches).toHaveLength(0);
    store.setControl("launches","enabled");
    daemon.resumeCoordinators();
    expect(launches).toEqual([[`unit-${id}`,id,"/release"]]);
    expect(store.activeLeases()).toHaveLength(1);
    expect(store.run(id)?.state).toBe("starting");
    daemon.resumeCoordinators();expect(launches).toHaveLength(1);
  }finally{store.close();}
});

it("resumes a parked coordinator on another account without changing model or thinking",()=>{
  const store=Store.open(":memory:"),fleet=new Fleet(store);
  const daemon=new Daemon(store,{...loadConfig("/missing"),maxConcurrentSessions:1},"/new") as any;
  try{
    const id=parent(store),run=child(fleet,id);
    const before=store.run(id)!;
    fleet.settle(id,"wait");store.updateRun(run.id,{state:"done",result:"answer"});
    store.setAccountEnabled("account",false);
    store.upsertAccount({id:"replacement",provider:"openai-codex",concurrency:1});
    daemon.unitIsActive=()=>false;daemon.startUnit=()=>{};
    daemon.resumeCoordinators();
    expect(store.run(id)).toMatchObject({accountId:"replacement",model:before.model,thinking:before.thinking,sessionFile:before.sessionFile,releasePath:before.releasePath,state:"starting"});
    expect(store.activeLeases().map(lease=>lease.account_id)).toEqual(["replacement"]);
  }finally{store.close();}
});

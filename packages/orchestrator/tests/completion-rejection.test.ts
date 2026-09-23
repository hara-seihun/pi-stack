import { expect, it } from "vitest";
import { createServer } from "node:http";
import { Daemon } from "../src/daemon.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store.js";
import { CompletionService } from "../src/completion.js";
import { loadConfig } from "../src/config.js";
import { assignCompletion } from "../src/policy.js";
import { recordCompletionRejection, recordCompletionSuccess, completionFeedbackRefusal } from "../src/completion-feedback.js";
import type { CompletionExecution, CompletionOutcome } from "../src/completion-contract.js";
const input={model:"luna" as const,prompt:"exact original",systemPrompt:"distinct instructions",metadata:{caller:"omniscience",purpose:"regulatory-atlas-tagging"}};
const rejected:CompletionExecution={state:"failed",error:{code:"rate-limited",httpStatus:429,message:'{"detail":"Rate limit exceeded"}',retryAfterMs:2000}};
const completed:CompletionExecution={state:"completed",result:{text:"ok",provider:"openai-codex",model:"gpt-6-luna",usage:{input:2,output:1,cacheRead:0,cacheWrite:0,totalTokens:3},stopReason:"stop"}};
function value<T>(outcome:CompletionOutcome<T>):T{if(!outcome.ok)throw new Error(outcome.error.message);return outcome.value;}
function assign(store:Store,id:string){store.upsertAccount({id:"account",provider:"openai-codex"});expect(store.assignRun(id,{accountId:"account",provider:"openai-codex",model:"gpt-6-luna",unit:`completion:${id}`,releasePath:"/release"})).toBe(true);}

it("retries only rejected execution with the same IDs and immutable attempt receipts across restart",()=>{
  const root=mkdtempSync(join(tmpdir(),"rejection-")),path=join(root,"ledger.sqlite3");let store=Store.open(path);
  try{
    let service=new CompletionService(store,root);const first=value(service.submit("stable",input));assign(store,first.runId);
    value(service.claim(first.runId,"first"));const queued=value(service.settle(first.runId,"first",rejected));
    expect(queued).toMatchObject({state:"queued",requestId:"stable",runId:first.runId,attemptCount:1});
    expect(store.activeLeases()).toHaveLength(0);
    expect(assignCompletion(store,first.runId,"luna",loadConfig("/missing")).assignment).toBeUndefined();
    expect(value(service.settle(first.runId,"first",rejected))).toEqual(queued);
    store.close();store=Store.open(path);service=new CompletionService(store,root);
    assign(store,first.runId);expect(value(service.claim(first.runId,"first")).execute).toBe(false);
    expect(value(service.claim(first.runId,"second")).input).toEqual(input);
    expect(value(service.settle(first.runId,"second",completed))).toMatchObject({state:"completed",runId:first.runId,attemptCount:2});
    expect(value(service.settle(first.runId,"first",rejected)).state).toBe("completed");
    expect(value(service.settle(first.runId,"second",completed)).state).toBe("completed");
    expect(service.attempts("stable")?.map(a=>a.outcome)).toEqual([rejected,completed]);
    expect(store.usageSince(0).reduce((n,r)=>n+r.tokens,0)).toBe(3);
    expect(store.runs()).toHaveLength(1);
  }finally{store.close();rmSync(root,{recursive:true,force:true});}
});

it("recovers the exact deployed Codex rejection envelope without editing original evidence, refusing unknowns",()=>{
  const store=Store.open(":memory:"),service=new CompletionService(store,"/tmp");
  try{
    const old:CompletionExecution={state:"failed",error:{code:"provider",message:'{"detail":"Rate limit exceeded"}'}};
    const first=value(service.submit("historical",input));assign(store,first.runId);value(service.claim(first.runId,"historical-attempt"));value(service.settle(first.runId,"historical-attempt",old));
    const recovered=value(service.retry("historical"));expect(recovered).toMatchObject({state:"queued",runId:first.runId});
    expect(value(service.retry("historical"))).toEqual(recovered);
    expect(service.attempts("historical")?.[0]).toMatchObject({outcome:old,recoveryReason:expect.stringContaining("original receipt retained")});
    for(const state of ["indeterminate","cancelled","failed"] as const){
      const r=value(service.submit(state,input));assign(store,r.runId);value(service.claim(r.runId,"attempt"));
      value(service.settle(r.runId,"attempt",{state,error:{code:state==="failed"?"provider":state,message:state==="failed"?"fetch failed":old.error.message}}));
      expect(service.retry(state)).toMatchObject({ok:false,error:{code:"invalid-state"}});
      expect(service.get(state)?.state).toBe(state);
    }
    value(service.cancel("historical"));expect(service.retry("historical")).toMatchObject({ok:false});
  }finally{store.close();}
});

it("serves retry and immutable attempt history without weakening the indeterminate fence",async()=>{
  const store=Store.open(":memory:"),service=new CompletionService(store,"/tmp"),daemon=new Daemon(store,loadConfig("/missing"),"/release") as any;
  daemon.reconcile=async()=>{};
  expect(store.path).toBe(":memory:");
  expect(daemon.threads.db.prepare("PRAGMA database_list").all()).toMatchObject([{ name: "main", file: "" }]);
  const server=createServer((req,res)=>void daemon.request(req,res));
  try{
    const first=value(service.submit("api-rejection",input));assign(store,first.runId);value(service.claim(first.runId,"first"));
    const old:CompletionExecution={state:"failed",error:{code:"provider",message:'{"detail":"Rate limit exceeded"}'}};value(service.settle(first.runId,"first",old));
    await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));
    const base=`http://127.0.0.1:${(server.address() as {port:number}).port}/v1/completions/api-rejection`;
    const retry=await fetch(base+'/retry',{method:'POST'});expect(retry.status).toBe(200);expect(await retry.json()).toMatchObject({state:'queued',runId:first.runId});
    const attempts=await(await fetch(base+'/attempts')).json();expect(attempts.attempts[0].outcome).toEqual(old);
    const plans=await(await fetch(base.replace('/completions/api-rejection','/plans'))).json();
    expect(Object.keys(plans.controls).some(key=>key.startsWith('completion-attempt:')||key.startsWith('completion-receipt:'))).toBe(false);
    await fetch(base+'/cancel',{method:'POST'});expect((await fetch(base+'/retry',{method:'POST'})).status).toBe(409);
  }finally{await new Promise<void>(resolve=>server.close(()=>resolve()));await daemon.threads.close();store.close();}
});

it("uses observed rejection concurrency once per wave, honors cooldown, and expands after success",()=>{
  const store=Store.open(":memory:");
  try{
    store.upsertAccount({id:"account",provider:"openai-codex"});
    expect(completionFeedbackRefusal(store,"account",100)).toBeUndefined();
    expect(recordCompletionRejection(store,"account",100,3000,100)).toBe(3100);
    recordCompletionRejection(store,"account",200,2000,10);
    let feedback=JSON.parse(store.control("completion-feedback:account")!);
    expect(feedback.limit).toBe(50);expect(feedback.rejections).toBe(1);
    expect(completionFeedbackRefusal(store,"account",1000)).toContain("backoff");
    for(let n=0;n<50;n++)recordCompletionSuccess(store,"account",4000);
    feedback=JSON.parse(store.control("completion-feedback:account")!);expect(feedback.limit).toBe(100);
    recordCompletionRejection(store,"account",5000,1000,80);
    expect(JSON.parse(store.control("completion-feedback:account")!).limit).toBe(40);
    expect(store.account("account")?.cooldownUntil).toBe(6000);
  }finally{store.close();}
});

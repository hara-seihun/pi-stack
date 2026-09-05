import { expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.js";
import { assign } from "../src/policy.js";
import { Store } from "../src/store.js";

it("balances admissions across restart without changing provider priority or resumed runs", () => {
  const root=mkdtempSync(join(tmpdir(),"thinking-pair-")),path=join(root,"config.json"),ledger=join(root,"ledger.sqlite3");
  writeFileSync(path,JSON.stringify({profiles:{
    standard:[{provider:"openai-codex",model:"gpt-6-astra",thinkingPair:["high","max"]},
      {provider:"anthropic",model:"claude-opus-5",thinking:"max"}],
    expert:[{provider:"openai-codex",model:"gpt-6-astra",thinking:"xhigh"}],
  }}));
  const config=loadConfig(path);
  let store=Store.open(ledger);
  try {
    store.upsertAccount({id:"codex",provider:"openai-codex",concurrency:100});
    store.upsertAccount({id:"opus",provider:"anthropic",concurrency:100});
    const create=(profile="standard")=>store.createRuns({count:1,source:"direct",prompt:"test",cwd:root,profile,budget:"force"})[0]!;
    const admit=(id:string,profile="standard")=>{
      const assignment=assign(store,profile,"force",config).assignment!;
      expect(store.assignRun(id,{...assignment,unit:id,releasePath:"/release"})).toBe(true);
      return store.run(id)!;
    };
    const levels:string[]=[];
    for(let i=0;i<12;i++){
      const id=create(),choice=assign(store,"standard","force",config).assignment!;
      expect(choice.accountId).toBe("codex");
      const controls=store.db.prepare("SELECT * FROM control ORDER BY key").all();
      expect(()=>store.assignRun(id,{...choice,accountId:"missing",unit:id,releasePath:"/release"})).toThrow();
      expect(store.db.prepare("SELECT * FROM control ORDER BY key").all()).toEqual(controls);
      const run=admit(id);
      levels.push(run.thinking!);
      const after=store.db.prepare("SELECT * FROM control ORDER BY key").all();
      expect(store.assignRun(id,{...choice,unit:id,releasePath:"/release"})).toBe(false);
      expect(store.resumeAssignedRun(id)).toBe(true);
      expect(store.run(id)?.thinking).toBe(run.thinking);
      expect(store.db.prepare("SELECT * FROM control ORDER BY key").all()).toEqual(after);
      store.updateRun(id,{state:"done"});
      if(i%2===0){
        store.setControl("boost:openai-codex","0");
        const opus=admit(create());
        expect(opus).toMatchObject({provider:"anthropic",thinking:"max"});
        store.updateRun(opus.id,{state:"done"});
        store.setControl("boost:openai-codex","1");
        const expert=admit(create("expert"),"expert");
        expect(expert.thinking).toBe("xhigh");
        store.updateRun(expert.id,{state:"done"});
        store.close();store=Store.open(ledger);
      }else{
        expect(levels.slice(-2).sort()).toEqual(["high","max"]);
      }
    }
    expect(levels.filter(level=>level==="high")).toHaveLength(6);
  } finally {
    store.close();rmSync(root,{recursive:true,force:true});
  }
});

it("rejects ambiguous or invalid thinking pairs", () => {
  const root=mkdtempSync(join(tmpdir(),"thinking-pair-config-")),path=join(root,"config.json");
  try {
    for(const fields of [
      {thinkingPair:["high"]}, {thinkingPair:["high","high"]},
      {thinkingPair:["high","invalid"]}, {thinkingPair:"high"},
      {thinking:"max",thinkingPair:["high","max"]},
    ]){
      writeFileSync(path,JSON.stringify({profiles:{standard:[{provider:"openai-codex",model:"gpt-6-astra",...fields}]}}));
      expect(()=>loadConfig(path)).toThrow("thinkingPair requires");
    }
  } finally { rmSync(root,{recursive:true,force:true}); }
});

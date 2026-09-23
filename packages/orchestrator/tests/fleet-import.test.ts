import { it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store.js";
import { ThreadService } from "../src/threads/service.js";
import { importFleetThreads } from "../src/threads/import.js";

it("moves queued and settled assignments to their owners without moving completion custody", async () => {
  const root=mkdtempSync(join(tmpdir(),"fleet-import-")),store=Store.open(":memory:");
  const openSession=async()=>{throw new Error("Import must not execute work");};
  const fleet=new ThreadService({databasePath:join(root,"fleet.sqlite3"),sessionsDir:root,openSession});
  const app=new ThreadService({databasePath:join(root,"app.sqlite3"),sessionsDir:root,openSession});
  const create=()=>store.createRuns({count:1,source:"direct",prompt:"Do the task",cwd:root,profile:"astra",budget:"force"})[0]!;
  const queued=create(),done=create(),completion=create();
  store.updateRun(done,{state:"done",result:"Finished"});
  store.setControl(`run-context:${done}`,JSON.stringify({tools:["read"]}));
  store.setControl(`completion-run:${completion}`,"completion-receipt");
  const options={sessionsDir:root,selectService:(thread:any)=>thread.metadata?.context?app:fleet,services:()=>[app]};
  try {
    expect(importFleetThreads(fleet,store.db,options)).toEqual({ok:true,value:{threads:2,messages:2}});
    expect(fleet.pending(queued)).toHaveLength(1);
    expect(fleet.get(done)).toBeNull();
    expect(app.get(done)?.metadata?.context).toEqual({tools:["read"]});
    expect(app.get(done)?.state).toBe("idle");
    expect(app.latestSettlement(done)).toMatchObject({outcome:"complete",finalMessage:{content:[{type:"text",text:"Finished"}]}});
    expect(store.runs().map(run=>run.id)).toEqual([completion]);
    expect(store.control(`completion-run:${completion}`)).toBe("completion-receipt");
    expect(importFleetThreads(fleet,store.db,options)).toEqual({ok:true,value:{threads:0,messages:0}});
    expect(fleet.pending(queued)).toHaveLength(1);
  } finally {await fleet.close();await app.close();store.close();rmSync(root,{recursive:true,force:true});}
});

import { expect, it, vi } from "vitest";
import { Store } from "../src/store.js";
import { Heartbeats } from "../src/heartbeats.js";

it("coalesces token floods into one transaction and never revives terminal work", () => {
  const store=Store.open(":memory:"), heartbeats=new Heartbeats(store);
  try {
    store.upsertAccount({id:"account",provider:"openai-codex"});
    const [id]=store.createRuns({count:1,source:"direct",prompt:"work",cwd:"/tmp",profile:"luna",budget:"force"});
    store.assignRun(id!,{accountId:"account",provider:"openai-codex",model:"gpt-5.6-luna",unit:"unit",releasePath:"/release"});
    const transaction=vi.spyOn(store,"transaction");
    for(let n=0;n<1000;n++)expect(heartbeats.accept(id!,{progress:n===0,activity:"WORKING",text:String(n)})).toBe(true);
    expect(transaction).not.toHaveBeenCalled();
    heartbeats.flush();expect(transaction).toHaveBeenCalledTimes(1);
    expect(store.live()[0].text).toBe("999");
    expect(store.run(id!)?.progressAt).toBeGreaterThan(0);
    heartbeats.accept(id!,{progress:true,activity:"WORKING",text:"late"});
    store.updateRun(id!,{state:"done",result:"retained"});
    heartbeats.flush();
    expect(store.run(id!)).toMatchObject({state:"done",result:"retained"});
    expect(store.activeLeases()).toHaveLength(0);
    expect(store.live()[0].text).toBe("999");
    expect(heartbeats.accept("missing",{})).toBe(false);
  } finally { heartbeats.flush();store.close(); }
});

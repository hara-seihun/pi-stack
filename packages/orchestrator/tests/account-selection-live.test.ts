import { expect, it, vi } from "vitest";
import { chooseInteractiveAccount, interactiveRetryAvailability } from "../src/auth/account-selection.js";
import { catalogModel } from "../src/catalog.js";
import { Store } from "../src/store.js";

it("puts a live session on the least loaded account and ordinary sessions on the least spent", () => {
  const store = Store.open(":memory:");
  try {
    store.upsertAccount({ id: "openai-codex-busy", provider: "openai-codex", concurrency: 4 });
    store.upsertAccount({ id: "openai-codex-quiet", provider: "openai-codex", concurrency: 4 });
    store.recordMeter("openai-codex-busy", "weekly", 10, Date.now() + 3_600_000);
    store.recordMeter("openai-codex-quiet", "weekly", 40, Date.now() + 3_600_000);
    for (const n of [1, 2, 3, 4]) store.createLease(`fleet-${n}`, "openai-codex-busy", "fleet");
    const auth = { has: () => true } as never;
    expect(chooseInteractiveAccount(store, auth, "openai-codex")?.id).toBe("openai-codex-busy");
    expect(chooseInteractiveAccount(store, auth, "openai-codex", undefined, { live: true })?.id).toBe("openai-codex-quiet");
  } finally { store.close(); }
});

it("never probes fresh exhausted model windows, even when cooling capacity is the only alternative", () => {
  const store = Store.open(":memory:");
  const model=catalogModel("opus")!.model,auth={has:()=>true} as never,now=Date.now();
  const clock=vi.spyOn(Date,"now").mockReturnValue(now);
  try {
    for(const id of ["anthropic-1","anthropic-2","anthropic-3"])store.upsertAccount({id,provider:"anthropic"});
    store.recordMeter("anthropic-1","anthropic-5h",100,now+3_600_000);
    store.recordMeter("anthropic-3","anthropic-5h",100,now+3_600_000);
    store.recordMeter("anthropic-2","anthropic-5h",0,now+3_600_000);
    store.recordMeter("anthropic-2","anthropic-7d",72,now+86_400_000);
    store.recordMeter("anthropic-2","anthropic-7d_oi",100,now+86_400_000);
    store.setCooldown("anthropic-2",now+86_400_000);
    expect(chooseInteractiveAccount(store,auth,"anthropic",undefined,{model,includeCooling:true})?.id).toBe("anthropic-2");
    expect(chooseInteractiveAccount(store,auth,"anthropic",new Set(["anthropic-2"]),{model,includeCooling:true})).toBeUndefined();
    expect(interactiveRetryAvailability(store,auth,"anthropic",model,now)).toEqual({available:false,retryAt:now+3_600_000});
    clock.mockReturnValue(now+1);
    store.recordMeter("anthropic-1","anthropic-5h",0,now+3_600_000,now+1);
    expect(interactiveRetryAvailability(store,auth,"anthropic",model,now+1).available).toBe(true);
    expect(chooseInteractiveAccount(store,auth,"anthropic",undefined,{model:catalogModel("fable")!.model,includeCooling:true})?.id).toBe("anthropic-1");
  } finally { clock.mockRestore();store.close(); }
});

it("does not mistake a stale or reset exhausted reading for current exhaustion",()=>{
  const store=Store.open(":memory:"),auth={has:()=>true} as never,now=Date.now();
  try{
    store.upsertAccount({id:"anthropic-1",provider:"anthropic"});
    store.recordMeter("anthropic-1","anthropic-5h",100,now-1,now-2);
    store.recordMeter("anthropic-1","anthropic-7d",100,now+86_400_000,now-2*3_600_000);
    expect(chooseInteractiveAccount(store,auth,"anthropic",undefined,{model:catalogModel("opus")!.model})?.id).toBe("anthropic-1");
  }finally{store.close();}
});

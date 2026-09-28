import { expect, it } from "vitest";
import { chooseInteractiveAccount } from "../src/auth/account-selection.js";
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

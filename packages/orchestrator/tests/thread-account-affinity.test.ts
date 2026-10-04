import { expect, it } from "vitest";
import { Fleet } from "../src/fleet.js";
import { loadConfig } from "../src/config.js";
import { assign } from "../src/policy.js";
import { Store } from "../src/store.js";
import type { Thread } from "../src/threads/contracts.js";

const opus = { provider: "anthropic", model: "claude-opus-5-5", thinking: "high" } as const;
const thread: Thread = { id: "cached-thread", parentId: "parent", title: "work", cwd: "/tmp", sessionFile: "/tmp/cache-affinity.jsonl",
  settings: { model: `${opus.provider}/${opus.model}`, thinkingLevel: "high", speed: "standard" }, admission: "force",
  state: "running", held: false, revision: 1, createdAt: 1, updatedAt: 1, pendingMessages: 1 };
function fixture() {
  const store = Store.open(":memory:");
  for (const id of ["anthropic-1", "anthropic-2"]) store.upsertAccount({ id, provider: opus.provider, concurrency: 1 });
  const config = { ...loadConfig("/missing"), profiles: { thread: [opus] } };
  return { store, config, choose: (id = thread.id, model: string = opus.model, pin?: string, exclude = new Set<string>()) =>
    assign(store, "thread", "force", { ...config, profiles: { thread: [{ ...opus, model }] } }, Date.now(), pin, id, "user", exclude).assignment?.accountId };
}

it.each(["force", "live"] as const)("retains eligible %s thread affinity across idle execution and scheduler restart despite changed load", async admission => {
  const { store, config } = fixture();
  try {
    let fleet = new Fleet(store, config);
    const first = await fleet.admit({ ...thread, admission }, thread.settings, false, "first");
    expect(first).toMatchObject({ ok: true, value: { env: { PI_ORCHESTRATOR_ACCOUNT_ID: "anthropic-1" } } });
    if (!first.ok) throw new Error(first.error.message);
    await first.value.release();
    expect(store.activeSessionLeases()).toEqual([]);
    store.createLease("unrelated-load", "anthropic-1", "interactive");
    fleet = new Fleet(store, config);
    const resumed = await fleet.admit({ ...thread, admission }, thread.settings, false, "resumed");
    expect(resumed).toMatchObject({ ok: true, value: { env: { PI_ORCHESTRATOR_ACCOUNT_ID: "anthropic-1" } } });
    if (resumed.ok) await resumed.value.release();
    const fresh = await fleet.admit({ ...thread, id: "fresh-thread", admission }, thread.settings, false, "fresh");
    expect(fresh).toMatchObject({ ok: true, value: { env: { PI_ORCHESTRATOR_ACCOUNT_ID: "anthropic-2" } } });
    if (fresh.ok) await fresh.value.release();
  } finally { store.close(); }
});

it.each(["cooldown", "quota", "disabled", "excluded", "pin"] as const)("does not retain an account over %s and keeps the eligible replacement", reason => {
  const { store, choose } = fixture();
  try {
    expect(choose()).toBe("anthropic-1");
    if (reason === "cooldown") store.setCooldown("anthropic-1", Date.now() + 60_000, { model: opus.model });
    if (reason === "quota") store.recordMeter("anthropic-1", "anthropic-7d", 100, Date.now() + 60_000);
    if (reason === "disabled") store.setAccountEnabled("anthropic-1", false);
    expect(choose(thread.id, opus.model, reason === "pin" ? "anthropic-2" : undefined,
      new Set(reason === "excluded" ? ["anthropic-1"] : []))).toBe("anthropic-2");
    store.setCooldown("anthropic-1");
    store.recordMeter("anthropic-1", "anthropic-7d", 0, Date.now() + 60_000);
    store.setAccountEnabled("anthropic-1", true);
    store.createLease("new-replacement-load", "anthropic-2", "interactive");
    expect(choose()).toBe("anthropic-2");
  } finally { store.close(); }
});

it("scopes affinity to thread, provider and model, without changing ordinary profile routing", () => {
  const { store, config, choose } = fixture();
  try {
    expect(choose()).toBe("anthropic-1");
    store.createLease("first-account-busy", "anthropic-1", "interactive");
    expect(choose("another-thread")).toBe("anthropic-2");
    expect(choose(thread.id, "claude-opus-5")).toBe("anthropic-2");
    store.upsertAccount({ id: "codex-1", provider: "openai-codex", concurrency: 1 });
    const codex = { ...config, profiles: { thread: [{ provider: "openai-codex" as const, model: "gpt-6.1-sol", thinking: "high" }] } };
    expect(assign(store, "thread", "force", codex, Date.now(), undefined, thread.id).assignment?.accountId).toBe("codex-1");
    expect(choose()).toBe("anthropic-1");
    const ordinary = { ...config, profiles: { ordinary: [opus] } };
    expect(assign(store, "ordinary", "force", ordinary, Date.now(), undefined, thread.id).assignment?.accountId).toBe("anthropic-2");
    store.setControl("launches", "paused");
    expect(choose()).toBeUndefined();
  } finally { store.close(); }
});

it("keeps background account and machine capacity checks ahead of affinity", () => {
  const { store, config, choose } = fixture();
  try {
    expect(choose()).toBe("anthropic-1");
    store.createLease("busy-preferred", "anthropic-1", "interactive");
    expect(assign(store, "thread", "background", config, Date.now(), undefined, thread.id).assignment?.accountId).toBe("anthropic-2");
    expect(assign(store, "thread", "background", { ...config, maxConcurrentSessions: 1 }, Date.now(), undefined, thread.id).assignment).toBeUndefined();
  } finally { store.close(); }
});

import { expect, it } from "vitest";
import { Fleet } from "../src/fleet.js";
import { loadConfig } from "../src/config.js";
import { Store } from "../src/store.js";
import type { Thread } from "../src/threads/contracts.js";

const thread: Thread = { id: "thread", parentId: null, title: "work", cwd: "/tmp", sessionFile: "/tmp/thread.jsonl",
  settings: { model: "openai-codex/gpt-6-astra", thinkingLevel: "high", speed: "standard" }, admission: "force",
  state: "running", held: false, revision: 1, createdAt: 1, updatedAt: 1, pendingMessages: 1 };

it("leases executions without creating fleet runs and enforces account capacity", async () => {
  const store = Store.open(":memory:");
  store.upsertAccount({ id: "a", provider: "openai-codex", concurrency: 1 });
  const fleet = new Fleet(store, loadConfig("/missing"));
  try {
    const first = await fleet.admit(thread, thread.settings, false, "execution-one");
    expect(first.ok).toBe(true);
    expect(store.runs()).toEqual([]);
    expect(store.activeSessionLeases().map(lease => lease.id)).toEqual(["thread:execution-one"]);
    expect((await fleet.admit({ ...thread, id: "other" }, thread.settings, false, "execution-two")).ok).toBe(false);
    if (!first.ok) throw new Error(first.error.message);
    await first.value.release();
    expect(store.activeSessionLeases()).toEqual([]);
    store.setControl("launches", "paused");
    const recovery = await fleet.admit(thread, thread.settings, true, "execution-one");
    expect(recovery.ok).toBe(true);
    if (recovery.ok) await recovery.value.release();
    store.setControl("launches", "enabled");
    const second = await fleet.admit(thread, thread.settings, false, "execution-three");
    expect(second.ok).toBe(true);
    if (second.ok) await second.value.release();
  } finally { store.close(); }
});

it("forces children but never bypasses exhausted quota, including root repair", async () => {
  const store = Store.open(":memory:");
  store.upsertAccount({ id: "a", provider: "openai-codex", concurrency: 1 });
  store.setControl("boost:openai-codex", "0");
  const fleet = new Fleet(store, loadConfig("/missing"));
  try {
    const child = await fleet.admit({ ...thread, parentId: "parent", admission: "background" }, thread.settings, false, "child-work");
    expect(child.ok).toBe(true);
    if (child.ok) await child.value.release();
    store.recordMeter("a", "weekly", 100, Date.now() + 1000);
    expect((await fleet.admit(thread, thread.settings, false, "exhausted")).ok).toBe(false);
    const root = await fleet.admit({ ...thread, metadata: { execution: "root-repair" } }, thread.settings, false, "root-work");
    expect(root).toMatchObject({ ok: false, error: { code: "unavailable", message: expect.stringContaining("provider quota exhausted") } });
    expect(store.control("repair-owner")).toBeUndefined();
  } finally { store.close(); }
});

it("owns root repair leases and recovers only recorded executions without isolated context", async () => {
  const store = Store.open(":memory:");
  store.upsertAccount({ id: "a", provider: "openai-codex", concurrency: 2 });
  store.setControl("ordinary-launches", "paused");
  const fleet = new Fleet(store, loadConfig("/missing"));
  const root = { ...thread, metadata: { execution: "root-repair" } };
  try {
    expect(await fleet.admit(root, root.settings, true, "missing")).toMatchObject({ ok: false, error: { code: "unavailable", message: expect.stringContaining("no recorded account lease") } });
    expect(await fleet.admit({ ...root, metadata: { ...root.metadata, context: { tools: [] } } }, root.settings, false, "isolated")).toMatchObject({ ok: false, error: { code: "invalid_request" } });
    expect(store.activeSessionLeases()).toEqual([]);
    const admitted = await fleet.admit(root, root.settings, false, "root-work");
    expect(admitted.ok).toBe(true);
    if (!admitted.ok) throw new Error(admitted.error.message);
    try {
      expect(store.control("repair-owner")).toBe(root.id);
      expect(await fleet.admit({ ...root, id: "other-root" }, root.settings, false, "other-work")).toMatchObject({ ok: false, error: { message: expect.stringContaining("repair already owned") } });
      expect(await fleet.admit({ ...root, id: "other-root" }, root.settings, true, "root-work")).toMatchObject({ ok: false, error: { message: expect.stringContaining("no recorded account lease") } });
    } finally { await admitted.value.release(); }
    expect(store.control("repair-owner")).toBeUndefined();
    store.setControl("launches", "paused");
    const recovered = await fleet.admit(root, root.settings, true, "root-work");
    expect(recovered.ok).toBe(true);
    if (!recovered.ok) throw new Error(recovered.error.message);
    try {
      expect(store.control("repair-owner")).toBe(root.id);
      expect(store.activeSessionLeases().map(lease => lease.id)).toEqual(["thread:root-work"]);
    } finally { await recovered.value.release(); }
    expect(store.control("repair-owner")).toBeUndefined();
    expect(store.activeSessionLeases()).toEqual([]);
  } finally { store.close(); }
});

it("admits ordinary executions through a model broker without local accounts or OAuth leases", async () => {
  const store = Store.open(":memory:");
  const config = { ...loadConfig("/missing"), modelBrokerUrl: "http://127.0.0.1:2461", maxConcurrentSessions: 2 };
  const fleet = new Fleet(store, config);
  try {
    const admitted = await fleet.admit(thread, thread.settings, false, "broker-work");
    expect(admitted).toMatchObject({ ok: true, value: { env: {
      PI_MODEL_BROKER_URL: "http://127.0.0.1:2461", PI_THREAD_USAGE: "service", PI_THREAD_ADMISSION: "force",
    } } });
    expect(store.accounts()).toEqual([]);
    expect(store.activeSessionLeases()).toEqual([]);
    expect(store.control("broker-execution:broker-work")).toBe(thread.id);

    store.setControl("launches", "paused");
    const restarted = new Fleet(store, config);
    const recovered = await restarted.admit(thread, thread.settings, true, "broker-work");
    expect(recovered.ok).toBe(true);
    expect(await restarted.admit(thread, thread.settings, true, "missing")).toMatchObject({ ok: false, error: { message: expect.stringContaining("no recorded model-broker custody") } });
    if (recovered.ok) await recovered.value.release();
    expect(store.control("broker-execution:broker-work")).toBeUndefined();
    expect(await fleet.admit(thread, thread.settings, false, "paused")).toMatchObject({ ok: false, error: { message: "emergency halt" } });
  } finally { store.close(); }
});

it.each([false, true])("admits explicitly chosen Anthropic for roots, children, lanes and direct runs (broker: %s)", async broker => {
  const store = Store.open(":memory:");
  store.upsertAccount({ id: "anthropic-1", provider: "anthropic", concurrency: 3 });
  const fleet = new Fleet(store, { ...loadConfig("/missing"), ...(broker ? { modelBrokerUrl: "http://127.0.0.1:2461" } : {}) });
  const settings = { ...thread.settings, model: "anthropic/claude-opus-5" };
  try {
    const admitted: [Thread, string][] = [[thread, "interactive"], [{ ...thread, parentId: "parent" }, "child"],
      [{ ...thread, metadata: { source: "lane" } }, "lane"], [{ ...thread, metadata: { source: "direct" } }, "direct"]];
    for (const [admitted_, id] of admitted) {
      const admitted = admitted_;
      const result = await fleet.admit(admitted, settings, false, id);
      expect(result.ok).toBe(true);
      if (result.ok) await result.value.release();
    }
  } finally { store.close(); }
});

it("denies root repair and direct providers in model-broker mode", async () => {
  const store = Store.open(":memory:");
  const fleet = new Fleet(store, { ...loadConfig("/missing"), modelBrokerUrl: "http://127.0.0.1:2461" });
  try {
    expect(await fleet.admit({ ...thread, metadata: { execution: "root-repair" } }, thread.settings, false, "repair"))
      .toMatchObject({ ok: false, error: { code: "invalid_request", message: expect.stringContaining("Root repair") } });
    expect(await fleet.admit(thread, { ...thread.settings, model: "google/gemini" }, false, "ambient"))
      .toMatchObject({ ok: false, error: { code: "invalid_request", message: expect.stringContaining("model broker") } });
    expect(store.control("broker-execution:repair")).toBeUndefined();
    expect(store.control("broker-execution:ambient")).toBeUndefined();
  } finally { store.close(); }
});

it("releases a retained lease on settlement without readmitting its stopped execution", () => {
  const store = Store.open(":memory:");
  store.upsertAccount({ id: "a", provider: "openai-codex", concurrency: 1 });
  store.createLease("thread:retained", "a", "fleet", thread.id);
  store.setControl("repair-owner", thread.id);
  const fleet = new Fleet(store, loadConfig("/missing"));
  try {
    fleet.event(thread.id, { type: "thread_settled", executionId: "retained", outcome: "cancelled" });
    expect(store.activeSessionLeases()).toEqual([]);
    expect(store.control("repair-owner")).toBeUndefined();
  } finally { store.close(); }
});

it("records each native assistant usage receipt once against its admitted account", async () => {
  const store = Store.open(":memory:");
  store.upsertAccount({ id: "a", provider: "openai-codex", concurrency: 1 });
  const fleet = new Fleet(store, loadConfig("/missing"));
  try {
    const admitted = await fleet.admit(thread, thread.settings, false, "work");
    expect(admitted.ok).toBe(true);
    const event = { type: "message_end", message: { role: "assistant", model: "gpt-6-astra", timestamp: 1, usage: { input: 3, output: 5 } } };
    fleet.event(thread.id, event); fleet.event(thread.id, event);
    expect(store.usageSince(0).map(row => [row.accountId, row.component, row.tokens])).toEqual([["a", "input", 3], ["a", "output", 5]]);
    if (admitted.ok) await admitted.value.release();
  } finally { store.close(); }
});

it("cools a thread's account for the limit class the provider named", async () => {
  const store = Store.open(":memory:");
  store.upsertAccount({ id: "a", provider: "openai-codex", concurrency: 3 });
  const fleet = new Fleet(store, loadConfig("/missing"));
  try {
    const cooldown = async (errorMessage: string) => {
      store.setCooldown("a", 0);
      const admitted = await fleet.admit(thread, thread.settings, false, errorMessage);
      if (!admitted.ok) throw new Error(admitted.error.message);
      const before = Date.now();
      fleet.event(thread.id, { type: "message_end", message: { role: "assistant", stopReason: "error", errorMessage } });
      await admitted.value.release();
      return store.account("a")!.cooldownUntil! - before;
    };
    expect(await cooldown("429 rate_limit_error: This request would exceed your account's monthly spend limit.")).toBeGreaterThan(23 * 3_600_000);
    expect(await cooldown("429 Too Many Requests")).toBeLessThan(2 * 60_000);
  } finally { store.close(); }
});

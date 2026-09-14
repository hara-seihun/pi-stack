import { expect, it } from "vitest";
import { Fleet } from "../src/fleet.js";
import { loadConfig } from "../src/config.js";
import { Store } from "../src/store.js";
import type { Thread } from "../src/threads/contracts.js";

const thread: Thread = { id: "thread", parentId: null, title: "work", cwd: "/tmp", sessionFile: "/tmp/thread.jsonl",
  settings: { model: "openai-codex/gpt-6-astra", thinkingLevel: "high", speed: "standard" }, admission: "force",
  state: "queued", revision: 1, createdAt: 1, updatedAt: 1, pendingMessages: 1 };

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

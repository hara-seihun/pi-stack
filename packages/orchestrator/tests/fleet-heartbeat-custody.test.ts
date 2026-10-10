import { expect, it, vi } from "vitest";
import { Daemon } from "../src/daemon.js";
import { Fleet } from "../src/fleet.js";
import { loadConfig } from "../src/config.js";
import { Store } from "../src/store.js";
import type { Thread } from "../src/threads/contracts.js";

const thread: Thread = { id: "retained", parentId: null, title: "retained", cwd: "/tmp", sessionFile: "/tmp/retained.jsonl",
  settings: { model: "openai-codex/gpt-6-astra", thinkingLevel: "high", speed: "standard" }, admission: "force",
  lifecycle: { kind: "idle" }, state: "running", held: false, revision: 1, createdAt: 1, updatedAt: 1, pendingMessages: 1 };

it.each([false, true])("detaches timers without releasing accepted execution custody (broker: %s)", async broker => {
  vi.useFakeTimers();
  const store = Store.open(":memory:");
  store.upsertAccount({ id: "a", provider: "openai-codex", concurrency: 1 });
  const config = { ...loadConfig("/missing"), ...(broker ? { modelBrokerUrl: "http://127.0.0.1:2461" } : {}) };
  const fleet = new Fleet(store, config), heartbeat = vi.spyOn(store, "heartbeatLease");
  let closed = false;
  try {
    expect((await fleet.admit(thread, thread.settings, false, "accepted")).ok).toBe(true);
    await vi.advanceTimersByTimeAsync(15_001);
    expect(heartbeat).toHaveBeenCalledTimes(broker ? 0 : 1);
    if (!broker) {
      expect((await fleet.admit(thread, thread.settings, true, "accepted")).ok).toBe(true);
      expect(vi.getTimerCount()).toBe(1);
    }
    fleet.detach(); fleet.detach();
    expect(vi.getTimerCount()).toBe(0);
    if (broker) expect(store.control("broker-execution:accepted")).toBe(thread.id);
    else expect(store.activeSessionLeases().map(lease => lease.id)).toEqual(["thread:accepted"]);
    const recovered = new Fleet(store, config);
    const admission = await recovered.admit(thread, thread.settings, true, "accepted");
    expect(admission.ok).toBe(true);
    recovered.detach();
    const heartbeatsBeforeClose = heartbeat.mock.calls.length;
    store.close(); closed = true;
    await vi.advanceTimersByTimeAsync(30_001);
    expect(heartbeat).toHaveBeenCalledTimes(heartbeatsBeforeClose);
    expect(await fleet.admit(thread, thread.settings, true, "accepted")).toMatchObject({ ok: false, error: { code: "unavailable" } });
  } finally {
    fleet.detach(); if (!closed) store.close(); vi.restoreAllMocks(); vi.useRealTimers();
  }
});

it.each([false, true])("daemon lifetime stops lease timers before caller closes its ledger (failed: %s)", async failed => {
  const detach = vi.fn();
  const owner = { fleet: { detach }, startOwned: async () => { if (failed) throw new Error("native custody retained"); } };
  const result = Daemon.prototype.start.call(owner as unknown as Daemon);
  if (failed) await expect(result).rejects.toThrow("native custody retained");
  else await expect(result).resolves.toBeUndefined();
  expect(detach).toHaveBeenCalledTimes(1);
});

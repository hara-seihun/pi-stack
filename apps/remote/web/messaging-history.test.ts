import { describe, expect, test } from "bun:test";
import type { MessagingHistory, MessagingResult, MessagingSnapshot } from "../server/messaging/protocol";
import { MessagingHistoryCache, MESSAGING_PRELOAD_WINDOW_MS } from "./src/messaging-history";

const snapshot = (version: number, ids = ["a", "b"]): MessagingSnapshot => ({
  version, backends: [], calls: [], conversations: ids.map(id => ({
    id, backendId: "signal", externalId: id, title: id, kind: "direct", updatedAt: 100, unread: 2, current: true, avatar: null,
  })),
});
const history: MessagingHistory = { messages: [], before: 42 };
const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };

function fixture() {
  const calls: Array<{ id: string; since: number; signal: AbortSignal; resolve: (result: MessagingResult<MessagingHistory>) => void }> = [];
  const cache = new MessagingHistoryCache((id, signal, since) => new Promise(resolve => calls.push({ id, signal, since, resolve })), () => 2 * MESSAGING_PRELOAD_WINDOW_MS);
  return { cache, calls };
}

describe("eager messaging history", () => {
  test("preloads seven days before selection and opening reuses the completed window", async () => {
    const { cache, calls } = fixture();
    const inbox = snapshot(1);
    cache.reconcile(inbox);
    expect(calls.map(call => call.id)).toEqual(["a", "b"]);
    expect(calls.every(call => call.since === MESSAGING_PRELOAD_WINDOW_MS)).toBe(true);
    calls[0].resolve({ ok: true, value: history });
    await flush();
    expect(cache.get("a").history).toBe(history);
    cache.ensure("a");
    cache.reconcile(inbox);
    expect(calls).toHaveLength(2);
    expect(inbox.conversations.map(item => item.unread)).toEqual([2, 2]);
    cache.dispose();
  });

  test("bounds concurrent requests, prioritizes a tap, and shares in-flight loads", async () => {
    const { cache, calls } = fixture();
    cache.reconcile(snapshot(1, ["a", "b", "c", "d", "e", "f"]));
    expect(calls).toHaveLength(4);
    cache.ensure("a");
    cache.ensure("f");
    calls[0].resolve({ ok: true, value: history });
    await flush();
    expect(calls.map(call => call.id)).toEqual(["a", "b", "c", "d", "f"]);
    cache.dispose();
  });

  test("reconciles an update arriving during preload without clearing the warm window", async () => {
    const { cache, calls } = fixture();
    cache.reconcile(snapshot(1, ["a"]));
    cache.reconcile(snapshot(2, ["a"]));
    expect(calls).toHaveLength(1);
    calls[0].resolve({ ok: true, value: history });
    await flush();
    expect(calls).toHaveLength(2);
    expect(cache.get("a").history).toBe(history);
    const next = { messages: [], before: 30 };
    calls[1].resolve({ ok: true, value: next });
    await flush();
    expect(cache.get("a").history).toBe(next);
    cache.dispose();
  });

  test("failed refresh retains history, exposes the error and allows retry", async () => {
    const { cache, calls } = fixture();
    cache.ensure("a");
    calls[0].resolve({ ok: true, value: history });
    await flush();
    cache.refresh("a");
    calls[1].resolve({ ok: false, error: { code: "network", message: "Offline" } });
    await flush();
    expect(cache.get("a")).toEqual({ history, error: "Offline" });
    cache.refresh();
    calls[2].resolve({ ok: true, value: history });
    await flush();
    expect(cache.get("a").error).toBe("");
    cache.dispose();
  });

  test("locking clears private history and late results cannot repopulate the next lifecycle", async () => {
    const { cache, calls } = fixture();
    cache.ensure("a");
    cache.dispose();
    expect(calls[0].signal.aborted).toBe(true);
    cache.start();
    cache.ensure("a");
    calls[0].resolve({ ok: true, value: history });
    await flush();
    expect(cache.get("a").history).toBeUndefined();
    calls[1].resolve({ ok: true, value: { messages: [], before: null } });
    await flush();
    expect(cache.get("a").history?.before).toBeNull();
    cache.dispose();
    expect(cache.get("a").history).toBeUndefined();
  });
});

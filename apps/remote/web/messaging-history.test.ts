import { describe, expect, test } from "bun:test";
import type { MessagingHistory, MessagingHistoryChanges, MessagingMessage, MessagingResult, MessagingSnapshot } from "../server/messaging/protocol";
import { MessagingHistoryCache } from "./src/messaging-history";

const snapshot = (revision: number, ids = ["a", "b"]): MessagingSnapshot => ({
  version: revision, backends: [], calls: [], conversations: ids.map(id => ({
    id, backendId: "signal", externalId: id, title: id, kind: "direct", updatedAt: 100, unread: 2, current: true, avatar: null, revision,
  })),
});
const message = (id: string, text = id, timestamp = 1): MessagingMessage => ({
  id, requestId: null, conversationId: "a", externalId: id, direction: "incoming", sender: "friend", text, timestamp, status: "received", error: null, attachments: [],
});
const history: MessagingHistory = { messages: [message("m1"), message("m2", "m2", 2)], before: 42, revision: 1 };
const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };

type Call =
  | { kind: "window"; id: string; priority: "high" | "low"; signal: AbortSignal; resolve: (result: MessagingResult<MessagingHistory>) => void }
  | { kind: "changes"; id: string; after: number; from: number; signal: AbortSignal; resolve: (result: MessagingResult<MessagingHistoryChanges>) => void };

function fixture() {
  const calls: Call[] = [];
  const cache = new MessagingHistoryCache({
    window: (id, signal, priority) => new Promise(resolve => calls.push({ kind: "window", id, signal, priority, resolve })),
    changes: (id, signal, after, from) => new Promise(resolve => calls.push({ kind: "changes", id, signal, after, from, resolve })),
  });
  const window = (index: number, value: MessagingHistory = history) => (calls[index] as Extract<Call, { kind: "window" }>).resolve({ ok: true, value });
  const changes = (index: number, value: MessagingHistoryChanges) => (calls[index] as Extract<Call, { kind: "changes" }>).resolve({ ok: true, value });
  return { cache, calls, window, changes };
}

describe("messaging history", () => {
  test("preloads the newest page once; unchanged revisions and taps fetch nothing more", async () => {
    const { cache, calls, window } = fixture();
    cache.reconcile(snapshot(1));
    expect(calls.map(call => [call.kind, call.id])).toEqual([["window", "a"], ["window", "b"]]);
    window(0);
    window(1);
    await flush();
    expect(cache.get("a").history).toBe(history);
    cache.ensure("a");
    cache.reconcile(snapshot(1));
    expect(calls).toHaveLength(2);
    cache.dispose();
  });

  test("a revised conversation fetches only its changes after the held revision and window", async () => {
    const { cache, calls, window, changes } = fixture();
    cache.reconcile(snapshot(1));
    window(0);
    window(1);
    await flush();
    cache.reconcile({ ...snapshot(1), conversations: [...snapshot(5, ["a"]).conversations, ...snapshot(1, ["b"]).conversations] });
    expect(calls.slice(2)).toMatchObject([{ kind: "changes", id: "a", after: 1, from: 42 }]);
    changes(2, { messages: [message("m2", "edited", 2), message("m3", "new", 3)], removed: ["m1"], revision: 5 });
    await flush();
    const next = cache.get("a");
    expect(next.history).toEqual({ messages: [message("m2", "edited", 2), message("m3", "new", 3)], before: 42, revision: 5 });
    expect([...next.removed]).toEqual(["m1"]);
    expect(cache.get("b").history).toBe(history);
    cache.dispose();
  });

  test("a tap starts immediately even when background requests are stalled, without duplicate loads", async () => {
    const { cache, calls, window } = fixture();
    cache.reconcile(snapshot(1, ["a", "b", "c", "d", "e", "f"]));
    expect(calls).toHaveLength(3);
    cache.ensure("a");
    expect(calls).toHaveLength(3);
    cache.ensure("f");
    expect(calls.map(call => call.id)).toEqual(["a", "b", "c", "f"]);
    expect(calls.filter(call => call.kind === "window").map(call => call.priority)).toEqual(["low", "low", "low", "high"]);
    cache.ensure("f");
    expect(calls).toHaveLength(4);
    window(0);
    await flush();
    expect(calls).toHaveLength(4);
    window(1);
    await flush();
    expect(calls.map(call => call.id)).toEqual(["a", "b", "c", "f", "d"]);
    cache.dispose();
  });

  test("background pages start in most-recent conversation order", () => {
    const { cache, calls } = fixture();
    const value = snapshot(1, ["oldest", "middle", "newest", "recent"]);
    value.conversations.forEach((conversation, index) => { conversation.updatedAt = [1, 2, 4, 3][index]; });
    cache.reconcile(value);
    expect(calls.map(call => call.id)).toEqual(["newest", "recent", "middle"]);
    expect(value.conversations[0].id).toBe("oldest");
    cache.dispose();
  });

  test("a revision announced during a load is fetched as changes when it finishes", async () => {
    const { cache, calls, window, changes } = fixture();
    cache.reconcile(snapshot(1, ["a"]));
    cache.reconcile(snapshot(2, ["a"]));
    expect(calls).toHaveLength(1);
    window(0);
    await flush();
    expect(calls[1]).toMatchObject({ kind: "changes", after: 1 });
    changes(1, { messages: [], removed: [], revision: 2 });
    await flush();
    expect(cache.get("a").history?.revision).toBe(2);
    expect(calls).toHaveLength(2);
    cache.dispose();
  });

  test("a failure keeps history, waits for a refresh or newer revision, then retries", async () => {
    const { cache, calls, window, changes } = fixture();
    cache.ensure("a");
    window(0);
    await flush();
    cache.refresh("a");
    (calls[1] as Extract<Call, { kind: "changes" }>).resolve({ ok: false, error: { code: "network", message: "Offline" } });
    await flush();
    expect(cache.get("a")).toMatchObject({ history, error: "Offline" });
    expect(calls).toHaveLength(2);
    cache.refresh();
    changes(2, { messages: [], removed: [], revision: 1 });
    await flush();
    expect(cache.get("a").error).toBe("");
    cache.refresh();
    expect(calls).toHaveLength(3);
    cache.dispose();
  });

  test("locking clears private history and late results cannot repopulate the next lifecycle", async () => {
    const { cache, calls, window } = fixture();
    cache.ensure("a");
    cache.dispose();
    expect(calls[0].signal.aborted).toBe(true);
    cache.start();
    cache.ensure("a");
    window(0);
    await flush();
    expect(cache.get("a").history).toBeUndefined();
    window(1, { messages: [], before: null, revision: 0 });
    await flush();
    expect(cache.get("a").history?.before).toBeNull();
    cache.dispose();
    expect(cache.get("a").history).toBeUndefined();
  });
});

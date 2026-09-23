import { expect, test } from "bun:test";
import type { Session, StreamSubscription } from "./protocol";
import { ClientStream, applySessionDelta, sessionDelta } from "./stream";
import { startThreadRefresh } from "./thread-refresh";

function worker(): Session {
  return {
    id: "bonsai", parentId: null, hasChildren: false, origin: "fleet", model: "openai-codex/gpt-6-sol",
    name: "bonsai-optimization", cwd: "/home", workspaceName: "Home", environment: "local",
    state: "running", held: false, activity: "running", activeTools: [], provider: "openai",
    createdAt: "2026-09-22T00:00:00.000Z", updatedAt: "2026-09-22T00:00:00.000Z", revision: 1,
    idleUnread: false, queuedMessages: [], archivedAt: null,
  };
}

for (const subscription of [{ dashboard: false }, { session: "local-chat", viewing: true, dashboard: false }]) {
  test(`a persistent ${subscription.session ? "chat" : "worker list"} receives an unselected peer's external Stop`, async () => {
    const frames: string[] = [];
    const stream = new ClientStream({ write: value => frames.push(value), close() {} });
    stream.subscription = subscription;
    const peer = worker();
    stream.sentSessions.set(peer.id, JSON.stringify(peer));
    // The owner changes without a Remote request, reconnect or Machine visit.
    Object.assign(peer, { state: "idle", held: true, activity: "idle", revision: 2 });
    const received = Promise.withResolvers<void>();
    const stop = startThreadRefresh({
      subscriptions: () => [stream.subscription],
      async refreshPeers() {
        const rows = [{ session: peer, encoded: JSON.stringify(peer) }];
        const delta = sessionDelta(stream.sentSessions, rows);
        applySessionDelta(stream.sentSessions, rows, delta.removed);
        stream.send({ type: "state", version: 2, reset: false, ...delta, archivedTotal: 0, ownerErrors: [] });
        received.resolve();
      },
      async inspect(id) { expect(id).toBe("local-chat"); },
      onError: received.reject,
    }, 5);
    try {
      await received.promise;
      expect(frames.join("")).toContain('"state":"idle","held":true,"activity":"idle"');
      expect(JSON.parse(stream.sentSessions.get("bonsai")!).state).toBe("idle");
    } finally { stop(); stream.close(); }
  });
}

test("refresh is shared, does not overlap or run without clients, and stops with its owner", async () => {
  let subscriptions: StreamSubscription[] = [];
  let refreshes = 0;
  const inspections: string[] = [];
  const pending = Promise.withResolvers<void>();
  const started = Promise.withResolvers<void>();
  const errors: unknown[] = [];
  const stop = startThreadRefresh({
    subscriptions: () => subscriptions,
    async refreshPeers() { refreshes++; started.resolve(); await pending.promise; },
    async inspect(id) { inspections.push(id); await pending.promise; },
    onError: error => errors.push(error),
  }, 5);
  try {
    await Bun.sleep(15);
    expect(refreshes).toBe(0);
    subscriptions = [{ session: "a" }, { session: "a" }, { session: "b" }];
    await started.promise;
    await Bun.sleep(15);
    expect(refreshes).toBe(1);
    expect(inspections).toEqual(["a", "b"]);
    stop();
    pending.reject(new Error("owner unavailable"));
    await Bun.sleep(15);
    expect(errors).toHaveLength(3);
    expect(refreshes).toBe(1);
  } finally { stop(); pending.resolve(); }
});

import { expect, test } from "bun:test";
import type { Session, StreamSubscription } from "./protocol";
import { ClientStream } from "./stream";
import { ReconcileReplica } from "../shared/reconcile";
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
    const replica = new ReconcileReplica();
    stream.publish({ type: "state", sessions: [peer], archivedTotal: 0, ownerErrors: [] });
    for (const frame of frames.splice(0)) expect(replica.apply(JSON.parse(frame.split("data: ")[1])).ok).toBe(true);
    // The owner changes without a Remote request, reconnect or Machine visit.
    Object.assign(peer, { state: "idle", held: true, activity: "idle", revision: 2 });
    const received = Promise.withResolvers<void>();
    const stop = startThreadRefresh({
      subscriptions: () => [stream.subscription],
      async refreshPeers() {
        stream.publish({ type: "state", sessions: [peer], archivedTotal: 0, ownerErrors: [] });
        received.resolve();
      },
      async inspect(id) { expect(id).toBe("local-chat"); },
      onError: received.reject,
    }, 5);
    try {
      await received.promise;
      for (const frame of frames) expect(replica.apply(JSON.parse(frame.split("data: ")[1])).ok).toBe(true);
      const state = replica.get("state")!.value as { sessions: Session[] };
      expect(state.sessions[0]).toMatchObject({ state: "idle", held: true, activity: "idle" });
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

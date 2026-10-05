import { describe, expect, test } from "bun:test";
import { requestStop, runningDescendants, submitThreadControl } from "./src/thread-controls";
import { composerAction, conversationThreads, workerThreads, working } from "./src/thread-state";
import { inboxRows, selectionAfterSync } from "./src/chats";
import { streamSessions } from "../server/stream-sessions";
import { buildWorkerTree, isActiveWorker } from "./src/features/workers/tree-model";
import { threadStatus } from "./src/features/status/thread-status";
import type { Session } from "./src/types";

const session = (id: string, extra: Partial<Session> = {}): Session => ({
  id, parentId: null, hasChildren: false, origin: "person", model: "astra", name: id, cwd: "/home", workspaceName: "Home", environment: "home", state: "idle", held: false, activity: "idle",
  activeTools: [], provider: "openai", createdAt: "", updatedAt: "", revision: 1, idleUnread: false,
  queuedMessages: [], archivedAt: null, ...extra,
});

async function withThreadClient(fetcher: typeof fetch, run: () => Promise<void>) {
  const names = ["window", "fetch"] as const;
  const descriptors = new Map(names.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  try {
    Object.defineProperties(globalThis, {
      window: { configurable: true, writable: true, value: { PiRemotePerson: { session: () => "thread-control-session" } } },
      fetch: { configurable: true, writable: true, value: fetcher },
    });
    await run();
  } finally {
    for (const name of names) {
      const descriptor = descriptors.get(name);
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  }
}

describe("thread controls", () => {
  test("closing asks first only for running, unheld workers anywhere below the chat", () => {
    const sessions = [
      session("root"), session("idle", { parentId: "root" }), session("running", { parentId: "root", state: "running" }),
      session("held", { parentId: "root", state: "running", held: true }), session("deep", { parentId: "idle", state: "running" }),
      session("archived", { parentId: "root", state: "running", archivedAt: "2026-09-28T19:04:00Z" }), session("elsewhere", { state: "running" }),
    ];
    expect(runningDescendants("root", sessions).map(item => item.id).sort()).toEqual(["deep", "running"]);
    expect(runningDescendants("elsewhere", sessions)).toEqual([]);
  });
  test("conversation roots exclude workers; the worker tree hangs children under their parent", () => {
    const rows = [session("root"), session("existing-worker", { parentId: "root" }), session("fleet-worker", { parentId: "root", origin: "fleet" }), session("lane", { origin: "fleet" })];
    expect(conversationThreads(rows).map(row => row.id)).toEqual(["root"]);
    const tree = buildWorkerTree(rows);
    expect(tree.map(node => node.session.id)).toEqual(["root", "lane"]);
    expect(tree[0].children.map(node => node.session.id).sort()).toEqual(["existing-worker", "fleet-worker"]);
    expect(isActiveWorker(session("stopped", { held: true }))).toBe(false);
    expect(isActiveWorker(session("busy", { state: "running", activity: "queued" }))).toBe(true);
  });
  test("watch checks appear in Workers, not Chats, without losing ownership, selection or stop scope", () => {
    const watch = session("watch", { watchList: true, state: "running", idleUnread: true });
    const worker = session("watch-worker", { parentId: watch.id, state: "running" });
    const rows = [session("chat"), watch, worker, session("settled-watch", { watchList: true }),
      session("archived-watch", { watchList: true, archivedAt: "2026-09-28T19:04:00Z" })];
    const live = streamSessions(rows.filter(row => !row.archivedAt), watch.id);
    const messaging = { version: 0, backends: [], conversations: [], calls: [] };
    expect(inboxRows(live, [], messaging).map(row => row.chat.id)).toEqual(["ai:chat"]);
    const workers = workerThreads(rows);
    expect(workers.map(row => row.id)).toEqual(["watch", "watch-worker", "settled-watch"]);
    const tree = buildWorkerTree(workers);
    const root = tree.find(node => node.session.id === watch.id)!;
    expect(root.session).toBe(watch);
    expect(root.session.origin).toBe("person");
    expect(root.session.idleUnread).toBe(true);
    expect(root.children.map(node => node.session.id)).toEqual([worker.id]);
    expect(selectionAfterSync("ai:watch", { sessions: live, messaging }, { sessions: live, messaging })).toBe("ai:watch");
    const stopped: unknown[] = [];
    const stop = (id: string, descendants: false) => { stopped.push({ id, descendants }); };
    requestStop(watch, stop);
    requestStop({ ...watch, hasChildren: true }, stop);
    expect(stopped).toEqual([{ id: watch.id, descendants: false }, { id: watch.id, descendants: false }]);
    expect(runningDescendants(watch.id, workers)).toEqual([worker]);
  });
  test("resume exposes an empty-queue error instead of reporting success", async () => {
    await withThreadClient((async (url, init) => {
      expect(url).toBe("/v1/sessions/stopped/resume");
      expect(init?.method).toBe("POST");
      return Response.json({ error: "no_pending_messages" }, { status: 409 });
    }) as typeof fetch, async () => {
      await expect(submitThreadControl({ threadId: "stopped", action: "resume" })).rejects.toThrow("no_pending_messages");
    });
  });

  test("Stop immediately targets only the selected thread, even with running descendants", async () => {
    const parent = session("parent", { hasChildren: true, state: "running" });
    const child = session("child", { parentId: parent.id, hasChildren: true, state: "running" });
    const grandchild = session("grandchild", { parentId: child.id, state: "running" });
    const requests: unknown[] = [];
    await withThreadClient((async (url, init) => {
      requests.push({ url, body: JSON.parse(String(init?.body)) });
      return Response.json({ ok: true });
    }) as typeof fetch, async () => {
      for (const selected of [parent, child, grandchild]) {
        let sent: Promise<void> | undefined;
        requestStop(selected, (threadId, descendants) => { sent = submitThreadControl({ threadId, action: "stop", descendants }); });
        expect(sent).toBeDefined();
        await sent;
      }
      expect(requests).toEqual([
        { url: "/v1/sessions/parent/abort", body: { descendants: false } },
        { url: "/v1/sessions/child/abort", body: { descendants: false } },
        { url: "/v1/sessions/grandchild/abort", body: { descendants: false } },
      ]);
    });
  });

  test("idle waiting and scheduled work can be stopped without claiming a native execution exists", () => {
    for (const parent of [session("waiting", { activity: "awaiting" }), session("timer", { wakeSchedule: { cadenceMs: 60000, nextDueAt: 1000, reason: "Job" } })]) {
      expect(working(parent)).toBe(false);
      expect(composerAction(parent, "")).toBe("stop");
      expect(composerAction(parent, "Continue")).toBe("send");
      expect(composerAction({ ...parent, held: true }, "")).toBe("send");
    }
  });

  test("an awaiting parent displays child activity but remains available for messages", () => {
    const parent = session("parent", { hasChildren: true, idleUnread: true, activity: "awaiting" });
    const child = session("child", { parentId: parent.id, state: "running", activity: "thinking" });
    expect(working(parent)).toBe(false);
    expect(working(child)).toBe(true);
    expect(threadStatus(parent)).toMatchObject({ key: "awaiting", label: "Waiting on agents", busy: true });
    expect(threadStatus(child)).toMatchObject({ key: "thinking", busy: true });
    expect(composerAction(parent, "")).toBe("stop");
    expect(composerAction(parent, "Continue")).toBe("send");
    expect(working({ ...child, state: "idle", held: true })).toBe(false);
  });

  test("stop requests always carry scope", async () => {
    const requests: unknown[] = [];
    await withThreadClient((async (url, init) => {
      requests.push({ url, method: init?.method, body: JSON.parse(String(init?.body)) });
      return Response.json({ ok: true });
    }) as typeof fetch, async () => {
      await submitThreadControl({ threadId: "parent/1", action: "stop", descendants: true });
      await submitThreadControl({ threadId: "child", action: "stop", descendants: false });
      expect(requests).toEqual([
        { url: "/v1/sessions/parent%2F1/abort", method: "POST", body: { descendants: true } },
        { url: "/v1/sessions/child/abort", method: "POST", body: { descendants: false } },
      ]);
    });
  });
});

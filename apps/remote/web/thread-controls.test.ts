import { expect, test } from "bun:test";
import { requestStop, submitThreadControl } from "./src/thread-controls";
import { composerAction, conversationTab, conversationThreads } from "./src/thread-state";
import { inboxRows, selectionAfterSync } from "./src/chats";
import type { Session } from "./src/types";

const session = (id: string, extra: Partial<Session> = {}): Session => ({
  id, parentId: null, hasChildren: false, origin: "person", model: "astra", name: id, cwd: "/home", workspaceName: "Home", environment: "home", state: "idle", held: false, activity: "idle",
  activeTools: [], provider: "openai", createdAt: "", updatedAt: "", revision: 1, idleUnread: false,
  queuedMessages: [], archivedAt: null, ...extra,
});

test("placement, not custody or provenance, controls Chats", () => {
  const rows = [session("foreground", { foreground: true, origin: "fleet", parentId: "other" }), session("background", { foreground: false }), session("historical")];
  expect(conversationThreads(rows).map(row => row.id)).toEqual(["foreground", "historical"]);
  for (const row of rows) expect(conversationTab(row)).toBe("chats");
  const messaging = { version: 0, backends: [], conversations: [], calls: [] };
  expect(inboxRows(rows, [], messaging).map(row => row.chat.id)).not.toContain("ai:background");
  expect(selectionAfterSync("ai:historical", { sessions: rows, messaging }, { sessions: rows, messaging })).toBe("ai:historical");
});

test("cancelling targets only the selected agent even when it launched agents", () => {
  const calls: unknown[] = [];
  requestStop(session("parent", { hasChildren: true, state: "running" }), (id, descendants) => calls.push({ id, descendants }));
  expect(calls).toEqual([{ id: "parent", descendants: false }]);
});

test("historical cancellation holds never create a persistent Resume composer state", () => {
  expect(composerAction(session("old", { held: true, queuedMessages: [{} as Session["queuedMessages"][number]] }), "")).toBe("send");
  expect(composerAction(session("waiting", { state: "waiting", waitingOnAgents: { kind: "job", jobId: "job", reason: "Need result", since: 1 } }), "")).toBe("stop");
  expect(composerAction(session("running", { state: "running" }), "new message")).toBe("send");
});

test("cancel transport carries selected-only scope and retains dependency refusal data", async () => {
  const descriptors = new Map(["window", "fetch"].map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  try {
    Object.defineProperty(globalThis, "window", { configurable: true, value: { PiRemotePerson: { session: () => "session" } } });
    Object.defineProperty(globalThis, "fetch", { configurable: true, value: async (url: string, init: RequestInit) => {
      expect(url).toBe("/v1/sessions/parent/abort");
      expect(JSON.parse(String(init.body))).toEqual({ descendants: false });
      return Response.json({ ok: true });
    } });
    await submitThreadControl({ threadId: "parent", action: "stop", descendants: true });
  } finally {
    for (const [name, descriptor] of descriptors) descriptor ? Object.defineProperty(globalThis, name, descriptor) : Reflect.deleteProperty(globalThis, name);
  }
});

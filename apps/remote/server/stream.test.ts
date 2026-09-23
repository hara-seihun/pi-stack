import { describe, expect, test } from "bun:test";
import {
  applySessionDelta, ClientStream, inboxMessaging, INBOX_CONVERSATION_WINDOW_MS, liveTextChange,
  mergeSubscription, readSubscription, sessionDelta, sessionPatch,
} from "./stream";
import type { Session } from "./protocol";
import type { MessagingConversation, MessagingSnapshot } from "./messaging/protocol";

function session(id: string, revision: number): Session {
  return {
    id, parentId: null, hasChildren: false, origin: "person", model: "anthropic/claude", name: id, cwd: "/home",
    workspaceName: "Home", environment: "local", state: "idle", held: false, activity: "idle", activeTools: [], provider: "anthropic",
    createdAt: "2026-09-18T00:00:00.000Z", updatedAt: "2026-09-18T00:00:00.000Z", revision, idleUnread: false,
    queuedMessages: [], archivedAt: null,
  };
}
const row = (id: string, revision: number) => { const value = session(id, revision); return { session: value, encoded: JSON.stringify(value) }; };

function recordingStream() {
  const chunks: string[] = [];
  const stream = new ClientStream({ write: (chunk) => chunks.push(chunk), close: () => chunks.push("[closed]") });
  return { stream, chunks };
}

describe("live text frames", () => {
  test("growth appends and a shortened runtime buffer resets", () => {
    expect(liveTextChange("abc", "abc")).toBeNull();
    expect(liveTextChange("abc", "abcdef")).toEqual({ append: "def", length: 6 });
    expect(liveTextChange("abc", "")).toEqual({ reset: "" });
    expect(liveTextChange("abcdef", "def")).toEqual({ reset: "def" });
    expect(liveTextChange("", "hello")).toEqual({ append: "hello", length: 5 });
  });
});

describe("session deltas", () => {
  test("a patch names only the fields that changed, with removed fields as null", () => {
    const held = { ...session("a", 1), activeTools: ["bash", "web_search"], activity: "waiting_on_tool" as const };
    const current = { ...session("a", 1), activeTools: [], activity: "running" as const };
    expect(sessionPatch(held, current)).toEqual({ id: "a", activeTools: [], activity: "running" });
  });
  test("a color edit streams even when the Orchestrator revision is unchanged", () => {
    const before = { ...session("fleet", 1), color: null };
    const after = { ...before, color: "blue" as const };
    const sent = new Map([[before.id, JSON.stringify(before)]]);
    expect(sessionDelta(sent, [{ session: after, encoded: JSON.stringify(after) }]).patches).toEqual([{ id: "fleet", color: "blue" }]);
    expect(sessionPatch(after, { ...after, color: null })).toEqual({ id: "fleet", color: null });
  });
  test("only changed rows travel, and rows the client holds that vanished are named", () => {
    const sent = new Map<string, string>();
    const first = [row("a", 1), row("b", 1)];
    const initial = sessionDelta(sent, first);
    expect(initial.sessions.map(item => item.id)).toEqual(["a", "b"]);
    applySessionDelta(sent, first, initial.removed);
    expect(sessionDelta(sent, first)).toEqual({ sessions: [], patches: [], removed: [] });

    const second = [row("a", 2)];
    const delta = sessionDelta(sent, second);
    expect(delta.sessions).toEqual([]);
    expect(delta.patches).toEqual([{ id: "a", revision: 2 }]);
    expect(delta.removed).toEqual(["b"]);
    applySessionDelta(sent, second, delta.removed);
    expect([...sent.keys()]).toEqual(["a"]);
  });
});

describe("the messaging inbox", () => {
  const conversation = (id: string, extra: Partial<MessagingConversation>): MessagingConversation => ({
    id, backendId: "signal", externalId: id, title: id, kind: "direct", updatedAt: 0, unread: 0, current: false, avatar: null, ...extra,
  });
  test("keeps open conversations that are recent or unread and drops the rest of the directory", () => {
    const now = Date.UTC(2026, 8, 18);
    const snapshot: MessagingSnapshot = { version: 3, backends: [], calls: [], conversations: [
      conversation("recent", { updatedAt: now - 1_000, current: true }),
      conversation("old", { updatedAt: now - INBOX_CONVERSATION_WINDOW_MS - 1, current: true }),
      conversation("unread", { updatedAt: 0, unread: 2, current: true }),
      conversation("closed-recent", { updatedAt: now - 1_000 }),
      conversation("closed-unread", { updatedAt: 0, unread: 2 }),
    ] };
    expect(inboxMessaging(snapshot, now).conversations.map(item => item.id)).toEqual(["recent", "unread"]);
    expect(inboxMessaging(snapshot, now).version).toBe(3);
  });
});

describe("subscriptions", () => {
  test("malformed fields are dropped and a patch merges over what is held", () => {
    expect(readSubscription({ session: "abc", viewing: true, thinking: "yes", notificationsAfter: 12, eventsAfter: -1, nonsense: 1 }))
      .toEqual({ session: "abc", viewing: true, notificationsAfter: 12 });
    expect(readSubscription({ session: null, notificationsAfter: null })).toEqual({ session: null, notificationsAfter: null });
    expect(mergeSubscription({ session: "a", thinking: true }, { session: "b" })).toEqual({ session: "b", thinking: true });
  });
});

describe("the stream connection", () => {
  test("events and comments are framed, and writes after close are dropped", () => {
    const { stream, chunks } = recordingStream();
    stream.send({ type: "error", message: "nope" });
    stream.ping();
    expect(chunks[0]).toBe(`event: error\ndata: {"type":"error","message":"nope"}\n\n`);
    expect(chunks[1]).toBe(": ping\n\n");
    stream.close();
    stream.send({ type: "error", message: "after" });
    expect(chunks).toHaveLength(3);
    expect(stream.closed).toBe(true);
  });

  test("changing session forgets what the client held for the previous one", () => {
    const { stream } = recordingStream();
    stream.subscription = { session: "a" };
    stream.sentText = "words";
    stream.sentImagesVersion = 4;
    stream.transcript = { sessionId: "a", generation: "g" };
    stream.subscription = { session: "b" };
    stream.resetSession();
    expect(stream.liveSession).toBe("b");
    expect(stream.sentText).toBe("");
    expect(stream.sentImagesVersion).toBe(-1);
    expect(stream.transcript).toBeNull();
  });
});

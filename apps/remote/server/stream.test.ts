import { describe, expect, test } from "bun:test";
import { ClientStream, inboxMessaging, INBOX_CONVERSATION_WINDOW_MS, mergeSubscription, readSubscription } from "./stream";
import { ReconcilePublisher, ReconcileReplica, type ReconcileFrame } from "../shared/reconcile";
import type { MessagingConversation, MessagingSnapshot } from "./messaging/protocol";

function recordingStream(publisher = new ReconcilePublisher()) {
  const chunks: string[] = [];
  const stream = new ClientStream({ write: chunk => chunks.push(chunk), close: () => chunks.push("[closed]") }, publisher);
  const frames = () => chunks.filter(chunk => chunk.startsWith("event: reconcile")).map(chunk => JSON.parse(chunk.split("data: ")[1]) as ReconcileFrame);
  return { stream, chunks, frames };
}

describe("resource subscriptions", () => {
  test("reconnects and thread revisits reconcile what the client actually retained", () => {
    const publisher = new ReconcilePublisher();
    const replica = new ReconcileReplica();
    const first = recordingStream(publisher);
    first.stream.declare({ session: "a", want: ["live:a"] });
    first.stream.publish({ type: "live", sessionId: "a", text: "hello".repeat(100) });
    expect(replica.apply(first.frames()[0]).ok).toBe(true);
    first.stream.close();
    const second = recordingStream(publisher);
    second.stream.declare({ session: "b", want: ["live:b"], have: replica.have() });
    second.stream.publish({ type: "live", sessionId: "a", text: "must not send" });
    expect(second.frames()).toHaveLength(0);
    second.stream.declare({ session: "a", want: ["live:a"], have: replica.have() });
    second.stream.publish({ type: "live", sessionId: "a", text: "hello".repeat(100) });
    expect(second.frames()).toHaveLength(0);
    second.stream.publish({ type: "live", sessionId: "a", text: "hello".repeat(100) + " world" });
    expect(second.frames()[0].kind).toBe("patch");
    const applied = replica.apply(second.frames()[0]);
    expect(applied).toEqual({ ok: true, value: { type: "live", sessionId: "a", text: "hello".repeat(100) + " world" } });
  });

  test("a client which lost its replica can explicitly ask for complete state", () => {
    const { stream, frames } = recordingStream();
    stream.declare({ session: "a", want: ["live:a"] });
    stream.publish({ type: "live", sessionId: "a", text: "held" });
    stream.declare({ have: {} });
    stream.publish({ type: "live", sessionId: "a", text: "held" });
    expect(frames().map(frame => frame.kind)).toEqual(["full", "full"]);
  });

  test("malformed fields are dropped and declarations are bounded", () => {
    expect(readSubscription({ session: "abc", viewing: true, thinking: "yes", notificationsAfter: 12, eventsAfter: -1, nonsense: 1 }))
      .toEqual({ session: "abc", viewing: true, notificationsAfter: 12 });
    expect(readSubscription({ session: null, notificationsAfter: null })).toEqual({ session: null, notificationsAfter: null });
    expect(readSubscription({ have: { "live:a": "r1" }, want: ["live:a", "live:a"] })).toEqual({ have: { "live:a": "r1" }, want: ["live:a"] });
    expect(readSubscription({ want: Array(129).fill("state"), have: { a: 5 } })).toEqual({});
    expect(mergeSubscription({ session: "a", thinking: true }, { session: "b" })).toEqual({ session: "b", thinking: true });
  });
});

describe("the messaging inbox", () => {
  const conversation = (id: string, extra: Partial<MessagingConversation>): MessagingConversation => ({
    id, backendId: "signal", externalId: id, title: id, kind: "direct", updatedAt: 0, unread: 0, current: false, avatar: null, ...extra,
  });
  test("keeps open conversations that are recent or unread", () => {
    const now = Date.UTC(2026, 8, 18);
    const snapshot: MessagingSnapshot = { version: 3, backends: [], calls: [], conversations: [
      conversation("recent", { updatedAt: now - 1_000, current: true }),
      conversation("old", { updatedAt: now - INBOX_CONVERSATION_WINDOW_MS - 1, current: true }),
      conversation("unread", { updatedAt: 0, unread: 2, current: true }),
      conversation("closed-recent", { updatedAt: now - 1_000 }),
      conversation("closed-unread", { updatedAt: 0, unread: 2 }),
    ] };
    expect(inboxMessaging(snapshot, now).conversations.map(item => item.id)).toEqual(["recent", "unread"]);
  });
});

test("events and comments are framed, writes after close are dropped", () => {
  const { stream, chunks } = recordingStream();
  stream.send({ type: "error", message: "nope" });
  stream.ping();
  expect(chunks[0]).toBe(`event: error\ndata: {"type":"error","message":"nope"}\n\n`);
  expect(chunks[1]).toBe(": ping\n\n");
  stream.close();
  expect(stream.send({ type: "error", message: "after" })).toBe(false);
  expect(chunks).toHaveLength(3);
});

test("failed sinks cannot advance the connection", () => {
  const stream = new ClientStream({ write() { throw new Error("closed socket"); }, close() {} });
  stream.publish({ type: "state", sessions: [], archivedTotal: 0, ownerErrors: [] });
  expect(stream.closed).toBe(true);
});

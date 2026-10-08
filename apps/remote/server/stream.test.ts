import { describe, expect, test } from "bun:test";
import { ClientStream, mergeSubscription, readSubscription } from "./stream";
import { ReconcilePublisher, ReconcileReplica, type ReconcileFrame } from "../shared/reconcile";

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
    expect(readSubscription({ workers: true, dashboard: "yes" })).toEqual({ workers: true });
    expect(readSubscription({ have: { "live:a": "r1" }, want: ["live:a", "live:a"] })).toEqual({ have: { "live:a": "r1" }, want: ["live:a"] });
    expect(readSubscription({ want: Array(129).fill("state"), have: { a: 5 } })).toEqual({});
    expect(mergeSubscription({ session: "a", thinking: true }, { session: "b" })).toEqual({ session: "b", thinking: true });
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

test("selection readiness waits for inspection and survives unrelated declarations, even with unchanged resources", async () => {
  const { stream, chunks, frames } = recordingStream();
  stream.declare(readSubscription({ session: "a", selectionId: "opening-a" }));
  const publish = () => {
    stream.publish({ type: "transcript", sessionId: "a", generation: "g", total: 0, items: [] });
    stream.publish({ type: "live", sessionId: "a", text: "" });
    stream.publish({ type: "state", sessions: [], archivedTotal: 0, ownerErrors: [] });
  };
  publish();
  let complete!: () => void;
  const inspection = new Promise<void>(resolve => { complete = resolve; });
  const ready = stream.synchronizeSelection(() => inspection, publish);
  stream.declare({ thinking: true, notificationsAfter: 1 });
  expect(chunks.some(chunk => chunk.startsWith("event: selection-ready"))).toBe(false);
  complete(); await ready;
  expect(frames()).toHaveLength(3);
  const acknowledgement = JSON.parse(chunks.at(-1)!.split("data: ")[1]);
  expect(acknowledgement).toMatchObject({ type: "selection-ready", sessionId: "a", selectionId: "opening-a" });
  expect(Object.keys(acknowledgement.have).sort()).toEqual(["live:a", "state", "transcript:a"]);
});

test("departed selections and inspection failures cannot acknowledge a fresh view", async () => {
  const { stream, chunks } = recordingStream();
  stream.declare({ session: "a", selectionId: "first" });
  let complete!: () => void;
  const pending = stream.synchronizeSelection(() => new Promise<void>(resolve => { complete = resolve; }), () => { throw new Error("stale publication"); });
  stream.declare({ session: "b", selectionId: "second" });
  stream.declare({ session: "a", selectionId: "third" });
  complete(); await pending;
  expect(chunks).toHaveLength(0);
  await stream.synchronizeSelection(() => Promise.reject(new Error("owner unavailable")), () => {});
  expect(chunks).toHaveLength(1);
  expect(chunks[0]).toContain("Could not refresh thread: owner unavailable");
  expect(chunks[0]).not.toContain("selection-ready");
});

test("failed sinks cannot advance the connection", () => {
  const stream = new ClientStream({ write() { throw new Error("closed socket"); }, close() {} });
  stream.publish({ type: "state", sessions: [], archivedTotal: 0, ownerErrors: [] });
  expect(stream.closed).toBe(true);
});

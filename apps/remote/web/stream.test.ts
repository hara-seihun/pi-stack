import { expect, test } from "bun:test";
import { ReconcilePublisher, revisionOf } from "../shared/reconcile";
import { createStreamClient, EventStreamParser, streamEventFromFrame } from "./src/stream";
import type { StreamEvent } from "../server/protocol";

const hello = 'event: hello\ndata: {"epoch":"e","streamId":"s","bootstrap":{"home":"/","threadStarts":[],"environmentId":"local"}}\n\n';
const sse = (frames: string[]) => new Response(new ReadableStream<Uint8Array>({ start(controller) { for (const frame of frames) controller.enqueue(new TextEncoder().encode(frame)); } }), { status: 200 });
const frame = (value: unknown) => `event: reconcile\ndata: ${JSON.stringify({ type: "reconcile", ...value })}\n\n`;
const settle = () => new Promise(resolve => setTimeout(resolve, 5));

test("the event-stream parser handles split chunks and comments", () => {
  const parser = new EventStreamParser();
  expect(parser.push(": ping\n\nevent: hello\ndata: {\"strea")).toEqual([]);
  expect(parser.push('mId":"s"}\n\n')).toEqual([{ event: "hello", data: '{"streamId":"s"}' }]);
  expect(streamEventFromFrame({ event: "reconcile", data: "{}" })).toEqual({ type: "reconcile" });
});

test("the replica applies generic frames, filters another session, and resumes from resident revisions", async () => {
  const publisher = new ReconcilePublisher();
  const first = publisher.publish("transcript:mine", { type: "transcript", sessionId: "mine", generation: "g", total: 0, items: [] });
  publisher.publish("transcript:other", { type: "transcript", sessionId: "other", generation: "g", total: 0, items: [] });
  const calls: Array<{ path: string; body: any }> = [];
  const received: StreamEvent[] = [];
  const client = createStreamClient({
    subscription: { session: "mine", viewing: true }, listen: false,
    onEvent: event => received.push(event), onStatus: () => {},
    fetch: async (path, init) => {
      calls.push({ path, body: JSON.parse(String(init.body)) });
      if (path !== "/v1/stream") return new Response(null, { status: 204 });
      return sse([hello, frame(publisher.reconcile("transcript:other", null)), frame(publisher.reconcile("transcript:mine", calls.length === 1 ? null : first))]);
    },
  });
  client.start(); await settle();
  expect(received.map(event => event.type)).toEqual(["hello", "transcript"]);
  expect(calls[0].body).toMatchObject({ have: {}, want: ["bootstrap", "state", "messaging", "live:mine", "transcript:mine", "images:mine"] });
  client.reconnect(); await settle(); client.stop();
  expect(calls.at(-1)?.body.have["transcript:mine"]).toBe(first);
});

test("restored transcript heads declare only their actual local revision", async () => {
  const cached = { type: "transcript" as const, sessionId: "mine", generation: "g", total: 1, items: [] };
  const calls: any[] = [];
  const client = createStreamClient({ subscription: { session: "mine", viewing: true }, listen: false, onEvent: () => {}, onStatus: () => {}, fetch: async (path, init) => {
    calls.push({ path, body: JSON.parse(String(init.body)) });
    return sse([hello]);
  } });
  client.restore(cached);
  client.start(); await settle(); client.stop();
  expect(calls[0].body.have).toEqual({ "transcript:mine": revisionOf(cached) });
  expect(calls[0].body.want).toContain("transcript:mine");
});

test("a missing patch base requests a full resource without retaining its revision", async () => {
  const calls: any[] = [];
  const client = createStreamClient({ subscription: { session: "mine", viewing: true }, listen: false, onEvent: () => {}, onStatus: () => {}, fetch: async (path, init) => {
    calls.push({ path, body: JSON.parse(String(init.body)) });
    return path === "/v1/stream"
      ? sse([hello, frame({ resource: "live:mine", revision: "new", base: "missing", kind: "patch", patch: { op: "replace", value: { type: "live", sessionId: "mine", text: "hi" } } })])
      : new Response(null, { status: 204 });
  } });
  client.start(); await settle(); client.stop();
  expect(calls.map(call => call.path)).toEqual(["/v1/stream", "/v1/stream/s"]);
  expect(calls[1].body.have).toEqual({});
});

test("selection changed before hello posts the latest subscription rather than reconnecting", async () => {
  const calls: Array<{ path: string; body: any }> = [];
  let resolve!: (value: Response) => void;
  const pending = new Promise<Response>(done => { resolve = done; });
  const client = createStreamClient({ subscription: { session: "a", viewing: true }, listen: false, onEvent: () => {}, onStatus: () => {}, fetch: async (path, init) => {
    calls.push({ path, body: JSON.parse(String(init.body)) });
    return path === "/v1/stream" ? pending : new Response(null, { status: 204 });
  } });
  client.start(); await settle(); client.update({ session: "b" });
  resolve(sse([hello])); await settle(); client.stop();
  expect(calls.map(call => call.path)).toEqual(["/v1/stream", "/v1/stream/s"]);
  expect(calls[1].body.want).toContain("transcript:b");
});

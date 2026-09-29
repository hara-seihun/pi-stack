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
  const questions = publisher.publish("questions:mine", { type: "questions", sessionId: "mine", questions: [] });
  publisher.publish("questions:other", { type: "questions", sessionId: "other", questions: [] });
  const calls: Array<{ path: string; body: any }> = [];
  const received: StreamEvent[] = [];
  const client = createStreamClient({
    subscription: { session: "mine", viewing: true }, listen: false,
    onEvent: event => received.push(event), onStatus: () => {},
    fetch: async (path, init) => {
      calls.push({ path, body: JSON.parse(String(init.body)) });
      if (path !== "/v1/stream") return new Response(null, { status: 204 });
      return sse([hello, frame(publisher.reconcile("transcript:other", null)), frame(publisher.reconcile("transcript:mine", calls.length === 1 ? null : first)),
        frame(publisher.reconcile("questions:other", null)), frame(publisher.reconcile("questions:mine", calls.length === 1 ? null : questions))]);
    },
  });
  client.start(); await settle();
  expect(received.map(event => event.type)).toEqual(["hello", "transcript", "questions"]);
  expect(calls[0].body).toMatchObject({ have: {}, want: ["bootstrap", "state", "messaging", "live:mine", "transcript:mine", "images:mine", "questions:mine"] });
  client.reconnect(); await settle(); client.stop();
  expect(calls.at(-1)?.body.have["transcript:mine"]).toBe(first);
  expect(calls.at(-1)?.body.have["questions:mine"]).toBe(questions);
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

test("a new selection replaces a stream whose obsolete subscription post is still pending", async () => {
  const posts: Array<{ body: any; signal: AbortSignal }> = [];
  const statuses: string[] = [];
  let connects = 0;
  const client = createStreamClient({ subscription: { session: "a", viewing: true }, listen: false,
    onEvent: () => {}, onStatus: status => statuses.push(status.state),
    fetch: async (path, init) => {
      if (path === "/v1/stream") {
        connects++;
        return sse([hello]);
      }
      const signal = init.signal as AbortSignal;
      posts.push({ body: JSON.parse(String(init.body)), signal });
      if (connects > 1) return new Response(null, { status: 204 });
      return new Promise<Response>((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
    },
  });
  client.start(); await settle();
  client.update({ session: "b" }); await settle();
  expect(posts[0].body.session).toBe("b");
  expect(posts[0].signal.aborted).toBe(false);
  client.update({ session: "c" }); await settle();
  expect(connects).toBe(2);
  expect(posts[0].signal.aborted).toBe(true);
  client.update({ session: "d" }); await settle();
  expect(posts).toHaveLength(2);
  expect(posts[1].body.session).toBe("d");
  expect(posts[1].signal.aborted).toBe(false);
  expect(statuses).not.toContain("offline");
  client.stop();
  expect(posts[1].signal.aborted).toBe(true);
});

test("only the current opening's acknowledged revisions finish refresh, including unchanged caches and reconnects", async () => {
  const publisher = new ReconcilePublisher();
  const cached = { type: "transcript" as const, sessionId: "a", generation: "g", total: 0, items: [] };
  const have = {
    "transcript:a": publisher.publish("transcript:a", cached),
    "live:a": publisher.publish("live:a", { type: "live", sessionId: "a", text: "" }),
    state: publisher.publish("state", { type: "state", sessions: [], archivedTotal: 0, ownerErrors: [] }),
  };
  const selections: Array<{ sessionId: string | null; ready: boolean }> = [];
  const calls: any[] = [];
  let wire!: ReadableStreamDefaultController<Uint8Array>;
  const emit = (event: unknown) => wire.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`));
  const client = createStreamClient({
    subscription: { session: "a" }, listen: false, onEvent: () => {}, onStatus: () => {},
    onSelectionStatus: status => selections.push(status),
    fetch: async (path, init) => {
      calls.push(JSON.parse(String(init.body)));
      if (path !== "/v1/stream") return new Response(null, { status: 204 });
      return new Response(new ReadableStream({ start(controller) { wire = controller; controller.enqueue(new TextEncoder().encode(hello)); } }));
    },
  });
  client.restore(cached);
  try {
    client.start(); await settle();
    const first = calls[0].selectionId;
    for (const resource of ["state", "live:a"]) emit({ type: "reconcile", ...publisher.reconcile(resource, null) });
    await settle();
    expect(selections).toEqual([{ sessionId: "a", ready: false }]);
    const ready = (selectionId: string, revisions = have) => emit({ type: "selection-ready", sessionId: "a", selectionId, have: revisions });
    ready(first, { ...have, "transcript:a": "not-applied" }); await settle();
    expect(selections.at(-1)?.ready).toBe(false);
    ready(first); await settle();
    expect(selections.at(-1)?.ready).toBe(true);

    client.update({ session: "b" }); await settle();
    client.update({ session: "a" }); await settle();
    const revisit = calls.at(-1).selectionId;
    expect(revisit).not.toBe(first);
    ready(first); await settle();
    expect(selections.at(-1)).toEqual({ sessionId: "a", ready: false });
    client.update({ thinking: true }); await settle();
    expect(calls.at(-1).selectionId).toBe(revisit);
    ready(revisit); await settle();
    expect(selections.at(-1)?.ready).toBe(true);

    client.reconnect(); await settle();
    expect(selections.at(-1)?.ready).toBe(false);
    ready(revisit); await settle();
    expect(selections.at(-1)?.ready).toBe(false);
    ready(calls.at(-1).selectionId); await settle();
    expect(selections.at(-1)?.ready).toBe(true);
  } finally { client.stop(); }
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

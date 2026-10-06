import { expect, spyOn, test } from "bun:test";
import { ReconcilePublisher, revisionOf } from "../shared/reconcile";
import { createStreamClient, EventStreamParser, RECONNECT_GRACE_MS, streamEventFromFrame, type StreamStatus } from "./src/stream";
import type { StreamEvent } from "../server/protocol";

const hello = 'event: hello\ndata: {"epoch":"e","streamId":"s","bootstrap":{"home":"/","threadStarts":[],"environmentId":"local"}}\n\n';
const sse = (frames: string[]) => new Response(new ReadableStream<Uint8Array>({ start(controller) { for (const frame of frames) controller.enqueue(new TextEncoder().encode(frame)); } }), { status: 200 });
const frame = (value: unknown) => `event: reconcile\ndata: ${JSON.stringify({ type: "reconcile", ...value })}\n\n`;
const settle = () => new Promise(resolve => setTimeout(resolve, 5));

function recoveryClock() {
  let now = 0;
  let sequence = 0;
  const timers = new Map<number, { at: number; run(): void }>();
  const timeout = spyOn(globalThis, "setTimeout").mockImplementation(((run: () => void, delay = 0) => {
    const id = ++sequence;
    timers.set(id, { at: now + delay, run });
    return id;
  }) as typeof setTimeout);
  const clear = spyOn(globalThis, "clearTimeout").mockImplementation(id => { timers.delete(Number(id)); });
  const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
  return {
    flush,
    async advance(ms: number) {
      const until = now + ms;
      await flush();
      for (;;) {
        const next = [...timers].filter(([, timer]) => timer.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        now = next[1].at;
        timers.delete(next[0]);
        next[1].run();
        await flush();
      }
      now = until;
    },
    pending: () => timers.size,
    restore() { timeout.mockRestore(); clear.mockRestore(); },
  };
}

test("the event-stream parser handles split chunks and comments", () => {
  const parser = new EventStreamParser();
  expect(parser.push(": ping\n\nevent: hello\ndata: {\"strea")).toEqual([]);
  expect(parser.push('mId":"s"}\n\n')).toEqual([{ event: "hello", data: '{"streamId":"s"}' }]);
  expect(() => streamEventFromFrame({ event: "reconcile", data: "{}" })).toThrow("Reconcile resource");
  expect(() => streamEventFromFrame({ event: "future-state", data: "{}" })).toThrow("invalid state");
  expect(() => streamEventFromFrame({ event: "error", data: "not JSON" })).toThrow("Invalid stream input");
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

test("a hash-valid snapshot with an unknown state is an immediate protocol error, never delivered as healthy data", async () => {
  const publisher = new ReconcilePublisher();
  publisher.publish("state", { type: "state", sessions: [{ id: "thread", state: "future", activity: "idle" }] });
  const statuses: StreamStatus[] = [];
  const received: StreamEvent[] = [];
  const client = createStreamClient({ subscription: {}, listen: false, onEvent: event => received.push(event), onStatus: status => statuses.push(status), fetch: async () => sse([hello, frame(publisher.reconcile("state", null))]) });
  try {
    client.start(); await settle();
    expect(received.map(event => event.type)).toEqual(["hello"]);
    expect(statuses.at(-1)).toMatchObject({ state: "offline" });
    expect(statuses.at(-1)?.error).toContain("Thread lifecycle: invalid state");
    expect(statuses.at(-1)?.error).not.toContain("Reconnecting…");
  } finally { client.stop(); }
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

test("short transport recovery stays syncing; uninterrupted loss stays visible across retries until hello", async () => {
  const clock = recoveryClock();
  const statuses: StreamStatus[] = [];
  let wire!: ReadableStreamDefaultController<Uint8Array>;
  let failing = false;
  const client = createStreamClient({
    subscription: { session: "a" }, listen: false, onEvent: () => {}, onStatus: status => statuses.push(status),
    fetch: async (_path, init) => {
      if (failing) throw new Error("raw socket diagnostic");
      return new Response(new ReadableStream<Uint8Array>({ start(controller) {
        wire = controller;
        controller.enqueue(new TextEncoder().encode(hello));
        init.signal?.addEventListener("abort", () => controller.error(init.signal?.reason), { once: true });
      } }));
    },
  });
  try {
    client.start(); await clock.flush();
    expect(client.state()).toBe("open");
    wire.error(new Error("short interruption")); await clock.flush();
    expect(statuses.at(-1)).toMatchObject({ state: "connecting", error: "", diagnostic: "short interruption" });
    await clock.advance(1_000);
    expect(client.state()).toBe("open");
    expect(statuses.some(status => status.state === "offline")).toBe(false);

    failing = true;
    wire.error(new Error("long interruption")); await clock.flush();
    await clock.advance(RECONNECT_GRACE_MS);
    expect(statuses.at(-1)).toEqual({ state: "offline", error: "Connection lost. Reconnecting…", diagnostic: "raw socket diagnostic" });
    const sinceLoss = statuses.length;
    client.reconnect(); await clock.flush();
    await clock.advance(2_000);
    expect(statuses.slice(sinceLoss).every(status => status.state === "offline")).toBe(true);

    failing = false;
    client.reconnect(); await clock.flush();
    expect(statuses.at(-1)).toEqual({ state: "open", error: "" });
    client.stop();
    expect(clock.pending()).toBe(0);
  } finally { client.stop(); clock.restore(); }
});

test("a visible conversation must acknowledge current resources before ending recovery", async () => {
  const clock = recoveryClock();
  const publisher = new ReconcilePublisher();
  const resources = {
    state: publisher.publish("state", { type: "state", sessions: [], archivedTotal: 0, ownerErrors: [] }),
    "transcript:a": publisher.publish("transcript:a", { type: "transcript", sessionId: "a", generation: "g", total: 0, items: [] }),
    "live:a": publisher.publish("live:a", { type: "live", sessionId: "a", text: "" }),
  };
  let wire!: ReadableStreamDefaultController<Uint8Array>;
  let selectionId = "";
  const statuses: StreamStatus[] = [];
  const client = createStreamClient({
    subscription: { session: "a", viewing: true }, listen: false, onEvent: () => {}, onStatus: status => statuses.push(status),
    fetch: async (_path, init) => {
      selectionId = JSON.parse(String(init.body)).selectionId;
      return new Response(new ReadableStream<Uint8Array>({ start(controller) {
        wire = controller;
        controller.enqueue(new TextEncoder().encode(hello));
        init.signal?.addEventListener("abort", () => controller.error(init.signal?.reason), { once: true });
      } }));
    },
  });
  const emit = (event: unknown) => wire.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`));
  try {
    client.start(); await clock.flush();
    expect(client.state()).toBe("connecting");
    const stale = selectionId;
    wire.error(new Error("closed before refresh")); await clock.flush();
    await clock.advance(RECONNECT_GRACE_MS);
    expect(client.state()).toBe("offline");
    expect(selectionId).not.toBe(stale);
    for (const resource of Object.keys(resources)) emit({ type: "reconcile", ...publisher.reconcile(resource, null) });
    emit({ type: "selection-ready", sessionId: "a", selectionId: stale, have: resources });
    await clock.flush();
    expect(client.state()).toBe("offline");
    emit({ type: "selection-ready", sessionId: "a", selectionId, have: resources });
    await clock.flush();
    expect(statuses.at(-1)).toEqual({ state: "open", error: "" });
  } finally { client.stop(); clock.restore(); }
});

test("HTTP success without a stream hello does not clear persistent loss", async () => {
  const clock = recoveryClock();
  const statuses: StreamStatus[] = [];
  let requests = 0;
  const client = createStreamClient({
    subscription: { session: "a" }, listen: false, onEvent: () => {}, onStatus: status => statuses.push(status),
    fetch: async () => { requests++; return sse([]); },
  });
  try {
    client.start(); await clock.flush();
    expect(client.state()).toBe("connecting");
    await clock.advance(RECONNECT_GRACE_MS);
    expect(statuses.at(-1)?.state).toBe("offline");
    client.reconnect(); await clock.flush();
    expect(requests).toBe(2);
    expect(statuses.at(-1)?.state).toBe("offline");
  } finally { client.stop(); clock.restore(); }
});

for (const status of [401, 403, 423]) {
  test(`HTTP ${status} requires authentication immediately, not after the transport grace`, async () => {
    const clock = recoveryClock();
    const statuses: StreamStatus[] = [];
    const client = createStreamClient({
      subscription: { session: "a" }, listen: false, onEvent: () => {}, onStatus: status => statuses.push(status),
      fetch: async () => new Response(null, { status }),
    });
    try {
      client.start(); await clock.flush();
      expect(statuses.at(-1)).toEqual({ state: "offline", error: status === 423 ? "Unlock your folder to reconnect." : "Sign in to reconnect.", diagnostic: `The stream returned HTTP ${status}` });
      client.reconnect();
      expect(statuses.at(-1)?.state).toBe("offline");
    } finally { client.stop(); clock.restore(); }
  });
}

test("a failed subscription update uses the same recovery grace as a failed stream", async () => {
  const clock = recoveryClock();
  const statuses: StreamStatus[] = [];
  let connections = 0;
  const client = createStreamClient({
    subscription: { session: "a" }, listen: false, onEvent: () => {}, onStatus: status => statuses.push(status),
    fetch: async path => {
      if (path === "/v1/stream") {
        connections++;
        if (connections > 1) throw new Error("stream unreachable");
        return sse([hello]);
      }
      throw new Error("update unreachable");
    },
  });
  try {
    client.start(); await clock.flush();
    client.update({ session: "b" }); await clock.flush();
    expect(connections).toBe(2);
    expect(statuses.some(status => status.state === "offline")).toBe(false);
    await clock.advance(RECONNECT_GRACE_MS);
    expect(statuses.at(-1)).toMatchObject({ state: "offline", error: "Connection lost. Reconnecting…" });
  } finally { client.stop(); clock.restore(); }
});

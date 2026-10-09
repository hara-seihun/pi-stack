import { expect, spyOn, test } from "bun:test";
import { ReconcilePublisher, revisionOf } from "../shared/reconcile";
import type { StreamEvent, StreamSnapshot, StreamSubscription } from "../server/protocol";
import { createStreamClient, DEAD_STREAM_MS, EventStreamParser, RECONCILE_TIMEOUT_MS, RECONNECT_GRACE_MS, streamEventFromFrame, type StreamClient, type StreamClientOptions, type StreamStatus } from "./src/stream";

const hello = { type: "hello", epoch: "epoch", streamId: "disposable", bootstrap: { managerOwnerEnvironmentId: "local", manager: { view: "classic", managerThreadId: null, hintSeen: false }, home: "/", threadStarts: [], environmentId: "local", speech: null } };
const encode = (event: unknown) => new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`);
const finite = (events: unknown[]) => Response.json({ events });
const transcript = (sessionId: string): StreamSnapshot => ({ type: "transcript", sessionId, generation: "g", total: 0, items: [] });
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
};

function clock() {
  let now = 0;
  let sequence = 0;
  const timers = new Map<number, { at: number; run(): void }>();
  const timeout = spyOn(globalThis, "setTimeout").mockImplementation(((run: () => void, delay = 0) => {
    const id = ++sequence;
    timers.set(id, { at: now + delay, run });
    return id;
  }) as typeof setTimeout);
  const clear = spyOn(globalThis, "clearTimeout").mockImplementation(id => { timers.delete(Number(id)); });
  const flush = async () => { for (let i = 0; i < 50; i++) await Promise.resolve(); };
  return {
    now: () => now, flush, pending: () => timers.size,
    async advance(ms: number) {
      const until = now + ms;
      await flush();
      for (let count = 0; ; count++) {
        if (count > 1_000) throw new Error("Unbounded immediate retry loop");
        const next = [...timers].filter(([, timer]) => timer.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        now = next[1].at;
        timers.delete(next[0]);
        next[1].run();
        await flush();
      }
      now = until;
    },
    restore() { timeout.mockRestore(); clear.mockRestore(); },
  };
}

class Page extends EventTarget {
  visibilityState = "visible";
  visibility(value: "visible" | "hidden") { this.visibilityState = value; this.dispatchEvent(new Event("visibilitychange")); }
}
type Call = { path: string; body: StreamSubscription; signal: AbortSignal; init: RequestInit };

async function harness(run: (h: ReturnType<typeof setup>) => Promise<void>) {
  const h = setup();
  try { await run(h); } finally { h.cleanup(); }
}
function setup() {
  const time = clock();
  const page = new Page();
  const windowTarget = new EventTarget();
  const original = ["document", "window"].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
  Object.defineProperty(globalThis, "document", { configurable: true, value: page });
  Object.defineProperty(globalThis, "window", { configurable: true, value: windowTarget });
  const clients: StreamClient[] = [];
  const calls: Call[] = [];
  const events: StreamEvent[] = [];
  const statuses: StreamStatus[] = [];
  const selections: Array<{ sessionId: string | null; ready: boolean }> = [];
  const activities: boolean[] = [];
  const publisher = new ReconcilePublisher();
  publisher.publish("state", { type: "state", sessions: [], archivedTotal: 0, ownerErrors: [] });
  for (const session of ["a", "b", "mine", "other"]) {
    publisher.publish(`transcript:${session}`, transcript(session));
    publisher.publish(`live:${session}`, { type: "live", sessionId: session, text: "" });
    publisher.publish(`questions:${session}`, { type: "questions", sessionId: session, state: "ready", questions: [] });
  }
  const reconcile = (resource: string, have: string | null = null) => {
    const frame = publisher.reconcile(resource, have);
    return frame && { type: "reconcile", ...frame };
  };
  const ack = (body: StreamSubscription, have?: Record<string, string>) => ({
    type: "selection-ready", sessionId: body.session, selectionId: body.selectionId,
    have: have ?? Object.fromEntries(["state", `transcript:${body.session}`, `live:${body.session}`].map(resource => [resource, publisher.reconcile(resource, null)!.revision])),
  });
  const response = (body: StreamSubscription) => {
    const frames = (body.want ?? []).map(resource => reconcile(resource, body.have?.[resource] ?? null)).filter(Boolean);
    return finite([hello, ...frames, ...(body.session && body.viewing ? [ack(body)] : [])]);
  };
  const wires: Array<{ emit(event: unknown): void; raw(text: string): void; fail(error: Error): void; cancelled: boolean }> = [];
  const push = (signal?: AbortSignal) => {
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const wire = {
      emit: (event: unknown) => controller.enqueue(encode(event)),
      raw: (text: string) => controller.enqueue(new TextEncoder().encode(text)),
      fail: (error: Error) => controller.error(error), cancelled: false,
    };
    const body = new ReadableStream<Uint8Array>({
      start(value) { controller = value; signal?.addEventListener("abort", () => controller.error(signal.reason), { once: true }); },
      cancel() { wire.cancelled = true; },
    });
    wires.push(wire);
    return new Response(body, { headers: { "content-type": "text/event-stream" } });
  };
  const client = (fetch: (call: Call) => Promise<Response> | Response = call => call.path === "/v1/reconcile" ? response(call.body) : push(call.signal), options: Partial<StreamClientOptions> = {}) => {
    const value = createStreamClient({
      subscription: {}, listen: false, now: time.now,
      onEvent: event => events.push(event), onStatus: status => statuses.push(status),
      onSelectionStatus: value => selections.push(value), onActivity: value => activities.push(value),
      ...options,
      fetch: async (path, init) => {
        const call = { path, body: JSON.parse(String(init.body)) as StreamSubscription, signal: init.signal as AbortSignal, init };
        calls.push(call);
        return fetch(call);
      },
    });
    clients.push(value);
    return value;
  };
  return { time, page, window: windowTarget, calls, events, statuses, selections, activities, publisher, reconcile, ack, response, push, wires, client,
    cleanup() {
      for (const client of clients) client.stop();
      time.restore();
      for (const [key, descriptor] of original) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
    },
  };
}

test("SSE parses split chunks, comments, multiline data and CRLF; invalid variants fail explicitly", () => {
  const parser = new EventStreamParser();
  expect(parser.push(": keepalive\r\n\r\nevent: hello\ndata: {\"strea")).toEqual([]);
  expect(parser.push('mId\":\"s\"}\n\n')).toEqual([{ event: "hello", data: '{"streamId":"s"}' }]);
  expect(parser.push("data: first\ndata: second\n\n")).toEqual([{ event: "message", data: "first\nsecond" }]);
  expect(() => streamEventFromFrame({ event: "reconcile", data: "{}" })).toThrow("Reconcile resource");
  expect(() => streamEventFromFrame({ event: "future-state", data: "{}" })).toThrow("invalid state");
  expect(() => streamEventFromFrame({ event: "error", data: "not JSON" })).toThrow("Invalid stream input");
});

test("finite reconciliation acknowledges visible resources before disposable push opens", () => harness(async h => {
  const pending = deferred<Response>();
  const client = h.client(call => call.path === "/v1/reconcile" ? pending.promise : h.push(call.signal), { subscription: { session: "a", viewing: true } });
  client.start(); await h.time.flush();
  expect(h.calls.map(call => call.path)).toEqual(["/v1/reconcile"]);
  expect(client.state()).toBe("connecting");
  pending.resolve(h.response(h.calls[0].body)); await h.time.flush();
  expect(h.calls.map(call => call.path)).toEqual(["/v1/reconcile", "/v1/stream"]);
  expect(client.state()).toBe("open");
  expect(h.selections.at(-1)).toEqual({ sessionId: "a", ready: true });
  expect(h.calls[1].body.selectionId).toBe(h.calls[0].body.selectionId);
  expect(h.calls.every(call => call.init.method === "POST" && call.init.cache === "no-store")).toBe(true);
}));

test("finite sync succeeds with permanently unavailable push; first recovery has no one-second floor", () => harness(async h => {
  const client = h.client(call => {
    if (call.path === "/v1/reconcile") return h.response(call.body);
    throw new Error("push permanently unavailable");
  }, { subscription: { session: "a", viewing: true } });
  client.start(); await h.time.flush();
  expect(client.state()).toBe("open");
  expect(h.selections.at(-1)?.ready).toBe(true);
  await h.time.advance(0);
  expect(h.calls.filter(call => call.path === "/v1/reconcile")).toHaveLength(2);
  await h.time.advance(RECONNECT_GRACE_MS * 3);
  expect(client.state()).toBe("open");
  expect(h.statuses.some(status => status.state === "offline")).toBe(false);
  expect(h.calls.every(call => ["/v1/reconcile", "/v1/stream"].includes(call.path))).toBe(true);
}));

test("reconnect retains actual replica hashes and caller-remembered event/notification cursors, not claimed server hashes", () => harness(async h => {
  const client = h.client(undefined, { subscription: { session: "mine", viewing: true, have: { state: "invented", "transcript:mine": "invented" }, notificationsAfter: 2, eventsAfter: 3 } });
  const cached = transcript("mine");
  client.restore(cached);
  client.start(); await h.time.flush();
  expect(h.calls[0].body.have).toEqual({ "transcript:mine": revisionOf(cached) });
  client.remember({ notificationsAfter: 11, eventsAfter: 19 });
  expect(h.calls).toHaveLength(2);
  client.reconnect(); await h.time.flush();
  expect(h.calls[2].body).toMatchObject({ notificationsAfter: 11, eventsAfter: 19, have: {
    "transcript:mine": revisionOf(cached), "live:mine": h.publisher.reconcile("live:mine", null)!.revision,
    state: h.publisher.reconcile("state", null)!.revision,
  } });
  expect(h.calls[2].body.selectionId).not.toBe(h.calls[0].body.selectionId);
}));

test("frames for another session cannot enter the replica or reach consumers", () => harness(async h => {
  const client = h.client(call => call.path === "/v1/reconcile" ? finite([h.reconcile("transcript:other"), h.reconcile("questions:other"), hello]) : h.push(call.signal), { subscription: { session: "mine" } });
  client.start(); await h.time.flush();
  h.wires[0].emit({ type: "events", sessionId: "other", events: [] }); await h.time.flush();
  expect(h.events.map(event => event.type)).toEqual(["hello"]);
  client.reconnect(); await h.time.flush();
  expect(h.calls[2].body.have).toEqual({});
}));

test("selection updates replace transports immediately, and revisits reuse resident resources", () => harness(async h => {
  const client = h.client(undefined, { subscription: { session: "a", viewing: true } });
  client.start(); await h.time.flush();
  client.update({ session: "b" }); await h.time.flush();
  expect(h.calls[1].signal.aborted).toBe(true);
  expect(h.calls[2].body.want).toContain("transcript:b");
  client.update({ session: "a" }); await h.time.flush();
  expect(h.calls[4].body.have?.["transcript:a"]).toBe(revisionOf(transcript("a")));
  expect(h.calls[4].body.have).not.toHaveProperty("transcript:b");
  const before = h.calls.length;
  client.update({ session: "a" }); await h.time.flush();
  expect(h.calls).toHaveLength(before);
}));

for (const stage of ["fetch", "JSON"]) {
  test(`late finite ${stage} replies are fenced after a selection change`, () => harness(async h => {
  const pending = deferred<Response>();
  const json = deferred<unknown>();
  const client = h.client(call => {
    if (call.path !== "/v1/reconcile") return h.push(call.signal);
    if (call.body.session === "a") return pending.promise;
    return h.response(call.body);
  }, { subscription: { session: "a", viewing: true } });
  client.start(); await h.time.flush();
  if (stage === "JSON") { pending.resolve({ ok: true, json: () => json.promise } as Response); await h.time.flush(); }
  client.update({ session: "b" }); await h.time.flush();
  const count = h.events.length;
  if (stage === "fetch") pending.resolve(h.response(h.calls[0].body));
  else json.resolve({ events: [h.reconcile("state"), h.reconcile("transcript:a"), h.ack(h.calls[0].body)] });
  await h.time.flush();
  expect(h.events).toHaveLength(count);
  expect(h.selections.at(-1)).toEqual({ sessionId: "b", ready: true });
  expect(h.calls.filter(call => call.path === "/v1/stream")).toHaveLength(1);
  expect(h.calls[0].signal.aborted).toBe(true);
  }));
}

test("late opening of obsolete push cannot deliver or rewind the current selection", () => harness(async h => {
  const pending = deferred<Response>();
  const client = h.client(call => call.path === "/v1/reconcile" ? h.response(call.body) : call.body.session === "a" ? pending.promise : h.push(call.signal), { subscription: { session: "a", viewing: true } });
  client.start(); await h.time.flush();
  client.update({ session: "b" }); await h.time.flush();
  const before = h.events.length;
  const late = h.push();
  h.wires.at(-1)!.emit(h.reconcile("transcript:a"));
  pending.resolve(late); await h.time.flush();
  expect(h.events).toHaveLength(before);
  expect(h.selections.at(-1)).toEqual({ sessionId: "b", ready: true });
}));

for (const stale of ["selection", "revision", "session"]) {
  test(`a stale ${stale} acknowledgement never ends finite selection recovery`, () => harness(async h => {
    const client = h.client(call => {
      const response = { ...h.ack(call.body) };
      if (stale === "selection") response.selectionId = "obsolete";
      if (stale === "session") response.sessionId = "other";
      if (stale === "revision") response.have = { ...response.have, "transcript:a": "unapplied" };
      return finite([hello, h.reconcile("state"), h.reconcile("transcript:a"), h.reconcile("live:a"), response]);
    }, { subscription: { session: "a", viewing: true } });
    client.start(); await h.time.flush();
    expect(h.selections.some(status => status.ready)).toBe(false);
    expect(client.state()).not.toBe("open");
    expect(h.calls.map(call => call.path)).toEqual(["/v1/reconcile"]);
  }));
}

test("finite transport failures recover immediately, then show persistent loss across retries", () => harness(async h => {
  let failing = true;
  const client = h.client(call => {
    if (failing) throw new Error("finite unreachable");
    return call.path === "/v1/reconcile" ? h.response(call.body) : h.push(call.signal);
  });
  client.start(); await h.time.flush();
  expect(h.statuses.at(-1)).toMatchObject({ state: "connecting", error: "", diagnostic: "finite unreachable" });
  await h.time.advance(0);
  expect(h.calls).toHaveLength(2);
  await h.time.advance(RECONNECT_GRACE_MS);
  expect(h.statuses.at(-1)).toMatchObject({ state: "offline", error: "Connection lost. Reconnecting…" });
  client.reconnect(); await h.time.flush();
  expect(client.state()).toBe("offline");
  failing = false;
  client.reconnect(); await h.time.flush();
  expect(h.statuses.at(-1)).toEqual({ state: "open", error: "" });
  client.stop(); await h.time.flush();
  expect(h.time.pending()).toBe(0);
}));

test("finite timeout aborts the request and schedules immediate recovery", () => harness(async h => {
  const client = h.client(call => new Promise<Response>((_, reject) => call.signal.addEventListener("abort", () => reject(call.signal.reason), { once: true })));
  client.start(); await h.time.flush();
  await h.time.advance(RECONCILE_TIMEOUT_MS);
  expect(h.calls[0].signal.aborted).toBe(true);
  expect(h.calls).toHaveLength(2);
  expect(h.statuses.at(-1)?.diagnostic).toBe("State synchronization timed out");
}));

for (const event of ["focus", "online", "pi-network-changed", "pageshow", "visibilitychange"]) {
  test(`${event} replaces a nominally-open dead stream immediately and coalesces wake bursts`, () => harness(async h => {
    const client = h.client(undefined, { listen: true });
    client.start(); await h.time.flush();
    const target = event === "visibilitychange" ? h.page : h.window;
    target.dispatchEvent(new Event(event)); target.dispatchEvent(new Event(event)); await h.time.flush();
    expect(h.calls.map(call => call.path)).toEqual(["/v1/reconcile", "/v1/stream", "/v1/reconcile", "/v1/stream"]);
    expect(h.calls[1].signal.aborted).toBe(true);
    expect(client.state()).toBe("open");
    client.stop(); await h.time.flush();
    target.dispatchEvent(new Event(event)); await h.time.flush();
    expect(h.calls).toHaveLength(4);
    expect(h.time.pending()).toBe(0);
  }));
}

test("a silent push watchdog reconciles immediately without discarding held state", () => harness(async h => {
  const client = h.client(undefined, { subscription: { session: "a", viewing: true } });
  client.start(); await h.time.flush();
  await h.time.advance(DEAD_STREAM_MS - 1);
  expect(h.calls).toHaveLength(2);
  await h.time.advance(1);
  expect(h.calls).toHaveLength(4);
  expect(h.calls[1].signal.aborted).toBe(true);
  expect(h.calls[2].body.have?.["transcript:a"]).toBe(revisionOf(transcript("a")));
}));

test("SSE comments refresh the silence watchdog without delivering events", () => harness(async h => {
  const client = h.client();
  client.start(); await h.time.flush();
  const count = h.events.length;
  await h.time.advance(DEAD_STREAM_MS - 1);
  h.wires[0].raw(": keepalive\n\n"); await h.time.flush();
  await h.time.advance(DEAD_STREAM_MS - 1);
  expect(h.calls).toHaveLength(2);
  expect(h.events).toHaveLength(count);
  await h.time.advance(1);
  expect(h.calls).toHaveLength(4);
}));

test("hidden normal clients cancel open push, retries and all timers; visible resumes once", () => harness(async h => {
  const client = h.client(undefined, { listen: true, suspendWhenHidden: true });
  client.start(); await h.time.flush();
  h.page.visibility("hidden"); await h.time.flush();
  expect(h.calls[1].signal.aborted).toBe(true);
  expect(h.time.pending()).toBe(0);
  client.update({ dashboard: true }); client.reconnect(); h.window.dispatchEvent(new Event("focus"));
  await h.time.advance(DEAD_STREAM_MS * 2);
  expect(h.calls).toHaveLength(2);
  h.page.visibility("visible"); h.window.dispatchEvent(new Event("pageshow")); await h.time.flush();
  expect(h.calls).toHaveLength(4);
  expect(h.calls[2].body.want).toContain("dashboard");
}));

test("hiding after transport failure removes queued retries and recovery-grace timers", () => harness(async h => {
  const client = h.client(() => { throw new Error("offline"); }, { listen: true, suspendWhenHidden: true });
  client.start(); await h.time.flush();
  expect(h.time.pending()).toBeGreaterThan(0);
  h.page.visibility("hidden"); await h.time.flush();
  expect(h.time.pending()).toBe(0);
  await h.time.advance(RECONNECT_GRACE_MS * 2);
  expect(h.calls).toHaveLength(1);
}));

for (const stage of ["finite", "push"]) {
  test(`hiding during a pending ${stage} opening cancels its deadline even if fetch ignores abort`, () => harness(async h => {
    const pending = deferred<Response>();
    const client = h.client(call => stage === "finite" || call.path === "/v1/stream" ? pending.promise : h.response(call.body), { listen: true, suspendWhenHidden: true });
    client.start(); await h.time.flush();
    h.page.visibility("hidden"); await h.time.flush();
    expect(h.calls.at(-1)!.signal.aborted).toBe(true);
    expect(h.time.pending()).toBe(0);
    pending.resolve(stage === "finite" ? finite([hello]) : h.push()); await h.time.flush();
    expect(h.time.pending()).toBe(0);
  }));
}

test("a normal client started hidden does no work; Voice's default remains active while hidden", () => harness(async h => {
  h.page.visibility("hidden");
  const normal = h.client(undefined, { listen: true, suspendWhenHidden: true });
  normal.start(); await h.time.flush();
  expect(h.calls).toHaveLength(0);
  expect(h.time.pending()).toBe(0);
  const voice = h.client(undefined, { listen: true, subscription: { session: "a", eventsAfter: 7 } });
  voice.start(); await h.time.flush();
  expect(voice.state()).toBe("open");
  h.page.visibility("hidden"); await h.time.flush();
  expect(h.calls[1].signal.aborted).toBe(false);
  await h.time.advance(DEAD_STREAM_MS);
  expect(h.calls).toHaveLength(4);
}));

test("stopping pending finite work fences late replies and releases every timer", () => harness(async h => {
  const pending = deferred<Response>();
  const client = h.client(() => pending.promise);
  client.start(); await h.time.flush();
  client.stop(); await h.time.flush();
  expect(h.calls[0].signal.aborted).toBe(true);
  expect(h.time.pending()).toBe(0);
  pending.resolve(finite([hello])); await h.time.flush();
  expect(h.events).toEqual([]);
  expect(h.calls).toHaveLength(1);
}));

test("beforeReconcile changes the finite declaration, but an obsolete preparation cannot send", () => harness(async h => {
  const first = deferred<Partial<StreamSubscription>>();
  let preparations = 0;
  const client = h.client(undefined, { beforeReconcile: () => ++preparations === 1 ? first.promise : Promise.resolve({ eventsAfter: 13 }) });
  client.start(); await h.time.flush();
  expect(h.calls).toHaveLength(0);
  client.reconnect(); await h.time.flush();
  expect(h.calls[0].body.eventsAfter).toBe(13);
  first.resolve({ eventsAfter: 1 }); await h.time.flush();
  expect(h.calls).toHaveLength(2);
  expect(client.subscription().eventsAfter).toBe(13);
}));

for (const status of [401, 403, 423]) {
  for (const endpoint of ["/v1/reconcile", "/v1/stream"]) {
    test(`HTTP ${status} from ${endpoint} requires authentication immediately`, () => harness(async h => {
      const client = h.client(call => call.path === endpoint ? new Response(null, { status }) : h.response(call.body));
      client.start(); await h.time.flush();
      expect(h.statuses.at(-1)).toMatchObject({ state: "offline", error: status === 423 ? "Unlock your folder to reconnect." : "Sign in to reconnect." });
      expect(h.statuses.at(-1)?.diagnostic).toContain(`HTTP ${status}`);
    }));
  }
}

for (const malformed of ["JSON", "envelope", "event", "snapshot"]) {
  test(`malformed finite ${malformed} is an immediate explicit protocol error, not delayed transport loss`, () => harness(async h => {
    const client = h.client(() => {
      if (malformed === "JSON") return new Response("not JSON", { headers: { "content-type": "application/json" } });
      if (malformed === "envelope") return Response.json({ events: null });
      if (malformed === "event") return finite([{ type: "future-state" }]);
      h.publisher.publish("state", { type: "state", sessions: [{ id: "thread", state: "future", activity: "idle" }] });
      return finite([h.reconcile("state")]);
    });
    client.start(); await h.time.flush();
    expect(h.events).toEqual([]);
    expect(h.statuses.at(-1)?.state).toBe("offline");
    expect(h.statuses.at(-1)?.error).not.toBe("");
    expect(h.statuses.at(-1)?.error).not.toContain("Reconnecting…");
  }));
}

test("malformed push is explicit even after finite sync succeeded", () => harness(async h => {
  const client = h.client();
  client.start(); await h.time.flush();
  h.wires[0].emit({ type: "unknown" }); await h.time.flush();
  expect(h.statuses.at(-1)?.state).toBe("offline");
  expect(h.statuses.at(-1)?.error).toContain("Invalid stream input");
}));

test("invalidation drops only its held hash; accepted push revisions become the next finite declaration", () => harness(async h => {
  const client = h.client(undefined, { subscription: { session: "a", viewing: true } });
  client.start(); await h.time.flush();
  const changed = { type: "live", sessionId: "a", text: "changed output" };
  const base = h.calls[1].body.have!["live:a"];
  const revision = h.publisher.publish("live:a", changed);
  h.wires[0].emit(h.reconcile("live:a", base)); await h.time.flush();
  expect(h.events.at(-1)).toEqual(changed);
  client.reconnect(); await h.time.flush();
  expect(h.calls[2].body.have!["live:a"]).toBe(revision);
  client.invalidate("live:a"); await h.time.flush();
  expect(h.calls[4].body.have).not.toHaveProperty("live:a");
  expect(h.calls[4].body.have!["transcript:a"]).toBe(revisionOf(transcript("a")));
}));

test("a missing patch base is forgotten before immediate finite repair", () => harness(async h => {
  const client = h.client(undefined, { subscription: { session: "a", viewing: true } });
  client.start(); await h.time.flush();
  h.wires[0].emit({ type: "reconcile", resource: "live:a", revision: "new", base: "missing", kind: "patch", patch: { op: "replace", value: { type: "live", sessionId: "a", text: "hi" } } });
  await h.time.flush(); await h.time.advance(0);
  expect(h.calls[2].path).toBe("/v1/reconcile");
  expect(h.calls[2].body.have).not.toHaveProperty("live:a");
  expect(h.calls[2].body.have?.["transcript:a"]).toBe(revisionOf(transcript("a")));
  expect(client.state()).toBe("open");
}));

import { expect, test } from "bun:test";
import { createThreadClient } from "../../../packages/orchestrator/src/threads/http";
import { CoreClient, coreConfiguration } from "./core-client";
import type { CoreProjection } from "../../../packages/orchestrator/src/core/contracts";
import type { Thread } from "pi-orchestrator/api";

const config = { url: "http://core.test", token: "fixture-secret", scopeId: "person/one" };
const thread = { id: "retained-thread", revision: 7, metadata: {}, state: "idle" } as unknown as Thread;
const projection = (): CoreProjection => ({ cursor: 12, threads: [thread], archivedTotal: 31_054, pending: { [thread.id]: [] }, inputs: { [thread.id]: [] }, settlements: {}, live: { [thread.id]: { text: "snapshot", thinking: "", tools: [] } }, managerThreadId: "retained-manager" });

test("aggregate analytics and manager replies use authenticated core endpoints with explicit scope boundaries", async () => {
  const calls: string[] = [];
  const client = new CoreClient(config, createThreadClient, (async (input, init) => {
    const url = String(input); calls.push(url);
    expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${config.token}`);
    if (url.includes("/projection")) return Response.json({ ok: true, value: projection() });
    if (url.includes("/people-usage")) return Response.json({ since: "start", until: "end", subscriptions: [], rows: [] });
    expect(JSON.parse(String(init?.body))).toEqual({ after: 12, limit: 100 });
    return Response.json({ ok: true, value: { managerThreadId: "other-manager", cursor: 13, replies: [] } });
  }) as typeof fetch);
  await client.refreshProjection();
  expect((await client.peopleUsage("week")).ok).toBe(true);
  expect(calls).toContain("http://core.test/v1/providers/people-usage?period=week");
  expect((await client.managerReplies({ after: 12, limit: 100 })).ok).toBe(false);
  expect(calls).toContain("http://core.test/v1/scopes/person%2Fone/thread-owner/managerReplies");
  client.close();
});

test("unset core configuration is an explicit error, never an invitation to create a local engine", () => {
  expect(coreConfiguration({})).toMatchObject({ ok: false, error: { code: "unavailable" } });
});

test("projection is scoped/authenticated and inspection preserves selected archived rows across refresh", async () => {
  const urls: string[] = [];
  const archived = { ...thread, id: "archived-selected", metadata: { archived: true } };
  const client = new CoreClient(config, createThreadClient, (async (input, init) => {
    const url = String(input); urls.push(url);
    expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${config.token}`);
    if (url.endsWith("/inspect")) return Response.json({ ok: true, value: { thread: archived, pending: [], inputs: [] } });
    const value = projection();
    if (new URL(url).searchParams.get("ids") === archived.id) value.threads.push(archived);
    return Response.json({ ok: true, value });
  }) as typeof fetch);
  expect((await client.refreshProjection()).ok).toBe(true);
  expect(client.get(thread.id)).toEqual(thread);
  expect(client.archivedCount()).toBe(31_054);
  expect(client.managerThreadId()).toBe("retained-manager");
  expect((await client.api.inspect(archived.id)).ok).toBe(true);
  await client.refreshProjection();
  expect(client.get(archived.id)).toEqual(archived);
  expect(client.snapshot({ archived: false })).toEqual([thread]);
  expect(urls.every(url => url.startsWith("http://core.test/v1/scopes/person%2Fone/"))).toBe(true);
  client.close();
});

test("native proxy preserves capability and exact message identity without changing delivery", async () => {
  const body = { threadId: thread.id, requestId: "original-admission", text: "original text" };
  const client = new CoreClient(config, createThreadClient, (async (input, init) => {
    expect(String(input)).toBe("http://core.test/v1/scopes/person%2Fone/thread-owner/send");
    expect(new Headers(init?.headers).get("x-pi-thread-token")).toBe("native-capability");
    expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${config.token}`);
    expect(JSON.parse(String(init?.body))).toEqual(body);
    return Response.json({ ok: true, value: { id: "accepted-original" } });
  }) as typeof fetch);
  const response = await client.forward(new Request("http://remote.test/v1/threads/send", { method: "POST", headers: { "x-pi-thread-token": "native-capability", authorization: "Bearer cannot-select-another-owner" }, body: JSON.stringify(body) }), "/v1/threads");
  expect((await response.json()).value.id).toBe("accepted-original");
  client.close();
});

test("concurrent UI adapters preserve each native caller capability through core methods", async () => {
  const identities: string[] = [];
  const client = new CoreClient(config, createThreadClient, (async (_input, init) => {
    identities.push(new Headers(init?.headers).get("x-pi-thread-token")!);
    return Response.json({ ok: true, value: thread });
  }) as typeof fetch);
  await Promise.all(["native-a", "native-b"].map(token => client.withCaller(new Request("http://remote.test/v1/sessions/retained-thread/abort", { headers: { "x-pi-thread-token": token } }), async () => {
    await Promise.resolve();
    return client.api.control({ threadId: thread.id, action: "cancel" });
  })));
  expect(identities.sort()).toEqual(["native-a", "native-b"]);
  client.close();
});

test("resync refreshes before notifying UI and failure retains the last known projection", async () => {
  let stream!: ReadableStreamDefaultController<Uint8Array>;
  let requests = 0, fail = false;
  const client = new CoreClient(config, createThreadClient, (async (input) => {
    if (String(input).includes("/events?")) return new Response(new ReadableStream({ start(controller) { stream = controller; } }));
    requests++;
    return fail ? Response.json({ ok: false, error: { code: "unavailable", message: "Core down" } }, { status: 503 }) : Response.json({ ok: true, value: { ...projection(), cursor: requests === 1 ? 12 : 13 } });
  }) as typeof fetch);
  await client.refreshProjection();
  const delivered = new Promise<void>(resolve => client.subscribe(change => { expect(change.threadId).toBe(thread.id); expect(change.live?.text).toBe("snapshot"); expect(requests).toBe(2); resolve(); }));
  client.start();
  stream.enqueue(new TextEncoder().encode(JSON.stringify({ ok: true, value: { cursor: 13, change: { type: "resync" } } }) + "\n"));
  await delivered;
  await client.refreshProjection(); // Join the resync already in flight before changing the provider.
  fail = true;
  expect(await client.refreshProjection()).toMatchObject({ ok: false });
  expect(client.get(thread.id)).toEqual(thread);
  client.close(); stream.close();
});

test("atomic live snapshot discards buffered deltas at its cursor and applies only newer events", async () => {
  let stream!: ReadableStreamDefaultController<Uint8Array>;
  let requests = 0;
  const client = new CoreClient(config, createThreadClient, (async input => {
    if (String(input).includes("/events?")) return new Response(new ReadableStream({ start(controller) { stream = controller; } }));
    const value = projection();
    value.cursor = ++requests === 1 ? 12 : 15;
    value.live[thread.id] = { text: requests === 1 ? "old" : "included", thinking: "", tools: [] };
    return Response.json({ ok: true, value });
  }) as typeof fetch);
  await client.refreshProjection();
  let text = "";
  const delivered = new Promise<void>(resolve => client.subscribe(change => {
    if (change.live) text = String(change.live.text);
    if (change.event) { text += (change.event as any).assistantMessageEvent.delta; resolve(); }
  }));
  client.start();
  const event = (cursor: number, change: unknown) => JSON.stringify({ ok: true, value: { cursor, change } });
  stream.enqueue(new TextEncoder().encode([
    event(13, { type: "resync" }),
    event(14, { type: "event", threadId: thread.id, event: { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "included" } } }),
    event(15, { type: "thread", threadId: thread.id }),
    event(16, { type: "event", threadId: thread.id, event: { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: " newer" } } }),
  ].join("\n") + "\n"));
  await delivered;
  expect(text).toBe("included newer");
  expect(requests).toBe(2);
  client.close(); stream.close();
});

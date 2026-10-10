import { afterEach, expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import type { ManagerWorkSummary, Result } from "pi-orchestrator/api";
import { handleAgentManager } from "./agent-manager";
import { managerRelay } from "./manager-relay";
import { managerRelayClient } from "./manager-relay-client";
import { personEnvironments, type EnvironmentEndpoint } from "./environments";
import type { Person } from "./persons";

const person: Person = { version: 1, user: "person", displayName: "Person", port: 10000,
  remoteAccess: ["home", "work"], unlock: { cipherDir: "/person/cipher", mountpoint: "/person/home" },
  environment: { PI_REMOTE_MANAGER_ENVIRONMENT: "home" } };
const catalog: EnvironmentEndpoint[] = [
  { id: "home", name: "Home", baseUrl: "" },
  { id: "work", name: "Work", baseUrl: "/v1/remotes/work", upstreams: { person: "http://work:10000", other: "http://work:10001" } },
  { id: "ungranted", name: "Ungrant", baseUrl: "/v1/remotes/ungranted", upstreams: { person: "http://ungranted:10000" } },
];
const request = (body: unknown = { input: {} }, signal?: AbortSignal) => new Request("http://router/v1/agent-manager/managerWorkSummary", {
  method: "POST", body: JSON.stringify(body), signal, headers: { "x-pi-remote-user": "other", "x-pi-remote-manager-origin": "ungranted" },
});
type Proxy = Parameters<typeof handleAgentManager>[6];
const handle = (proxy: Proxy, req = request(), uid = 1000, endpoints = personEnvironments(person, catalog, "home")) =>
  handleAgentManager(req, { uid }, new Map([[1000, "person"]]), user => user === person.user ? person : undefined,
    () => endpoints, "home", proxy);
const ok = (value: ManagerWorkSummary) => Response.json({ ok: true, value });
const unavailable: Result<never> = { ok: false, error: { code: "unavailable", message: "Owner is unreachable" } };
const disposals: Array<() => void> = [];
afterEach(() => { for (const dispose of disposals.splice(0).reverse()) dispose(); });

function owner(summary: Result<ManagerWorkSummary>) {
  const db = new Database(":memory:");
  disposals.push(() => db.close());
  return { db, environmentId: "work", authorizedRouter: true, manager: null,
    threads: { managerNotificationPolicy: async () => unavailable, send: async () => unavailable },
    directory: { managerWorkSummary: async () => summary, questionOrigin: async () => unavailable, managerQuestionCustody: async () => unavailable } };
}

const relayRequest = (input: unknown = {}) => new Request("http://supervisor/v1/manager-relay/managerWorkSummary", { method: "POST", body: JSON.stringify(input) });

test("summary aggregates every granted environment, excluding ungranted endpoints and foreign upstreams", async () => {
  const calls: unknown[] = [];
  const response = await handle(async (actor, origin, req, target, upstream, source) => {
    calls.push({ user: actor.user, origin, path: target.pathname, upstream, source, input: await req.json(), forgedIdentity: req.headers.get("x-pi-remote-user") });
    return upstream ? ok({ activeWork: true, lastHumanMessageAt: 300 }) : ok({ activeWork: false, lastHumanMessageAt: 200 });
  });
  expect(await response.json()).toEqual({ ok: true, value: { activeWork: true, lastHumanMessageAt: 300 } });
  expect(calls).toEqual([
    { user: "person", origin: "http://127.0.0.1:10000", path: "/v1/manager-relay/managerWorkSummary", upstream: undefined, source: "home", input: {}, forgedIdentity: null },
    { user: "person", origin: "http://work:10000", path: "/v1/manager-relay/managerWorkSummary", upstream: "work", source: "home", input: {}, forgedIdentity: null },
  ]);
});

test("summary uses kernel identity and rejects forged body identity, partial selectors and metadata requests", async () => {
  let calls = 0;
  const proxy: Proxy = async () => { calls++; return ok({ activeWork: false, lastHumanMessageAt: null }); };
  expect((await handle(proxy, request(), 2000)).status).toBe(403);
  for (const body of [{ input: {}, user: "other" }, { input: {}, environmentId: "home" }, { input: { user: "other" } }, { input: { includeTranscript: true } }])
    expect((await handle(proxy, request(body))).status).toBe(400);
  expect(calls).toBe(0);
});

test("granted owner failure never becomes inactive or a partial successful summary", async () => {
  for (const remote of [
    () => Response.json(unavailable),
    () => Response.json({ error: "locked" }, { status: 423 }),
    () => { throw Error("Transport lost"); },
    () => ok({ activeWork: false, lastHumanMessageAt: -1 }),
    () => Response.json({ ok: true, value: { activeWork: true, lastHumanMessageAt: 200, transcript: "private" } }),
    () => Response.json({ ok: true, value: { activeWork: false, lastHumanMessageAt: null }, thread: { cwd: "/private" } }),
    () => new Response("x".repeat(4097)),
  ]) {
    const response = await handle(async (_person, _origin, _req, _target, upstream) => upstream ? remote() : ok({ activeWork: true, lastHumanMessageAt: 100 }));
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ ok: false, error: { code: "unavailable" } });
  }
  const noUpstream = [catalog[0]!, { ...catalog[1]!, upstreams: { other: "http://work:10001" } }];
  expect((await handle(async () => ok({ activeWork: false, lastHumanMessageAt: null }), request(), 1000, noUpstream)).status).toBe(503);
});

test("deadline bounds hanging grants and cancels all in-flight proxies", async () => {
  const nativeTimeout = AbortSignal.timeout.bind(AbortSignal);
  const deadlines: number[] = [];
  const timeout = spyOn(AbortSignal, "timeout").mockImplementation(ms => { deadlines.push(ms); return nativeTimeout(10); });
  const deadlineSignals: AbortSignal[] = [];
  try {
    expect((await handle(async (_person, _origin, req) => { deadlineSignals.push(req.signal); return new Promise<Response>(() => {}); })).status).toBe(503);
    expect(deadlines).toEqual([5000]);
    expect(deadlineSignals).toHaveLength(2);
    expect(deadlineSignals.every(signal => signal.aborted)).toBe(true);
  } finally { timeout.mockRestore(); }
  const controller = new AbortController();
  const signals: AbortSignal[] = [];
  const pending = handle(async (_person, _origin, req) => {
    signals.push(req.signal);
    if (signals.length === 2) controller.abort();
    return new Promise<Response>(() => {});
  }, request({ input: {} }, controller.signal));
  expect((await pending).status).toBe(503);
  expect(signals).toHaveLength(2);
  expect(signals.every(signal => signal.aborted)).toBe(true);
});

test("deadline also bounds a response body that never settles", async () => {
  const controller = new AbortController();
  let cancelled = false;
  const pending = handle(async () => {
    const body = new ReadableStream({ start() { queueMicrotask(() => controller.abort()); }, cancel() { cancelled = true; } });
    return new Response(body);
  }, request({ input: {} }, controller.signal));
  expect((await pending).status).toBe(503);
  await Promise.resolve();
  expect(cancelled).toBe(true);
});

test("authorized nonmanager supervisor provides only canonical directory summary", async () => {
  const state = owner({ ok: true, value: { activeWork: true, lastHumanMessageAt: 321 } });
  expect(await (await managerRelay(relayRequest(), state)).json()).toEqual({ ok: true, value: { activeWork: true, lastHumanMessageAt: 321 } });
  expect((await managerRelay(relayRequest(), { ...state, authorizedRouter: false })).status).toBe(403);
  expect((await managerRelay(relayRequest({ person: "other" }), state)).status).toBe(400);
  expect(await (await managerRelay(relayRequest(), owner(unavailable))).json()).toEqual(unavailable);
});

test("client summary uses all-environment router bridge and validates exact metadata", async () => {
  const seen: unknown[] = [];
  const client = managerRelayClient("http://router/v1/agent-manager", "home", async (url, init) => {
    seen.push({ path: new URL(String(url)).pathname, body: JSON.parse(String(init?.body)) });
    return ok({ activeWork: false, lastHumanMessageAt: null });
  });
  expect(await client.managerWorkSummary()).toEqual({ ok: true, value: { activeWork: false, lastHumanMessageAt: null } });
  expect(seen).toEqual([{ path: "/v1/agent-manager/managerWorkSummary", body: { input: {} } }]);
  for (const value of [null, {}, { activeWork: "false", lastHumanMessageAt: 100 }, { activeWork: false },
    { activeWork: false, lastHumanMessageAt: -1 }, { activeWork: false, lastHumanMessageAt: 1.5 },
    { activeWork: false, lastHumanMessageAt: 100, cwd: "/private" }]) {
    const invalid = managerRelayClient("http://router/v1/agent-manager", undefined, async () => Response.json({ ok: true, value }));
    expect((await invalid.managerWorkSummary()).ok).toBe(false);
  }
});

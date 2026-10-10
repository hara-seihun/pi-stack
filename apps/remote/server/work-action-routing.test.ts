import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Person } from "./persons";
import { handleWorkAgentActions, readWorkActionsConfig, WORK_ACTION_CAPABILITY_HEADER, type WorkActionsConfigResult } from "./work-action-routing";

const secret = "a".repeat(64);
const data = { routes: { worker: { origin: "http://owner-supervisor:18822", capabilityFile: "/etc/pi-stack/work-action.capability" } },
  grants: [{ capabilitySha256: "b".repeat(64), owner: "kenan", scope: "converge", sourceEnvironment: "work" }] };
const ready = (): WorkActionsConfigResult => readWorkActionsConfig({ PI_STACK_WORK_ACTIONS_CONFIG: "/etc/pi-stack/work-actions.json" }, () => ({ ok: true, text: JSON.stringify(data) }));
const people = new Map([[1001, "worker"]]);
const person: Person = { version: 1, user: "worker", displayName: "Worker", port: 10000, environment: {} };
const lookup = (user: string) => user === person.user ? person : undefined;
const request = (operation = "inspect", input: unknown = { id: "action" }, headers: HeadersInit = {}) => new Request("http://router/v1/external-actions?user=kenan&scope=personal", {
  method: "POST", headers, body: JSON.stringify({ operation, input }),
});
const missing = () => ({ ok: false as const, error: "missing" as const });

test("only absent standard configuration selects ordinary owner routing", () => {
  expect(readWorkActionsConfig({}, missing)).toEqual({ state: "unset" });
  expect(readWorkActionsConfig({ PI_STACK_WORK_ACTIONS_CONFIG: "/etc/missing" }, missing)).toEqual({ state: "unavailable" });
  expect(readWorkActionsConfig({ PI_STACK_WORK_ACTIONS_CONFIG: "relative" }, missing)).toEqual({ state: "unavailable" });
  expect(readWorkActionsConfig({ PI_STACK_WORK_ACTIONS_CONFIG: "" }, missing)).toEqual({ state: "unavailable" });
  expect(readWorkActionsConfig({}, () => ({ ok: false, error: "unavailable" }))).toEqual({ state: "unavailable" });
});

test("config has exact trusted bindings and cannot select a path, credential or ambiguous grant", () => {
  expect(ready()).toMatchObject({ state: "ready", config: data });
  const invalid = [null, {}, { ...data, token: secret }, { ...data, routes: { worker: { origin: "http://owner/private", capabilityFile: "/secret" } } },
    { ...data, routes: { worker: { origin: "http://owner?x=y", capabilityFile: "/secret" } } },
    { ...data, routes: { worker: { origin: "http://user:password@owner", capabilityFile: "/secret" } } },
    { ...data, routes: { worker: { origin: "file:///etc/private", capabilityFile: "/secret" } } },
    { ...data, routes: { worker: { origin: "http://owner", capabilityFile: "relative" } } },
    { ...data, grants: [data.grants[0], data.grants[0]] }, { ...data, grants: [{ ...data.grants[0], scope: "" }] },
    { ...data, grants: [{ ...data.grants[0], owner: "../private" }] }, { ...data, grants: [{ ...data.grants[0], capabilitySha256: secret.toUpperCase() }] },
    { ...data, grants: [{ ...data.grants[0], sourceEnvironment: "Work" }] }];
  for (const value of invalid) expect(readWorkActionsConfig({}, () => ({ ok: true, text: JSON.stringify(value) }))).toEqual({ state: "unavailable" });
  expect(readWorkActionsConfig({}, () => ({ ok: true, text: "{broken" }))).toEqual({ state: "unavailable" });
});

test("caller-owned config in a writable directory cannot confer work authority", () => {
  const dir = mkdtempSync(join(tmpdir(), "work-routing-"));
  const path = join(dir, "work-actions.json");
  try {
    writeFileSync(path, JSON.stringify(data), { mode: 0o600 });
    expect(readWorkActionsConfig({ PI_STACK_WORK_ACTIONS_CONFIG: path })).toEqual({ state: "unavailable" });
  } finally { rmSync(dir, { force: true, recursive: true }); }
});

test("kernel UID controls route; owner headers and browser sessions grant nothing", async () => {
  for (const peer of [undefined, { uid: 0 }, { uid: 9001 }]) {
    let read = false, fetched = false;
    const response = await handleWorkAgentActions(request("inspect", { id: "action" }, { "x-pi-remote-user": "worker", authorization: "Bearer caller-token" }), peer, people, lookup, ready(), {
      read: () => { read = true; return { ok: true, text: secret }; }, fetch: async () => { fetched = true; return Response.json({ ok: true }); },
    });
    expect(response?.status).toBe(403);
    expect(read || fetched).toBe(false);
  }
  expect((await handleWorkAgentActions(request(), { uid: 1001 }, people, () => undefined, ready()))?.status).toBe(403);
});

test("unset or unconfigured registered accounts keep original route, errors never fall back", async () => {
  expect(await handleWorkAgentActions(request(), { uid: 1001 }, people, lookup, { state: "unset" })).toBeNull();
  expect(await handleWorkAgentActions(request(), { uid: 1001 }, people, lookup, { state: "ready", config: { routes: {}, grants: [] } })).toBeNull();
  expect((await handleWorkAgentActions(request(), { uid: 1001 }, people, lookup, { state: "unavailable" }))?.status).toBe(503);
  expect((await handleWorkAgentActions(request(), { uid: 1001 }, people, lookup, ready(), { read: missing }))?.status).toBe(503);
});

test("bounded route forwards only operation/input and router-held secret, not inbound identity or query", async () => {
  for (const operation of ["submit", "inspect", "claim", "dispatch", "finish"]) {
    let fetched = 0;
    const response = await handleWorkAgentActions(request(operation, { id: "action" }, {
      [WORK_ACTION_CAPABILITY_HEADER]: "forged", "x-pi-remote-user": "kenan", "x-pi-remote-upstream": "general-credential", cookie: "session=private", authorization: "Bearer personal",
    }), { uid: 1001 }, people, lookup, ready(), {
      read: (path, rootOnly) => { expect(path).toBe(data.routes.worker.capabilityFile); expect(rootOnly).toBe(true); return { ok: true, text: secret + "\n" }; },
      fetch: async (url, init) => {
        fetched++;
        expect(url).toBe("http://owner-supervisor:18822/v1/work-external-actions");
        expect(init.redirect).toBe("manual");
        expect(Object.fromEntries(new Headers(init.headers))).toEqual({ "content-type": "application/json", [WORK_ACTION_CAPABILITY_HEADER]: secret });
        expect(JSON.parse(String(init.body))).toEqual({ operation, input: { id: "action" } });
        return Response.json({ ok: true, value: { id: "action" } }, { headers: { "set-cookie": "private=1", [WORK_ACTION_CAPABILITY_HEADER]: secret } });
      },
    });
    expect(fetched).toBe(1);
    expect(response?.status).toBe(200);
    expect(response?.headers.get("set-cookie")).toBeNull();
    expect(response?.headers.get(WORK_ACTION_CAPABILITY_HEADER)).toBeNull();
    expect(await response?.json()).toEqual({ ok: true, value: { id: "action" } });
  }
});

test("listing, unrestricted operations and malformed bodies are rejected before credential read", async () => {
  const requests = [request("inspect", {}), request("reconcile"), request("retry"), request("recover"), request("list"),
    request("inspect", null), new Request("http://router/v1/external-actions", { method: "GET" }),
    new Request("http://router/v1/external-actions", { method: "POST", body: JSON.stringify({ operation: "inspect", input: { id: "action" }, owner: "kenan" }) }),
    new Request("http://router/v1/external-actions", { method: "POST", body: "x".repeat(2_100_001) })];
  for (const req of requests) {
    let read = false;
    const response = await handleWorkAgentActions(req, { uid: 1001 }, people, lookup, ready(), { read: () => { read = true; return { ok: true, text: secret }; } });
    expect(response?.status).toBeGreaterThanOrEqual(400);
    expect(read).toBe(false);
  }
});

test("upstream failures and redirects do not replay effects or expose transport metadata", async () => {
  for (const result of [new Response(null, { status: 302, headers: { location: "http://attacker/private" } }), Response.json({ unrelated: "data" }), new Response("invalid json"), null]) {
    let fetched = 0;
    const response = await handleWorkAgentActions(request("submit", { intentKey: "same-intent" }), { uid: 1001 }, people, lookup, ready(), {
      read: () => ({ ok: true, text: secret }), fetch: async () => { fetched++; if (!result) throw Error("network failure containing secret"); return result; },
    });
    expect(fetched).toBe(1);
    expect(response?.status).toBe(502);
    expect(await response?.json()).toMatchObject({ ok: false, error: "unavailable" });
  }
  const response = await handleWorkAgentActions(request(), { uid: 1001 }, people, lookup, ready(), {
    read: () => ({ ok: true, text: secret }), fetch: async () => Response.json({ ok: false, error: "blocked" }, { status: 409 }),
  });
  expect(response?.status).toBe(409);
  expect(await response?.json()).toEqual({ ok: false, error: "blocked" });
});

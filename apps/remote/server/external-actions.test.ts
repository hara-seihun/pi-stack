import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { ActionStore } from "kenan-memory/actions";
import { ActionHttpClient } from "../../../packages/kenan-memory/src/action-http-client";
import { externalActionCaller, externalActionsEndpoint, ownedPhoneActionCaller, type ExternalActionCaller } from "./external-actions";
import { callerResolver, threadCapability } from "../../../packages/orchestrator/src/threads/caller";
import { handleAgentActions } from "./agent-actions";
const roots: string[] = [], stores: ActionStore[] = [], servers: ReturnType<typeof Bun.serve>[] = [];
afterEach(async () => { for (const server of servers.splice(0)) await server.stop(true); for (const store of stores.splice(0)) store.close(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() { const root = mkdtempSync(join(tmpdir(), "actions-http-")); roots.push(root); const actions = new ActionStore(join(root, "private"), "synthetic-alice"); stores.push(actions); return { root, actions }; }
function req(operation: string, input: unknown) { return new Request("http://127.0.0.1/v1/external-actions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ operation, input }) }); }
const input = { intentKey: "synthetic:one", recipients: ["+12025550123"], transport: "synthetic", payload: { message: "No real effect" }, requestId: "one", threadId: "synthetic-worker" };
const evidence = { kind: "operator-observation", reference: "fake-operator", detail: "Synthetic evidence" } as const;
const operator: ExternalActionCaller = { kind: "operator" };
const worker: ExternalActionCaller = { kind: "thread", threadId: "synthetic-worker", managing: false };

test("canonical HTTP authority rejects owner forgery and ungranted reconciliation", async () => {
  const { actions } = fixture();
  expect((await externalActionsEndpoint(req("list", {}), actions, { kind: "denied" })).status).toBe(403);
  expect((await externalActionsEndpoint(req("submit", { ...input, owner: "bob" }), actions, worker)).status).toBe(409);
  expect((await externalActionsEndpoint(req("reconcile", { id: "missing", actor: "manager", evidence }), actions, worker)).status).toBe(403);
  expect((await externalActionsEndpoint(req("list", {}), null, operator)).status).toBe(503);
  const created = await (await externalActionsEndpoint(req("submit", input), actions, worker)).json();
  expect(created).toMatchObject({ ok: true, value: { action: { owner: "synthetic-alice", state: "accepted" } } });
  const replay = await (await externalActionsEndpoint(req("submit", { ...input, requestId: "two", threadId: "other-worker" }), actions, { kind: "thread", threadId: "other-worker", managing: false })).json();
  expect(replay.value.action.id).toBe(created.value.action.id);
});

test("phone capability belongs to exact canonical owner and loopback", () => {
  const { root } = fixture(), token = "synthetic-only".repeat(4);
  writeFileSync(join(root, "token"), token); writeFileSync(join(root, "config"), JSON.stringify({ owner: "alice", adminTokenFile: join(root, "token") }));
  const request = new Request("http://127.0.0.1/v1/external-actions", { headers: { authorization: `Bearer ${token}` } });
  const env = { PI_STACK_PHONE_CONFIG: join(root, "config") };
  expect(ownedPhoneActionCaller(request, "alice", true, env)).toBe(true);
  expect(ownedPhoneActionCaller(request, "bob", true, env)).toBe(false);
  expect(ownedPhoneActionCaller(request, "alice", false, env)).toBe(false);
  expect(ownedPhoneActionCaller(new Request(request.url), "alice", true, env)).toBe(false);
});

test("router pins both hosts to account-granted canonical owner, not caller identity fields", async () => {
  const person = { user: "alice", port: 18790, environment: { PI_REMOTE_MANAGER_ENVIRONMENT: "home" } } as any;
  const endpoints = [{ id: "home", upstreams: { alice: "http://home-synthetic:18790" } }, { id: "work", upstreams: { alice: "http://work-synthetic:18790" } }] as any;
  const calls: unknown[] = [];
  const proxy = async (...args: any[]) => { calls.push([args[0].user, args[1], args[3].pathname, args[4], args[5]]); return Response.json({ ok: true, value: null }); };
  const forged = req("list", { owner: "bob", environmentId: "work" });
  const response = await handleAgentActions(forged, { uid: 1001 }, new Map([[1001, "alice"]]), () => person, () => endpoints, "work", proxy);
  expect(response.status).toBe(200); expect(calls).toEqual([["alice", "http://home-synthetic:18790", "/v1/external-actions", "home", "work"]]);
  expect((await handleAgentActions(req("list", {}), { uid: 1002 }, new Map([[1001, "alice"]]), () => person, () => endpoints, "work", proxy)).status).toBe(403);
  expect((await handleAgentActions(req("list", {}), { uid: 1001 }, new Map([[1001, "alice"]]), () => person, () => [], "work", proxy)).status).toBe(503);
});

test("async native tools reach same-loop canonical supervisor without blocking it", async () => {
  const { actions } = fixture();
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: req => externalActionsEndpoint(req, actions, operator) }); servers.push(server as any);
  const client = new ActionHttpClient({ PI_REMOTE_SERVER_URL: `http://127.0.0.1:${server.port}` });
  const submitted = await client.submit(input); expect(submitted.ok).toBe(true);
  if (!submitted.ok) throw new Error(submitted.message);
  expect(await client.inspect(submitted.value.action.id)).toMatchObject({ ok: true, value: { state: "accepted" } });
});

test("independent namespace clients share one effect and crash-before-receipt fence through canonical HTTP", async () => {
  const { actions } = fixture();
  let dispatches = 0;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const body = await request.clone().json(); const response = await externalActionsEndpoint(request, actions, operator);
    if (body.operation === "dispatch" && response.ok) dispatches++;
    return response;
  } }); servers.push(server as any);
  const module = resolve(import.meta.dir, "../../../packages/kenan-memory/src/action-client.ts");
  const script = `import {ActionClient} from ${JSON.stringify(module)}; const a=new ActionClient('http://127.0.0.1:${server.port}'); const s=a.submit({...${JSON.stringify(input)},requestId:crypto.randomUUID()}); if(s.ok && s.value.disposition!=='recipient-held' && s.value.action.state==='accepted'){const t=a.claim(s.value.action.id,'worker:'+process.pid); if(t.ok){const d=a.dispatch(t.value); if(!d.ok)throw Error(d.message);}} console.log(JSON.stringify(a.list()));`;
  const processes = Array.from({ length: 6 }, () => Bun.spawn([process.execPath, "--eval", script], { stdout: "pipe", stderr: "pipe" }));
  const results = await Promise.all(processes.map(async process => { const out = await new Response(process.stdout).text(), error = await new Response(process.stderr).text(); expect(await process.exited).toBe(0); expect(error).toBe(""); return JSON.parse(out); }));
  expect(dispatches).toBe(1); expect(results.every(result => result.ok && result.value.length === 1)).toBe(true);
  const final = actions.list(); expect(final).toMatchObject({ ok: true, value: [{ state: "inflight" }] });
  const changed = actions.submit({ ...input, requestId: "different", intentKey: "rephrased contact", transport: "email.send" });
  expect(changed).toMatchObject({ ok: false, error: "fenced", action: { state: "inflight" } });
});

async function submitAs(actions: ActionStore, caller: ExternalActionCaller, overrides: Record<string, unknown> = {}) {
  const response = await externalActionsEndpoint(req("submit", { ...input, ...overrides }), actions, caller);
  const result = await response.json();
  expect(response.status).toBe(200);
  expect(result.ok).toBe(true);
  return result.value.action;
}
function deliver(actions: ActionStore, id: string, outcome: "succeeded" | "uncertain" | "failed-before-effect" = "succeeded") {
  const claimed = actions.claim(id, "synthetic-transport");
  if (!claimed.ok) throw new Error(claimed.message);
  expect(actions.dispatch(claimed.value).ok).toBe(true);
  const result = actions.finish(claimed.value, outcome, { receipt: "synthetic" }, {
    kind: outcome === "succeeded" ? "provider-receipt" : outcome === "failed-before-effect" ? "provider-rejection" : "operator-observation",
    reference: "synthetic-provider", detail: "Synthetic outcome",
  });
  if (!result.ok) throw new Error(result.message);
  return result.value;
}
function resolution(action: { id: string; revision: number }, decision = "resolve-purpose") {
  return { id: action.id, expectedRevision: action.revision, decision, evidence, actor: "forged-manager" };
}

test("authenticated owning worker resolves delivered purpose and frees next contact without effect authority", async () => {
  const { actions } = fixture();
  const action = await submitAs(actions, worker, { threadId: "forged-other-worker", authenticatedThreadId: "forged-owner" });
  expect(action.submittingThreadId).toBe(worker.kind === "thread" ? worker.threadId : null);
  const submittedActor = actions.db.query("SELECT actor FROM external_action_events WHERE action_id=? AND event='submitted'").get(action.id);
  expect(submittedActor).toEqual({ actor: "synthetic-worker" });
  const delivered = deliver(actions, action.id);
  const attempted = await externalActionsEndpoint(req("submit", { ...input, intentKey: "synthetic:next", requestId: "next" }), actions, worker);
  expect(attempted.status).toBe(409);
  expect(await attempted.json()).toMatchObject({ ok: false, error: "fenced", action: { id: action.id } });
  const resolved = await externalActionsEndpoint(req("reconcile", resolution(delivered)), actions, worker);
  expect(resolved.status).toBe(200);
  expect(await resolved.json()).toMatchObject({ ok: true, value: { state: "succeeded", resolved: true } });
  expect(actions.db.query("SELECT actor FROM external_action_events WHERE action_id=? AND event='resolve-purpose'").get(action.id)).toEqual({ actor: "synthetic-worker" });
  const next = await submitAs(actions, worker, { intentKey: "synthetic:next", requestId: "next", transport: "synthetic-other-transport" });
  expect(next.id).not.toBe(action.id);
  expect(next.state).toBe("accepted");
});

test("dedup, actor text and supplied identity never transfer worker purpose ownership", async () => {
  const { actions } = fixture();
  const action = await submitAs(actions, worker);
  const other: ExternalActionCaller = { kind: "thread", threadId: "other-worker", managing: false };
  const duplicate = await submitAs(actions, other, { requestId: "other-request", authenticatedThreadId: "other-worker" });
  expect(duplicate.id).toBe(action.id);
  expect(duplicate.submittingThreadId).toBe("synthetic-worker");
  const delivered = deliver(actions, action.id);
  const before = actions.inspect(action.id);
  expect((await externalActionsEndpoint(req("reconcile", { ...resolution(delivered), actor: "synthetic-worker", authenticatedThreadId: "synthetic-worker", threadId: "synthetic-worker" }), actions, other)).status).toBe(403);
  expect(actions.inspect(action.id)).toEqual(before);
  const unknownOwner = await submitAs(actions, operator, { intentKey: "synthetic:operator", requestId: "operator", recipients: ["synthetic-recipient"], threadId: "synthetic-worker", authenticatedThreadId: "synthetic-worker" });
  expect(unknownOwner.submittingThreadId).toBeNull();
  const operatorDelivered = deliver(actions, unknownOwner.id);
  expect((await externalActionsEndpoint(req("reconcile", resolution(operatorDelivered)), actions, worker)).status).toBe(403);
  expect((await externalActionsEndpoint(req("reconcile", resolution(operatorDelivered)), actions, operator)).status).toBe(200);
});

test("worker purpose exception rejects every undelivered state and all privileged operations", async () => {
  const { actions } = fixture();
  for (const state of ["accepted", "inflight", "uncertain", "held", "failed-before-effect"] as const) {
    const action = await submitAs(actions, worker, { intentKey: `synthetic:${state}`, requestId: state, recipients: [`synthetic-${state}`] });
    if (state === "inflight") expect(actions.claim(action.id, "synthetic-transport").ok).toBe(true);
    else if (state === "held") expect(actions.reconcile(action.id, action.revision, "hold", evidence, "operator").ok).toBe(true);
    else if (state === "uncertain" || state === "failed-before-effect") deliver(actions, action.id, state);
    const inspected = actions.inspect(action.id);
    if (!inspected.ok) throw new Error(inspected.message);
    expect((await externalActionsEndpoint(req("reconcile", resolution(inspected.value)), actions, worker)).status).toBe(403);
    expect(actions.inspect(action.id)).toEqual(inspected);
  }
  const action = await submitAs(actions, worker, { recipients: ["synthetic-delivered"], requestId: "delivered" });
  const delivered = deliver(actions, action.id);
  const before = actions.list();
  for (const decision of ["effect-confirmed", "no-effect-confirmed", "hold"]) {
    expect((await externalActionsEndpoint(req("reconcile", resolution(delivered, decision)), actions, worker)).status).toBe(403);
  }
  for (const operation of ["retry", "followup", "recover", "release-recipient"]) {
    expect((await externalActionsEndpoint(req(operation, { ...resolution(delivered), recipient: "synthetic-delivered", input }), actions, worker)).status).toBe(403);
  }
  expect(actions.list()).toEqual(before);
  expect((await externalActionsEndpoint(req("reconcile", { ...resolution(delivered), expectedRevision: delivered.revision - 1 }), actions, worker)).status).toBe(409);
  expect(actions.list()).toEqual(before);
  const manager: ExternalActionCaller = { kind: "thread", threadId: "synthetic-manager", managing: true };
  expect((await externalActionsEndpoint(req("reconcile", resolution(delivered)), actions, manager)).status).toBe(200);
});

test("server caller wiring derives purpose authority only from verified capability", () => {
  const { root } = fixture();
  const capability = threadCapability(join(root, "capability-key"));
  const resolver = callerResolver({ capability, peer: () => ({ kind: "process", uid: 1234 }) });
  const resolved = resolver.resolve({ headers: new Headers({ "x-pi-thread-token": capability.issue("synthetic-worker") }) });
  expect(externalActionCaller(resolved, 1234, "synthetic-manager", false)).toEqual(worker);
  expect(externalActionCaller(resolved, 1234, "synthetic-worker", false)).toEqual({ ...worker, managing: true });
  const forged = resolver.resolve({ headers: new Headers({ "x-pi-thread-token": "synthetic-worker", "x-pi-thread-id": "synthetic-manager" }) });
  expect(externalActionCaller(forged, 1234, "synthetic-manager", false)).toEqual({ kind: "denied" });
  expect(externalActionCaller({ kind: "process", uid: 9999 }, 1234, null, false)).toEqual({ kind: "denied" });
  expect(externalActionCaller({ kind: "process", uid: 1234 }, 1234, null, false)).toEqual(operator);
  expect(externalActionCaller({ kind: "runtime", pid: 12 }, 1234, null, false)).toEqual({ kind: "runtime" });
  expect(externalActionCaller({ kind: "service", pid: 12 }, 1234, null, false)).toEqual({ kind: "runtime" });
  expect(externalActionCaller({ kind: "person", via: "router" }, 1234, null, false)).toEqual(operator);
  expect(externalActionCaller(forged, 1234, null, true)).toEqual(operator);
});

import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { ActionStore } from "kenan-memory/actions";
import { ActionHttpClient } from "../../../packages/kenan-memory/src/action-http-client";
import { externalActionsEndpoint, ownedPhoneActionCaller } from "./external-actions";
import { handleAgentActions } from "./agent-actions";
const roots: string[] = [], stores: ActionStore[] = [], servers: ReturnType<typeof Bun.serve>[] = [];
afterEach(async () => { for (const server of servers.splice(0)) await server.stop(true); for (const store of stores.splice(0)) store.close(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() { const root = mkdtempSync(join(tmpdir(), "actions-http-")); roots.push(root); const actions = new ActionStore(join(root, "private"), "synthetic-alice"); stores.push(actions); return { root, actions }; }
function req(operation: string, input: unknown) { return new Request("http://127.0.0.1/v1/external-actions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ operation, input }) }); }
const input = { intentKey: "synthetic:one", recipients: ["+12025550123"], transport: "synthetic", payload: { message: "No real effect" }, requestId: "one", threadId: "synthetic-worker" };
const evidence = { kind: "operator-observation", reference: "fake-operator", detail: "Synthetic evidence" };

test("canonical HTTP authority rejects owner forgery and ungranted reconciliation", async () => {
  const { actions } = fixture();
  expect((await externalActionsEndpoint(req("list", {}), actions, false)).status).toBe(403);
  expect((await externalActionsEndpoint(req("submit", { ...input, owner: "bob" }), actions, true)).status).toBe(409);
  expect((await externalActionsEndpoint(req("reconcile", { id: "missing", actor: "manager", evidence }), actions, true, false)).status).toBe(403);
  expect((await externalActionsEndpoint(req("list", {}), null, true)).status).toBe(503);
  const created = await (await externalActionsEndpoint(req("submit", input), actions, true)).json();
  expect(created).toMatchObject({ ok: true, value: { action: { owner: "synthetic-alice", state: "accepted" } } });
  const replay = await (await externalActionsEndpoint(req("submit", { ...input, requestId: "two", threadId: "other-worker" }), actions, true)).json();
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
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: req => externalActionsEndpoint(req, actions, true, true) }); servers.push(server as any);
  const client = new ActionHttpClient({ PI_REMOTE_SERVER_URL: `http://127.0.0.1:${server.port}` });
  const submitted = await client.submit(input); expect(submitted.ok).toBe(true);
  if (!submitted.ok) throw new Error(submitted.message);
  expect(await client.inspect(submitted.value.action.id)).toMatchObject({ ok: true, value: { state: "accepted" } });
});

test("independent namespace clients share one effect and crash-before-receipt fence through canonical HTTP", async () => {
  const { actions } = fixture();
  let dispatches = 0;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const body = await request.clone().json(); const response = await externalActionsEndpoint(request, actions, true, true);
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
  expect(changed).toMatchObject({ ok: true, value: { disposition: "recipient-held" } });
});

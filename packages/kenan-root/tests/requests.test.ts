import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { KENAN_REQUEST_HEADER, kenanRequestNotice, type RootAdmission } from "kenan-memory/contract";
import { rootService } from "../src/service.js";
import { RootRequestStore } from "../src/requests.js";
import type { RootExecutor } from "../src/root-runtime.js";
import type { ConsentBridge } from "../src/consent-contract.js";

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => resolve = done); return { promise, resolve }; }
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "root-requests-")); directories.push(directory);
  const path = join(directory, "requests.sqlite3");
  const admission: RootAdmission = { person: "alice", threadId: "original-thread", recipients: ["alice"], subjects: ["bob"], rootSessionId: randomUUID(), memoryToken: "private-root-token" };
  const id = randomUUID();
  const post = (token = "person-token", text = "fixture-request") => new Request("http://root/v1/ask", { method: "POST", headers: { "x-kenan-memory-session": token, [KENAN_REQUEST_HEADER]: id }, body: JSON.stringify({ request: text }) });
  const get = (token = "person-token") => new Request(`http://root/v1/ask/${id}`, { headers: { "x-kenan-memory-session": token } });
  let admissions = 0, executions = 0, accounting = 0, deliveries = 0, allowAccounting = true;
  const acknowledged = deferred();
  const accepted = new Set<string>();
  const bridge: Pick<ConsentBridge, "reply"> = { reply: async input => {
    deliveries++; accepted.add(input.consentId);
    expect(input).toMatchObject({ consentId: id, person: "alice", threadId: "original-thread" });
    expect(["Only the chosen reply", kenanRequestNotice(id, "failed"), kenanRequestNotice(id, "interrupted")]).toContain(input.reply);
    acknowledged.resolve(); return { ok: true, value: { accepted: true } };
  } };
  const service = (store: RootRequestStore, executor: RootExecutor, delivery = bridge, admissionGate?: Promise<void>, maxConcurrent = 4) => rootService({ requestStore: store, bridge: delivery, maxConcurrent, enabled: () => true, memoryUrl: "http://memory", memoryRootToken: "service-token", adminCapability: "a".repeat(64), sessionsDir: directory, report() {},
    executor: async (root, text, onExecution) => { executions++; return executor(root, text, onExecution); },
    transport: (async (url, init) => {
      const body = JSON.parse(String(init!.body));
      if (String(url).endsWith("admit")) { admissions++; await admissionGate; return Response.json({ ok: true, value: admission }); }
      if (String(url).endsWith("resume-request")) return Response.json({ ok: true, value: admission });
      if (String(url).endsWith("authorize-request")) return body.callerToken === "person-token" ? Response.json({ ok: true, value: { authorized: true } }) : Response.json({ ok: false }, { status: 403 });
      accounting++; return allowAccounting ? Response.json({ ok: true }) : Response.json({ ok: false }, { status: 503 });
    }) as typeof fetch });
  return { path, admission, id, post, get, service, bridge, accepted, acknowledged, counts: () => ({ admissions, executions, accounting, deliveries }), setAccounting: (allowed: boolean) => allowAccounting = allowed };
}
const chosen: RootExecutor = async (_admission, _request, onExecution) => { onExecution?.(); return { ok: true, value: { reply: "Only the chosen reply", subjects: ["bob"] } }; };

test("asynchronous admission returns before the model; concurrent retries never repeat execution and completion arrives without status polling", async () => {
  const f = fixture(), store = new RootRequestStore(f.path), model = deferred(), admitted = deferred();
  const handle = f.service(store, async (_root, _text, onExecution) => { onExecution?.(); await model.promise; return chosen(f.admission, "fixture-request"); }, f.bridge, admitted.promise);
  const original = handle(f.post()), retry = handle(f.post());
  admitted.resolve();
  for (const response of await Promise.all([original, retry])) {
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ requestId: f.id, status: "pending" });
  }
  expect(f.counts()).toMatchObject({ admissions: 1, executions: 1, deliveries: 0 });
  expect((await handle(f.post("person-token", "changed"))).status).toBe(409);
  expect((await handle(f.get("another-person"))).status).toBe(404);
  expect((await handle(f.post("another-person"))).status).toBe(404);
  model.resolve(); await f.acknowledged.promise;
  await handle.drain();
  const response = await handle(f.get());
  expect(await response.json()).toEqual({ reply: "Only the chosen reply" });
  expect(f.counts()).toEqual({ admissions: 1, executions: 1, accounting: 2, deliveries: 1 });
  expect(JSON.stringify(store.get(f.id))).not.toContain("private-root-token");
  expect(store.get(f.id)?.delivery).toBe("delivered"); store.close();
});

test("interrupted execution is durable and never replayed on POST, GET or reconciliation", async () => {
  const f = fixture(); let store = new RootRequestStore(f.path);
  store.accept(f.id, "fixture-request", f.admission); store.close();
  store = new RootRequestStore(f.path); const handle = f.service(store, chosen);
  expect(await (await handle(f.get())).json()).toEqual({ requestId: f.id, status: "interrupted" });
  expect(await (await handle(f.post())).json()).toEqual({ requestId: f.id, status: "interrupted" });
  expect(await handle.drain()).toEqual({ errors: 0 });
  expect(f.counts()).toEqual({ admissions: 0, executions: 0, accounting: 1, deliveries: 1 });
  expect(store.get(f.id)?.delivery).toBe("delivered"); store.close();
});

test("chosen text persists while accounting fails; restart retries only finalization and delivers without a new model", async () => {
  const f = fixture(); let store = new RootRequestStore(f.path);
  const record = store.accept(f.id, "fixture-request", f.admission);
  store.save({ ...record, state: "finalizing", chosen: { reply: "Only the chosen reply", subjects: ["bob"] } });
  f.setAccounting(false); const first = f.service(store, chosen);
  const pending = await first(f.get());
  expect(await pending.json()).toEqual({ requestId: f.id, status: "pending" });
  expect(f.counts()).toMatchObject({ accounting: 1, deliveries: 0, executions: 0 });
  store.close(); store = new RootRequestStore(f.path); f.setAccounting(true);
  const recovered = f.service(store, chosen);
  expect(await recovered.drain()).toEqual({ errors: 0 });
  expect(await (await recovered(f.get())).json()).toEqual({ reply: "Only the chosen reply" });
  expect(f.counts()).toMatchObject({ accounting: 3, executions: 0, admissions: 0, deliveries: 1 }); store.close();
});

test("lost delivery acknowledgement survives restart with the same idempotent reply identity", async () => {
  const f = fixture(); let store = new RootRequestStore(f.path);
  const record = store.accept(f.id, "fixture-request", f.admission);
  store.save({ ...record, state: "completed", chosen: { reply: "Only the chosen reply", subjects: ["bob"] } });
  const lost: Pick<ConsentBridge, "reply"> = { reply: async input => { await f.bridge.reply(input); return { ok: false, message: "ACK lost" }; } };
  expect(await f.service(store, chosen, lost).drain()).toEqual({ errors: 1 });
  expect(store.get(f.id)?.delivery).toBe("pending"); store.close();
  store = new RootRequestStore(f.path); const recovered = f.service(store, chosen);
  f.setAccounting(false);
  expect(await recovered.drain()).toEqual({ errors: 1 });
  expect(f.counts().deliveries).toBe(1);
  f.setAccounting(true);
  expect(await recovered.drain()).toEqual({ errors: 0 });
  expect(f.accepted.size).toBe(1); expect(f.counts()).toMatchObject({ executions: 0, accounting: 3, deliveries: 2 });
  expect(await recovered.drain()).toEqual({ errors: 0 }); expect(f.counts().deliveries).toBe(2); store.close();
});

test("local root concurrency also keeps accepted work queued rather than dropping it as busy", async () => {
  const f = fixture(), store = new RootRequestStore(f.path), model = deferred(), started = deferred();
  const handle = f.service(store, async (admission, text, onExecution) => { onExecution?.(); started.resolve(); await model.promise; return chosen(admission, text); }, f.bridge, undefined, 1);
  const first = handle(new Request("http://root/v1/ask", { method: "POST", headers: { "x-kenan-memory-session": "person-token" }, body: JSON.stringify({ request: "First inline request" }) }));
  await started.promise;
  const queued = await handle(f.post());
  expect(queued.status).toBe(202);
  expect(await queued.json()).toEqual({ requestId: f.id, status: "pending", reason: "root-concurrency" });
  expect(f.counts().executions).toBe(1);
  expect(store.get(f.id)?.state).toBe("queued");
  model.resolve(); expect((await first).status).toBe(200);
  await Promise.all([handle.drain(), handle.drain()]);
  expect(f.counts().executions).toBe(2);
  expect(store.get(f.id)?.state).toBe("completed");
  store.close();
});

test("101 denied root agents remain durable runnable requests; restart and release admit only a new granted execution", async () => {
  const f = fixture(); let store = new RootRequestStore(f.path), available = 0, nativeStarts = 0;
  const started = deferred(), model = deferred(), admissions = new Map<string, RootAdmission>(), delivered = new Set<string>();
  const service = (storage: RootRequestStore) => rootService({ requestStore: storage, enabled: () => true, memoryUrl: "http://memory", memoryRootToken: "service-token", adminCapability: "a".repeat(64), sessionsDir: "/fixture", report() {},
    bridge: { reply: async input => { delivered.add(input.consentId); return { ok: true, value: { accepted: true } }; } },
    executor: async (_root, _request, onExecution) => {
      if (!available) return { ok: false, error: "capacity-unavailable", message: "Global 100-agent cap", retryAt: Date.now() + 5_000 };
      available--; onExecution?.(); nativeStarts++; started.resolve(); await model.promise;
      return { ok: true, value: { reply: "Only the chosen reply", subjects: ["alice"] } };
    }, transport: (async (url, init) => {
      const body = JSON.parse(String(init!.body));
      if (String(url).endsWith("admit")) { const admission = { ...f.admission, rootSessionId: randomUUID() }; admissions.set(admission.rootSessionId, admission); return Response.json({ ok: true, value: admission }); }
      if (String(url).endsWith("resume-request")) return Response.json({ ok: true, value: admissions.get(body.rootSessionId) });
      return Response.json({ ok: true, value: { authorized: true } });
    }) as typeof fetch });
  const first = service(store), ids: string[] = [];
  for (let n = 0; n < 101; n++) {
    const id = randomUUID(); ids.push(id);
    const response = await first(new Request("http://root/v1/ask", { method: "POST", headers: { "x-kenan-memory-session": "person-token", [KENAN_REQUEST_HEADER]: id }, body: JSON.stringify({ request: `Root request ${n}` }) }));
    expect(response.status).toBe(202);
  }
  expect(nativeStarts).toBe(0); expect(delivered.size).toBe(0);
  for (const id of ids) expect(store.get(id)).toMatchObject({ state: "queued", reason: "global-agent-capacity" });
  expect(JSON.stringify(store.get(ids[0]!))).not.toContain("private-root-token");
  store.close(); store = new RootRequestStore(f.path); const recovered = service(store);
  for (const id of ids) {
    const queued = store.get(id)!; expect(queued.state).toBe("queued");
    if (queued.state === "queued") store.save({ ...queued, retryAt: 0 });
  }
  available = 1;
  const draining = recovered.drain(); await started.promise;
  expect(nativeStarts).toBe(1); expect(delivered.size).toBe(0);
  model.resolve(); await draining;
  expect(delivered.size).toBe(1);
  expect(ids.filter(id => store.get(id)?.state === "queued")).toHaveLength(100);
  expect(ids.filter(id => store.get(id)?.state === "completed")).toHaveLength(1);
  store.close();
});

test("failed executors report terminal status without exposing internal error text or authorizing replay", async () => {
  const f = fixture(), store = new RootRequestStore(f.path), finished = deferred();
  const handle = f.service(store, async () => { finished.resolve(); return { ok: false, error: "unavailable", message: "private-model-trace" }; });
  await handle(f.post()); await finished.promise;
  const response = await handle(f.get());
  expect(await response.json()).toEqual({ requestId: f.id, status: "failed" });
  await f.acknowledged.promise; await handle.drain();
  await handle(f.post()); expect(f.counts().executions).toBe(1);
  expect(store.get(f.id)?.delivery).toBe("delivered"); store.close();
});

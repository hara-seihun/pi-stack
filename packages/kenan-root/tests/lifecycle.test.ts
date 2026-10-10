import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { KENAN_REQUEST_HEADER, type RootAdmission } from "kenan-memory/contract";
import { rootService, type RootReleaseState } from "../src/service.js";
import { RootRequestStore } from "../src/requests.js";

const capability = "a".repeat(64), targetCommit = "b".repeat(40);
function release(method: string, authenticated = true, target = targetCommit) {
  return new Request("http://root/v1/admin/release", { method, headers: authenticated ? { "x-pi-kenan-admin": capability } : {}, body: JSON.stringify({ targetCommit: target }) });
}
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(done => resolve = done); return { promise, resolve }; };
const admission: RootAdmission = { person: "alice", threadId: "thread", recipients: ["alice"], subjects: [], rootSessionId: randomUUID(), memoryToken: "private" };
const ask = (id = randomUUID(), token = "person-token") => new Request("http://root/v1/ask", { method: "POST", headers: { "x-kenan-memory-session": token, [KENAN_REQUEST_HEADER]: id }, body: '{"request":"fixture"}' });
const health = async (handle: ReturnType<typeof rootService>) => (await handle(new Request("http://root/v1/health"))).json();
const transport = (async (input, init) => {
  if (String(input).endsWith("admit") || String(input).endsWith("resume-request")) return Response.json({ ok: true, value: admission });
  if (String(input).endsWith("authorize-request") && JSON.parse(String(init!.body)).callerToken !== "person-token") return Response.json({ ok: false }, { status: 403 });
  return Response.json({ ok: true });
}) as typeof fetch;
const options = { enabled: () => true, memoryUrl: "http://memory", memoryRootToken: "secret", adminCapability: capability, sessionsDir: "/unused", releaseCommit: targetCommit, report() {}, transport };

test("durable handoff survives crashed activation and owner replacement; only explicit matching resume dispatches queued work", async () => {
  const directory = mkdtempSync(join(tmpdir(), "root-handoff-")), path = join(directory, "requests.sqlite3");
  let store = new RootRequestStore(path);
  let executions = 0;
  const delivered: string[] = [];
  const service = (storage: RootRequestStore) => rootService({ ...options, requestStore: storage,
    executor: async (_root, _text, executing) => { executions++; executing?.(); return { ok: true, value: { reply: "Chosen reply", subjects: [] } }; },
    bridge: { reply: async input => { delivered.push(input.consentId); return { ok: true, value: { accepted: true } }; } } });
  const id = randomUUID();
  try {
    const old = service(store);
    expect((await old(release("POST", false))).status).toBe(404);
    expect(await (await old(release("POST"))).json()).toEqual({ ok: true, dispatchPaused: true, targetCommit });
    expect(await (await old(release("POST"))).json()).toEqual({ ok: true, dispatchPaused: true, targetCommit });
    const receipt = { requestId: id, status: "pending", reason: "executor-handoff" };
    expect(await (await old(ask(id))).json()).toEqual(receipt);
    expect(await (await old(ask(id))).json()).toEqual(receipt);
    expect((await old(ask(id, "another-person"))).status).toBe(404);
    await old.drain(); await old.settled();
    expect(executions).toBe(0);
    store.close(); store = new RootRequestStore(path);
    const next = service(store);
    expect(await health(next)).toMatchObject({ releaseProtocol: 3, releaseCapabilities: ["durable-dispatch-handoff"], handoffTarget: targetCommit, dispatchPaused: true, handoffReady: true });
    await next.drain();
    expect(executions).toBe(0);
    expect((await next(release("DELETE", true, "c".repeat(40)))).status).toBe(409);
    expect((await next(release("DELETE", false))).status).toBe(404);
    expect(store.handoffTarget()).toBe(targetCommit);
    expect(await (await next(release("DELETE"))).json()).toEqual({ ok: true, dispatchPaused: false, targetCommit });
    await next.drain(); await next.drain();
    expect(executions).toBe(1); expect(delivered).toEqual([id]);
    expect(await (await next(ask(id))).json()).toEqual({ reply: "Chosen reply" });
    expect(await health(next)).toMatchObject({ handoffTarget: null, dispatchPaused: false, handoffReady: false });
    store.close(); store = new RootRequestStore(path);
    expect(store.handoffTarget()).toBeNull();
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("busy handoff atomically pauses only new dispatch; continuing request intake cannot starve natural execution drain", async () => {
  const state: RootReleaseState = { dispatchPaused: false, consentActive: false };
  const entered = deferred(), model = deferred(), intakeEntered = deferred(), intake = deferred();
  let executions = 0, holdIntake = false;
  const store = new RootRequestStore(":memory:");
  const handle = rootService({ ...options, requestStore: store, releaseState: state,
    transport: (async (input, init) => {
      if (holdIntake && String(input).endsWith("admit")) { intakeEntered.resolve(); await intake.promise; }
      return transport(input, init);
    }) as typeof fetch,
    executor: async (_root, _text, executing) => { executions++; executing?.(); entered.resolve(); await model.promise; return { ok: true, value: { reply: "Chosen reply", subjects: [] } }; } });
  try {
    expect((await handle(ask())).status).toBe(202); await entered.promise;
    state.consentActive = true;
    expect((await handle(release("POST"))).status).toBe(200);
    expect(state.dispatchPaused).toBe(true);
    expect(await health(handle)).toMatchObject({ handoffReady: false });
    let settled = false;
    const draining = handle.dispatchSettled().then(() => { settled = true; });
    for (let i = 0; i < 20; i++) {
      expect(await (await handle(ask())).json()).toMatchObject({ status: "pending", reason: "executor-handoff" });
      await handle.drain();
    }
    expect(settled).toBe(false); expect(executions).toBe(1);
    holdIntake = true;
    const accepting = handle(ask()); await intakeEntered.promise;
    model.resolve(); await draining;
    expect(settled).toBe(true);
    expect(await health(handle)).toMatchObject({ handoffReady: false });
    state.consentActive = false;
    expect(await health(handle)).toMatchObject({ handoffReady: true });
    expect(executions).toBe(1);
    intake.resolve();
    expect(await (await accepting).json()).toMatchObject({ status: "pending", reason: "executor-handoff" });
    expect((await handle(release("DELETE"))).status).toBe(200);
    await handle.drain(); await handle.settled();
    expect(executions).toBeGreaterThan(1);
  } finally { model.resolve(); intake.resolve(); await handle.settled(); store.close(); }
});

test("a superseding release transfers only the paused target by compare-and-swap, never reopening dispatch", async () => {
  const store = new RootRequestStore(":memory:");
  let executions = 0;
  const handle = rootService({ ...options, requestStore: store,
    executor: async () => { executions++; return { ok: true, value: { reply: "chosen", subjects: [] } }; } });
  const successor = "c".repeat(40);
  const transfer = (previousTarget: string) => new Request("http://root/v1/admin/release", { method: "POST", headers: { "x-pi-kenan-admin": capability }, body: JSON.stringify({ targetCommit: successor, previousTarget }) });
  try {
    expect((await handle(release("POST"))).status).toBe(200);
    expect((await handle(ask())).status).toBe(202);
    expect((await handle(release("POST", true, successor))).status).toBe(409);
    expect((await handle(transfer("d".repeat(40)))).status).toBe(409);
    expect(store.handoffTarget()).toBe(targetCommit);
    expect((await handle(transfer(targetCommit))).status).toBe(200);
    expect(await health(handle)).toMatchObject({ dispatchPaused: true, handoffTarget: successor });
    await handle.drain(); expect(executions).toBe(0);
    expect((await handle(release("DELETE"))).status).toBe(409);
    expect((await handle(release("DELETE", true, successor))).status).toBe(200);
    await handle.drain(); expect(executions).toBe(1);
  } finally { await handle.settled(); store.close(); }
});

test("explicit resume cannot reopen a retiring executor", async () => {
  const store = new RootRequestStore(":memory:"), closing = new AbortController();
  const handle = rootService({ ...options, requestStore: store, shutdownSignal: closing.signal,
    executor: async () => { throw new Error("Retiring executor must not dispatch"); } });
  try {
    expect((await handle(release("POST"))).status).toBe(200);
    closing.abort();
    const response = await handle(release("DELETE"));
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ ok: false, error: "executor-stopping" });
    expect(store.handoffTarget()).toBe(targetCommit);
    expect(await health(handle)).toMatchObject({ dispatchPaused: true });
  } finally { store.close(); }
});

test("resume admission already in flight cannot cross the dispatch handoff boundary", async () => {
  const store = new RootRequestStore(":memory:");
  const id = randomUUID();
  store.accept(id, "fixture", admission, true, "queued");
  const entered = deferred(), admitted = deferred();
  let executions = 0;
  const handle = rootService({ ...options, requestStore: store,
    transport: (async (input, init) => {
      if (String(input).endsWith("resume-request")) { entered.resolve(); await admitted.promise; }
      return transport(input, init);
    }) as typeof fetch,
    executor: async () => { executions++; return { ok: true, value: { reply: "chosen", subjects: [] } }; } });
  try {
    const draining = handle.drain(); await entered.promise;
    expect((await handle(release("POST"))).status).toBe(200);
    admitted.resolve(); await draining;
    expect(executions).toBe(0);
    expect(store.get(id)).toMatchObject({ state: "queued", reason: "executor-handoff" });
    expect(await health(handle)).toMatchObject({ handoffReady: true });
    expect((await handle(release("DELETE"))).status).toBe(200);
    await handle.drain(); expect(executions).toBe(1);
  } finally { admitted.resolve(); await handle.settled(); store.close(); }
});

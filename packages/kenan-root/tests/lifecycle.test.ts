import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { KENAN_REQUEST_HEADER, type RootAdmission } from "kenan-memory/contract";
import { rootService, type RootReleaseState } from "../src/service.js";
import { RootRequestStore } from "../src/requests.js";

const capability = "a".repeat(64);
function release(method: string, authenticated = true) {
  return new Request("http://root/v1/admin/release", { method, headers: authenticated ? { "x-pi-kenan-admin": capability } : {} });
}
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(done => resolve = done); return { promise, resolve }; };

test("dispatch handoff accepts durable authenticated asks and resumes them once after owner replacement", async () => {
  const directory = mkdtempSync(join(tmpdir(), "root-handoff-")), path = join(directory, "requests.sqlite3");
  let store = new RootRequestStore(path);
  const state: RootReleaseState = { dispatchPaused: false, consentActive: false };
  const admission: RootAdmission = { person: "alice", threadId: "thread", recipients: ["alice"], subjects: [], rootSessionId: randomUUID(), memoryToken: "private" };
  let executions = 0, admissions = 0;
  const delivered: string[] = [];
  const service = (storage: RootRequestStore, releaseState: RootReleaseState) => rootService({ enabled: () => true, memoryUrl: "http://memory", memoryRootToken: "secret", adminCapability: capability, sessionsDir: directory,
    releaseCommit: "fixture", releaseState, requestStore: storage, report() {},
    executor: async (_root, _text, executing) => { executions++; executing?.(); return { ok: true, value: { reply: "Chosen reply", subjects: [] } }; },
    bridge: { reply: async input => { delivered.push(input.consentId); return { ok: true, value: { accepted: true } }; } },
    transport: (async (input, init) => {
      if (String(input).endsWith("admit")) { admissions++; return Response.json({ ok: true, value: admission }); }
      if (String(input).endsWith("resume-request")) return Response.json({ ok: true, value: admission });
      if (String(input).endsWith("authorize-request") && JSON.parse(String(init!.body)).callerToken !== "person-token") return Response.json({ ok: false }, { status: 403 });
      return Response.json({ ok: true });
    }) as typeof fetch });
  const id = randomUUID();
  const ask = (token = "person-token") => new Request("http://root/v1/ask", { method: "POST", headers: { "x-kenan-memory-session": token, [KENAN_REQUEST_HEADER]: id }, body: '{"request":"fixture"}' });
  try {
    const old = service(store, state);
    expect((await old(release("POST", false))).status).toBe(404);
    state.consentActive = true;
    expect((await old(release("POST"))).status).toBe(409);
    expect(state.dispatchPaused).toBe(false);
    state.consentActive = false;
    expect(await (await old(release("POST"))).json()).toEqual({ ok: true, dispatchPaused: true });
    const receipt = { requestId: id, status: "pending", reason: "executor-handoff" };
    expect(await (await old(ask())).json()).toEqual(receipt);
    expect(await (await old(ask())).json()).toEqual(receipt);
    expect((await old(ask("another-person"))).status).toBe(404);
    await old.drain(); await old.settled();
    expect(executions).toBe(0); expect(admissions).toBe(1);
    store.close(); store = new RootRequestStore(path);
    const next = service(store, { dispatchPaused: false, consentActive: false });
    await next.drain(); await next.drain();
    expect(executions).toBe(1); expect(delivered).toEqual([id]);
    expect(await (await next(ask())).json()).toEqual({ reply: "Chosen reply" });
    expect(admissions).toBe(1);
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("busy replacement never cancels execution; graceful owner drain keeps receipt intake open", async () => {
  const state: RootReleaseState = { dispatchPaused: false, consentActive: false };
  const entered = deferred(), model = deferred();
  let executions = 0;
  const handle = rootService({ enabled: () => true, memoryUrl: "http://memory", memoryRootToken: "secret", adminCapability: capability, sessionsDir: "/unused", releaseState: state, report() {},
    executor: async (_root, _text, executing) => { executions++; executing?.(); entered.resolve(); await model.promise; return { ok: true, value: { reply: "Chosen reply", subjects: [] } }; },
    transport: (async input => String(input).endsWith("admit") ? Response.json({ ok: true, value: { rootSessionId: randomUUID(), person: "alice", threadId: "thread", recipients: ["alice"] } }) : Response.json({ ok: true })) as typeof fetch });
  const ask = () => handle(new Request("http://root/v1/ask", { method: "POST", headers: { "x-kenan-memory-session": "person-token", [KENAN_REQUEST_HEADER]: randomUUID() }, body: '{"request":"fixture"}' }));
  expect((await ask()).status).toBe(202); await entered.promise;
  expect((await handle(release("POST"))).status).toBe(409);
  expect(state.dispatchPaused).toBe(false);
  state.dispatchPaused = true;
  let settled = false;
  const draining = handle.settled().then(() => { settled = true; });
  expect((await ask()).status).toBe(202);
  expect(settled).toBe(false); expect(executions).toBe(1);
  model.resolve(); await draining;
  expect(settled).toBe(true);
  expect(await (await handle(release("DELETE"))).json()).toEqual({ ok: true, dispatchPaused: false });
});

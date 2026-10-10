import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ThreadService } from "../../../packages/orchestrator/src/threads/service";
import { createThreadClient, threadHttp } from "../../../packages/orchestrator/src/threads/http";
import { admissionFor, callerResolver, threadCapability } from "../../../packages/orchestrator/src/threads/caller";
import { controllerReplacementFetch } from "./src/controller-replacement";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "controller-replacement-")); roots.push(root);
  const options = { databasePath: join(root, "threads.sqlite3"), sessionsDir: root, capacity: { mode: "unmanaged" as const },
    openSession: async () => { throw new Error("Acceptance does not execute a model"); } };
  let owner = new ThreadService(options);
  const capability = threadCapability(join(root, "capability.key"));
  const callers = callerResolver({ capability, peer: () => ({ kind: "person", via: "router" }) });
  return { root, get owner() { return owner; },
    restart: async () => { expect(await owner.detach()).toMatchObject({ ok: true }); owner = new ThreadService(options); },
    response: async (operation: "spawn" | "send", input: unknown, headers = new Headers()) => {
      const request = new Request(`http://owner/v1/thread-owner/${operation}`, { method: "POST", headers, body: JSON.stringify(input) });
      return (await threadHttp(owner, request, "/v1/thread-owner", admissionFor(callers, { headers, socket: { address: "127.0.0.1", port: 1, localAddress: "127.0.0.1", localPort: 2 } })))!;
    } };
}

test.each(["spawn", "send"] as const)("web %s reconciles both precommit and lost-body replacement through the owner's durable receipt", async operation => {
  for (const committed of [false, true]) {
    const f = fixture();
    if (operation === "send") expect(await f.owner.spawn({ requestId: "recipient-create", id: "recipient", cwd: f.root, title: "Recipient" })).toMatchObject({ ok: true });
    const requestId = crypto.randomUUID();
    const input = operation === "spawn" ? { requestId, cwd: f.root, message: "one assignment" }
      : { requestId, threadId: "recipient", text: "one message" };
    const init = { method: "POST", body: JSON.stringify(input) };
    const transmitted: string[] = [];
    let original: unknown;
    const response = await controllerReplacementFetch(operation === "spawn" ? "/v1/sessions" : "/v1/sessions/recipient/prompt", init, async () => {
      transmitted.push(init.body);
      if (transmitted.length === 1 && !committed) { await f.restart(); throw new TypeError("Listener replaced before commit"); }
      const accepted = await f.response(operation, JSON.parse(init.body));
      if (transmitted.length === 1) {
        original = await accepted.clone().json();
        await f.restart();
        return new Response(new ReadableStream({ start(controller) { controller.error(new TypeError("Controller died after commit before its response body arrived")); } }));
      }
      return accepted;
    }, () => {});
    const result = await response.json();
    expect(result.ok).toBe(true);
    if (committed) expect(result).toEqual(original);
    expect(transmitted).toEqual([init.body, init.body]);
    const threadId = operation === "spawn" ? result.value.id : "recipient";
    expect(f.owner.snapshot()).toHaveLength(1);
    expect(f.owner.pending(threadId)).toMatchObject([{ id: requestId }]);
    expect(await f.response(operation, { ...input, ...(operation === "spawn" ? { message: "different" } : { text: "different" }) }).then(response => response.json()))
      .toMatchObject({ ok: false, error: { code: "conflict" } });
    await f.owner.detach();
  }
});

test.each(["spawn", "send"] as const)("native %s survives committed/lost acceptance and uncommitted replacement exactly once", async operation => {
  for (const committed of [false, true]) {
    const f = fixture();
    if (operation === "send") expect(await f.owner.spawn({ requestId: "recipient-create", id: "recipient", cwd: f.root, title: "Recipient" })).toMatchObject({ ok: true });
    const input = operation === "spawn" ? { requestId: "native-spawn-call", cwd: f.root, message: "assignment" }
      : { requestId: "native-send-call", threadId: "recipient", text: "message" };
    const bodies: string[] = [];
    let original: unknown;
    const client = createThreadClient("http://owner/v1/thread-owner", async (_url, init) => {
      bodies.push(String(init!.body));
      if (bodies.length === 1 && !committed) { await f.restart(); throw new TypeError("Listener not yet ready"); }
      const response = await f.response(operation, JSON.parse(String(init!.body)));
      if (bodies.length === 1) { original = await response.json(); await f.restart(); throw new TypeError("Committed response lost"); }
      return response;
    }, { timeoutMs: 3_000 });
    const result = operation === "spawn" ? await client.spawn(input as Parameters<typeof client.spawn>[0])
      : await client.send(input as Parameters<typeof client.send>[0]);
    expect(result).toMatchObject({ ok: true });
    if (committed) expect(result).toEqual(original);
    expect(bodies).toEqual([JSON.stringify(input), JSON.stringify(input)]);
    expect(f.owner.snapshot()).toHaveLength(1);
    const id = operation === "send" ? "recipient" : result.ok ? result.value.id : "never-success";
    expect(f.owner.pending(id)).toMatchObject([{ id: input.requestId }]);
    await f.owner.detach();
  }
});

test("replacement keeps validation/auth terminal and never borrows another owner's capability", async () => {
  const f = fixture();
  const foreign = threadCapability(join(f.root, "foreign.key")).issue("another-person-thread");
  let calls = 0;
  const input = { requestId: crypto.randomUUID(), cwd: f.root, parentId: "another-person-thread" };
  const response = await controllerReplacementFetch("/v1/sessions", { method: "POST", body: JSON.stringify(input) }, async () => {
    calls++; return f.response("spawn", input, new Headers({ "x-pi-thread-token": foreign }));
  }, () => {});
  expect(response.status).toBe(401);
  expect(calls).toBe(1);
  expect(f.owner.snapshot()).toEqual([]);
  const invalid = await controllerReplacementFetch("/v1/sessions", { method: "POST", body: JSON.stringify({ requestId: crypto.randomUUID() }) }, async () => {
    calls++; return f.response("spawn", { requestId: "invalid" });
  }, () => {});
  expect(await invalid.json()).toMatchObject({ ok: false, error: { code: "invalid_request" } });
  expect(calls).toBe(2);
  await f.owner.detach();
});

test.each(["person", "environment", "session"])("changing %s during replacement does not send or expose the request again", async scope => {
  let changed = false, calls = 0;
  await expect(controllerReplacementFetch("/v1/sessions", { method: "POST", body: JSON.stringify({ requestId: crypto.randomUUID() }) }, async () => {
    calls++; changed = true; return new Response("Replacing", { status: 503 });
  }, () => { if (changed) throw new DOMException(`${scope} changed`, "AbortError"); })).rejects.toThrow(`${scope} changed`);
  expect(calls).toBe(1);
});

test("Stop cancels reconnect, and commands or missing identities are never retried", async () => {
  const controller = new AbortController(); let calls = 0;
  const cancelled = controllerReplacementFetch("/v1/sessions", { method: "POST", body: JSON.stringify({ requestId: crypto.randomUUID() }), signal: controller.signal }, async () => {
    calls++; controller.abort(new DOMException("Stopped", "AbortError")); throw new TypeError("Connection reset");
  }, () => {});
  await expect(cancelled).rejects.toThrow("Stopped");
  expect(calls).toBe(1);
  for (const [path, body] of [["/v1/sessions/thread/command", { requestId: crypto.randomUUID() }], ["/v1/sessions", {}]] as const) {
    calls = 0;
    await expect(controllerReplacementFetch(path, { method: "POST", body: JSON.stringify(body) }, async () => { calls++; throw new TypeError("Lost response"); }, () => {})).rejects.toThrow("Lost response");
    expect(calls).toBe(1);
  }
});

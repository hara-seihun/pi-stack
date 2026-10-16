import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ThreadService } from "../src/threads/service.js";
import { createThreadClient, threadHttp } from "../src/threads/http.js";
import { threadTools } from "../src/threads/pi-tools.js";
import { spawnThreadId } from "../src/threads/spawn-receipt.js";
import type { SpawnThread, ThreadApi } from "../src/threads/contracts.js";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "spawn-receipt-"));
  const service = new ThreadService({ capacity: { mode: "unmanaged" }, databasePath: join(root, "threads.sqlite3"), sessionsDir: root,
    openSession: async () => { throw new Error("This receipt fixture never executes a model"); } });
  return { root, service, close: async () => { await service.close(); rmSync(root, { recursive: true, force: true }); } };
}

test("disk failure after create and brief acceptance returns the existing thread; same-key retry never duplicates either", async () => {
  const f = fixture();
  const request = { requestId: "caller:original-tool-call", cwd: f.root, message: "Exact original assignment", title: "Receipt repair" };
  const internal = f.service as unknown as { changed(id: string): void };
  const changed = internal.changed.bind(f.service);
  const internalStore = f.service as unknown as { db: { prepare(sql: string): { run(...parameters: unknown[]): unknown } } };
  internal.changed = () => {
    internalStore.db.prepare("UPDATE thread_work SET landed_at=? WHERE id=?").run(Date.now(), request.requestId);
    throw new Error("disk I/O error after create and brief landing");
  };
  try {
    const created = await f.service.spawn(request);
    expect(created).toMatchObject({ ok: true, value: { id: spawnThreadId(request.requestId) } });
    internal.changed = changed;
    const retry = await f.service.spawn(request);
    expect(retry).toEqual(created);
    expect(f.service.snapshot()).toHaveLength(1);
    expect(f.service.pending(spawnThreadId(request.requestId))).toHaveLength(0);
    const work = (f.service as unknown as { db: { prepare(sql: string): { all(...parameters: unknown[]): unknown[] } } }).db.prepare("SELECT id,text,landed_at FROM thread_work WHERE thread_id=?").all(spawnThreadId(request.requestId));
    expect(work).toMatchObject([{ id: request.requestId, text: request.message, landed_at: expect.any(Number) }]);
    expect(await f.service.spawn({ ...request, message: "Changed brief is another instruction" })).toMatchObject({ ok: false, error: { code: "conflict" } });
  } finally { internal.changed = changed; await f.close(); }
});

test("committed creation with unreadable receipt returns its exact accepted thread identity, never bare I/O failure", async () => {
  const f = fixture(), request = { requestId: "caller:unreadable", cwd: f.root, title: "Accepted source", message: "Brief" };
  const get = f.service.get.bind(f.service);
  let fail = false;
  const internal = f.service as unknown as { changed(id: string): void };
  const changed = internal.changed.bind(f.service);
  internal.changed = () => { fail = true; throw new Error("disk I/O error"); };
  f.service.get = id => { if (fail) throw new Error("receipt read I/O error"); return get(id); };
  try {
    expect(await f.service.spawn(request)).toMatchObject({ ok: false, error: { requestId: request.requestId, retryable: false,
      spawnReceipt: { requestId: request.requestId, threadId: spawnThreadId(request.requestId), state: "accepted" } } });
    fail = false; internal.changed = changed;
    expect(await f.service.spawn(request)).toMatchObject({ ok: true, value: { id: spawnThreadId(request.requestId) } });
    expect(f.service.snapshot()).toHaveLength(1);
    expect(f.service.pending(spawnThreadId(request.requestId))).toHaveLength(1);
  } finally { fail = false; f.service.get = get; internal.changed = changed; await f.close(); }
});

test("transport loss after durable create has a known ID and an unchanged same-key recovery returns that thread", async () => {
  const f = fixture(), request = { requestId: "caller:lost-ack", cwd: f.root, title: "Lost acknowledgement", message: "Only one brief" };
  let lose = true;
  const bodies: string[] = [];
  const api = createThreadClient("http://owner/v1/threads", async (url, init) => {
    bodies.push(String(init?.body));
    const reply = await threadHttp(f.service, new Request(url, init));
    if (lose) throw new TypeError("acknowledgement lost after effect");
    return reply!;
  }, { timeoutMs: 30 });
  try {
    expect(await api.spawn(request)).toMatchObject({ ok: false, error: { requestId: request.requestId,
      spawnReceipt: { threadId: spawnThreadId(request.requestId), requestId: request.requestId, state: "unconfirmed" } } });
    lose = false;
    expect(await api.spawn(request)).toMatchObject({ ok: true, value: { id: spawnThreadId(request.requestId) } });
    expect(new Set(bodies).size).toBe(1);
    expect(f.service.snapshot()).toHaveLength(1);
    expect(f.service.pending(spawnThreadId(request.requestId))).toHaveLength(1);
  } finally { await f.close(); }
});

test("historical random-ID receipts remain exact when a new client qualifies the same original request", async () => {
  const f = fixture(), request = { requestId: "caller:historical", cwd: f.root, title: "Historical task", message: "Original brief" };
  const historicalId = "historical-random-child";
  try {
    expect(await f.service.spawn({ ...request, id: historicalId })).toMatchObject({ ok: true });
    const internal = f.service as unknown as { db: { prepare(sql: string): { run(...args: unknown[]): unknown } }; recordRequest(id: string, value: unknown, kind: string, target: string): void };
    internal.db.prepare("DELETE FROM thread_request WHERE id=?").run(request.requestId);
    internal.recordRequest(request.requestId, request, "spawn", historicalId);
    const api = createThreadClient("http://owner/v1/threads", async (url, init) => (await threadHttp(f.service, new Request(url, init)))!);
    expect(await api.spawn(request)).toMatchObject({ ok: true, value: { id: historicalId } });
    expect(f.service.snapshot()).toHaveLength(1);
    expect(f.service.pending(historicalId)).toHaveLength(1);
  } finally { await f.close(); }
});

test("HTTP 503 retains the exact owner accepted spawn receipt instead of discarding it as activation failure", async () => {
  const request = { requestId: "caller:read-failure", cwd: "/work", title: "Receipt" };
  const receipt = { requestId: request.requestId, threadId: "already-created-historical-id", state: "accepted" as const };
  const response = { ok: false, error: { code: "unavailable", message: "Disk I/O after commit", spawnReceipt: receipt } };
  let attempts = 0;
  const api = createThreadClient("http://owner", async () => { attempts++; return Response.json(response, { status: 503 }); });
  expect(await api.spawn(request)).toMatchObject({ ok: false, error: { spawnReceipt: receipt, requestId: request.requestId, retryable: false } });
  expect(attempts).toBe(1);
});

test("native retry with another tool call ID reuses the returned caller requestId and unchanged payload", async () => {
  const requests: SpawnThread[] = [];
  const api = { spawn: async (input: SpawnThread) => { requests.push(input); return { ok: false, error: { code: "unavailable", requestId: input.requestId,
    spawnReceipt: { requestId: input.requestId, threadId: spawnThreadId(input.requestId), state: "accepted" }, message: "Recover same receipt" } }; } } as unknown as ThreadApi;
  const tool = threadTools({ threadId: "caller", cwd: "/work", sessionFile: "/work/caller.jsonl", args: [], env: {}, threads: api }).find(tool => tool.name === "thread_spawn")!;
  const input = { message: "Bounded assignment", title: "Receipt retry" };
  await tool.execute("first-call", input, undefined, undefined, {} as never);
  await tool.execute("second-call", { ...input, requestId: "caller:first-call" }, undefined, undefined, {} as never);
  expect(requests).toHaveLength(2);
  expect(requests[1]).toEqual(requests[0]);
  expect(await tool.execute("third-call", { ...input, requestId: "another:call" }, undefined, undefined, {} as never)).toMatchObject({ isError: true });
  expect(requests).toHaveLength(2);
});

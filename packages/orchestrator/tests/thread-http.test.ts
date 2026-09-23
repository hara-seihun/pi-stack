import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import * as sourceHttp from "../src/threads/http.js";
import * as sourceService from "../src/threads/service.js";
import * as sourceDirectory from "../src/threads/directory.js";
import * as sourceTools from "../src/threads/pi-tools.js";
import type { SendThread, ThreadApi } from "../src/threads/contracts.js";

const release = process.env.PI_THREAD_TEST_RELEASE;
const { createThreadClient, threadHttp }: typeof sourceHttp = release ? await import(`${release}/threads/http.js`) : sourceHttp;
const { ThreadService }: typeof sourceService = release ? await import(`${release}/threads/service.js`) : sourceService;
const { ThreadDirectory }: typeof sourceDirectory = release ? await import(`${release}/threads/directory.js`) : sourceDirectory;
const { threadTools }: typeof sourceTools = release ? await import(`${release}/threads/pi-tools.js`) : sourceTools;

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
const send: SendThread = { requestId: "sender:tool-call", threadId: "recipient", senderId: "sender", text: "GO", delivery: "steer", source: "explicit" };
const close = (server: Server) => new Promise<void>((resolve, reject) => {
  server.close(error => error ? reject(error) : resolve());
  server.closeAllConnections();
});
const listen = (server: Server, port = 0) => new Promise<number>(resolve => {
  server.listen(port, "127.0.0.1", () => resolve((server.address() as { port: number }).port));
});

it("recovers refused connection and lost acceptance across owner restart without duplicate input or undoing Stop", async () => {
  const root = mkdtempSync(join(tmpdir(), "thread-send-handoff-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const options = { databasePath: join(root, "threads.sqlite3"), sessionsDir: root,
    openSession: async () => { throw new Error("No model execution is needed for transport acceptance"); } };
  let service = new ThreadService(options);
  cleanups.push(async () => { expect(await service.close()).toMatchObject({ ok: true }); });
  expect((await service.spawn({ requestId: "create", id: "recipient", cwd: root })).ok).toBe(true);
  const bodies: string[] = [];
  let lostAcceptance = false;
  let restart: Promise<void> = Promise.resolve();
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString();
    bodies.push(body);
    await restart;
    const response = await threadHttp(service, new Request(`http://owner${req.url}`, { method: "POST", body }));
    if (!lostAcceptance) {
      lostAcceptance = true;
      expect((await response!.clone().json()).ok).toBe(true);
      restart = (async () => {
        expect((await service.control({ threadId: "recipient", action: "stop", descendants: false })).ok).toBe(true);
        await service.detach();
        service = new ThreadService(options);
      })();
      res.destroy();
      return;
    }
    res.writeHead(response!.status, Object.fromEntries(response!.headers));
    res.end(await response!.text());
  });
  const port = await listen(server);
  await close(server);
  cleanups.push(() => close(server));
  let refusals = 0;
  const fetcher = async (url: string | URL | Request, init?: RequestInit) => {
    try { return await fetch(url, init); }
    catch (error) {
      if (!server.listening) { refusals++; await listen(server, port); }
      throw error;
    }
  };
  const api = createThreadClient(`http://127.0.0.1:${port}/v1/threads`, fetcher, { timeoutMs: 3_000 });
  const result = await api.send(send);
  expect(result).toMatchObject({ ok: true, value: { id: send.requestId, text: "GO", delivery: "steer" } });
  expect(refusals).toBe(1);
  expect(bodies).toEqual([JSON.stringify(send), JSON.stringify(send)]);
  expect(service.pending("recipient")).toHaveLength(1);
  expect(service.get("recipient")).toMatchObject({ state: "idle", held: true });
  expect(await api.send({ ...send, text: "different instruction" })).toMatchObject({ ok: false, error: { code: "conflict" } });
  expect(service.pending("recipient")).toHaveLength(1);
});

it("waits through a suspended controller, then returns its durable acceptance", async () => {
  const root = mkdtempSync(join(tmpdir(), "thread-suspended-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const options = { databasePath: join(root, "threads.sqlite3"), sessionsDir: root,
    openSession: async () => { throw new Error("No model execution"); } };
  let owner = new ThreadService(options);
  cleanups.push(async () => { expect(await owner.close()).toMatchObject({ ok: true }); });
  await owner.spawn({ requestId: "create", id: "recipient", cwd: root });
  owner.suspend();
  const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const response = await threadHttp(owner, new Request(url, init));
    if (fetcher.mock.calls.length === 1) {
      expect(await response!.clone().json()).toMatchObject({ ok: false, error: { retryable: true } });
      await owner.detach();
      owner = new ThreadService(options);
    }
    return response!;
  });
  expect(await createThreadClient("http://owner/v1/threads", fetcher).send(send)).toMatchObject({ ok: true });
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(owner.pending("recipient")).toHaveLength(1);
});

it("deduplicates overlapping spawn retries after asynchronous parent discovery", async () => {
  const root = mkdtempSync(join(tmpdir(), "thread-spawn-retry-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const owner = new ThreadService({ databasePath: join(root, "threads.sqlite3"), sessionsDir: root,
    openSession: async () => { throw new Error("No model execution"); } });
  cleanups.push(async () => { expect(await owner.close()).toMatchObject({ ok: true }); });
  const parentOwner = new ThreadService({ databasePath: join(root, "parent.sqlite3"), sessionsDir: join(root, "parent"),
    openSession: async () => { throw new Error("No model execution"); } });
  cleanups.push(async () => { expect(await parentOwner.close()).toMatchObject({ ok: true }); });
  expect(await parentOwner.spawn({ requestId: "create-parent", id: "parent", cwd: root })).toMatchObject({ ok: true });
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const list = parentOwner.list.bind(parentOwner);
  const discovery = vi.spyOn(parentOwner, "list").mockImplementation(async input => { await gate; return list(input); });
  owner.setDirectory(parentOwner);
  const request = { requestId: "spawn-call", parentId: "parent", cwd: root, message: "work" };
  const first = owner.spawn(request), second = owner.spawn(request);
  expect(discovery).toHaveBeenCalledTimes(2);
  release();
  const results = await Promise.all([first, second]);
  expect(results[0]).toMatchObject({ ok: true });
  expect(results[1]).toEqual(results[0]);
  const children = owner.snapshot();
  expect(children).toHaveLength(1);
  expect(children[0]).toMatchObject({ parentId: "parent", settings: { model: "openai-codex/gpt-6-sol" } });
  expect(owner.pending(children[0]!.id)).toMatchObject([{ id: request.requestId, text: request.message }]);
});

it.each([502, 503, 504])("reconnects after HTTP %s with the same spawn identity", async status => {
  const fetcher = vi.fn().mockResolvedValueOnce(new Response("Activating", { status }))
    .mockResolvedValueOnce(Response.json({ ok: true, value: { id: "child" } }));
  expect(await createThreadClient("http://owner", fetcher).spawn({ requestId: "spawn-call", cwd: "/work" })).toMatchObject({ ok: true });
  expect(fetcher.mock.calls[0][1].body).toBe(fetcher.mock.calls[1][1].body);
  expect(fetcher.mock.calls[0][1].headers).toEqual(fetcher.mock.calls[1][1].headers);
});

it.each(["command", "control", "missing-identity"])("does not replay %s after a lost response", async operation => {
  const fetcher = vi.fn().mockRejectedValue(new TypeError("connection lost"));
  const api = createThreadClient("http://owner", fetcher);
  const result = operation === "command" ? await api.command("recipient", { type: "compact" })
    : operation === "control" ? await api.control({ threadId: "recipient", action: "resume" })
    : await api.send({ ...send, requestId: "" });
  expect(result.ok).toBe(false);
  expect(fetcher).toHaveBeenCalledTimes(1);
});

it.each([401, 403, 423])("does not retry HTTP %s or change the authorized endpoint", async status => {
  const fetcher = vi.fn().mockResolvedValue(Response.json({ ok: false, error: { code: "unavailable", message: "Access denied", retryable: true } }, { status }));
  expect((await createThreadClient("http://person/v1/thread-owner", fetcher).send(send)).ok).toBe(false);
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(fetcher.mock.calls[0][0]).toBe("http://person/v1/thread-owner/send");
});

it("leaves archived, invalid and conflicting inputs as terminal owner decisions", async () => {
  for (const code of ["unavailable", "invalid_request", "conflict", "not_found"]) {
    const result = { ok: false, error: { code, message: "Owner decision" } };
    const fetcher = vi.fn().mockResolvedValue(Response.json(result));
    expect(await createThreadClient("http://owner", fetcher).send(send)).toEqual({ ...result, error: { ...result.error, requestId: send.requestId, retryable: false } });
    expect(fetcher).toHaveBeenCalledTimes(1);
  }
});

it("cancels native tool reconnect promptly without issuing another send", async () => {
  const controller = new AbortController();
  const fetcher = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
    setTimeout(() => controller.abort(), 5);
    throw new TypeError("connection refused");
  });
  const tool = threadTools({ threadId: "sender", cwd: "/work", sessionFile: "/work/session.jsonl", args: [],
    env: { PI_THREAD_API_URL: "http://owner/v1/threads" } }).find(tool => tool.name === "thread_send")!;
  const result = await tool.execute("tool-call", { threadId: "recipient", text: "GO" }, controller.signal, undefined, {} as never);
  expect(result).toMatchObject({ isError: true, details: { ok: false, error: { requestId: send.requestId, retryable: false } } });
  expect(result.content[0]).toMatchObject({ text: expect.stringContaining("cancelled") });
  expect(fetcher).toHaveBeenCalledTimes(1);
});

it("bounds reconnect by one deadline and reports unconfirmed acceptance with the original identity", async () => {
  const fetcher = vi.fn().mockRejectedValue(new TypeError("connection refused"));
  const started = Date.now();
  const result = await createThreadClient("http://owner", fetcher, { timeoutMs: 30 }).send(send);
  expect(result).toMatchObject({ ok: false, error: { requestId: send.requestId, retryable: false, message: expect.stringContaining("Acceptance is unconfirmed") } });
  expect(Date.now() - started).toBeLessThan(300);
  expect(fetcher).toHaveBeenCalledTimes(1);
});

it("propagates the caller deadline and cancellation through an authorized directory hop", async () => {
  const controller = new AbortController();
  const deadline = Date.now() + 100;
  const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    expect(new Headers(init?.headers).get("x-pi-thread-deadline")).toBe(String(deadline));
    setTimeout(() => controller.abort(), 5);
    throw new TypeError("peer activating");
  });
  const directory = new ThreadDirectory({ id: "person", api: createThreadClient("http://person/v1/thread-owner", fetcher) });
  const response = await threadHttp(directory, new Request("http://directory/v1/threads/send", { method: "POST",
    headers: { "x-pi-thread-deadline": String(deadline) }, body: JSON.stringify(send), signal: controller.signal }));
  expect(await response!.json()).toMatchObject({ ok: false, error: { retryable: false, message: expect.stringContaining("cancelled") } });
  expect(fetcher).toHaveBeenCalledTimes(1);
});

it("rejects an expired forwarded operation before invoking its owner", async () => {
  const owner = { send: vi.fn() } as unknown as ThreadApi;
  const response = await threadHttp(owner, new Request("http://owner/v1/threads/send", { method: "POST",
    headers: { "x-pi-thread-deadline": String(Date.now() - 1) }, body: JSON.stringify(send) }));
  expect(response?.status).toBe(408);
  expect(owner.send).not.toHaveBeenCalled();
});

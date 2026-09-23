import { describe, expect, it, vi } from "vitest";
import type { AwaitThreads, Result, Thread, ThreadApi, ThreadAwaitResult, ThreadSettlement } from "../src/threads/contracts.js";
import { ThreadDirectory } from "../src/threads/directory.js";
import { createThreadClient, threadHttp } from "../src/threads/http.js";
import { threadTools } from "../src/threads/pi-tools.js";

const settlement = (threadId: string, seq = 7): ThreadSettlement => ({
  seq, threadId, executionId: `${threadId}-execution`, workId: "work", outcome: "complete", time: 1, finalMessage: { role: "assistant", content: "Done" },
});
function response(input: AwaitThreads, settled: ThreadSettlement | null = null): Result<ThreadAwaitResult> {
  return { ok: true, value: { settlement: settled,
    remainingThreadIds: input.threadIds.filter(id => id !== settled?.threadId),
    after: Object.fromEntries([...Object.entries(input.after ?? {}), ...input.threadIds.map(id => [id, id === settled?.threadId ? settled.seq : input.after?.[id] ?? 0])]),
  } };
}
function owner(threads: Array<{ id: string; parentId: string }>) {
  const calls = {
    list: vi.fn(async (input: { id?: string } = {}) => ({ ok: true as const, value: { threads: threads.filter(thread => !input.id || thread.id === input.id) as Thread[] } })),
    await: vi.fn<ThreadApi["await"]>().mockImplementation(async input => response(input)),
  };
  return { id: threads[0]?.id ?? "empty", api: calls as unknown as ThreadApi, calls };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

it("returns on the first owner timeout with cursors and actionable child statuses", async () => {
  const wait = vi.fn<ThreadApi["await"]>().mockImplementation(async input => response({ ...input, after: { ...input.after, child: 8, other: 4 } }));
  const list = vi.fn<ThreadApi["list"]>().mockImplementation(async input => ({ ok: true, value: { threads: [{
    id: input!.id!, parentId: "parent", state: "running", held: false, pendingMessages: 1,
    metadata: input!.id === "child" ? { admissionWait: { code: "quota_exhausted", reason: "No account available" } } : { executionError: "Cancellation unconfirmed" },
  } as unknown as Thread] } }));
  const tool = threadTools({ threadId: "parent", cwd: "/work", sessionFile: "/work/session.jsonl", args: [], env: {}, threads: { await: wait, list } as unknown as ThreadApi })
    .find(tool => tool.name === "thread_await")!;
  const controller = new AbortController();
  const outcome = await tool.execute("call", { threadIds: ["child", "other"], after: { prior: 3 } }, controller.signal, undefined, {} as never);
  expect(wait).toHaveBeenCalledOnce();
  expect(wait).toHaveBeenCalledWith({ threadIds: ["child", "other"], parentId: "parent", after: { prior: 3 }, timeoutMs: 25_000 }, controller.signal);
  expect(outcome.details).toEqual({ ok: true, value: { settlement: null, timedOut: true, remainingThreadIds: ["child", "other"], after: { prior: 3, child: 8, other: 4 }, statuses: [
    { threadId: "child", state: "running", held: false, pendingMessages: 1, admissionWait: { code: "quota_exhausted", reason: "No account available" } },
    { threadId: "other", state: "running", held: false, pendingMessages: 1, executionError: "Cancellation unconfirmed" },
  ] } });
  expect(list).toHaveBeenCalledTimes(2);
});

it("returns a useful timeout even when a child status lookup fails", async () => {
  const wait = vi.fn<ThreadApi["await"]>().mockImplementation(async input => response(input));
  const list = vi.fn<ThreadApi["list"]>().mockResolvedValue({ ok: false, error: { code: "unavailable", message: "Owner offline" } });
  const tool = threadTools({ threadId: "parent", cwd: "/work", sessionFile: "/work/session.jsonl", args: [], env: {}, threads: { await: wait, list } as unknown as ThreadApi })
    .find(tool => tool.name === "thread_await")!;
  const outcome = await tool.execute("call", { threadIds: ["child"] }, undefined, undefined, {} as never);
  expect(outcome.details).toEqual({ ok: true, value: { settlement: null, timedOut: true, remainingThreadIds: ["child"], after: { child: 0 }, statuses: [
    { threadId: "child", error: { code: "unavailable", message: "Owner offline" } },
  ] } });
  expect(wait).toHaveBeenCalledOnce();
});

it("bounds status lookup when an owner cannot answer after await times out", async () => {
  vi.useFakeTimers();
  try {
    const wait = vi.fn<ThreadApi["await"]>().mockImplementation(async input => response(input));
    const list = vi.fn<ThreadApi["list"]>().mockImplementation(() => new Promise(() => {}));
    const tool = threadTools({ threadId: "parent", cwd: "/work", sessionFile: "/work/session.jsonl", args: [], env: {}, threads: { await: wait, list } as unknown as ThreadApi })
      .find(tool => tool.name === "thread_await")!;
    const waiting = tool.execute("call", { threadIds: ["child"] }, undefined, undefined, {} as never);
    await vi.advanceTimersByTimeAsync(2_000);
    expect((await waiting).details).toMatchObject({ ok: true, value: { settlement: null, timedOut: true, after: { child: 0 },
      statuses: [{ threadId: "child", error: { code: "unavailable" } }] } });
    expect(wait).toHaveBeenCalledOnce();
  } finally {
    vi.useRealTimers();
  }
});

it("preserves final text while omitting opaque content without changing the native result", async () => {
  const text = "Full final message. ".repeat(3000);
  const native = { ...settlement("child"), finalMessage: { role: "assistant", content: [
    { type: "text", text, textSignature: "OPAQUE_SIGNATURE" },
    { type: "thinking", thinking: "OPAQUE_THINKING" },
    { type: "image", mimeType: "image/png", data: "OPAQUE_BYTES" },
    { type: "redacted_thinking", data: "OPAQUE_REDACTED_THINKING" },
  ] } };
  const wait = vi.fn<ThreadApi["await"]>().mockImplementation(async input => response(input, native));
  const tool = threadTools({ threadId: "parent", cwd: "/work", sessionFile: "/work/session.jsonl", args: [], env: {}, threads: { await: wait } as unknown as ThreadApi })
    .find(tool => tool.name === "thread_await")!;
  const result = await tool.execute("call", { threadIds: ["child"] }, undefined, undefined, {} as never);
  expect(result.details).toMatchObject({ ok: true, value: { settlement: { finalMessage: { content: [{ type: "text", text }, null, { type: "image", mimeType: "image/png", image: "[image bytes omitted]" }, null] } } } });
  expect(JSON.stringify(result)).not.toContain("OPAQUE");
  expect(native.finalMessage.content[0]).toHaveProperty("textSignature", "OPAQUE_SIGNATURE");
});

it("aborts an in-process tool wait without another API call", async () => {
  const entered = deferred<void>();
  const wait = vi.fn<ThreadApi["await"]>().mockImplementation((input, signal) => new Promise(resolve => {
    signal!.addEventListener("abort", () => resolve(response(input)), { once: true });
    entered.resolve();
  }));
  const tool = threadTools({ threadId: "parent", cwd: "/work", sessionFile: "/work/session.jsonl", args: [], env: {}, threads: { await: wait } as unknown as ThreadApi })
    .find(tool => tool.name === "thread_await")!;
  const controller = new AbortController();
  const waiting = tool.execute("call", { threadIds: ["child"] }, controller.signal, undefined, {} as never);
  await entered.promise;
  controller.abort();
  await expect(waiting).rejects.toThrow();
  expect(wait).toHaveBeenCalledOnce();
});

it("routes HTTP await and propagates per-call cancellation through Request.signal", async () => {
  const entered = deferred<void>();
  let requestSignal: AbortSignal | undefined;
  const wait = vi.fn<ThreadApi["await"]>().mockImplementation((input, signal) => {
    if (input.timeoutMs === 0) return Promise.resolve(response(input, settlement("child")));
    requestSignal = signal;
    entered.resolve();
    return new Promise(resolve => signal!.addEventListener("abort", () => resolve({ ok: false, error: { code: "unavailable", message: "cancelled" } }), { once: true }));
  });
  const api = { await: wait } as unknown as ThreadApi;
  const fetcher = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => (await threadHttp(api, new Request(url, init)))!);
  const client = createThreadClient("http://owner/v1/threads", fetcher as unknown as typeof fetch);
  const input = { parentId: "parent", threadIds: ["child"], timeoutMs: 0 };
  expect(await client.await(input)).toEqual(response(input, settlement("child")));
  const controller = new AbortController();
  const waiting = client.await({ ...input, timeoutMs: 25_000 }, controller.signal);
  await entered.promise;
  controller.abort();
  expect((await waiting).ok).toBe(false);
  expect(requestSignal?.aborted).toBe(true);
});

it.each(["call", "client", "deadline"])("cancels directory HTTP awaits through the %s signal without dropping the forwarded deadline", async source => {
  const entered = deferred<void>();
  const controller = new AbortController();
  let ownerSignal: AbortSignal | undefined;
  const wait = vi.fn<ThreadApi["await"]>().mockImplementation((_input, signal) => {
    ownerSignal = signal;
    entered.resolve();
    return new Promise(resolve => signal!.addEventListener("abort", () => resolve({ ok: false, error: { code: "unavailable", message: "cancelled" } }), { once: true }));
  });
  const local = owner([{ id: "child", parentId: "parent" }]);
  local.api.await = wait;
  const deadlines: string[] = [];
  const peerFetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    deadlines.push(new Headers(init?.headers).get("x-pi-thread-deadline")!);
    return (await threadHttp(local.api, new Request(url, init)))!;
  });
  const directory = new ThreadDirectory({ id: "owner", api: createThreadClient("http://owner/v1/threads", peerFetch) });
  let deadline: string | null = null;
  const directoryFetch = async (url: string | URL | Request, init?: RequestInit) => {
    deadline = new Headers(init?.headers).get("x-pi-thread-deadline");
    return (await threadHttp(directory, new Request(url, init)))!;
  };
  const client = createThreadClient("http://directory/v1/threads", directoryFetch, {
    ...(source === "client" ? { signal: controller.signal } : {}), timeoutMs: source === "deadline" ? 100 : 1_000,
  });
  const waiting = client.await({ parentId: "parent", threadIds: ["child"], timeoutMs: 25_000 }, source === "call" ? controller.signal : undefined);
  await entered.promise;
  if (source !== "deadline") controller.abort();
  expect(await waiting).toMatchObject({ ok: false, error: { code: "unavailable" } });
  expect(ownerSignal?.aborted).toBe(true);
  expect(wait).toHaveBeenCalledOnce();
  expect(deadlines.length).toBeGreaterThan(1);
  expect(deadlines.every(value => value === deadline)).toBe(true);
});

describe("directory await", () => {
  it("validates every child before starting any owner's await", async () => {
    const local = owner([{ id: "child", parentId: "parent" }]);
    const peer = owner([{ id: "unrelated", parentId: "someone-else" }]);
    const directory = new ThreadDirectory(local, [peer]);
    expect(await directory.await({ parentId: "parent", threadIds: ["child", "unrelated"] })).toMatchObject({ ok: false, error: { code: "invalid_request" } });
    expect(local.calls.await).not.toHaveBeenCalled();
    expect(peer.calls.await).not.toHaveBeenCalled();
    expect((await directory.await({ parentId: "parent", threadIds: ["child", "child"] })).ok).toBe(false);
  });

  it("returns the first owner result, aborts losing waits and advances only the winner", async () => {
    const local = owner([{ id: "first", parentId: "parent" }]);
    const peer = owner([{ id: "second", parentId: "parent" }]);
    const entered = deferred<void>();
    let loserSignal: AbortSignal | undefined;
    local.calls.await.mockImplementation((input, signal) => {
      loserSignal = signal;
      entered.resolve();
      return new Promise(resolve => signal!.addEventListener("abort", () => resolve(response(input)), { once: true }));
    });
    peer.calls.await.mockImplementation(async input => { await entered.promise; return response(input, settlement("second", 19)); });
    const input = { parentId: "parent", threadIds: ["first", "second"], after: { first: 2, second: 9, prior: 30 } };
    expect(await new ThreadDirectory(local, [peer]).await(input)).toEqual(response(input, settlement("second", 19)));
    expect(loserSignal?.aborted).toBe(true);
  });

  it("does not let an owner timeout beat another owner's settlement", async () => {
    const local = owner([{ id: "first", parentId: "parent" }]);
    const peer = owner([{ id: "second", parentId: "parent" }]);
    peer.calls.await.mockImplementation(async input => response(input, settlement("second")));
    const input = { parentId: "parent", threadIds: ["first", "second"] };
    expect(await new ThreadDirectory(local, [peer]).await(input)).toEqual(response(input, settlement("second")));
  });

  it("returns all IDs on timeout and handles IDs that match object prototype keys", async () => {
    const local = owner([{ id: "constructor", parentId: "parent" }]);
    const peer = owner([{ id: "__proto__", parentId: "parent" }]);
    const input = { parentId: "parent", threadIds: ["constructor", "__proto__"], timeoutMs: 0 };
    const result = await new ThreadDirectory(local, [peer]).await(input);
    expect(result).toEqual({ ok: true, value: { settlement: null, remainingThreadIds: input.threadIds, after: Object.fromEntries(input.threadIds.map(id => [id, 0])) } });
    expect(local.calls.await.mock.calls[0]![0].after).toEqual(Object.fromEntries(input.threadIds.map(id => [id, 0])));
  });

  it("forwards parent cancellation to every pending owner", async () => {
    const owners = [owner([{ id: "first", parentId: "parent" }]), owner([{ id: "second", parentId: "parent" }])];
    const entered = owners.map(() => deferred<void>());
    const signals: AbortSignal[] = [];
    for (const [index, target] of owners.entries()) target.calls.await.mockImplementation((input, signal) => {
      signals.push(signal!);
      entered[index]!.resolve();
      return new Promise(resolve => signal!.addEventListener("abort", () => resolve(response(input)), { once: true }));
    });
    const controller = new AbortController();
    const waiting = new ThreadDirectory(owners[0]!, [owners[1]!]).await({ parentId: "parent", threadIds: ["first", "second"] }, controller.signal);
    await Promise.all(entered.map(item => item.promise));
    controller.abort();
    expect(await waiting).toMatchObject({ ok: false, error: { code: "unavailable" } });
    expect(signals.every(signal => signal.aborted)).toBe(true);
  });
});

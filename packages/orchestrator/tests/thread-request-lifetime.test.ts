import { afterEach, expect, it, vi } from "vitest";
import { createThreadClient, threadHttp } from "../src/threads/http.js";
import type { Result, ThreadApi, ThreadPage } from "../src/threads/contracts.js";

afterEach(() => vi.restoreAllMocks());

it.each(["returned", "threw"])("does not give background owner reads a %s request's deadline or cancellation", async outcome => {
  const now = Date.now();
  const clock = vi.spyOn(Date, "now").mockReturnValue(now);
  const caller = new AbortController();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    expect(init?.signal?.aborted).toBe(false);
    expect(Number(new Headers(init?.headers).get("x-pi-thread-deadline"))).toBe(now + 120_000);
    return Response.json({ ok: true, value: { threads: [] } });
  });
  const peer = createThreadClient("http://fleet/v1/thread-owner", fetcher);
  let background!: Promise<Result<ThreadPage>>;
  const owner = { list: async () => {
    background = (async () => { await gate; return peer.list({ id: "worker", limit: 1 }); })();
    if (outcome === "threw") throw new Error("Owner failed after scheduling work");
    return { ok: true, value: { threads: [] } };
  } } as unknown as ThreadApi;
  const response = await threadHttp(owner, new Request("http://person/v1/threads/list", {
    method: "POST", body: "{}", signal: caller.signal,
    headers: { "x-pi-thread-deadline": String(now + 1_000) },
  }));
  expect(response?.status).toBe(outcome === "returned" ? 200 : 503);
  caller.abort();
  clock.mockReturnValue(now + 60_000);
  release();
  expect(await background).toEqual({ ok: true, value: { threads: [] } });
  expect(fetcher).toHaveBeenCalledTimes(1);
});

it.each(["list", "questions"] as const)("retries the same authorized %s read after a transient transport loss", async operation => {
  const value = operation === "list" ? { threads: [] } : [];
  const fetcher = vi.fn().mockRejectedValueOnce(new TypeError("connection reset"))
    .mockResolvedValueOnce(Response.json({ ok: true, value }));
  const owner = createThreadClient("http://fleet/v1/thread-owner", fetcher);
  const result = operation === "list" ? await owner.list({ id: "worker", limit: 1 }) : await owner.questions("worker");
  expect(result).toEqual({ ok: true, value });
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(fetcher.mock.calls[0][0]).toBe(fetcher.mock.calls[1][0]);
  expect(fetcher.mock.calls[0][1].body).toBe(fetcher.mock.calls[1][1].body);
});

it("names the operation and owner endpoint without credentials when a request never starts", async () => {
  const caller = new AbortController();
  caller.abort();
  const fetcher = vi.fn();
  const owner = createThreadClient("http://identity:secret@fleet/v1/thread-owner", fetcher, { signal: caller.signal });
  expect(await owner.questions("worker")).toMatchObject({ ok: false, error: {
    code: "unavailable", retryable: false,
    message: "Thread questions cancelled at http://fleet/v1/thread-owner/questions: Request ended before contacting the owner.",
  } });
  expect(fetcher).not.toHaveBeenCalled();
});

it("keeps the active caller's deadline on nested owner reads", async () => {
  const deadline = Date.now() + 10_000;
  const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    expect(new Headers(init?.headers).get("x-pi-thread-deadline")).toBe(String(deadline));
    return Response.json({ ok: true, value: { threads: [] } });
  });
  const peer = createThreadClient("http://fleet/v1/thread-owner", fetcher);
  const owner = { list: () => peer.list({ id: "worker", limit: 1 }) } as unknown as ThreadApi;
  const response = await threadHttp(owner, new Request("http://person/v1/threads/list", {
    method: "POST", body: "{}", headers: { "x-pi-thread-deadline": String(deadline) },
  }));
  expect(await response!.json()).toEqual({ ok: true, value: { threads: [] } });
  expect(fetcher).toHaveBeenCalledTimes(1);
});

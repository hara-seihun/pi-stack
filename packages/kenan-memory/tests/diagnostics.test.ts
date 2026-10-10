import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { memoryExtension } from "../src/tools.js";
import { infrastructureReason, type InfrastructureEvent } from "../src/diagnostics.js";

async function ask(transport: typeof fetch, timeoutMs = 100, signal?: AbortSignal, input: { request?: string; requestId?: string } = { request: "private-request" }) {
  const directory = mkdtempSync(join(tmpdir(), "root-client-diagnostics-"));
  const host = join(directory, "host.json"); writeFileSync(host, '{"oneKenan":true}');
  const tools: any[] = [], events: InfrastructureEvent[] = [];
  try {
    memoryExtension({ env: { PI_STACK_HOST_CONFIG: host, PI_THREAD_ID: "private-thread", PI_KENAN_MEMORY_ROLE: "person", PI_KENAN_MEMORY_PERSON: "private-person", PI_KENAN_MEMORY_TOKEN: "private-token" },
      ask: async () => ({}), rootTransport: transport, rootTimeoutMs: timeoutMs, report: event => events.push(event) })({ registerTool: tool => tools.push(tool), on() {} } as any);
    const result = await tools.find(tool => tool.name === "ask_kenan").execute("id", input, signal);
    expect(JSON.stringify(events)).not.toMatch(/private-|private-reply|private-error/);
    return { result, events };
  } finally { rmSync(directory, { force: true, recursive: true }); }
}
test("root timeout and cancellation distinguish unknown outcomes without replay or private diagnostics", async () => {
  let calls = 0;
  const stalled = (async (_input, init) => {
    calls++;
    const signal = init!.signal!;
    return await new Promise<Response>((_resolve, reject) => {
      if (signal.aborted) reject(signal.reason);
      else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
  }) as typeof fetch;
  const deadline = await ask(stalled, 5);
  expect(calls).toBe(1);
  expect(deadline.result.details.memoryResult.message).toContain("timed out; its outcome is unknown");
  expect(deadline.events[0]).toMatchObject({ outcome: "failed", reason: "timeout" });
  const controller = new AbortController(); controller.abort(new Error("private-error"));
  const cancelled = await ask(stalled, 100, controller.signal);
  expect(calls).toBe(1);
  expect(cancelled.result.details.memoryResult.message).toContain("cancelled before submission");
});
test("root client diagnoses terminal HTTP and malformed replies without echoing root internals", async () => {
  let calls = 0;
  const http = await ask((async () => { calls++; return new Response("private-error", { status: 403 }); }) as typeof fetch);
  expect(calls).toBe(1);
  expect(http.events).toHaveLength(1);
  expect(http.events[0]).toMatchObject({ stage: "request", outcome: "failed", reason: "http-error", status: 403 });
  expect(http.result.isError).toBe(true);
  expect(http.result.details.rootRequest).toBeUndefined();
  expect(http.result.content[0].text).not.toContain("private-error");
  const invalid = await ask((async () => Response.json({ trace: "private-error" })) as typeof fetch);
  expect(invalid.events[0].reason).toBe("invalid-response");
  const unknown = await ask((async (_url, init) => Response.json({ requestId: (init!.headers as Record<string, string>)["x-kenan-request-id"], status: "future-status", reply: "private-reply" })) as typeof fetch);
  expect(unknown.events[0].reason).toBe("invalid-response");
  expect(unknown.result.isError).toBe(true);
  expect(unknown.result.content[0].text).not.toContain("private-reply");
  const ready = await ask((async () => Response.json({ reply: "private-reply" })) as typeof fetch);
  expect(ready.events[0]).toMatchObject({ outcome: "ok", status: 200 });
  expect(ready.result.content[0].text).toBe("private-reply");
  expect(infrastructureReason({ name: "private-error", code: "private-token" })).toBe("unexpected");
});
test("pending receipts are stable per tool call and status-only checks never submit another request", async () => {
  const calls: { url: string; method: string; body: unknown; id: string | undefined }[] = [];
  const transport = (async (url, init) => {
    const headers = init!.headers as Record<string, string>;
    calls.push({ url: String(url), method: init!.method!, body: init!.body, id: headers["x-kenan-request-id"] });
    return init!.method === "GET" ? Response.json({ reply: "private-reply", trace: "private-error" }) : Response.json({ requestId: headers["x-kenan-request-id"], status: "pending", trace: "private-error", rootSessionId: "private-session" }, { status: 202 });
  }) as typeof fetch;
  const first = await ask(transport), replay = await ask(transport);
  const receipt = first.result.details.rootRequest;
  expect(first.result.isError).toBe(false);
  expect(replay.result.details.rootRequest.requestId).toBe(receipt.requestId);
  expect(calls[0].body).toBe('{"request":"private-request"}');
  expect(calls[0].id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-a[0-9a-f]{3}-[0-9a-f]{12}$/);
  expect(first.result.content[0].text).not.toMatch(/private-session|private-error/);
  const retrieved = await ask(transport, 100, undefined, { requestId: receipt.requestId });
  expect(retrieved.result.content[0].text).toBe("private-reply");
  expect(calls[2]).toMatchObject({ method: "GET", body: undefined, id: undefined });
  expect(calls[2].url).toEndWith(`/v1/ask/${receipt.requestId}`);
  const malformed = await ask(transport, 100, undefined, { request: "private-request", requestId: receipt.requestId });
  expect(malformed.result.isError).toBe(true); expect(calls).toHaveLength(3);
});
test("global-capacity receipts stay pending with an explicit reason, not a failed request", async () => {
  const result = await ask((async (_url, init) => Response.json({ requestId: (init!.headers as Record<string, string>)["x-kenan-request-id"], status: "pending", reason: "global-agent-capacity", rootSessionId: "private-session" }, { status: 202 })) as typeof fetch);
  expect(result.result.isError).toBe(false);
  expect(result.result.details.rootRequest).toMatchObject({ status: "pending", reason: "global-agent-capacity" });
  expect(result.result.content[0].text).toContain("100-agent capacity");
  expect(result.result.content[0].text).not.toContain("private-session");
});

test("retryable HTTP and transport failures exhaust the deadline without synthetic acceptance", async () => {
  for (const transport of [
    (async () => new Response("private-error", { status: 503 })) as typeof fetch,
    (async () => { throw Object.assign(new Error("private-error"), { code: "ECONNREFUSED" }); }) as typeof fetch,
    (async () => { throw new Error("private-error"); }) as typeof fetch,
  ]) {
    let id = "", calls = 0;
    const failed = await ask((async (url, init) => {
      calls++; id = (init!.headers as Record<string, string>)["x-kenan-request-id"];
      return transport(url, init);
    }) as typeof fetch, 10);
    expect(calls).toBe(1);
    expect(failed.events).toHaveLength(1);
    expect(failed.events[0]).toMatchObject({ stage: "request", outcome: "failed", reason: "timeout" });
    expect(failed.events[0].status).toBeUndefined();
    expect(failed.result.isError).toBe(true);
    expect(failed.result.details.rootRequest).toBeUndefined();
    expect(failed.result.details.memoryResult.requestId).toBe(id);
    expect(failed.result.content[0].text).toContain("timed out; its outcome is unknown");
    expect(failed.result.content[0].text).toContain("do not resubmit");
  }
});

test("replacement reconnects preserve the original ask and report only a verified receipt", async () => {
  const calls: { url: string; method: string | undefined; body: unknown; id: string | undefined }[] = [];
  const recovered = await ask((async (url, init) => {
    const id = (init!.headers as Record<string, string>)["x-kenan-request-id"];
    calls.push({ url: String(url), method: init!.method, body: init!.body, id });
    if (calls.length === 1) return new Response("private-error", { status: 503 });
    if (calls.length === 2) throw Object.assign(new Error("private-error"), { code: "ECONNREFUSED" });
    return Response.json({ requestId: id, status: "pending", trace: "private-error", rootSessionId: "private-session" }, { status: 202 });
  }) as typeof fetch, 1_000);
  expect(calls).toHaveLength(3);
  expect(calls[0]).toMatchObject({ method: "POST", body: '{"request":"private-request"}' });
  expect(calls[1]).toEqual(calls[0]);
  expect(calls[2]).toEqual(calls[0]);
  expect(recovered.events).toHaveLength(1);
  expect(recovered.events[0]).toMatchObject({ stage: "request", outcome: "ok", status: 202 });
  expect(recovered.result.isError).toBe(false);
  expect(recovered.result.details.rootRequest).toMatchObject({ requestId: calls[0].id, status: "pending" });
  expect(recovered.result.content[0].text).not.toMatch(/private-session|private-error/);
});

test("timeout recovery accepts only a fenced not-accepted receipt and never resubmits", async () => {
  const calls: string[] = [];
  const transport = (async (_url, init) => {
    calls.push(init!.method!);
    if (init!.method === "POST") return await new Promise<Response>((_resolve, reject) => {
      init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason), { once: true });
    });
    return Response.json({ requestId, state: "not-accepted", safeToResubmit: true });
  }) as typeof fetch;
  const timedOut = await ask(transport, 5);
  const requestId = timedOut.result.details.memoryResult.requestId;
  const recovered = await ask(transport, 100, undefined, { requestId });
  expect(calls).toEqual(["POST", "GET"]);
  expect(recovered.result.details.rootRequest).toMatchObject({ requestId, state: "not-accepted", safeToResubmit: true });
  expect(recovered.result.content[0].text).toContain("old ID is fenced");
  for (const invalid of [
    { requestId: "unrelated", state: "not-accepted", safeToResubmit: true },
    { requestId, state: "not-accepted", safeToResubmit: false },
    { requestId, state: "not-accepted", safeToResubmit: true, status: "pending" },
  ]) {
    const rejected = await ask((async () => Response.json(invalid)) as typeof fetch, 100, undefined, { requestId });
    expect(rejected.result.isError).toBe(true);
    expect(rejected.result.details.rootRequest).toBeUndefined();
  }
});

test("unrelated receipts are rejected without trusting or replaying them", async () => {
  let calls = 0;
  const wrong = await ask((async () => { calls++; return Response.json({ requestId: "unrelated", status: "pending" }, { status: 202 }); }) as typeof fetch);
  expect(calls).toBe(1);
  expect(wrong.events[0].reason).toBe("invalid-response");
  expect(wrong.result.isError).toBe(true);
  expect(wrong.result.details.rootRequest).toBeUndefined();
});

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
test("root client diagnoses HTTP, malformed replies and transport errors without echoing root internals", async () => {
  const http = await ask((async () => new Response("private-error", { status: 503 })) as typeof fetch);
  expect(http.events[0]).toMatchObject({ outcome: "failed", reason: "http-error", status: 503 });
  expect(http.result.content[0].text).not.toContain("private-error");
  const invalid = await ask((async () => Response.json({ trace: "private-error" })) as typeof fetch);
  expect(invalid.events[0].reason).toBe("invalid-response");
  const unknown = await ask((async (_url, init) => Response.json({ requestId: (init!.headers as Record<string, string>)["x-kenan-request-id"], status: "future-status", reply: "private-reply" })) as typeof fetch);
  expect(unknown.events[0].reason).toBe("invalid-response");
  expect(unknown.result.isError).toBe(true);
  expect(unknown.result.content[0].text).not.toContain("private-reply");
  const refused = await ask((async () => { throw Object.assign(new Error("private-error"), { code: "ECONNREFUSED" }); }) as typeof fetch);
  expect(refused.events[0].reason).toBe("connection-refused");
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
test("lost acknowledgement returns the recoverable public id, never automatically retries or trusts unrelated receipts", async () => {
  let id = "", calls = 0;
  const failed = await ask((async (_url, init) => { calls++; id = (init!.headers as Record<string, string>)["x-kenan-request-id"]; throw new Error("private-error"); }) as typeof fetch);
  expect(calls).toBe(1);
  expect(failed.result.details.memoryResult.requestId).toBe(id);
  expect(failed.result.content[0].text).toContain("do not resubmit");
  const wrong = await ask((async () => Response.json({ requestId: "unrelated", status: "pending" }, { status: 202 })) as typeof fetch);
  expect(wrong.events[0].reason).toBe("invalid-response"); expect(wrong.result.isError).toBe(true);
});

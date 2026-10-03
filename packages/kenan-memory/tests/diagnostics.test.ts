import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { memoryExtension } from "../src/tools.js";
import { infrastructureReason, type InfrastructureEvent } from "../src/diagnostics.js";

async function ask(transport: typeof fetch, timeoutMs = 100, signal?: AbortSignal) {
  const directory = mkdtempSync(join(tmpdir(), "root-client-diagnostics-"));
  const host = join(directory, "host.json"); writeFileSync(host, '{"oneKenan":true}');
  const tools: any[] = [], events: InfrastructureEvent[] = [];
  try {
    memoryExtension({ env: { PI_STACK_HOST_CONFIG: host, PI_THREAD_ID: "private-thread", PI_KENAN_MEMORY_ROLE: "person", PI_KENAN_MEMORY_PERSON: "private-person", PI_KENAN_MEMORY_TOKEN: "private-token" },
      ask: async () => ({}), rootTransport: transport, rootTimeoutMs: timeoutMs, report: event => events.push(event) })({ registerTool: tool => tools.push(tool), on() {} } as any);
    const result = await tools.find(tool => tool.name === "ask_kenan").execute("id", { request: "private-request" }, signal);
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
  expect(calls).toBe(2);
  expect(cancelled.result.details.memoryResult.message).toContain("cancelled; its outcome is unknown");
});
test("root client diagnoses HTTP, malformed replies and transport errors without echoing root internals", async () => {
  const http = await ask((async () => new Response("private-error", { status: 503 })) as typeof fetch);
  expect(http.events[0]).toMatchObject({ outcome: "failed", reason: "http-error", status: 503 });
  expect(http.result.content[0].text).not.toContain("private-error");
  const invalid = await ask((async () => Response.json({ trace: "private-error" })) as typeof fetch);
  expect(invalid.events[0].reason).toBe("invalid-response");
  const refused = await ask((async () => { throw Object.assign(new Error("private-error"), { code: "ECONNREFUSED" }); }) as typeof fetch);
  expect(refused.events[0].reason).toBe("connection-refused");
  const ready = await ask((async () => Response.json({ reply: "private-reply" })) as typeof fetch);
  expect(ready.events[0]).toMatchObject({ outcome: "ok", status: 200 });
  expect(ready.result.content[0].text).toBe("private-reply");
  expect(infrastructureReason({ name: "private-error", code: "private-token" })).toBe("unexpected");
});

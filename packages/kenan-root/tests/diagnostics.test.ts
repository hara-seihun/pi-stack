import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createRootExecutor, type RootConfig } from "../src/root-runtime.js";
import { rootService } from "../src/service.js";
import type { InfrastructureEvent } from "kenan-memory/diagnostics";

test("executor logs failing stage and bounded reason, never exception/private context", async () => {
  const root = mkdtempSync(join(tmpdir(), "root-diagnostics-"));
  const events: InfrastructureEvent[] = [];
  const config: RootConfig = { version: 1, provider: "fixture", model: "fixture", thinkingLevel: "off", cwd: root, agentDir: root, sessionsDir: join(root, "sessions"), promptFile: "unused", brokerUrl: "http://127.0.0.1:2480/" };
  mkdirSync(config.sessionsDir);
  const admission = { rootSessionId: randomUUID(), person: "private-person", threadId: "private-thread", recipients: ["private-person"], subjects: [], memoryToken: "private-token" };
  try {
    const report = (event: InfrastructureEvent) => events.push(event);
    const creating = createRootExecutor(config, { prompt: "private-policy", capacity: { mode: "unmanaged" }, report, factory: async () => { throw new Error("private-error-request-content"); } });
    expect((await creating(admission, "private-request")).ok).toBe(false);
    expect(events.at(-1)).toMatchObject({ stage: "create-session", outcome: "failed", reason: "unexpected" });
    const turning = createRootExecutor(config, { prompt: "private-policy", capacity: { mode: "unmanaged" }, report, factory: async () => ({ prompt: async () => { throw new DOMException("private-error", "TimeoutError"); }, reply: () => "private-reply", dispose() {} }) });
    expect((await turning({ ...admission, rootSessionId: randomUUID() }, "private-request")).ok).toBe(false);
    expect(events.at(-1)).toMatchObject({ stage: "model-turn", reason: "timeout" });
    const missing = createRootExecutor(config, { prompt: "private-policy", capacity: { mode: "unmanaged" }, report, factory: async () => ({ prompt: async () => {}, reply: () => undefined, dispose() {} }) });
    expect((await missing({ ...admission, rootSessionId: randomUUID() }, "private-request")).ok).toBe(false);
    expect(events.at(-1)).toMatchObject({ stage: "model-turn", reason: "no-reply" });
    expect(JSON.stringify(events)).not.toContain("private-");
  } finally { rmSync(root, { force: true, recursive: true }); }
});
test("root admission transport diagnostics do not echo credentials or requests", async () => {
  const events: InfrastructureEvent[] = [];
  const handle = rootService({ enabled: () => true, memoryUrl: "http://memory", memoryRootToken: "private-root-token", adminCapability: "a".repeat(64), sessionsDir: "/unused",
    report: event => events.push(event), executor: async () => { throw new Error("must not execute"); },
    transport: (async () => { throw Object.assign(new Error("private-error"), { code: "ECONNREFUSED" }); }) as typeof fetch });
  const response = await handle(new Request("http://root/v1/ask", { method: "POST", headers: { "x-kenan-memory-session": "private-person-token" }, body: '{"request":"private-request"}' }));
  expect(response.status).toBe(503);
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({ component: "root-service", stage: "admit", reason: "connection-refused" });
  expect(JSON.stringify(events)).not.toContain("private-");
});

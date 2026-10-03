import { test, expect } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { memoryExtension } from "../src/tools.js";
import { prepareMemoryEnvironment } from "../src/session.js";

test("custody outage does not gate person or room initialization/turns; only requested tools fail", async () => {
  const root = mkdtempSync(join(tmpdir(), "memory-outage-")); const path = join(root, "host.json"); writeFileSync(path, JSON.stringify({ oneKenan: true }));
  let calls = 0;
  const service = createServer((_req, response) => { calls++; response.writeHead(503, { "content-type": "application/json" }); response.end(JSON.stringify({ ok: false, error: "unavailable", message: "Custody is unavailable" })); });
  await new Promise<void>(resolve => service.listen(0, "127.0.0.1", resolve));
  try {
    for (const room of [false, true]) {
      const tools: any[] = [], handlers: any[] = []; let active = room ? ["request_user_input_async"] : ["read", "bash"];
      const env: NodeJS.ProcessEnv = { PI_STACK_HOST_CONFIG: path, PI_THREAD_ID: room ? "room" : "b", PI_KENAN_MEMORY_URL: `http://127.0.0.1:${(service.address() as { port: number }).port}`,
        ...(room ? { PI_REMOTE_ROOMS_RUNTIME: "1" } : {}) };
      const pi = { registerTool: (tool: unknown) => tools.push(tool), on: (...args: any[]) => handlers.push(args), getAllTools: () => tools, getActiveTools: () => active, setActiveTools: (names: string[]) => { active = names; } };
      const beforeCalls = calls;
      memoryExtension({ env, ask: async () => ({}) })(pi as any);
      expect(calls).toBe(beforeCalls);
      expect(tools.some(t => t.name === "ask_kenan")).toBe(true);
      const before = handlers.find(h => h[0] === "before_agent_start")[1];
      const result = await before({ systemPrompt: "ordinary-turn" });
      expect(result.systemPrompt).toStartWith("ordinary-turn");
      expect(calls).toBe(beforeCalls);
      if (!room) expect(active).toContain("bash");
      const ask = await tools.find(t => t.name === "ask_kenan").execute("ask", { request: "Cross-person question" });
      expect(ask.isError).toBe(true); expect(ask.details.memoryResult).toMatchObject({ ok: false, error: "unavailable" });
      expect(env.PI_KENAN_MEMORY_TOKEN).toBeUndefined();
      if (!room) {
        const read = await tools.find(t => t.name === "memory_read").execute("read", { ids: ["private-id"] });
        expect(read.isError).toBe(true); expect(read.details.memoryResult).toMatchObject({ ok: false, error: "unavailable" });
      }
      const afterFailure = calls;
      await before({ systemPrompt: "next-turn" }); expect(calls).toBe(afterFailure);
    }
  } finally { await new Promise<void>(resolve => service.close(() => resolve())); rmSync(root, { recursive: true, force: true }); }
});

test("capability transport/credential failure is typed and root has no person-mint fallback", async () => {
  const root = mkdtempSync(join(tmpdir(), "memory-auth-outage-")); const path = join(root, "host.json"); writeFileSync(path, JSON.stringify({ oneKenan: true }));
  try {
    const env = { PI_STACK_HOST_CONFIG: path, PI_THREAD_ID: "b", PI_KENAN_MEMORY_SUPERVISOR_TOKEN_FILE: join(root, "missing") };
    expect(await prepareMemoryEnvironment(env, "b")).toMatchObject({ ok: false, error: "unavailable" });
    const pi = { registerTool() {}, on() {} };
    expect(() => memoryExtension({ env: { PI_STACK_HOST_CONFIG: path, PI_THREAD_ID: "root", PI_KENAN_MEMORY_ROLE: "root" }, ask: async () => ({}) })(pi as any)).toThrow("admitted root capability");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

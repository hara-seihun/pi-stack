import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createServer } from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { openPiSession } from "../src/threads/pi-session.js";
import type { PiEvent } from "../src/threads/contracts.js";

it("adds remote reach without replacing local context/tools, and leaves off/person/raw paths unchanged", async () => {
  const root = mkdtempSync(join(tmpdir(), "converge-session-"));
  const host = join(root, "host.json");
  writeFileSync(join(root, "AGENTS.md"), "local memory fixture stays here");
  const credential = join(root, "supervisor-token");
  writeFileSync(credential, "fixture-supervisor-credential");
  const memory = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ ok: true, value: {
      person: "kenan", threadId: JSON.parse(body).threadId, token: "fixture-session-token",
    } }));
  });
  memory.listen(0, "127.0.0.1");
  await once(memory, "listening");
  const memoryUrl = `http://127.0.0.1:${(memory.address() as AddressInfo).port}`;
  try {
    for (const [name, enabled, person, raw, hasTool] of [
      ["on", true, "kenan", false, true], ["off", false, "kenan", false, false],
      ["other", true, "sybil", false, false], ["raw", true, "kenan", true, false],
    ] as const) {
      writeFileSync(host, JSON.stringify({ oneKenan: enabled }));
      const events: PiEvent[] = [];
      const session = await openPiSession({ cwd: root, args: raw ? ["--raw"] : [], threadId: name,
        sessionFile: join(root, `${name}.jsonl`), env: { PI_CODING_AGENT_DIR: join(root, "agent"),
          PI_OFFLINE: "1", PI_STACK_HOST_CONFIG: host, PI_REMOTE_SENDER_ID: person,
          PI_KENAN_MEMORY_URL: memoryUrl, PI_KENAN_MEMORY_SUPERVISOR_TOKEN_FILE: credential } }, event => events.push(event), () => {});
      try {
        await session.command({ type: "get_context", id: "context" });
        const context = events.find(event => event.type === "response" && event.id === "context")!.data as {
          systemPrompt: string; tools: { name: string }[];
        };
        const names = context.tools.map(tool => tool.name);
        expect(names.includes("converge")).toBe(hasTool);
        if (raw) expect(names).toEqual([]);
        else {
          expect(names).toEqual(expect.arrayContaining(["read", "write", "edit", "bash", "thread_send"]));
          expect(context.systemPrompt).toContain("local memory fixture stays here");
        }
      } finally { await session.close(); }
    }
  } finally { await new Promise<void>(resolve => memory.close(() => resolve())); rmSync(root, { recursive: true, force: true }); }
}, 5000);

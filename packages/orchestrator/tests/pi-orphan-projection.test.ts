import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { createAgentSessionRuntime, createAgentSessionServices, createAgentSessionFromServices, SessionManager, type CreateAgentSessionRuntimeFactory } from "@earendil-works/pi-coding-agent";
import type { Agent, AgentMessage } from "@earendil-works/pi-agent-core";
import { installOrphanReceiptProjection } from "../src/threads/pi-orphan-projection.js";

test("the cached SDK runtime factory installs historical projection on every replacement Agent without altering native messages", async () => {
  const directory = mkdtempSync(join(tmpdir(), "runtime-orphan-"));
  const agents: Agent[] = [];
  const factory: CreateAgentSessionRuntimeFactory = async ({ sessionManager, sessionStartEvent }) => {
    const services = await createAgentSessionServices({ cwd: directory, agentDir: join(directory, "agent"), resourceLoaderOptions: {
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    } });
    const created = await createAgentSessionFromServices({ services, sessionManager, sessionStartEvent, tools: [] });
    installOrphanReceiptProjection(created.session.agent);
    agents.push(created.session.agent);
    return { ...created, services, diagnostics: services.diagnostics };
  };
  const runtime = await createAgentSessionRuntime(factory, { cwd: directory, agentDir: join(directory, "agent"), sessionManager: SessionManager.inMemory(directory) });
  try {
    const receipt = { role: "toolResult", toolName: "fixture", toolCallId: "orphan-original", content: [{ type: "text", text: "already landed result" }], isError: true, timestamp: 1 } as AgentMessage;
    for (let index = 0; index < 3; index++) {
      if (index) await runtime.newSession();
      const agent = runtime.session.agent;
      const wrapper = agent.transformContext;
      installOrphanReceiptProjection(agent);
      expect(agent.transformContext).toBe(wrapper);
      const messages = [receipt];
      const before = JSON.stringify(messages);
      const projected = await agent.transformContext!(messages);
      expect(projected).toHaveLength(1);
      expect(projected[0]!.role).toBe("user");
      expect(JSON.stringify(projected)).toContain("already landed result");
      expect(JSON.stringify(projected)).toContain("not a new request to execute the tool");
      expect(JSON.stringify(messages)).toBe(before);
    }
    expect(new Set(agents).size).toBe(3);
  } finally { await runtime.dispose(); rmSync(directory, { recursive: true, force: true }); }
});

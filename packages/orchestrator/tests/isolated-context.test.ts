import { expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { isolatedPiContext } from "../src/host/isolated-context.js";
import type { PiSessionOptions } from "../src/threads/contracts.js";

it.each(["browser", "application"])("builds an isolated %s Pi context without mutating process state", async kind => {
  const processCwd = process.cwd();
  const processHome = process.env.HOME;
  const processRemoteSession = process.env.PI_REMOTE_SESSION_ID;
  const root = mkdtempSync(join(tmpdir(), "isolated-context-"));
  const cwd = join(root, "task");
  mkdirSync(join(cwd, ".pi/extensions"), { recursive: true });
  writeFileSync(join(root, "AGENTS.md"), "HOST CONTEXT MUST NOT LOAD");
  writeFileSync(join(cwd, ".pi/extensions/unrelated.ts"), "throw new Error('unrelated extension loaded')");
  const application = join(root, "application.mjs");
  writeFileSync(application, `export default pi => { for (const name of ['inspect_scene', 'unselected_tool']) pi.registerTool({ name, label: name, description: name, parameters: {type:'object',properties:{}}, execute: async () => ({content:[{type:'text',text:'frame'}],details:{}}) }); }`);
  const context = kind === "application"
    ? { tools: ["read", "write", "edit", "bash", "thread_await", "inspect_scene"], extensions: [application] }
    : { tools: ["read", "write", "edit", "bash", "agent_browser"] };
  const options: PiSessionOptions = {
    threadId: "isolated-thread",
    cwd,
    sessionFile: join(root, "session.jsonl"),
    args: ["--orchestrator-context", JSON.stringify(context)],
    env: {},
  };
  const environment: NodeJS.ProcessEnv = {
    HOME: "/host/home",
    PI_REMOTE_SESSION_ID: "unrelated-thread",
    OPENAI_API_KEY: "host-secret",
    PI_STACK_RUNTIME_DEST: fileURLToPath(new URL("../../runtime", import.meta.url)),
  };

  try {
    const isolated = await isolatedPiContext(options, environment);
    expect(isolated).toBeDefined();
    expect(isolated!.resourceLoader.getAgentsFiles().agentsFiles).toEqual([]);
    expect(isolated!.resourceLoader.getSkills().skills).toEqual([]);
    expect(isolated!.resourceLoader.getPrompts().prompts).toEqual([]);
    expect(isolated!.resourceLoader.getAppendSystemPrompt()).toEqual([]);
    expect(isolated!.tools).toEqual(context.tools);
    expect(isolated!.context).toEqual(context);
    expect(isolated!.environment.HOME).toBe(join(cwd, ".home"));
    expect(isolated!.environment.PI_CODING_AGENT_DIR).toBe(join(cwd, ".home/.pi/agent"));
    expect(isolated!.environment).toBe(environment);
    expect(environment.PI_REMOTE_SESSION_ID).toBeUndefined();
    expect(environment.OPENAI_API_KEY).toBeUndefined();
    expect(process.cwd()).toBe(processCwd);
    expect(process.env.HOME).toBe(processHome);
    expect(process.env.PI_REMOTE_SESSION_ID).toBe(processRemoteSession);

    if (kind === "application") {
      const registered = isolated!.resourceLoader.getExtensions().extensions.flatMap(extension => [...extension.tools.keys()]);
      expect(registered).toContain("unselected_tool");
      expect(isolated!.tools).not.toContain("unselected_tool");
      await expect(isolatedPiContext({ ...options, args: ["--orchestrator-context", JSON.stringify({ ...context, tools: ["missing_tool"] })] }, environment)).rejects.toThrow("not registered");
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

import { expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Store } from "../src/store.js";
import { isolatedContext } from "../src/host/isolated-context.js";
import { openHostedSession } from "../src/host/session-lifecycle.js";

it.each(['browser', 'application'])("persists the %s tool contract without discovering host context", async (kind) => {
  const originalCwd = process.cwd(), environment = { ...process.env };
  const root = mkdtempSync(join(tmpdir(), "isolated-context-")), cwd = join(root, "task");
  mkdirSync(join(cwd, ".pi/extensions"), { recursive: true });
  writeFileSync(join(root, "AGENTS.md"), "HOST CONTEXT MUST NOT LOAD");
  writeFileSync(join(cwd, ".pi/extensions/unrelated.ts"), "throw new Error('unrelated extension loaded')");
  const application = join(root, 'application.mjs');
  writeFileSync(application, `export default pi => { for (const name of ['inspect_scene', 'unselected_tool']) pi.registerTool({ name, label: name, description: name, parameters: {type:'object',properties:{}}, execute: async () => ({content:[{type:'text',text:'frame'}],details:{}}) }); }`);
  const context = kind === 'application'
    ? { tools: ['read', 'write', 'edit', 'bash', 'inspect_scene'], extensions: [application] }
    : { tools: ['read', 'write', 'edit', 'bash', 'agent_browser'] };
  const ledger = join(root, "ledger.sqlite3");
  const store = Store.open(ledger);
  const [id] = store.createRuns({ count: 1, source: "direct", prompt: "Task", cwd, profile: "standard", budget: "force", context });
  store.close();
  const reopened = Store.open(ledger), run = reopened.run(id!)!;
  reopened.close();
  expect(run.context).toEqual(context);
  process.env.PI_ORCHESTRATOR_LEDGER = ledger;
  process.env.PI_ORCHESTRATOR_ASSIGNED = "1";
  process.env.PI_STACK_RUNTIME_DEST = fileURLToPath(new URL("../../runtime", import.meta.url));
  process.env.PI_REMOTE_SESSION_ID = "unrelated-thread";
  let hosted: Awaited<ReturnType<typeof openHostedSession>> | undefined;
  try {
    const options = await isolatedContext(run, join(root, "sessions"));
    expect(options.resourceLoader.getAgentsFiles().agentsFiles).toEqual([]);
    expect(options.resourceLoader.getSkills().skills).toEqual([]);
    expect(options.resourceLoader.getPrompts().prompts).toEqual([]);
    expect(options.resourceLoader.getAppendSystemPrompt()).toEqual([]);
    expect(process.env.HOME).toBe(join(cwd, ".home"));
    expect(process.env.PI_REMOTE_SESSION_ID).toBeUndefined();
    hosted = await openHostedSession({ cwd, ...options });
    expect(hosted.session.getActiveToolNames().sort()).toEqual([...run.context!.tools].sort());
    expect(hosted.session.sessionManager.getSessionFile()).toMatch(join(root, "sessions"));
    expect(hosted.session.agent.state.systemPrompt).not.toContain("HOST CONTEXT MUST NOT LOAD");
    if (kind === 'application') {
      expect(hosted.session.getActiveToolNames()).not.toContain('agent_browser');
      expect(hosted.session.getActiveToolNames()).not.toContain('unselected_tool');
      await expect(isolatedContext({ ...run, context: { ...context, tools: ['missing_tool'] } }, join(root, 'sessions'))).rejects.toThrow('not registered');
    }
  } finally {
    hosted?.dispose();
    process.chdir(originalCwd);
    for (const key of Object.keys(process.env)) if (!(key in environment)) delete process.env[key];
    Object.assign(process.env, environment);
    rmSync(root, { recursive: true, force: true });
  }
});

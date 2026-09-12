import { DefaultResourceLoader, SettingsManager, SessionManager } from "@earendil-works/pi-coding-agent";
import { mkdir, realpath } from "node:fs/promises";
import { join } from "node:path";
import type { Run } from "../domain.js";
import { argument, type CoreSessionOptions } from "../cores/contracts.js";
import { isRunContext } from "../isolated-context-contract.js";
import routing from "../extension/routing.js";
import usageLogger from "../extension/usage-logger.js";
import outputLimitContinuation from "../extension/output-limit-continuation.js";

export async function isolatedCoreContext(options: CoreSessionOptions) {
  const raw = argument(options.args, "--orchestrator-context");
  if (raw === undefined) return undefined;
  const context: unknown = JSON.parse(raw);
  if (!isRunContext(context)) throw new Error("Invalid isolated core context");
  return isolatedContext({ cwd: options.cwd, context, sessionFile: argument(options.args, "--session") }, join(options.stateDir, "sessions"));
}

export async function isolatedContext(run: Pick<Run, "cwd" | "context" | "sessionFile">, sessionDirectory: string) {
  if (!run.context) throw new Error("Missing isolated run context");
  const home = join(run.cwd, ".home"), agentDir = join(home, ".pi/agent");
  await mkdir(agentDir, { recursive: true });
  await mkdir(join(home, ".tmp"), { recursive: true });
  process.chdir(run.cwd);
  process.env.HOME = home;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  process.env.TMPDIR = join(home, ".tmp");
  process.env.XDG_CONFIG_HOME = join(home, ".config");
  process.env.XDG_CACHE_HOME = join(home, ".cache");
  process.env.XDG_DATA_HOME = join(home, ".local/share");
  for (const key of Object.keys(process.env)) {
    if (/^(PI_REMOTE_|PI_SESSION_|AGENT_BROWSER_|SSH_|GIT_|GH_|GITHUB_|MCP_|PI_MCP_)/.test(key) || /(?:API_KEY|TOKEN|SECRET|PASSWORD)$/.test(key)) delete process.env[key];
  }
  const settingsManager = SettingsManager.inMemory();
  const runtime = process.env.PI_STACK_RUNTIME_DEST ?? "/srv/pi/runtime";
  const additionalExtensionPaths = await Promise.all((run.context.extensions ?? []).map(path => realpath(path)));
  if (run.context.tools.includes("bash")) additionalExtensionPaths.push(await realpath(join(runtime, "extensions/bash-timeout-guard/index.mjs")));
  if (run.context.tools.includes("agent_browser")) additionalExtensionPaths.push(await realpath(join(runtime, "extensions/browser/index.mjs")));
  const resourceLoader = new DefaultResourceLoader({
    cwd: run.cwd, agentDir, settingsManager,
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    systemPromptOverride: () => undefined, appendSystemPromptOverride: () => [],
    additionalExtensionPaths,
    extensionFactories: [routing, usageLogger, outputLimitContinuation],
  });
  await resourceLoader.reload();
  const { errors, extensions } = resourceLoader.getExtensions();
  if (errors.length) throw new Error(`Isolated context failed to load: ${JSON.stringify(errors)}`);
  const available = new Set(['read', 'write', 'edit', 'bash', 'grep', 'find', 'ls', ...extensions.flatMap(extension => [...extension.tools.keys()])]);
  const missing = run.context.tools.filter(name => !available.has(name));
  if (missing.length) throw new Error(`Isolated tools were not registered: ${missing.join(', ')}`);
  return {
    agentDir, settingsManager, resourceLoader, tools: [...run.context.tools],
    sessionManager: run.sessionFile ? SessionManager.open(run.sessionFile, undefined, run.cwd) : SessionManager.create(run.cwd, sessionDirectory),
  };
}

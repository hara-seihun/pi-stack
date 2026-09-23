import { DefaultResourceLoader, SettingsManager } from "@earendil-works/pi-coding-agent";
import { mkdir, realpath } from "node:fs/promises";
import { join } from "node:path";
import { isRunContext } from "../isolated-context-contract.js";
import routing from "../extension/routing.js";
import usageLogger from "../extension/usage-logger.js";
import outputLimitContinuation from "../extension/output-limit-continuation.js";
import type { PiSessionOptions } from "../threads/contracts.js";
import { threadSpeed } from "../threads/pi-speed.js";
import { argument } from "../threads/pi-session-file.js";

import { isolatePiEnvironment } from "../threads/pi-environment.js";

export async function isolatedPiContext(options: PiSessionOptions, environment: NodeJS.ProcessEnv) {
  const raw = argument(options.args, "--orchestrator-context");
  if (raw === undefined) return undefined;
  const context: unknown = JSON.parse(raw);
  if (!isRunContext(context)) throw new Error("Invalid isolated Pi context");

  const home = join(options.cwd, ".home");
  const agentDir = join(home, ".pi/agent");
  const tmpDir = join(home, ".tmp");
  await mkdir(agentDir, { recursive: true });
  await mkdir(tmpDir, { recursive: true });

  const scopedEnvironment = isolatePiEnvironment(options.cwd, environment);

  const settingsManager = SettingsManager.inMemory();
  const runtime = scopedEnvironment.PI_STACK_RUNTIME_DEST ?? "/srv/pi/runtime";
  const additionalExtensionPaths = await Promise.all((context.extensions ?? []).map(path => realpath(path)));
  if (context.tools.includes("bash")) additionalExtensionPaths.push(await realpath(join(runtime, "extensions/bash-timeout-guard/index.mjs")));
  if (context.tools.includes("agent_browser")) additionalExtensionPaths.push(await realpath(join(runtime, "extensions/browser/index.mjs")));
  const resourceLoader = new DefaultResourceLoader({
    cwd: options.cwd,
    agentDir,
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    systemPromptOverride: () => undefined,
    appendSystemPromptOverride: () => [],
    additionalExtensionPaths,
    extensionFactories: [routing, usageLogger, outputLimitContinuation, threadSpeed],
  });
  await resourceLoader.reload();
  const { errors, extensions } = resourceLoader.getExtensions();
  if (errors.length) throw new Error(`Isolated context failed to load: ${JSON.stringify(errors)}`);
  const available = new Set(["read", "write", "edit", "bash", "grep", "find", "ls", "thread_spawn", "thread_send", "thread_await", "thread_list", "thread_read", "thread_control", ...extensions.flatMap(extension => [...extension.tools.keys()])]);
  const missing = context.tools.filter(name => !available.has(name));
  if (missing.length) throw new Error(`Isolated tools were not registered: ${missing.join(", ")}`);

  return {
    agentDir,
    environment: scopedEnvironment,
    context,
    settingsManager,
    resourceLoader,
    tools: [...context.tools],
  };
}

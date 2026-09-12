import { AsyncLocalStorage } from "node:async_hooks";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createAgentSessionRuntime, createAgentSessionServices, createAgentSessionFromServices,
  createBashTool, convertToLlm, getAgentDir, getPackageDir, SessionManager, type AgentSessionRuntime, type CreateAgentSessionRuntimeFactory } from "@earendil-works/pi-coding-agent";
import { argument, type CoreOutput, type CoreSession } from "./contracts.js";
import type { OpenPiNative } from "./pi-types.js";
import { piChildTools } from "./pi-tools.js";
import { piIsolatedContext } from "./pi-isolated.js";
import { checkpointPiSession, preparePiSession, seedPiSession } from "./pi-transfer.js";
import { SESSION_RETRY } from "../host/session-lifecycle.js";

const scopeKey = Symbol.for("pi-stack.session-environment");
const globals = globalThis as typeof globalThis & { [scopeKey]?: AsyncLocalStorage<NodeJS.ProcessEnv> };
const scope = globals[scopeKey] ??= new AsyncLocalStorage<NodeJS.ProcessEnv>();
type SharedRpc = (runtime: AgentSessionRuntime, io: { output(event: CoreOutput): void; exit(code?: number): void }) => Promise<CoreSession>;

export const openPiNative: OpenPiNative = async (options, node, tools, output, exit) => {
  const env: NodeJS.ProcessEnv = { ...process.env, ...options.env, PI_STACK_CORE_OWNS_CHILDREN: "1",
    PI_STACK_CORE_ROOT_ID: options.sessionId, PI_STACK_CORE_AGENT_ID: node.id,
    PI_STACK_CORE_PARENT_ID: node.parentId ?? undefined };
  if (node.parentId) {
    env.PI_REMOTE_SESSION_ID = undefined;
    env.PI_REMOTE_CONTEXT_OWNER_PID = undefined;
    env.PI_REMOTE_MEETING_ID = undefined;
    env.PI_SUBAGENT_MODEL = undefined;
    env.PI_ORCHESTRATOR_ASSIGNED = undefined;
  }
  return scope.run(env, async () => {
    let generation = 0;
    let closing = false;
    const runs = new AsyncLocalStorage<number>();
    const extensions = options.args.flatMap((arg, index) => arg === "--extension" ? [resolve(options.cwd, options.args[index + 1])] : []);
    const agentDir = env.PI_CODING_AGENT_DIR ?? getAgentDir();
    if (!existsSync(node.sessionFile)) {
      if (node.nativeSessionId || !node.parentId && argument(options.args, "--session") && !options.transfer) {
        throw new Error(`Native Pi session is missing: ${node.sessionFile}`);
      }
      seedPiSession(node.sessionFile, node.cwd, node.parentId ? undefined : options.transfer);
    }
    let acceptedContext: { tools: string[]; extensions?: string[] } | undefined;
    const factory: CreateAgentSessionRuntimeFactory = async ({ cwd, sessionManager, sessionStartEvent }) => {
      preparePiSession(sessionManager);
      const isolated = await piIsolatedContext(options, cwd, sessionManager.getSessionFile()!, env, scope);
      const services = await createAgentSessionServices({ cwd, agentDir: isolated?.agentDir ?? agentDir,
        settingsManager: isolated?.settingsManager,
        resourceLoaderOptions: isolated ? {
          noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
          extensionsOverride: () => isolated.resourceLoader.getExtensions(),
        } : { additionalExtensionPaths: extensions,
          extensionFactories: [{ name: "pi-core-context", factory: pi => {
            pi.on("context", (event, ctx) => {
              const active = new Set(pi.getActiveTools());
              output({ type: "context_update", context: { systemPrompt: ctx.getSystemPrompt(),
                tools: pi.getAllTools().filter(tool => active.has(tool.name))
                  .map(({ name, description, parameters }) => ({ name, description, parameters })),
                messages: convertToLlm(event.messages) } });
            });
          } }],
        } });
      if (isolated) {
        services.resourceLoader = isolated.resourceLoader;
        acceptedContext = isolated.context;
      }
      const errors = services.resourceLoader.getExtensions().errors;
      if (errors.length) throw new Error(`Session extensions failed: ${JSON.stringify(errors)}`);
      const model = node.provider && node.model ? services.modelRuntime.getModel(node.provider, node.model) : undefined;
      if (node.provider && node.model && !model) throw new Error(`Model not found: ${node.provider}/${node.model}`);
      const bash = createBashTool(cwd, { spawnHook: context => ({ ...context, env: { ...context.env,
        ...Object.fromEntries(Object.entries(env).filter(([key]) => key.startsWith("PI_REMOTE_") || key.startsWith("PI_STACK_CORE_") || key === "PI_SUBAGENT_MODEL")),
        PI_SESSION_FILE: sessionManager.getSessionFile(), PI_REMOTE_CONTEXT_OWNER_PID: String(process.pid) } }) });
      const created = await createAgentSessionFromServices({ services, sessionManager, sessionStartEvent, model,
        thinkingLevel: node.thinkingLevel as never, tools: isolated?.tools,
        customTools: [bash, ...piChildTools(tools, node.id)] });
      const agentPrompt = created.session.agent.prompt.bind(created.session.agent);
      const agentContinue = created.session.agent.continue.bind(created.session.agent);
      const assertRun = () => {
        if (closing || runs.getStore() !== undefined && runs.getStore() !== generation) throw new Error("Pi operation was aborted");
      };
      const gated = <T extends Function>(call: T): T => new Proxy(call, {
        apply(target, receiver, args) { assertRun(); return Reflect.apply(target, receiver, args); },
      });
      created.session.agent.prompt = gated(agentPrompt);
      created.session.agent.continue = gated(agentContinue);
      const prompt = created.session.prompt.bind(created.session);
      created.session.prompt = async (...args) => runs.run(generation, async () => {
        let activity = false;
        const unsubscribe = created.session.subscribe(event => {
          if (event.type === "agent_start" || event.type === "agent_settled") activity = true;
        });
        try {
          await prompt(...args);
          if (!activity && !created.session.isStreaming && !closing && runs.getStore() === generation) output({ type: "agent_settled" });
        } finally { unsubscribe(); }
      });
      created.session.settingsManager.applyOverrides({ retry: { ...SESSION_RETRY } });
      return { ...created, services, diagnostics: services.diagnostics };
    };
    const runtime = await createAgentSessionRuntime(factory, { cwd: node.cwd, agentDir,
      sessionManager: SessionManager.open(node.sessionFile, undefined, node.cwd) });
    const snapshot = () => ({ name: runtime.session.sessionName ?? node.name, nativeSessionId: runtime.session.sessionId,
      sessionFile: runtime.session.sessionFile!, cwd: runtime.cwd,
      model: runtime.session.model?.provider === "unknown" ? undefined : runtime.session.model?.id,
      provider: runtime.session.model?.provider === "unknown" ? undefined : runtime.session.model?.provider,
      thinkingLevel: runtime.session.thinkingLevel,
      isStreaming: runtime.session.isStreaming, isCompacting: runtime.session.isCompacting,
      pendingMessageCount: runtime.session.pendingMessageCount, context: acceptedContext,
      messages: runtime.session.messages as unknown as Record<string, unknown>[],
      entries: runtime.session.sessionManager.getEntries() as unknown as Record<string, unknown>[] });
    runtime.setBeforeSessionInvalidate(() => { generation++; });
    let replacing = false;
    const replaced = async <T>(operation: () => Promise<T>): Promise<T> => {
      await tools.beforeReplace(node.id);
      const previous = runtime.session;
      replacing = true;
      try {
        const result = await operation();
        checkpointPiSession(runtime.session.sessionManager);
        if (runtime.session !== previous) {
          output({ type: "core_native_session" });
          output({ type: "conversation_replaced", messages: runtime.session.messages });
        }
        return result;
      } finally { replacing = false; }
    };
    const newSession = runtime.newSession.bind(runtime);
    const switchSession = runtime.switchSession.bind(runtime);
    const fork = runtime.fork.bind(runtime);
    runtime.newSession = (...args) => replaced(() => newSession(...args));
    runtime.switchSession = (...args) => replaced(() => switchSession(...args));
    runtime.fork = (...args) => replaced(() => fork(...args));
    const context = () => ({ systemPrompt: runtime.session.agent.state.systemPrompt,
      messages: runtime.session.messages,
      tools: runtime.session.agent.state.tools.map(({ name, description, parameters }) => ({ name, description, parameters })) });
    const dialogs = new Set<string>();
    try {
      runtime.session.setSessionName(node.name);
      const sdk = join(getPackageDir(), "dist");
      const { runSharedRpcMode } = await import(pathToFileURL(join(sdk, "modes/rpc/shared-rpc-mode.js")).href) as { runSharedRpcMode: SharedRpc };
      const rpc = await runSharedRpcMode(runtime, { exit, output: event => {
        if (event.type === "agent_settled" && (replacing || runs.getStore() !== undefined && runs.getStore() !== generation)) {
          output({ type: "core_run_cancelled" });
          return;
        }
        if (event.type === "extension_ui_request" && ["select", "confirm", "input", "editor"].includes(String(event.method))) dialogs.add(String(event.id));
        if (event.type === "message_end" || event.type === "agent_settled") checkpointPiSession(runtime.session.sessionManager);
        output(event);
      } });
      checkpointPiSession(runtime.session.sessionManager);
      return {
        snapshot,
        command: command => scope.run(env, async () => {
          if (command.type === "get_core_context") {
            output({ type: "response", id: command.id, command: command.type, success: true, data: context() });
            return;
          }
          if (command.type === "abort") {
            generation++;
            for (const id of dialogs) await rpc.command({ type: "extension_ui_response", id, cancelled: true });
            dialogs.clear();
          }
          if (command.type === "extension_ui_response") dialogs.delete(String(command.id));
          await rpc.command(command);
          checkpointPiSession(runtime.session.sessionManager);
        }),
        inject: (customType, data) => scope.run(env, () => runs.run(generation, () => runtime.session.sendCustomMessage({
          customType, content: JSON.stringify(data), display: true, details: data,
        }, { triggerTurn: true, deliverAs: "followUp" }))),
        close: () => scope.run(env, () => { closing = true; generation++; return rpc.close(); }),
      };
    } catch (error) {
      await runtime.dispose();
      throw error;
    }
  });
};

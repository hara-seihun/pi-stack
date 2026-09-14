import { AsyncLocalStorage } from "node:async_hooks";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createAgentSessionRuntime, createAgentSessionServices, createAgentSessionFromServices, createBashTool,
  convertToLlm, getAgentDir, getPackageDir, SessionManager, type AgentSessionRuntime, type CreateAgentSessionRuntimeFactory } from "@earendil-works/pi-coding-agent";
import type { OpenPiSession, PiCommand, PiEvent, PiSession } from "./contracts.js";
import { threadTools } from "./pi-tools.js";
import { argument, assertPiSessionFile, checkpointPiSession, preparePiSession, seedPiSession } from "./pi-session-file.js";
import { PiExecution } from "./pi-execution.js";
import { threadSpeed } from "./pi-speed.js";
import { PiCommandReceipts } from "./pi-command-receipts.js";
import { resolveSessionModel } from "../extension/routing.js";
import { isolatedPiContext } from "../host/isolated-context.js";

const scopeKey = Symbol.for("pi-stack.session-environment");
const globals = globalThis as typeof globalThis & { [scopeKey]?: AsyncLocalStorage<NodeJS.ProcessEnv> };
export const piEnvironmentScope = globals[scopeKey] ??= new AsyncLocalStorage<NodeJS.ProcessEnv>();
type SharedRpc = (runtime: AgentSessionRuntime, io: { output(event: PiEvent): void; exit(code?: number): void }) => Promise<PiSession>;
const inputCommands = new Set(["prompt", "steer", "follow_up"]);
const retry = { enabled: true, maxRetries: 6, baseDelayMs: 5_000 };

export const openPiSession: OpenPiSession = async (options, output, exit) => {
  const env: NodeJS.ProcessEnv = { ...process.env, ...options.env, PI_THREAD_ID: options.threadId };
  for (const key of Object.keys(env)) if (key.startsWith("PI_STACK_CORE_")) delete env[key];
  return piEnvironmentScope.run(env, async () => {
    const execution = new PiExecution();
    const extensions = options.args.flatMap((arg, index) => arg === "--extension" ? [resolve(options.cwd, options.args[index + 1])] : []);
    const agentDir = env.PI_CODING_AGENT_DIR ?? getAgentDir();
    if (options.args.includes("--orchestrator-context") && process.env.HOME !== join(options.cwd, ".home")) throw new Error("Isolated Pi sessions require their application runner environment");
    if (!existsSync(options.sessionFile)) {
      if (env.PI_THREAD_REQUIRE_SESSION === "1") throw new Error(`Native Pi session is missing: ${options.sessionFile}`);
      seedPiSession(options.sessionFile, options.cwd);
    }
    assertPiSessionFile(options.sessionFile);
    let acceptedContext: unknown;
    const factory: CreateAgentSessionRuntimeFactory = async ({ cwd, sessionManager, sessionStartEvent }) => {
      preparePiSession(sessionManager);
      const isolated = await isolatedPiContext({ ...options, cwd, sessionFile: sessionManager.getSessionFile()! }, env);
      const services = await createAgentSessionServices({ cwd, agentDir: isolated?.agentDir ?? agentDir,
        settingsManager: isolated?.settingsManager,
        resourceLoaderOptions: isolated ? {
          noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
          extensionsOverride: () => isolated.resourceLoader.getExtensions(),
        } : { additionalExtensionPaths: extensions,
          extensionFactories: [threadSpeed, { name: "thread-context", factory: pi => {
            pi.on("context", (event, ctx) => {
              const active = new Set(pi.getActiveTools());
              output({ type: "context_update", context: { systemPrompt: ctx.getSystemPrompt(),
                tools: pi.getAllTools().filter(tool => active.has(tool.name)).map(({ name, description, parameters }) => ({ name, description, parameters })),
                messages: convertToLlm(event.messages) } });
            });
          } }],
        } });
      if (isolated) { services.resourceLoader = isolated.resourceLoader; acceptedContext = JSON.parse(argument(options.args, "--orchestrator-context")!); }
      const errors = services.resourceLoader.getExtensions().errors;
      if (errors.length) throw new Error(`Session extensions failed: ${JSON.stringify(errors)}`);
      const initializationErrors = services.diagnostics.filter(diagnostic => diagnostic.type === "error");
      if (initializationErrors.length) throw new Error(`Pi session initialization failed: ${initializationErrors.map(diagnostic => diagnostic.message).join("; ")}`);
      const provider = argument(options.args, "--provider"), modelId = argument(options.args, "--model");
      const selection = provider && modelId ? resolveSessionModel(services.modelRuntime.getModels(), provider, modelId, env) : undefined;
      if (selection && !selection.ok) throw new Error(selection.error);
      const bash = createBashTool(cwd, { spawnHook: context => ({ ...context, env: { ...context.env, ...env,
        PI_SESSION_FILE: sessionManager.getSessionFile(), PI_REMOTE_CONTEXT_OWNER_PID: String(process.pid) } }) });
      const created = await createAgentSessionFromServices({ services, sessionManager, sessionStartEvent,
        model: selection?.ok ? selection.model : undefined, thinkingLevel: argument(options.args, "--thinking") as never,
        tools: isolated?.tools, customTools: [bash, ...threadTools({ ...options, cwd, env })] });
      execution.bind(created.session);
      const prompt = created.session.prompt.bind(created.session);
      created.session.prompt = async (...args) => {
        let activity = false;
        const unsubscribe = created.session.subscribe(event => { if (event.type === "agent_start" || event.type === "agent_settled") activity = true; });
        try {
          await prompt(...args);
          if (!activity && !created.session.isStreaming && !execution.blocked) settle();
        } finally { unsubscribe(); }
      };
      created.session.settingsManager.applyOverrides({ retry });
      return { ...created, services, diagnostics: services.diagnostics };
    };
    const runtime = await createAgentSessionRuntime(factory, { cwd: options.cwd, agentDir,
      sessionManager: SessionManager.open(options.sessionFile, undefined, options.cwd) });
    const commands = new PiCommandReceipts();
    const activeWork = new Set<string>();
    let executionStart: string | null = null;
    const pendingInputs = new Map<string, PiCommand>();
    const internalResponses = new Map<string, PiEvent | undefined>();
    const dialogs = new Set<string>();
    let replacing = false;
    let cancelling = false;
    let closed = false;
    let settlement: Promise<void> | undefined;
    function branch() { return runtime.session.sessionManager.getBranch(); }
    function receipts() {
      const acceptedWorkIds = new Set<string>(), completedWorkIds = new Set<string>();
      for (const entry of branch()) {
        if (entry.type !== "custom") continue;
        const data = entry.data as { workId?: string; workIds?: string[] } | undefined;
        if (entry.customType === "thread_input" && data?.workId) acceptedWorkIds.add(data.workId);
        if (entry.customType === "thread_rejected" && data?.workId) acceptedWorkIds.delete(data.workId);
        if (entry.customType === "thread_settled") for (const id of data?.workIds ?? []) completedWorkIds.add(id);
      }
      return { acceptedWorkIds: [...acceptedWorkIds], completedWorkIds: [...completedWorkIds] };
    }
    function lastAssistant() {
      const entries = branch();
      const settled = [...entries].reverse().find(entry => entry.type === "custom" && entry.customType === "thread_settled");
      const entryId = settled?.type === "custom" ? (settled.data as { assistantEntryId?: string | null }).assistantEntryId : undefined;
      const entry = entryId === null ? undefined : entryId ? entries.find(entry => entry.id === entryId)
        : [...entries].reverse().find(entry => entry.type === "message" && entry.message.role === "assistant");
      return entry?.type === "message" ? entry.message : null;
    }
    function settle(cancelled = false): Promise<void> {
      if (closed || replacing || cancelling && !cancelled) return Promise.resolve();
      if (settlement) return settlement;
      const current = execution.whenIdle().then(() => {
      if (closed || replacing) return;
      const entries = branch();
      const firstInput = entries.findIndex(entry => entry.id === executionStart);
      const final = entries.slice(firstInput < 0 ? entries.length : firstInput + 1).reverse().find(entry => entry.type === "message" && entry.message.role === "assistant");
      const message = final?.type === "message" ? final.message : null;
      const outcome = cancelled ? "cancelled" : message?.role === "assistant" && ["error", "aborted"].includes(message.stopReason) ? "failed" : "complete";
      const workIds = [...activeWork];
      if (workIds.length) runtime.session.sessionManager.appendCustomEntry("thread_settled", { workIds, outcome, assistantEntryId: final?.id ?? null });
      activeWork.clear();
      checkpointPiSession(runtime.session.sessionManager);
      if (settlement === current) settlement = undefined;
      output({ type: "agent_settled", workIds, outcome, lastAssistantMessage: message });
      }).finally(() => { if (settlement === current) settlement = undefined; });
      settlement = current;
      return current;
    }
    async function replace<T>(operation: () => Promise<T>): Promise<T> {
      if (execution.blocked) throw new Error("Local execution has not confirmed cancellation");
      replacing = true;
      try {
        await execution.cancel(runtime.session, 30_000);
        const result = await operation();
        preparePiSession(runtime.session.sessionManager);
        checkpointPiSession(runtime.session.sessionManager);
        activeWork.clear();
        commands.attach(runtime.session.sessionManager);
        output({ type: "session_changed", sessionFile: runtime.session.sessionFile, sessionId: runtime.session.sessionId, cwd: runtime.cwd });
        output({ type: "conversation_replaced", messages: runtime.session.messages });
        return result;
      } finally { replacing = false; }
    }
    const newSession = runtime.newSession.bind(runtime), switchSession = runtime.switchSession.bind(runtime), fork = runtime.fork.bind(runtime);
    runtime.newSession = (...args) => replace(() => newSession(...args));
    runtime.switchSession = (...args) => { assertPiSessionFile(args[0]); return replace(() => switchSession(...args)); };
    runtime.fork = (...args) => replace(() => fork(...args));
    try {
      const sdk = join(getPackageDir(), "dist");
      const { runSharedRpcMode } = await import(pathToFileURL(join(sdk, "modes/rpc/shared-rpc-mode.js")).href) as { runSharedRpcMode: SharedRpc };
      const rpc = await runSharedRpcMode(runtime, { exit, output: event => {
        if (event.type === "response") {
          if (internalResponses.has(String(event.id))) { internalResponses.set(String(event.id), event); return; }
          commands.finish(event, runtime.session.sessionManager);
          const input = pendingInputs.get(String(event.id));
          if (input) {
            pendingInputs.delete(String(event.id));
            if (event.success === false) {
              const workId = String(input.workId);
              runtime.session.sessionManager.appendCustomEntry("thread_rejected", { workId, error: event.error });
              activeWork.delete(workId);
              checkpointPiSession(runtime.session.sessionManager);
            }
          }
          if (event.command === "get_state" && event.success) event = { ...event, data: { ...event.data as object, ...receipts(),
            lastAssistantMessage: lastAssistant(), context: acceptedContext, localTools: execution.activeTools,
            isStreaming: runtime.session.isStreaming || execution.activePrompts > 0 || execution.activeTools > 0 || !!settlement,
            cancellationFailed: execution.blocked } };
        }
        if (event.type === "extension_ui_request" && ["select", "confirm", "input", "editor"].includes(String(event.method))) dialogs.add(String(event.id));
        if (event.type === "agent_settled") { settle(); return; }
        if (event.type === "message_end") checkpointPiSession(runtime.session.sessionManager);
        output(event);
      } });
      checkpointPiSession(runtime.session.sessionManager);
      return {
        command: command => piEnvironmentScope.run(env, async () => {
          const response = (success: boolean, error?: string, data?: unknown) => output({ type: "response", id: command.id, command: command.type, success, ...(error ? { error } : {}), ...(data === undefined ? {} : { data }) });
          if (closed) { response(false, "Pi session is closed"); return; }
          if (command.type === "get_context") {
            response(true, undefined, { systemPrompt: runtime.session.agent.state.systemPrompt, messages: runtime.session.messages,
              tools: runtime.session.agent.state.tools.map(({ name, description, parameters }) => ({ name, description, parameters })) });
            return;
          }
          if (command.type === "set_model") {
            const selection = resolveSessionModel(runtime.session.modelRuntime.getAvailableSnapshot(), String(command.provider), String(command.modelId), env);
            if (!selection.ok) { response(false, selection.error); return; }
            command = { ...command, provider: selection.model.provider };
          }
          if (inputCommands.has(command.type)) {
            if (execution.blocked || cancelling || replacing) { response(false, "Local execution has not confirmed cancellation"); return; }
            if (command.workId) {
              const workId = String(command.workId);
              const existing = receipts();
              if (existing.acceptedWorkIds.includes(workId)) {
                if (command.resume === true && !existing.completedWorkIds.includes(workId)) {
                  if (runtime.session.isStreaming || runtime.session.isCompacting || execution.activePrompts || execution.activeTools || settlement) { response(false, "Cannot resume active Pi execution"); return; }
                  const receipt = branch().find(entry => entry.type === "custom" && entry.customType === "thread_input" && (entry.data as { workId?: string }).workId === workId);
                  activeWork.add(workId);
                  runtime.session.sessionManager.appendCustomEntry("thread_resume", { workId });
                  executionStart = runtime.session.sessionManager.getLeafId();
                  checkpointPiSession(runtime.session.sessionManager);
                  response(true, undefined, { alreadyAccepted: true, resumed: true });
                  void execution.run(() => runtime.session.sendCustomMessage({ customType: "thread_recovery", display: true,
                    content: `Continue the interrupted accepted work below. Use the existing conversation and current state; do not repeat completed actions. This is recovery of the same work, not a new assignment.\n${JSON.stringify(receipt?.type === "custom" ? receipt.data : { workId })}`,
                    details: { workId },
                  }, { triggerTurn: true })).catch(error => { output({ type: "extension_error", error: String(error) }); settle(); });
                } else response(true, undefined, { alreadyAccepted: true, completed: existing.completedWorkIds.includes(workId) });
                return;
              }
              runtime.session.sessionManager.appendCustomEntry("thread_input", { workId, message: command.message, images: command.images, delivery: command.type });
              if (!activeWork.size) executionStart = runtime.session.sessionManager.getLeafId();
              activeWork.add(workId);
              checkpointPiSession(runtime.session.sessionManager);
              pendingInputs.set(String(command.id), command);
            }
          }
          if (command.type === "abort") {
            cancelling = true;
            try {
              for (const id of dialogs) await rpc.command({ type: "extension_ui_response", id, cancelled: true });
              dialogs.clear();
              await execution.cancel(runtime.session, Number(env.PI_THREAD_CANCEL_TIMEOUT_MS ?? 30_000));
              await settle(true);
              response(true);
            } catch (error) { response(false, String(error)); }
            finally { cancelling = false; }
            return;
          }
          if (command.type === "extension_ui_response") dialogs.delete(String(command.id));
          const admission = commands.begin(command, runtime.session.sessionManager);
          if (admission.kind === "error") { response(false, admission.message); return; }
          if (admission.kind === "replay") {
            if (admission.sessionFile !== runtime.session.sessionFile) {
              const id = `adopt:${command.id}`;
              internalResponses.set(id, undefined);
              try {
                await rpc.command({ type: "switch_session", id, sessionPath: admission.sessionFile });
                const adopted = internalResponses.get(id);
                if (!adopted?.success) throw new Error(String(adopted?.error ?? "Session adoption did not acknowledge"));
              } catch (error) { response(false, `Cannot adopt recorded command result: ${String(error)}`); return; }
              finally { internalResponses.delete(id); }
            }
            output({ ...admission.response, id: command.id });
            return;
          }
          await rpc.command(command);
          checkpointPiSession(runtime.session.sessionManager);
        }),
        close: () => piEnvironmentScope.run(env, async () => {
          if (closed) return;
          if (runtime.session.isStreaming || runtime.session.isCompacting || runtime.session.isBashRunning || execution.activeTools || execution.activePrompts || execution.blocked || settlement) throw new Error("Cannot close active Pi execution; stop and confirm cancellation first");
          await execution.cancel(runtime.session, Number(env.PI_THREAD_CANCEL_TIMEOUT_MS ?? 30_000));
          closed = true;
          execution.dispose();
          await rpc.close();
        }),
      };
    } catch (error) { await runtime.dispose(); throw error; }
  });
};

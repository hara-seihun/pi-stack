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
import { threadSpeed, updateThreadSpeed } from "./pi-speed.js";
import { PiCommandReceipts } from "./pi-command-receipts.js";
import { isRawSession, rawModelContext } from "./pi-raw.js";
import routing, { EXPLICIT_THREAD_MODEL_ENV, resolveSessionModel } from "../extension/routing.js";
import usageLogger from "../extension/usage-logger.js";
import { isolatedPiContext } from "../host/isolated-context.js";
import { piCwdAdmission, requirePiCwd } from "./pi-cwd.js";

const scopeKey = Symbol.for("pi-stack.session-environment");
const globals = globalThis as typeof globalThis & { [scopeKey]?: AsyncLocalStorage<NodeJS.ProcessEnv> };
export const piEnvironmentScope = globals[scopeKey] ??= new AsyncLocalStorage<NodeJS.ProcessEnv>();
type SharedRpc = (runtime: AgentSessionRuntime, io: { output(event: PiEvent): void; exit(code?: number): void }) => Promise<PiSession>;
const inputCommands = new Set(["prompt", "steer", "follow_up"]);
const retry = { enabled: true, maxRetries: 6, baseDelayMs: 5_000 };

export const openPiSession: OpenPiSession = async (options, output, exit) => {
  const admission = piCwdAdmission(options.env.PI_REMOTE_WORKSPACES);
  options = { ...options, cwd: requirePiCwd(admission, options.cwd, "thread.cwd") };
  const env: NodeJS.ProcessEnv = { ...process.env, ...options.env, PI_THREAD_ID: options.threadId,
    PI_THREAD_REQUIRE_SESSION: options.env.PI_THREAD_REQUIRE_SESSION === "1" ? "1" : "0",
    PI_THREAD_CAN_SPAWN: options.env.PI_THREAD_CAN_SPAWN === "0" ? "0" : "1" };
  for (const key of Object.keys(env)) if (key.startsWith("PI_STACK_CORE_") || key === EXPLICIT_THREAD_MODEL_ENV) delete env[key];
  if (argument(options.args, "--provider") && argument(options.args, "--model")) env[EXPLICIT_THREAD_MODEL_ENV] = "1";
  return piEnvironmentScope.run(env, async () => {
    const execution = new PiExecution(() => settle());
    const extensions = options.args.flatMap((arg, index) => arg === "--extension" ? [resolve(options.cwd, options.args[index + 1])] : []);
    const agentDir = env.PI_CODING_AGENT_DIR ?? getAgentDir();
    const raw = isRawSession(options.args);
    if (raw && options.args.includes("--orchestrator-context")) throw new Error("Raw Pi sessions cannot carry an isolated application context");
    if (options.args.includes("--orchestrator-context") && process.env.HOME !== join(options.cwd, ".home")) throw new Error("Isolated Pi sessions require their application runner environment");
    if (!existsSync(options.sessionFile)) {
      if (env.PI_THREAD_REQUIRE_SESSION === "1") throw new Error(`Native Pi session is missing: ${options.sessionFile}`);
      seedPiSession(options.sessionFile, options.cwd);
    }
    requirePiCwd(admission, assertPiSessionFile(options.sessionFile).cwd, "native header.cwd");
    let acceptedContext: unknown;
    const factory: CreateAgentSessionRuntimeFactory = async ({ cwd, sessionManager, sessionStartEvent }) => {
      cwd = requirePiCwd(admission, cwd, "runtime.cwd");
      preparePiSession(sessionManager);
      const isolated = await isolatedPiContext({ ...options, cwd, sessionFile: sessionManager.getSessionFile()! }, env);
      // Pi Remote's context-mirror extension owns context capture when it is loaded; a raw session loads no packages, so the runner reports.
      const contextOwner = !raw && env.PI_REMOTE_SESSION_ID && env.PI_REMOTE_SERVER_URL ? "remote-mirror" : "runner";
      // Like the mirror, the runner also reports each finished reply. The `context` event fires only before a
      // model call, so without this a raw thread's context never held its final answer: the transcript kept it
      // as live text and the supervisor's response metrics, keyed to that message, had nothing to attach to.
      const threadContext = { name: "thread-context", factory: (pi: Parameters<typeof threadSpeed>[0]) => {
        let reported: { systemPrompt: string; tools: unknown[]; messages: ReturnType<typeof convertToLlm> } | null = null;
        pi.on("context", (event, ctx) => {
          const active = new Set(pi.getActiveTools());
          reported = { systemPrompt: ctx.getSystemPrompt(),
            tools: pi.getAllTools().filter(tool => active.has(tool.name)).map(({ name, description, parameters }) => ({ name, description, parameters })),
            messages: convertToLlm(event.messages) };
          output({ type: "context_update", contextOwner, context: reported });
        });
        pi.on("message_end", event => {
          if (!reported || (event.message.role !== "assistant" && event.message.role !== "toolResult")) return;
          reported = { ...reported, messages: [...reported.messages, ...convertToLlm([event.message])] };
          output({ type: "context_update", contextOwner, context: reported });
        });
      } };
      const services = await createAgentSessionServices({ cwd, agentDir: isolated?.agentDir ?? agentDir,
        settingsManager: isolated?.settingsManager,
        resourceLoaderOptions: isolated ? {
          noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
          extensionsOverride: () => isolated.resourceLoader.getExtensions(),
        } : raw ? {
          // Raw: no packages, skills, prompt templates, AGENTS files or SYSTEM.md; only account routing,
          // usage evidence, service tier, the empty system prompt and context reporting for the owning controller.
          noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
          systemPromptOverride: () => undefined, appendSystemPromptOverride: () => [],
          extensionFactories: [routing, usageLogger, threadSpeed, rawModelContext, threadContext],
        } : { additionalExtensionPaths: extensions, extensionFactories: [threadSpeed, threadContext] } });
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
        tools: isolated?.tools ?? (raw ? [] : undefined), customTools: raw ? [] : [bash, ...threadTools({ ...options, cwd, env })] });
      execution.bind(created.session);
      created.session.agent.steeringMode = "all";
      created.session.settingsManager.applyOverrides({ retry });
      return { ...created, services, diagnostics: services.diagnostics };
    };
    const runtime = await createAgentSessionRuntime(factory, { cwd: options.cwd, agentDir,
      sessionManager: SessionManager.open(options.sessionFile, undefined, options.cwd) });
    const commands = new PiCommandReceipts();
    const activeWork = new Set<string>();
    let executionStart: string | null | undefined;
    const pendingInputs = new Map<string, PiCommand>();
    const internalResponses = new Map<string, PiEvent | undefined>();
    const dialogs = new Set<string>();
    const backgroundCommands = new Set<string>();
    let replacing = false;
    let closed = false;
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
    function settle(cancelled = false): void {
      if (closed || replacing && !cancelled || executionStart === undefined && !activeWork.size) return;
      if (execution.active || !runtime.session.isIdle || runtime.session.isBashRunning) return;
      if (!cancelled && (execution.blocked || runtime.session.getSteeringMessages().length || runtime.session.getFollowUpMessages().length)) return;
      const entries = branch();
      const firstInput = entries.findIndex(entry => entry.id === executionStart);
      const final = entries.slice(firstInput < 0 ? entries.length : firstInput + 1).reverse().find(entry => entry.type === "message" && entry.message.role === "assistant");
      const message = final?.type === "message" ? final.message : null;
      const outcome = cancelled ? "cancelled" : message?.role === "assistant" && ["error", "aborted"].includes(message.stopReason) ? "failed" : "complete";
      const workIds = [...activeWork];
      if (workIds.length) runtime.session.sessionManager.appendCustomEntry("thread_settled", { workIds, outcome, assistantEntryId: final?.id ?? null });
      checkpointPiSession(runtime.session.sessionManager);
      activeWork.clear();
      executionStart = undefined;
      output({ type: "agent_settled", workIds, outcome, lastAssistantMessage: message });
    }
    async function halt(): Promise<void> {
      const stopped = execution.halt(runtime.session, 20_000, () => settle(true));
      const dismissed = [...dialogs].map(id => rpc.command({ type: "extension_ui_response", id, cancelled: true }));
      dialogs.clear();
      await Promise.all([stopped, ...dismissed]);
    }
    async function replace<T>(operation: () => Promise<T>): Promise<T> {
      if (execution.blocked) throw new Error("Local execution has not confirmed cancellation");
      replacing = true;
      try {
        await halt();
        const result = await operation();
        preparePiSession(runtime.session.sessionManager);
        checkpointPiSession(runtime.session.sessionManager);
        commands.attach(runtime.session.sessionManager);
        output({ type: "session_changed", sessionFile: runtime.session.sessionFile, sessionId: runtime.session.sessionId, cwd: runtime.cwd });
        output({ type: "conversation_replaced", messages: runtime.session.messages });
        return result;
      } finally { replacing = false; }
    }
    const newSession = runtime.newSession.bind(runtime), switchSession = runtime.switchSession.bind(runtime), fork = runtime.fork.bind(runtime);
    runtime.newSession = (...args) => replace(() => newSession(...args));
    runtime.switchSession = (path, options) => {
      const header = assertPiSessionFile(path), cwdOverride = requirePiCwd(admission, options?.cwdOverride ?? header.cwd, "switch.cwd");
      return replace(() => switchSession(path, { ...options, cwdOverride }));
    };
    runtime.fork = (...args) => replace(() => fork(...args));
    const importFromJsonl = runtime.importFromJsonl.bind(runtime);
    runtime.importFromJsonl = (path, override) => {
      const cwd = requirePiCwd(admission, override ?? assertPiSessionFile(path).cwd, "import.cwd");
      return replace(() => importFromJsonl(path, cwd));
    };
    let rpc: PiSession;
    try {
      const sdk = join(getPackageDir(), "dist");
      const { runSharedRpcMode } = await import(pathToFileURL(join(sdk, "modes/rpc/shared-rpc-mode.js")).href) as { runSharedRpcMode: SharedRpc };
      rpc = await runSharedRpcMode(runtime, { exit, output: event => {
        if (event.type === "response") {
          if (internalResponses.has(String(event.id))) { internalResponses.set(String(event.id), event); return; }
          commands.finish(event, runtime.session.sessionManager);
          if (backgroundCommands.delete(String(event.id))) {
            output({ type: "compaction_end", commandId: event.id, success: event.success, error: event.error, result: event.data });
            output({ type: "command_settled", commandId: event.id, response: event });
            return;
          }
          const input = pendingInputs.get(String(event.id));
          if (input) {
            pendingInputs.delete(String(event.id));
            if (event.success === false) {
              const workId = String(input.workId);
              runtime.session.sessionManager.appendCustomEntry("thread_rejected", { workId, error: event.error });
              activeWork.delete(workId);
              if (!activeWork.size && runtime.session.isIdle) executionStart = undefined;
              checkpointPiSession(runtime.session.sessionManager);
            }
          }
          if (event.command === "get_state" && event.success) event = { ...event, data: { ...event.data as object, ...receipts(),
            lastAssistantMessage: lastAssistant(), context: acceptedContext, localTools: execution.activeTools, pendingCommandCount: backgroundCommands.size,
            isStreaming: !runtime.session.isIdle || execution.active || executionStart !== undefined,
            cancellationFailed: execution.blocked } };
        }
        if (event.type === "extension_ui_request" && ["select", "confirm", "input", "editor"].includes(String(event.method))) dialogs.add(String(event.id));
        if (event.type === "agent_start" && executionStart === undefined) executionStart = runtime.session.sessionManager.getLeafId();
        if (event.type === "agent_settled") { queueMicrotask(() => settle()); return; }
        if (event.type === "message_end") checkpointPiSession(runtime.session.sessionManager);
        output(event);
      } });
      checkpointPiSession(runtime.session.sessionManager);
      return {
        command: command => piEnvironmentScope.run(env, async () => {
          const response = (success: boolean, error?: string, data?: unknown) => output({ type: "response", id: command.id, command: command.type, success, ...(error ? { error } : {}), ...(data === undefined ? {} : { data }) });
          if (closed) { response(false, "Pi session is closed"); return; }
          if (command.type === "get_context") {
            response(true, undefined, { systemPrompt: raw ? "" : runtime.session.systemPrompt, messages: runtime.session.messages,
              tools: runtime.session.agent.state.tools.map(({ name, description, parameters }) => ({ name, description, parameters })) });
            return;
          }
          if (command.type === "set_model") {
            const selection = resolveSessionModel(runtime.session.modelRuntime.getModels(), String(command.provider), String(command.modelId), env);
            if (!selection.ok) { response(false, selection.error); return; }
            try { await runtime.session.setModel(selection.model); response(true, undefined, selection.model); }
            catch (error) { response(false, error instanceof Error ? error.message : String(error)); }
            checkpointPiSession(runtime.session.sessionManager);
            return;
          }
          if (command.type === "set_speed") {
            const updated = updateThreadSpeed(env, command.speed);
            if (!updated.ok) { response(false, updated.error); return; }
            response(true, undefined, { speed: updated.value });
            return;
          }
          if (inputCommands.has(command.type)) {
            if (execution.blocked || replacing) { response(false, "Local execution has not confirmed cancellation"); return; }
            if (command.workId) {
              const workId = String(command.workId);
              const existing = receipts();
              if (existing.acceptedWorkIds.includes(workId)) {
                if (command.resume === true && !existing.completedWorkIds.includes(workId)) {
                  if (!runtime.session.isIdle || execution.active || executionStart !== undefined) { response(false, "Cannot resume active Pi execution"); return; }
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
            }
            if (command.type === "prompt" && (execution.active || !runtime.session.isIdle || executionStart !== undefined) && !(command.streamingBehavior && runtime.session.isStreaming)) { response(false, "Cannot overlap active Pi execution"); return; }
            if (command.workId) {
              const workId = String(command.workId);
              runtime.session.sessionManager.appendCustomEntry("thread_input", { workId, message: command.message, images: command.images, delivery: command.type });
              if (command.type === "prompt" && executionStart === undefined) executionStart = runtime.session.sessionManager.getLeafId();
              activeWork.add(workId);
              checkpointPiSession(runtime.session.sessionManager);
              pendingInputs.set(String(command.id), command);
            }
          }
          if (["abort", "abort_bash", "abort_retry"].includes(command.type)) {
            try { await halt(); response(true); }
            catch (error) { response(false, String(error)); }
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
          if (command.type === "compact") {
            backgroundCommands.add(String(command.id));
            output({ type: "compaction_start", commandId: command.id });
            response(true, undefined, { accepted: true, commandId: command.id });
            void rpc.command(command).catch(error => {
              const event = { type: "response", id: command.id, command: command.type, success: false, error: String(error) };
              commands.finish(event, runtime.session.sessionManager);
              backgroundCommands.delete(String(command.id));
              output({ type: "compaction_end", commandId: command.id, success: false, error: String(error) });
              output({ type: "command_settled", commandId: command.id, response: event });
            });
          } else await rpc.command(command);
          checkpointPiSession(runtime.session.sessionManager);
        }),
        close: () => piEnvironmentScope.run(env, async () => {
          if (closed) return;
          if (backgroundCommands.size || !runtime.session.isIdle || runtime.session.isBashRunning || execution.active || execution.blocked) throw new Error("Cannot close active Pi execution; stop and confirm cancellation first");
          await halt();
          closed = true;
          execution.dispose();
          await rpc.close();
        }),
      };
    } catch (error) { await runtime.dispose(); throw error; }
  });
};

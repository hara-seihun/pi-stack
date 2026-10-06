import { AsyncLocalStorage } from "node:async_hooks";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ImageContent } from "@earendil-works/pi-ai";
import { assertNever, requireRuntimeEvent, requireAssistantStopReason } from "./runtime-events.js";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createAgentSessionRuntime, createAgentSessionServices, createAgentSessionFromServices, createBashTool,
  convertToLlm, getAgentDir, getPackageDir, SessionManager, type AgentSessionRuntime, type CreateAgentSessionRuntimeFactory } from "@earendil-works/pi-coding-agent";
import type { OpenPiSession, PiCommand, PiEvent, PiSession } from "./contracts.js";
import { threadTools } from "./pi-tools.js";
import { convergeTools } from "./converge.js";
import { argument, assertPiSessionFile, checkpointPiSession, preparePiSession, seedPiSession } from "./pi-session-file.js";
import { PiExecution } from "./pi-execution.js";
import { threadSpeed, updateThreadSpeed } from "./pi-speed.js";
import { scopedBashOperations } from "./pi-bash-resources.js";
import { loadConfig } from "../config.js";
import { modeEnvironment, modeTools } from "./pi-mode.js";
import { PiCommandReceipts } from "./pi-command-receipts.js";
import { inputReceipts } from "./pi-input-receipts.js";
import { isRawSession, rawModelContext, SANDBOX_ARGUMENT, SANDBOX_POLICY_ARGUMENT, type SandboxPolicy } from "./pi-raw.js";
import { createSandboxTools } from "./pi-sandbox.js";
import routing, { EXPLICIT_THREAD_MODEL_ENV, POOLED_ACCOUNT_WAIT, resolveSessionModel } from "../extension/routing.js";
import { isTransientFailure } from "../provider-errors.js";
import usageLogger from "../extension/usage-logger.js";
import { observeProviderRequests } from "../extension/provider-request-activity.js";
import { isolatedPiContext } from "../host/isolated-context.js";
import { piCwdAdmission, requirePiCwd } from "./pi-cwd.js";
import { memoryExtension } from "kenan-memory/tools";
import { oneKenanEnabled } from "kenan-memory/config";
import { isRoomSession, assertRoomTools, ROOM_TOOLS, roomSessionInstructions } from "./room-session.js";
import { createThreadClient } from "./http.js";
import { createExecutionActivity, executionActivitySnapshot, observeExecutionActivity, settleExecutionActivity } from "./execution-activity.js";

const scopeKey = Symbol.for("pi-stack.session-environment");
const globals = globalThis as typeof globalThis & { [scopeKey]?: AsyncLocalStorage<NodeJS.ProcessEnv> };
export const piEnvironmentScope = globals[scopeKey] ??= new AsyncLocalStorage<NodeJS.ProcessEnv>();
type SharedRpc = (runtime: AgentSessionRuntime, io: { output(event: PiEvent): void; exit(code?: number): void }) => Promise<PiSession>;
const inputCommands = new Set(["prompt", "steer", "follow_up"]);
const retry = { enabled: true, maxRetries: 6, baseDelayMs: 5_000 };

export function assistantWorkOutcome(stopReason: unknown): "complete" | "failed" {
  const reason = requireAssistantStopReason(stopReason);
  switch (reason) {
    case "stop": case "length": case "toolUse": return "complete";
    case "error": case "aborted": case "pending": case "deferred": return "failed";
  }
  return assertNever(reason);
}

export const openPiSession: OpenPiSession = async (options, emitOutput, exit) => {
  const activity = createExecutionActivity();
  const liveTools = new Map<string, Record<string, unknown>>();
  const output = (input: PiEvent) => {
    let event = requireRuntimeEvent(input);
    if (typeof event.emittedAt !== "number") event.emittedAt = Date.now();
    observeExecutionActivity(activity, event);
    if (event.type === "tool_execution_start" || event.type === "tool_execution_update") {
      const id = String(event.toolCallId);
      liveTools.set(id, { ...liveTools.get(id), toolCallId: id, toolName: event.toolName,
        ...(event.type === "tool_execution_start" ? { args: event.args } : { output: event.partialResult }) });
    }
    for (const id of liveTools.keys()) if (!activity.activityTools.has(id)) liveTools.delete(id);
    if (event.type === "response" && event.command === "get_state" && event.success) {
      const data = event.data as Record<string, any>;
      event = { ...event, data: { ...data, live: { ...data?.live, ...executionActivitySnapshot(activity),
        isThinking: activity.activity === "thinking", tools: [...liveTools.values()] } } };
    }
    emitOutput(event);
  };
  const admission = piCwdAdmission(options.env.PI_REMOTE_WORKSPACES);
  options = { ...options, cwd: requirePiCwd(admission, options.cwd, "thread.cwd") };
  const env: NodeJS.ProcessEnv = { ...process.env, ...options.env, PI_THREAD_ID: options.threadId,
    PI_THREAD_REQUIRE_SESSION: options.env.PI_THREAD_REQUIRE_SESSION === "1" ? "1" : "0",
    PI_THREAD_CAN_SPAWN: options.env.PI_THREAD_CAN_SPAWN === "0" ? "0" : "1",
    PI_THREAD_RESOURCE_BOUNDARY: process.env.PI_THREAD_RESOURCE_BOUNDARY };
  // A shared runner inherits its first session's launch environment. Account
  // custody belongs to this open, not to whichever session started the runner.
  for (const key of ["PI_ORCHESTRATOR_ASSIGNED", "PI_ORCHESTRATOR_ACCOUNT_ID", "PI_ORCHESTRATOR_RUN_ID", "PI_ORCHESTRATOR_PROVIDER", "PI_SUBAGENT_MODEL"])
    if (options.env[key] === undefined) delete env[key];
  for (const key of Object.keys(env)) if (key.startsWith("PI_STACK_CORE_") || key === EXPLICIT_THREAD_MODEL_ENV) delete env[key];
  delete env.PI_KENAN_MEMORY_PERSON;
  delete env.PI_KENAN_MEMORY_TOKEN;
  delete env.PI_KENAN_MEMORY_ROLE;
  if (options.env.PI_REMOTE_ROOM_ID === undefined) delete env.PI_REMOTE_ROOM_ID;
  if (options.env.PI_REMOTE_ROOMS_RUNTIME === undefined) delete env.PI_REMOTE_ROOMS_RUNTIME;
  const room = isRoomSession(env, options.threadId);
  if (room && !oneKenanEnabled(env)) throw new Error("Room execution requires the oneKenan host flag");
  const memoryEligible = !isRawSession(options.args) && !options.args.includes(SANDBOX_ARGUMENT) && !options.args.includes("--orchestrator-context");
  modeEnvironment(env);
  if (argument(options.args, "--provider") && argument(options.args, "--model")) env[EXPLICIT_THREAD_MODEL_ENV] = "1";
  return piEnvironmentScope.run(env, async () => {
    const execution = new PiExecution(() => settle());
    const inputWork = new AsyncLocalStorage<string>();
    const workMessages = new WeakMap<object, string>();
    const extensions = options.args.flatMap((arg, index) => arg === "--extension" ? [resolve(options.cwd, options.args[index + 1])] : []);
    const agentDir = env.PI_CODING_AGENT_DIR ?? getAgentDir();
    const raw = isRawSession(options.args);
    const sandbox = options.args.includes(SANDBOX_ARGUMENT);
    const policyArgument = argument(options.args, SANDBOX_POLICY_ARGUMENT);
    const sandboxTools = sandbox ? await createSandboxTools(options.cwd,
      policyArgument ? JSON.parse(policyArgument) as SandboxPolicy : { profile: "public" }) : undefined;
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
      if (sandbox && cwd !== options.cwd) throw new Error("Sandbox sessions cannot switch workspaces");
      preparePiSession(sessionManager);
      const memoryFactories = memoryEligible ? [memoryExtension({ env, ask: async (id, question, suggestions) => {
        const api = options.threads ?? createThreadClient(env.PI_THREAD_API_URL!, fetch, { token: env.PI_THREAD_TOKEN });
        const result = await api.ask({ threadId: options.threadId, requestId: `${options.threadId}:${id}`, questions: [{ question, suggestions }] });
        if (!result.ok) throw new Error(`Cannot ask which forget mode: ${JSON.stringify(result)}`);
        return result.value;
      } })] : [];
      const isolated = await isolatedPiContext({ ...options, cwd, sessionFile: sessionManager.getSessionFile()! }, env);
      // Pi Remote's context-mirror extension owns context capture when it is loaded; a raw session loads no packages, so the runner reports.
      const contextOwner = !room && !raw && env.PI_REMOTE_SESSION_ID && env.PI_REMOTE_SERVER_URL ? "remote-mirror" : "runner";
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
        resourceLoaderOptions: room ? {
          noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
          systemPromptOverride: () => undefined, appendSystemPromptOverride: () => [],
          extensionFactories: [routing, usageLogger, threadSpeed, threadContext, ...memoryFactories, roomSessionInstructions(env)],
        } : isolated ? {
          noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
          extensionsOverride: () => isolated.resourceLoader.getExtensions(),
        } : raw ? {
          // Raw: no packages, skills, prompt templates, AGENTS files or SYSTEM.md; only account routing,
          // usage evidence, service tier, the empty system prompt and context reporting for the owning controller.
          noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
          systemPromptOverride: () => undefined, appendSystemPromptOverride: () => [],
          extensionFactories: [routing, usageLogger, threadSpeed, rawModelContext, threadContext],
        } : { additionalExtensionPaths: extensions, extensionFactories: [threadSpeed, threadContext, modeTools(env), ...memoryFactories] } });
      if (isolated) { services.resourceLoader = isolated.resourceLoader; acceptedContext = JSON.parse(argument(options.args, "--orchestrator-context")!); }
      const errors = services.resourceLoader.getExtensions().errors;
      if (errors.length) throw new Error(`Session extensions failed: ${JSON.stringify(errors)}`);
      const initializationErrors = services.diagnostics.filter(diagnostic => diagnostic.type === "error");
      if (initializationErrors.length) throw new Error(`Pi session initialization failed: ${initializationErrors.map(diagnostic => diagnostic.message).join("; ")}`);
      const provider = argument(options.args, "--provider"), modelId = argument(options.args, "--model");
      const selection = provider && modelId ? await resolveSessionModel(services.modelRuntime.getModels(), provider, modelId, env) : undefined;
      if (selection && !selection.ok) throw new Error(selection.error);
      const bash = createBashTool(cwd, { operations: scopedBashOperations(env), spawnHook: context => ({ ...context, env: { ...context.env, ...env,
        PI_SESSION_FILE: sessionManager.getSessionFile(), PI_REMOTE_CONTEXT_OWNER_PID: String(process.pid) } }) });
      const created = await createAgentSessionFromServices({ services, sessionManager, sessionStartEvent,
        model: selection?.ok ? selection.model : undefined, thinkingLevel: argument(options.args, "--thinking") as never,
        tools: room ? ROOM_TOOLS : sandboxTools?.map(tool => tool.name) ?? isolated?.tools ?? (raw ? [] : undefined),
        customTools: room ? threadTools({ ...options, cwd, env }).filter(tool => tool.name === "request_user_input_async")
          : sandboxTools ?? (raw ? [] : [bash, ...threadTools({ ...options, cwd, env }), ...(isolated ? [] : convergeTools(env))]) });
      if (room) assertRoomTools(created.session.agent.state.tools.map(tool => tool.name));
      observeProviderRequests(created.session, output);
      execution.bind(created.session);
      const session = created.session, agent = session.agent;
      const prompt = session.prompt.bind(session);
      const promptWork = new WeakMap<object, string>();
      session.prompt = (text, options) => {
        const workId = (options && promptWork.get(options)) ?? inputWork.getStore();
        if (!workId) return prompt(text, options);
        if (options) promptWork.set(options, workId);
        return inputWork.run(workId, () => prompt(text, options));
      };
      const remember = (message: { role: string }) => {
        const workId = inputWork.getStore();
        if (workId && message.role === "user") workMessages.set(message, workId);
      };
      const agentPrompt = agent.prompt.bind(agent) as typeof agent.prompt;
      agent.prompt = (input: string | AgentMessage | AgentMessage[], images?: ImageContent[]) => {
        if (typeof input !== "string") for (const message of Array.isArray(input) ? input : [input]) remember(message);
        return typeof input === "string" ? agentPrompt(input, images) : agentPrompt(input);
      };
      for (const name of ["steer", "followUp"] as const) {
        const enqueue = agent[name].bind(agent);
        agent[name] = message => { remember(message); enqueue(message); };
      }
      created.session.agent.steeringMode = "all";
      created.session.settingsManager.applyOverrides({ retry });
      return { ...created, services, diagnostics: services.diagnostics };
    };
    const runtime = await createAgentSessionRuntime(factory, { cwd: options.cwd, agentDir,
      sessionManager: SessionManager.open(options.sessionFile, undefined, options.cwd) });
    const commands = new PiCommandReceipts();
    const activeWork = new Set<string>();
    let executionStart: string | null | undefined;
    // Accepted inputs awaiting Pi's acknowledgement. Each is dispatched only after the previous one is acknowledged,
    // so two inputs to an idle session cannot both pass Pi's streaming check and start overlapping runs.
    const pendingInputs = new Map<string, { command: PiCommand; acknowledge(): void }>();
    let inputTail = Promise.resolve();
    function acknowledge(id: string) {
      const input = pendingInputs.get(id);
      if (input) { pendingInputs.delete(id); input.acknowledge(); }
      return input?.command;
    }
    const internalResponses = new Map<string, PiEvent | undefined>();
    const dialogs = new Set<string>();
    const backgroundCommands = new Set<string>();
    let replacing = false;
    let closed = false;
    function branch() { return runtime.session.sessionManager.getBranch(); }
    function receipts() { return inputReceipts(branch()); }
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
      // An unacknowledged input may still start a run (Pi defers prompts made while it emits agent_settled); its response re-checks.
      if (!cancelled && (pendingInputs.size || execution.blocked)) return;
      if (!cancelled && runtime.session.agent.hasQueuedMessages()) {
        // Pi consumes queued steering only inside a live run. A run that ended on a terminal error (for example a
        // fenced compaction) leaves the queue stranded, and settlement would wait on it forever. Run it now.
        void execution.run(() => runtime.session.agent.continue()).catch(error => { output({ type: "extension_error", error: String(error) }); });
        return;
      }
      // Display copies of queue entries whose run already consumed or discarded them are not pending work.
      if (runtime.session.pendingMessageCount) runtime.session.clearQueue();
      const entries = branch();
      const firstInput = entries.findIndex(entry => entry.id === executionStart);
      const final = entries.slice(firstInput < 0 ? entries.length : firstInput + 1).reverse().find(entry => entry.type === "message" && entry.message.role === "assistant");
      const message = final?.type === "message" ? final.message : null;
      const outcome = cancelled ? "cancelled" : message?.role === "assistant" ? assistantWorkOutcome(message.stopReason) : "complete";
      const landed = new Set(receipts().landedWorkIds);
      const deferredWorkIds = cancelled ? [...activeWork].filter(id => !landed.has(id)) : [];
      const workIds = [...activeWork].filter(id => !deferredWorkIds.includes(id));
      if (deferredWorkIds.length) runtime.session.sessionManager.appendCustomEntry("thread_deferred", { workIds: deferredWorkIds });
      if (workIds.length) runtime.session.sessionManager.appendCustomEntry("thread_settled", { workIds, outcome, assistantEntryId: final?.id ?? null });
      checkpointPiSession(runtime.session.sessionManager);
      activeWork.clear();
      executionStart = undefined;
      // Cancellation discards Pi's deferred inputs without a response; release their dispatch order with the receipt.
      for (const id of [...pendingInputs.keys()]) acknowledge(id);
      output({ type: "agent_settled", workIds, deferredWorkIds, outcome, lastAssistantMessage: message });
      settleExecutionActivity(activity);
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
    // Settlement is event driven; this re-evaluates it so that no missed or misordered event can leave work open.
    const reconcile = setInterval(() => settle(), 30_000);
    reconcile.unref();
    let rpc: PiSession;
    try {
      const sdk = join(getPackageDir(), "dist");
      const { runSharedRpcMode } = await import(pathToFileURL(join(sdk, "modes/rpc/shared-rpc-mode.js")).href) as { runSharedRpcMode: SharedRpc };
      rpc = await runSharedRpcMode(runtime, { exit, output: event => {
        event = requireRuntimeEvent(event);
        if (event.type === "response") {
          if (internalResponses.has(String(event.id))) { internalResponses.set(String(event.id), event); return; }
          commands.finish(event, runtime.session.sessionManager);
          if (backgroundCommands.delete(String(event.id))) {
            output({ type: "compaction_end", commandId: event.id, success: event.success, error: event.error, result: event.data });
            output({ type: "command_settled", commandId: event.id, response: event });
            return;
          }
          const input = acknowledge(String(event.id));
          if (input) {
            queueMicrotask(() => settle());
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
            isStreaming: !runtime.session.isIdle || execution.active || executionStart !== undefined || pendingInputs.size > 0,
            cancellationFailed: execution.blocked } };
        }
        if (event.type === "extension_ui_request" && ["select", "confirm", "input", "editor"].includes(String(event.method))) dialogs.add(String(event.id));
        if (event.type === "agent_start" && executionStart === undefined) executionStart = runtime.session.sessionManager.getLeafId();
        if (event.type === "agent_settled") { queueMicrotask(() => settle()); return; }
        if (event.type === "message_start" && (event.message as { role?: string })?.role === "user") {
          const workId = workMessages.get(event.message as object);
          if (workId) {
            runtime.session.sessionManager.appendCustomEntry("thread_landed", { workId });
            checkpointPiSession(runtime.session.sessionManager);
            event = { ...event, inputWorkId: workId };
          }
        }
        if (event.type === "message_end") checkpointPiSession(runtime.session.sessionManager);
        output(event);
      } });
      checkpointPiSession(runtime.session.sessionManager);
      return {
        command: command => piEnvironmentScope.run(env, async () => {
          const response = (success: boolean, error?: string, data?: unknown) => output({ type: "response", id: command.id, command: command.type, success, ...(error ? { error } : {}), ...(data === undefined ? {} : { data }) });
          if (closed) { response(false, "Pi session is closed"); return; }
          if (sandbox && ["bash", "switch_session", "new_session", "fork", "import_from_jsonl"].includes(command.type)) {
            response(false, "Sandbox sessions use only their confined tools and workspace"); return;
          }
          if (command.type === "get_context") {
            response(true, undefined, { systemPrompt: raw ? "" : runtime.session.systemPrompt, messages: runtime.session.messages,
              tools: runtime.session.agent.state.tools.map(({ name, description, parameters }) => ({ name, description, parameters })) });
            return;
          }
          if (command.type === "set_model") {
            const selection = await resolveSessionModel(runtime.session.modelRuntime.getModels(), String(command.provider), String(command.modelId), env);
            if (!selection.ok) { response(false, selection.error); return; }
            try { await runtime.session.setModel(selection.model); response(true, undefined, selection.model); }
            catch (error) { response(false, error instanceof Error ? error.message : String(error)); }
            checkpointPiSession(runtime.session.sessionManager);
            return;
          }
          if (command.type === "set_speed") {
            const candidateEnv = { ...env };
            const updated = updateThreadSpeed(candidateEnv, command.speed, runtime.session.model);
            if (!updated.ok) { response(false, updated.error); return; }
            if ((env.PI_THREAD_SPEED === "ultrafast") !== (updated.value === "ultrafast") && loadConfig(undefined, undefined, env).ultrafastModelBrokerUrl) {
              response(false, "Changing the Ultrafast broker route requires the next execution; the active request keeps its admitted route.");
              return;
            }
            if (updated.value === "ultrafast" && runtime.session.model) {
              const current = runtime.session.model;
              const selection = await resolveSessionModel(runtime.session.modelRuntime.getModels(), current.provider.replace(/-\d+$/, ""), current.id, candidateEnv);
              if (!selection.ok) { response(false, selection.error); return; }
              if (selection.model.provider !== current.provider) {
                try { await runtime.session.setModel(selection.model); }
                catch (error) { response(false, error instanceof Error ? error.message : String(error)); return; }
              }
            }
            env.PI_THREAD_SPEED = updated.value;
            response(true, undefined, { speed: updated.value });
            return;
          }
          if (inputCommands.has(command.type)) {
            if (execution.blocked || replacing) { response(false, "Local execution has not confirmed cancellation"); return; }
            if (command.workId) {
              const workId = String(command.workId);
              const existing = receipts();
              const redelivery = existing.deferredWorkIds.includes(workId) || existing.acceptedWorkIds.includes(workId)
                && !existing.landedWorkIds.includes(workId) && !existing.completedWorkIds.includes(workId) && !activeWork.has(workId);
              if (redelivery) {
                const receipt = [...branch()].reverse().find(entry => entry.type === "custom" && entry.customType === "thread_input" && (entry.data as { workId?: string }).workId === workId);
                if (receipt?.type === "custom") {
                  const original = receipt.data as { message: string; images?: unknown };
                  command = { ...command, message: original.message, images: original.images };
                }
              }
              if (existing.acceptedWorkIds.includes(workId) && !redelivery) {
                const settled = [...branch()].reverse().find(entry => entry.type === "custom" && entry.customType === "thread_settled" && (entry.data as {workIds?:string[]}).workIds?.includes(workId));
                const last = lastAssistant();
                const capacityResume = command.resumeProviderWait === true && settled?.type === "custom"
                  && (settled.data as {outcome?:string}).outcome === "failed" && last?.role === "assistant" && last.stopReason === "error"
                  && (isTransientFailure(last.errorMessage ?? "") || last.errorMessage?.startsWith(POOLED_ACCOUNT_WAIT));
                if (command.resumeProviderWait === true && existing.completedWorkIds.includes(workId) && !capacityResume) {
                  response(false, "Cannot resume completed work without a provider capacity failure"); return;
                }
                if (command.resume === true && (!existing.completedWorkIds.includes(workId) || capacityResume)) {
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
              const original = branch().some(entry => entry.type === "custom" && entry.customType === "thread_input" && (entry.data as { workId?: string }).workId === workId);
              runtime.session.sessionManager.appendCustomEntry(original ? "thread_redelivery" : "thread_input", original ? { workId }
                : { workId, message: command.message, images: command.images, delivery: command.type, receiptVersion: 2 });
              if (executionStart === undefined) executionStart = runtime.session.sessionManager.getLeafId();
              activeWork.add(workId);
              checkpointPiSession(runtime.session.sessionManager);
              const prior = inputTail;
              inputTail = new Promise(resolve => pendingInputs.set(String(command.id), { command, acknowledge: resolve }));
              await prior;
              // A cancelled settlement already recorded this input; it must not start a run after admission reopens.
              if (!pendingInputs.has(String(command.id))) { response(false, "Pi execution has been cancelled"); return; }
            }
            // Pi's steer/follow_up only enqueue: after the run has settled nothing consumes them, and the message is
            // stranded while the queue reports busy forever. The controller cannot see settlement atomically with its
            // dispatch, so Pi decides after input handling: queue into a live run, otherwise start a turn with it.
            if (command.type !== "prompt") command = { ...command, type: "prompt", streamingBehavior: command.type === "steer" ? "steer" : "followUp" };
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
          if (admission.kind !== "execute") return assertNever(admission);
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
          } else if (inputCommands.has(command.type) && command.workId) await inputWork.run(String(command.workId), () => rpc.command(command));
          else await rpc.command(command);
          checkpointPiSession(runtime.session.sessionManager);
        }),
        close: () => piEnvironmentScope.run(env, async () => {
          if (closed) return;
          if (backgroundCommands.size || !runtime.session.isIdle || runtime.session.isBashRunning || execution.active || execution.blocked) throw new Error("Cannot close active Pi execution; stop and confirm cancellation first");
          await halt();
          closed = true;
          clearInterval(reconcile);
          execution.dispose();
          await rpc.close();
        }),
      };
    } catch (error) { clearInterval(reconcile); await runtime.dispose(); throw error; }
  });
};

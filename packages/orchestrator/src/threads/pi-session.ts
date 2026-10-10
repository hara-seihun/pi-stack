import { assertNever, requireRuntimeEvent, requireAssistantStopReason } from "./runtime-events.js";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createAgentSessionRuntime, createBashTool,
  getAgentDir, getPackageDir, SessionManager, type AgentSessionRuntime, type CreateAgentSessionRuntimeFactory } from "@earendil-works/pi-coding-agent";
import { CONTEXT_WINDOW_MAX_BYTES, type OpenPiSession, type PiEvent, type PiSession } from "./contracts.js";
import { measureJsonBytes } from "./json-size.js";
import { retainNativeThinking } from "./pi-native-thinking.js";
import { threadTools } from "./pi-tools.js";
import { convergeTools } from "./converge.js";
import { argument, assertPiSessionFile, checkpointPiBranch, checkpointPiSession, preparePiSession, seedPiSession } from "./pi-session-file.js";
import { PiExecution } from "./pi-execution.js";
import { PiInputBatch, parseNativeInputs } from "./pi-input-batch.js";
import { roleTools, roleInstruction, isThreadRole } from "./roles.js";
import { coreSessionEnvironment, createCoreNativeServices, createCoreNativeSession } from "../core/native-session.js";
import { threadSpeed, updateThreadSpeed } from "./pi-speed.js";
import { scopedBashOperations } from "./pi-bash-resources.js";
import { loadConfig } from "../config.js";
import { modeEnvironment, modeTools } from "./pi-mode.js";
import { PiCommandReceipts } from "./pi-command-receipts.js";
import { PiInputStatus } from "./pi-input-status.js";
import { installMessageDelivery } from "./message-delivery.js";
import { previewCurrentContext } from "./pi-current-context.js";
import { inputReceipts } from "./pi-input-receipts.js";
import { isRawSession, rawModelContext } from "./pi-raw.js";
import routing, { EXPLICIT_THREAD_MODEL_ENV, resolveSessionModel } from "../extension/routing.js";
import usageLogger from "../extension/usage-logger.js";
import { observeProviderRequests } from "../extension/provider-request-activity.js";
import { isolatedPiContext } from "../host/isolated-context.js";
import { piCwdAdmission, requirePiCwd } from "./pi-cwd.js";
import { RunnerStartupError } from "./runner-startup.js";
import { memoryExtension } from "kenan-memory/tools";
import { oneKenanEnabled } from "kenan-memory/config";
import { isRoomSession, assertRoomTools, ROOM_TOOLS, roomSessionInstructions } from "./room-session.js";
import { createThreadClient } from "./http.js";
import { createExecutionActivity, executionActivitySnapshot, observeExecutionActivity, settleExecutionActivity } from "./execution-activity.js";
import { TELEPHONE_CONTEXT_ARGUMENT, isTelephoneContext, telephoneModelContext } from "./telephone-context.js";

export const piEnvironmentScope = coreSessionEnvironment;
type SharedRpc = (runtime: AgentSessionRuntime, io: { output(event: PiEvent): void; exit(code?: number): void }) => Promise<PiSession>;
const inputCommands = new Set(["input_batch", "prompt", "steer", "follow_up"]);
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
  let liveAssistant: { messageTimestamp: number; text: string; thinking: string } | undefined;
  const output = (input: PiEvent) => {
    let event = requireRuntimeEvent(input);
    if (typeof event.emittedAt !== "number") event.emittedAt = Date.now();
    observeExecutionActivity(activity, event);
    if (event.type === "message_start" && (event.message as { role?: string })?.role === "assistant") {
      const message = event.message as { timestamp: number };
      if (!Number.isFinite(message.timestamp)) throw new Error("Active assistant message requires a timestamp");
      liveAssistant = { messageTimestamp: message.timestamp, text: "", thinking: "" };
    }
    if (event.type === "message_update" && liveAssistant) {
      const update = event.assistantMessageEvent as { type: string; delta?: string };
      if (update.type === "text_delta") liveAssistant.text += update.delta ?? "";
      if (update.type === "thinking_delta") liveAssistant.thinking += update.delta ?? "";
    }
    if (event.type === "message_end" && (event.message as { role?: string })?.role === "assistant"
      || event.type === "agent_end" || event.type === "agent_settled" || event.type === "session_changed") liveAssistant = undefined;
    if (event.type === "tool_execution_start" || event.type === "tool_execution_update") {
      const id = String(event.toolCallId);
      liveTools.set(id, { ...liveTools.get(id), toolCallId: id, toolName: event.toolName,
        ...(event.type === "tool_execution_start" ? { args: event.args } : { output: event.partialResult }) });
    }
    for (const id of liveTools.keys()) if (!activity.activityTools.has(id)) liveTools.delete(id);
    if (event.type === "response" && event.command === "get_state" && event.success) {
      const data = event.data as Record<string, any>;
      event = { ...event, data: { ...data, live: { ...data?.live, ...executionActivitySnapshot(activity),
        isThinking: activity.activity === "thinking", tools: [...liveTools.values()],
        text: liveAssistant?.text ?? "", thinking: liveAssistant?.thinking ?? "", messageTimestamp: liveAssistant?.messageTimestamp } } };
    }
    emitOutput(event);
  };
  const admission = (() => {
    try {
      const admission = piCwdAdmission(options.env.PI_REMOTE_WORKSPACES);
      options = { ...options, cwd: requirePiCwd(admission, options.cwd, "thread.cwd") };
      return admission;
    } catch (error) { throw new RunnerStartupError(error instanceof Error ? error.message : String(error)); }
  })();
  const env: NodeJS.ProcessEnv = { ...process.env, ...options.env, PI_THREAD_ID: options.threadId,
    PI_THREAD_REQUIRE_SESSION: options.env.PI_THREAD_REQUIRE_SESSION === "1" ? "1" : "0",
    PI_THREAD_MANAGER: options.env.PI_THREAD_MANAGER === "1" ? "1" : "0",
    PI_THREAD_CAN_SPAWN: options.env.PI_THREAD_CAN_SPAWN === "0" ? "0" : "1",
    PI_THREAD_RESOURCE_BOUNDARY: process.env.PI_THREAD_RESOURCE_BOUNDARY, PI_THREAD_RUNNER_UNIT: process.env.PI_THREAD_RUNNER_UNIT };
  for (const key of ["PI_PERSON_SETTINGS_DATA", "PI_REMOTE_DATA", "PI_THREAD_SPEED", "PI_PERSON_TIMEZONE_FILE", "PI_MODEL_DELIVERY_TIMEZONE"]) {
    if (options.env[key] === undefined) delete env[key];
  }
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
  const memoryEligible = !isRawSession(options.args) && !options.args.includes("--orchestrator-context");
  modeEnvironment(env);
  if (argument(options.args, "--provider") && argument(options.args, "--model")) env[EXPLICIT_THREAD_MODEL_ENV] = "1";
  return piEnvironmentScope.run(env, async () => {
    const execution = new PiExecution(() => settle(), event => output(event));
    let inbox: PiInputBatch;
    const activeWork = new Set<string>();
    let executionStart: string | null | undefined;
    const extensions = options.args.flatMap((arg, index) => arg === "--extension" ? [resolve(options.cwd, options.args[index + 1])] : []);
    const agentDir = env.PI_CODING_AGENT_DIR ?? getAgentDir();
    const raw = isRawSession(options.args);
    const role = env.PI_THREAD_ROLE;
    if (!isThreadRole(role)) throw new RunnerStartupError("PI_THREAD_ROLE is required for native session construction");
    const roleContext = (api: import("@earendil-works/pi-coding-agent").ExtensionAPI) => {
      api.on("before_agent_start", event => ({ systemPrompt: `${event.systemPrompt}\n\n${roleInstruction(role)}` }));
    };

    const telephoneArgument = argument(options.args, TELEPHONE_CONTEXT_ARGUMENT);
    const telephone = telephoneArgument ? JSON.parse(telephoneArgument) : undefined;
    if (telephone !== undefined && (!raw || !isTelephoneContext(telephone))) throw new RunnerStartupError("Invalid telephone execution boundary");
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
      env.PI_SESSION_FILE = sessionManager.getSessionFile();
      const memoryFactories = memoryEligible ? [memoryExtension({ env, ask: async (id, question, suggestions) => {
        const api = options.threads ?? createThreadClient(env.PI_THREAD_API_URL!, fetch, { token: env.PI_THREAD_TOKEN });
        const result = await api.ask({ threadId: options.threadId, requestId: `${options.threadId}:${id}`, questions: [{ question, suggestions }] });
        if (!result.ok) throw new Error(`Cannot ask which forget mode: ${JSON.stringify(result)}`);
        return result.value;
      } })] : [];
      const isolated = await isolatedPiContext({ ...options, cwd, sessionFile: sessionManager.getSessionFile()! }, env);
      const servicesResult = await createCoreNativeServices({ cwd, agentDir: isolated?.agentDir ?? agentDir,
        settingsManager: isolated?.settingsManager,
        resourceLoaderOptions: room ? {
          noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
          systemPromptOverride: () => undefined, appendSystemPromptOverride: () => [],
          extensionFactories: [routing, usageLogger, threadSpeed, ...memoryFactories, roomSessionInstructions(env)],
        } : isolated ? {
          noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
          extensionsOverride: () => isolated.resourceLoader.getExtensions(),
        } : raw ? {
          // Raw: no packages, skills, prompt templates, AGENTS files or SYSTEM.md; only account routing,
          // usage evidence, service tier and the empty system prompt.
          noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
          systemPromptOverride: () => undefined, appendSystemPromptOverride: () => [],
          extensionFactories: [routing, usageLogger, threadSpeed, telephone ? telephoneModelContext(telephone) : rawModelContext],
        } : { additionalExtensionPaths: extensions, extensionFactories: [threadSpeed, modeTools(env), roleContext, ...memoryFactories] } });
      if (!servicesResult.ok) throw new RunnerStartupError(servicesResult.error.message);
      const services = servicesResult.value;
      if (isolated) { services.resourceLoader = isolated.resourceLoader; acceptedContext = JSON.parse(argument(options.args, "--orchestrator-context")!); }
      const provider = argument(options.args, "--provider"), modelId = argument(options.args, "--model");
      const selection = provider && modelId ? await resolveSessionModel(services.modelRuntime.getModels(), provider, modelId, env) : undefined;
      if (selection && !selection.ok) throw new Error(selection.error);
      const bash = createBashTool(cwd, { operations: scopedBashOperations(env), spawnHook: context => ({ ...context, env: { ...context.env, ...env,
        PI_SESSION_FILE: sessionManager.getSessionFile() } }) });
      const createdResult = await createCoreNativeSession({ services, sessionManager, sessionStartEvent,
        model: selection?.ok ? selection.model : undefined, thinkingLevel: argument(options.args, "--thinking") as never,
        tools: room ? ROOM_TOOLS : isolated?.tools ?? (raw ? [] : undefined),
        customTools: room ? threadTools({ ...options, cwd, env }).filter(tool => tool.name === "request_user_input_async")
          : raw ? [] : [bash, ...threadTools({ ...options, cwd, env }), ...(isolated ? [] : convergeTools(env)), { ...execution.inspectionTool(), label: "Tool operation" }] });
      if (!createdResult.ok) throw new RunnerStartupError(createdResult.error.message);
      const created = createdResult.value;
      if (room) assertRoomTools(created.session.agent.state.tools.map(tool => tool.name));
      if (telephone && created.session.agent.state.tools.length !== 0) throw new RunnerStartupError("Telephone sessions cannot expose host tools");
      retainNativeThinking(created.session);
      installMessageDelivery(created.session, env);
      observeProviderRequests(created.session, output);
      const enforceRole = () => {
        const allowed = new Set(roleTools(role, created.session.agent.state.tools.map(tool => tool.name)));
        created.session.agent.state.tools = created.session.agent.state.tools.filter(tool => allowed.has(tool.name));
      };
      enforceRole();
      execution.setToolAdmission(toolName => roleTools(role, [toolName]).includes(toolName));
      execution.bind(created.session);
      inbox?.close();
      inbox = new PiInputBatch(created.session, execution, output, workId => {
        activeWork.add(workId);
        if (executionStart === undefined) executionStart = created.session.sessionManager.getLeafId();
      });
      const session = created.session;
      const navigateTree = session.navigateTree.bind(session);
      session.navigateTree = async (...args) => {
        try { return await navigateTree(...args); }
        finally { checkpointPiBranch(session.sessionManager); }
      };
      created.session.agent.steeringMode = "all";
      created.session.settingsManager.applyOverrides({ retry });
      return { ...created, services, diagnostics: services.diagnostics };
    };
    const runtime = await createAgentSessionRuntime(factory, { cwd: options.cwd, agentDir,
      sessionManager: SessionManager.open(options.sessionFile, undefined, options.cwd) });
    const commands = new PiCommandReceipts();
    let inputStatuses = new PiInputStatus(runtime.session.sessionManager);
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
      if (!cancelled && (execution.blocked || inbox.awaitingAdmission)) return;
      if (!cancelled && runtime.session.agent.hasQueuedMessages()) {
        // Pi consumes queued steering only inside a live run. A run that ended on a terminal error (for example a
        // fenced compaction) leaves the queue stranded, and settlement would wait on it forever. Run it now.
        void execution.run(() => runtime.session.agent.continue()).catch(error => { output({ type: "extension_error", error: String(error) }); });
        return;
      }
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
        inputStatuses = new PiInputStatus(runtime.session.sessionManager);
        output({ type: "session_changed", sessionFile: runtime.session.sessionFile, sessionId: runtime.session.sessionId, cwd: runtime.cwd });
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
          inputStatuses.finish(event);
          commands.finish(event, runtime.session.sessionManager);
          if (backgroundCommands.delete(String(event.id))) {
            output({ type: "compaction_end", commandId: event.id, success: event.success, error: event.error, result: event.data });
            output({ type: "command_settled", commandId: event.id, response: event });
            return;
          }
          if (event.command === "get_state" && event.success) event = { ...event, data: { ...event.data as object, ...receipts(),
            lastAssistantMessage: lastAssistant(), context: acceptedContext, historySource: "native-jsonl-v1", localTools: execution.active ? execution.activeTools : 0,
            nativeProtocolVersion: "batch-operations-v1", backgroundOperationCount: execution.activeTools, pendingCommandCount: backgroundCommands.size,
            isStreaming: !runtime.session.isIdle || execution.active || executionStart !== undefined,
            cancellationFailed: execution.blocked } };
        }
        if (event.type === "extension_ui_request" && ["select", "confirm", "input", "editor"].includes(String(event.method))) {
          const requestId = String(event.id);
          if (!dialogs.has(requestId)) {
            dialogs.add(requestId);
            runtime.session.sessionManager.appendCustomEntry("thread_ui_response", { requestId, cancelled: true });
            checkpointPiSession(runtime.session.sessionManager);
            // This RPC session has no native UI. Cancellation belongs to its owner, not a connected Remote client.
            void rpc.command({ type: "extension_ui_response", id: requestId, cancelled: true }).then(() => dialogs.delete(requestId), error => {
              output({ type: "extension_error", error: `Native UI cancellation ${requestId} unconfirmed: ${String(error)}` });
            });
          }
        }
        if (event.type === "agent_start" && executionStart === undefined) executionStart = runtime.session.sessionManager.getLeafId();
        if (event.type === "agent_settled") { queueMicrotask(() => settle()); return; }
        if (event.type === "message_end") checkpointPiSession(runtime.session.sessionManager);
        output(event);
      } });
      checkpointPiSession(runtime.session.sessionManager);
      return {
        command: command => piEnvironmentScope.run(env, async () => {
          const response = (success: boolean, error?: string, data?: unknown) => {
            const event = { type: "response", id: command.id, command: command.type, success, ...(error ? { error } : {}), ...(data === undefined ? {} : { data }) };
            inputStatuses.finish(event);
            output(event);
          };
          if (command.type === "tool_operation") {
            if (typeof command.operationId !== "string" || command.action !== "inspect" && command.action !== "cancel") { response(false, "Invalid tool operation request"); return; }
            const result = command.action === "inspect" ? execution.inspect(command.operationId) : execution.cancel(command.operationId);
            response(result.ok, result.ok ? undefined : result.error.message, result.ok ? result.value : undefined); return;
          }
          if (command.type === "resume_pending") {
            if (!command.id || !Array.isArray(command.workIds) || !command.workIds.length || command.workIds.some(id => typeof id !== "string")) { response(false, "Recovery requires command identity and workIds"); return; }
            const known = receipts();
            if (command.workIds.some(id => !known.acceptedWorkIds.includes(id) && !known.landedWorkIds.includes(id) && !known.deferredWorkIds.includes(id))) { response(false, "Recovery references input never accepted by native custody"); return; }
            if (execution.blocked || replacing) { response(false, "Local execution has not confirmed cancellation"); return; }
            const status = inputStatuses.begin(command.id, command.workIds[0]);
            if (status?.state === "accepted") { response(true, undefined, { alreadyAccepted: true }); return; }
            if (status?.state === "rejected") { response(false, status.error); return; }
            for (const workId of command.workIds) activeWork.add(workId);
            if (executionStart === undefined) executionStart = runtime.session.sessionManager.getLeafId();
            runtime.session.sessionManager.appendCustomEntry("thread_resume", { workIds: command.workIds });
            checkpointPiSession(runtime.session.sessionManager);
            response(true, undefined, { accepted: true });
            inbox.resume(); return;
          }
          if (command.type === "input_batch") {
            if (!command.id || typeof command.batchId !== "string" || !command.batchId) { response(false, "Native input batch requires command and batch identities"); return; }
            const parsed = parseNativeInputs(command.inputs);
            if (!parsed.ok) { response(false, parsed.error); return; }
            const prior = inputStatuses.begin(command.id, parsed.value[0]!.workId);
            if (prior?.state === "rejected") { response(false, prior.error); return; }
            const admitted = inbox.accept(parsed.value, { commandId: command.id, batchId: command.batchId });
            response(admitted.ok, admitted.ok ? undefined : admitted.error, admitted.ok ? { accepted: true, workIds: parsed.value.map(input => input.workId) } : undefined);
            return;
          }
          if (command.type === "get_input_status") {
            if (typeof command.commandId !== "string" || typeof command.workId !== "string") { response(false, "Input status requires commandId and workId"); return; }
            response(true, undefined, inputStatuses.query(command.commandId, command.workId)); return;
          }
          if (inputCommands.has(command.type) && command.workId && command.resume !== true && command.resumeProviderWait !== true) {
            if (!command.id) { response(false, "Native input requires command identity"); return; }
            const prior = inputStatuses.begin(command.id, String(command.workId));
            if (prior) {
              if (prior.state === "accepted") response(true, undefined, { alreadyAccepted: true });
              else if (prior.state === "rejected") response(false, prior.error);
              else output({ type: "response", id: command.id, command: command.type, success: false,
                inputUnconfirmed: true, error: "Native input is still in flight; it will not be dispatched again" });
              return;
            }
          }
          if (closed) { response(false, "Pi session is closed"); return; }
          if (command.type === "get_state") execution.flushCompletions();
          if (command.type === "get_context") {
            const context = await previewCurrentContext(runtime.session);
            if (!context.ok) {
              output({ type: "response", id: command.id, command: command.type, success: false,
                error: context.error.message, errorCode: context.error.code });
              return;
            }
            const event = { type: "response", id: command.id, command: command.type, success: true, data: context.value };
            const measured = measureJsonBytes(event, CONTEXT_WINDOW_MAX_BYTES);
            output(measured.ok ? event : { type: "response", id: command.id, command: command.type, success: false,
              error: measured.error.message, errorCode: measured.error.code });
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
            response(false, "Native messages require the lossless input_batch command"); return;
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
          } else await rpc.command(command);
          checkpointPiSession(runtime.session.sessionManager);
        }),
        close: () => piEnvironmentScope.run(env, async () => {
          if (closed) return;
          if (backgroundCommands.size || !runtime.session.isIdle || runtime.session.isBashRunning || execution.active || execution.activeTools || execution.blocked) throw new Error("Cannot close active Pi execution; stop and confirm cancellation first");
          await halt();
          closed = true;
          clearInterval(reconcile);
          inbox.close();
          execution.dispose();
          await rpc.close();
        }),
      };
    } catch (error) { clearInterval(reconcile); await runtime.dispose(); throw error; }
  });
};

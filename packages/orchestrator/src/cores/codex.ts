import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, symlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { argument, type CoreAgent, type CoreCommand, type CoreOutput, type OpenCoreSession } from "./contracts.js";
import { credentialGuard, type CodexAccountLease, type OpenCodexAccount } from "./codex-auth.js";
import { openCoreAccount } from "./account.js";
import { anthropicCodexModels, codexProviderFamily } from "./codex-models.js";
import { startCodexAnthropicAdapter, type CodexAnthropicAdapter } from "./codex-anthropic.js";
import { writeCoreState } from "./journal.js";
import { openCodexRpc, type CodexRpc, type Json, type OpenCodexRpc, type RpcResult } from "./codex-rpc.js";
import { CodexProjection, transferItems } from "./codex-projection.js";
import { CodexProcessError } from "./codex-process.js";
import type { Thread } from "./codex-protocol/v2/Thread.js";
import type { ThreadItem } from "./codex-protocol/v2/ThreadItem.js";
import type { Turn } from "./codex-protocol/v2/Turn.js";
import type { Model } from "./codex-protocol/v2/Model.js";
import type { UserInput } from "./codex-protocol/v2/UserInput.js";
import type { ThreadStartResponse } from "./codex-protocol/v2/ThreadStartResponse.js";
import type { ThreadSettings } from "./codex-protocol/v2/ThreadSettings.js";
import type { ThreadTokenUsage } from "./codex-protocol/v2/ThreadTokenUsage.js";
import type { SkillsListResponse } from "./codex-protocol/v2/SkillsListResponse.js";

type Receipt = { hash: string; state: "pending" | "accepted" | "rejected"; turnId?: string };
type State = {
  version: 1; sessionId: string; threadId?: string; materialized?: boolean; provider?: string; model?: string; effort?: string; name?: string;
  transfer?: "pending" | "complete"; transferProjection?: Record<string, unknown>[];
  receipts: Record<string, Receipt>; timestamps: Record<string, number>;
};
export interface CodexDependencies {
  openAccount: OpenCodexAccount;
  openRpc?: OpenCodexRpc;
  openAnthropic?: typeof startCodexAnthropicAdapter;
  binary?: string;
  /** Native app-server flags, not Pi runtime arguments. */
  appServerArgs?: string[];
}
class Failure extends Error {}
function fail(message: string): never { throw new Failure(message); }
const needString = (value: unknown, name: string): string => typeof value === "string" && value.trim() ? value : fail(`${name} is required`);
const publicModel = (model: Model, provider: string) => ({ id: model.model, provider, name: model.displayName,
  reasoning: model.supportedReasoningEfforts.length > 0, input: model.inputModalities, nativeCore: "codex" });

/** Bind the account owner once at the integration layer; credentials never become core output. */
export const openCodexSession: OpenCoreSession = createCodexSession({
  openAccount: options => openCoreAccount({
    initialProvider: argument(options.args, "--provider") === "openai" ? "openai-codex" : argument(options.args, "--provider") ?? "openai-codex",
    initialModel: needString(argument(options.args, "--model"), "Starting --model"),
    sessionId: options.sessionId,
    env: options.env,
  }),
});

export function createCodexSession(dependencies: CodexDependencies): OpenCoreSession {
  return async (options, output, exit) => {
    mkdirSync(options.stateDir, { recursive: true, mode: 0o700 });
    const statePath = join(options.stateDir, "codex-session.json");
    let state: State;
    try {
      state = existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) : {
        version: 1, sessionId: options.sessionId, receipts: {}, timestamps: {},
      };
      if (state.version !== 1 || state.sessionId !== options.sessionId || !state.receipts || !state.timestamps) fail("Codex state does not belong to this session");
    } catch { throw new Error("Cannot load Codex durable session state"); }
    const guard = credentialGuard();
    const emit = (event: CoreOutput) => output(guard.clean(event));
    const save = () => writeCoreState(statePath, guard.clean(state));
    const stamp = (id: string, suggested?: number) => state.timestamps[id] ??= suggested && suggested > 0 ? suggested : Date.now();
    const agents = new Map<string, CoreAgent>();
    const nativeStatus = new Map<string, string>();
    let treeWasBusy = false, settling = 0, dispatching = 0, abortRequested = false;
    const uncertainThreads = new Set<string>();
    const threadBusy = (id: string) => uncertainThreads.has(id) || active.has(id) || compactingThreads.has(id) || nativeStatus.get(id) === "active" || agents.get(id)?.state === "running";
    const treeBusy = () => dispatching > 0 || settling > 0 || aborting.size > 0 || [...new Set([state.threadId!, ...agents.keys(), ...active.keys(), ...compactingThreads, ...uncertainThreads])].some(threadBusy);
    const reconcileLifecycle = () => {
      if (!ready || closed) return;
      const busy = treeBusy();
      account!.setActive(busy);
      if (busy === treeWasBusy) return;
      treeWasBusy = busy;
      emit(busy ? { type: "agent_start" } : { type: "agent_end", messages: projection(state.threadId!).entries.map(entry => entry.message) });
      if (!busy) emit({type:"agent_settled"});
    };
    const subscriptions = new Map<string, Promise<void>>();
    const nativeSettings = new Map<string, { model: string; effort?: string }>();
    const projections = new Map<string, CodexProjection>();
    const active = new Map<string, string>();
    const completedTurns = new Set<string>();
    const compactingThreads = new Set<string>();
    const setCompacting = (threadId: string, value: boolean, failure?: {errorMessage:string;aborted?:boolean}) => {
      if (compactingThreads.has(threadId) === value) return;
      if (value) compactingThreads.add(threadId); else compactingThreads.delete(threadId);
      const event = value ? {type:"compaction_start"} : {type:"compaction_end", ...(failure ?? {result:{core:"codex",projection:"activity"}})};
      if (threadId === state.threadId) emit(event); else emit({ type: "core_child_event", agentId: threadId, event });
    };
    let closed = false, ready = false, account: CodexAccountLease | undefined, rpc: CodexRpc | undefined;
    let anthropic: CodexAnthropicAdapter | undefined;
    let closePromise: Promise<void> | undefined, handlingCommand = false, pendingExit: { code?: number } | undefined, exitSent = false;
    const notifyExit = (code?: number) => {
      if (exitSent) return;
      if (handlingCommand) { pendingExit = { code }; return; }
      exitSent = true; exit(code);
    };
    let accounting = Promise.resolve();
    let accountClosed: Promise<void> | undefined;
    const closeAccount = () => accountClosed ??= Promise.resolve().then(async () => {
      try { await account?.close(); } catch { throw new Failure("Codex account cleanup failed"); }
    });
    let accountingFailure = false;
    const notifications: [string, Json][] = [];
    let models: Model[] = [];
    const modelId = () => state.model ?? "";
    const providerFamily = () => codexProviderFamily(state.provider ?? "openai-codex")!;
    const projection = (threadId: string) => {
      let value = projections.get(threadId);
      if (!value) {
        value = new CodexProjection(() => threadId === state.threadId ? modelId() : nativeSettings.get(threadId)?.model ?? agents.get(threadId)?.model ?? "", event => {
          if (threadId === state.threadId) emit(event);
          else if (agents.has(threadId)) emit({ type: "core_child_event", agentId: threadId, event });
        }, stamp, providerFamily);
        projections.set(threadId, value);
      }
      return value;
    };
    const call = async <T = Json>(method: string, params: Json): Promise<T> => {
      const result = await rpc!.request<T>(method, params);
      if (!result.ok) fail(result.error);
      return (result as { ok: true; value: T }).value;
    };
    const agentState = (native: string): CoreAgent["state"] => {
      if (["running", "pendingInit", "active"].includes(native)) return "running";
      if (["errored", "systemError", "notFound", "failed"].includes(native)) return "failed";
      if (["interrupted", "shutdown"].includes(native)) return "cancelled";
      return "idle";
    };
    const announce = (thread: Thread) => {
      nativeStatus.set(thread.id, thread.status.type);
      if (thread.status.type === "notLoaded") active.delete(thread.id);
      if (!thread.parentThreadId || thread.id === state.threadId) return;
      const agent: CoreAgent = { id: thread.id, nativeSessionId: thread.id,
        parentId: thread.parentThreadId === state.threadId ? options.sessionId : thread.parentThreadId,
        name: thread.name ?? thread.agentNickname ?? thread.agentRole ?? thread.id,
        state: thread.status.type === "notLoaded" && agents.get(thread.id)?.state !== "running"
          ? agents.get(thread.id)?.state ?? "idle" : agentState(thread.status.type),
        model: nativeSettings.get(thread.id)?.model ?? agents.get(thread.id)?.model };
      agents.set(thread.id, agent);
      emit({ type: "core_agent", agent, canAcceptDirectInput: thread.canAcceptDirectInput });
      if (thread.status.type === "active" && !abortRequested && !closed) background(subscribeChild(thread.id), "child subscription");
      reconcileLifecycle();
    };
    function subscribeChild(threadId: string): Promise<void> {
      const existing = subscriptions.get(threadId);
      if (existing) return existing;
      const operation = (async () => {
        const joined = await call<ThreadStartResponse>("thread/resume", { threadId, excludeTurns: true });
        nativeSettings.set(threadId, { model: joined.model, effort: joined.reasoningEffort ?? undefined });
        announce(joined.thread);
        const history = await turns(threadId);
        projection(threadId).restore(history);
        projection(threadId).context();
        const running = history.find(turn => turn.status === "inProgress");
        if (running && !completedTurns.has(running.id)) active.set(threadId, running.id);
        reconcileLifecycle();
      })();
      subscriptions.set(threadId, operation);
      return operation;
    }
    const turns = (threadId: string) => pages<Turn>("thread/turns/list", { threadId, sortDirection: "asc", itemsView: "full", limit: 100 });
    async function pages<T>(method: string, params: Json): Promise<T[]> {
      const data: T[] = []; let cursor: string | null = null;
      do {
        const page: { data: T[]; nextCursor?: string | null } = await call(method, { ...params, cursor });
        data.push(...page.data); cursor = page.nextCursor ?? null;
      } while (cursor);
      return data;
    }
    const discover = async () => {
      if (!state.threadId) return;
      for (const thread of await pages<Thread>("thread/list", { ancestorThreadId: state.threadId,
        sourceKinds: ["subAgent", "subAgentReview", "subAgentCompact", "subAgentThreadSpawn", "subAgentOther"], limit: 100 })) announce(thread);
    };
    const background = (work: Promise<unknown>, operation: string) => {
      void work.catch(() => { if (!closed) emit({ type: "core_error", core: "codex", error: `Codex ${operation} failed` }); });
    };
    const applyNotification = (method: string, params: Json) => {
      if (method === "thread/started") { announce(params.thread as Thread); return; }
      const threadId = typeof params.threadId === "string" ? params.threadId : undefined;
      if (!threadId) return;
      const root = threadId === state.threadId;
      if (!root && !agents.has(threadId) && (method === "thread/closed" || method === "thread/deleted")) return;
      // Child lifecycle events can precede their metadata; discovery supplies parentage.
      if (!root && !agents.has(threadId)) {
        const agent: CoreAgent = { id: threadId, nativeSessionId: threadId, parentId: null, name: threadId, state: "running" };
        agents.set(threadId, agent); emit({ type: "core_agent", agent });
      }
      const send = (event: CoreOutput) => root ? emit(event) : emit({ type: "core_child_event", agentId: threadId, event });
      if (method === "thread/closed" || method === "thread/deleted") {
        uncertainThreads.delete(threadId);
        nativeStatus.set(threadId, "notLoaded"); active.delete(threadId); setCompacting(threadId, false);
        projection(threadId).clearLive();
        const agent = agents.get(threadId);
        if (agent) { if (agent.state === "running") agent.state = "cancelled"; emit({ type: "core_agent", agent }); }
      } else if (method === "thread/status/changed") {
        const status = params.status as { type: string };
        uncertainThreads.delete(threadId);
        nativeStatus.set(threadId, status.type);
        if (!root && status.type !== "active") active.delete(threadId);
        const agent = agents.get(threadId);
        if (agent) { agent.state = agentState(status.type); emit({ type: "core_agent", agent }); }
        if (!root && status.type === "active" && !abortRequested) background(subscribeChild(threadId), "child subscription");
      } else if (method === "thread/settings/updated") {
        const settings = params.threadSettings as ThreadSettings;
        nativeSettings.set(threadId, { model: settings.model, effort: settings.effort ?? undefined });
        if (root) { state.model = settings.model; state.effort = settings.effort ?? undefined; save(); }
        else { const agent = agents.get(threadId)!; agent.model = settings.model; emit({ type: "core_agent", agent }); }
      } else if (method === "thread/name/updated") {
        if (root) { state.name = String(params.threadName ?? ""); save(); }
        else { const agent = agents.get(threadId)!; agent.name = String(params.threadName ?? threadId); emit({ type: "core_agent", agent }); }
      } else if (method === "turn/started") {
        uncertainThreads.delete(threadId);
        const turn = params.turn as Turn;
        active.set(threadId, turn.id);
        nativeStatus.set(threadId, "active");
        const agent = agents.get(threadId);
        if (agent) { agent.state = "running"; emit({ type: "core_agent", agent }); }
        if (!root) send({ type: "agent_start" });
        send({ type: "turn_start" });
      } else if (method === "turn/completed") {
        uncertainThreads.delete(threadId);
        const turn = params.turn as Turn;
        completedTurns.add(turn.id);
        if (active.get(threadId) === turn.id) active.delete(threadId);
        nativeStatus.set(threadId, "idle");
        projection(threadId).finish(turn);
        setCompacting(threadId, false, turn.status === "failed" || turn.status === "interrupted"
          ? {errorMessage:turn.error?.message ?? "Native compaction interrupted",aborted:turn.status === "interrupted"} : undefined);
        const agent = agents.get(threadId);
        if (agent) { agent.state = agentState(turn.status); emit({ type: "core_agent", agent }); }
        save();
        send({ type: "turn_end", message: projection(threadId).entries.at(-1)?.message, toolResults: [] });
        if (!root) send({ type: "agent_end", messages: projection(threadId).entries.map(entry => entry.message) });
        if (root) {
          settling++;
          background(discover().finally(() => { settling--; reconcileLifecycle(); }), "child discovery");
        }
      } else if (method === "item/started" || method === "item/completed") {
        const item = params.item as ThreadItem;
        const completed = method === "item/completed";
        if (item.type === "contextCompaction") {
          uncertainThreads.delete(threadId);
          setCompacting(threadId, !completed);
          if (completed) projection(threadId).context();
        }
        if (item.type === "subAgentActivity") {
          if (!agents.has(item.agentThreadId)) {
            const agent: CoreAgent = { id: item.agentThreadId, nativeSessionId: item.agentThreadId, parentId: null, name: item.agentPath, state: "running" };
            agents.set(agent.id, agent); emit({ type: "core_agent", agent });
          }
          background(discover(), "child discovery");
        }
        if (item.type === "collabAgentToolCall") {
          for (const id of item.receiverThreadIds) {
            const existing = agents.get(id);
            const agent: CoreAgent = { id, nativeSessionId: id, parentId: existing?.parentId ?? (threadId === state.threadId ? options.sessionId : threadId),
              name: existing?.name ?? id, model: item.model ?? existing?.model,
              state: agentState(item.agentsStates[id]?.status ?? "running") };
            agents.set(id, agent);
            if (item.agentsStates[id]) nativeStatus.set(id, agent.state === "running" ? "active" : "idle");
            emit({ type: "core_agent", agent });
          }
          if (completed) background(discover(), "child discovery");
        }
        projection(threadId).item(item, String(params.turnId), completed);
        if (completed) save();
      } else if (method === "item/reasoning/summaryPartAdded") {
        if (Number(params.summaryIndex) > 0) projection(threadId).delta(String(params.itemId), "\n\n", true);
      } else if (method === "item/agentMessage/delta" || method === "item/plan/delta" || method === "item/reasoning/summaryTextDelta" || method === "item/reasoning/textDelta") {
        projection(threadId).delta(String(params.itemId), String(params.delta ?? ""), method.includes("reasoning"));
      } else if (method === "item/commandExecution/outputDelta" || method === "item/fileChange/outputDelta") {
        send({ type: "tool_execution_update", toolCallId: params.itemId, toolName: method.includes("fileChange") ? "apply_patch" : "exec_command",
          partialResult: { content: [{ type: "text", text: params.delta }] } });
      } else if (method === "thread/tokenUsage/updated") {
        if (providerFamily() === "anthropic") return;
        const usage = (params.tokenUsage as ThreadTokenUsage).total;
        accounting = accounting.then(async () => {
          try {
            if (!root && !nativeSettings.has(threadId)) await subscribeChild(threadId);
            await account!.recordUsage({ sessionId: options.sessionId, nativeThreadId: threadId, turnId: String(params.turnId), model: root ? modelId() : nativeSettings.get(threadId)!.model,
              inputTokens: usage.inputTokens, cachedInputTokens: usage.cachedInputTokens, cacheWriteInputTokens: usage.cacheWriteInputTokens, outputTokens: usage.outputTokens,
              reasoningOutputTokens: usage.reasoningOutputTokens, totalTokens: usage.totalTokens });
          } catch { accountingFailure = true; emit({ type: "core_error", core: "codex", error: "Codex account usage recording failed; new turns are blocked" }); }
        });
      } else if (method === "error") {
        const error = params.error as { message?: string } | undefined;
        send({ type: "core_error", core: "codex", error: error?.message ?? "Codex turn error", willRetry: params.willRetry === true });
      }
    };
    const serverRequest = async (method: string, params: Json): Promise<RpcResult<unknown>> => {
      if (method === "account/chatgptAuthTokens/refresh") {
        try {
          const credentials = await account!.credentials({ refresh: true,
            ...(typeof params.previousAccountId === "string" ? { previousAccountId: params.previousAccountId } : {}) });
          guard.remember(credentials);
          if (!credentials.chatgptAccountId) fail("This core has no ChatGPT account");
          return { ok: true, value: { accessToken: credentials.accessToken, chatgptAccountId: credentials.chatgptAccountId,
            chatgptPlanType: credentials.chatgptPlanType ?? null } };
        } catch { return { ok: false, error: "Codex account broker refresh failed" }; }
      }
      if (method === "currentTime/read") return { ok: true, value: { currentTimeAt: Math.floor(Date.now() / 1000) } };
      emit({ type: "core_error", core: "codex", error: `Unsupported Codex client request: ${method}` });
      return { ok: false, error: `PiStack does not support Codex client request ${method}` };
    };
    const aborting = new Map<string, Promise<void>>();
    const interrupted = new Set<string>();
    const interruptThread = (threadId: string): Promise<void> => {
      const existing = aborting.get(threadId);
      if (existing) return existing;
      const operation = Promise.resolve().then(async () => {
        let turnId = active.get(threadId);
        if (!turnId && threadBusy(threadId)) {
          const history = await turns(threadId);
          turnId = history.find(turn => turn.status === "inProgress" && !completedTurns.has(turn.id))?.id;
          if (turnId) active.set(threadId, turnId);
          else if (threadBusy(threadId)) fail("Native Codex child has no interruptible turn");
        }
        if (turnId && !interrupted.has(`${threadId}:${turnId}`)) {
          const result = await rpc!.request("turn/interrupt", { threadId, turnId });
          if (!result.ok && threadBusy(threadId)) fail(result.error);
          interrupted.add(`${threadId}:${turnId}`);
        }
        if (nativeStatus.get(threadId) !== "notLoaded" && (threadId !== state.threadId || state.materialized || state.transfer)) {
          const terminals = await pages<{ processId: string }>("thread/backgroundTerminals/list", { threadId, limit: 100 });
          await Promise.all(terminals.map(terminal => call("thread/backgroundTerminals/terminate", { threadId, processId: terminal.processId })));
        }
      }).finally(() => { aborting.delete(threadId); reconcileLifecycle(); });
      aborting.set(threadId, operation);
      return operation;
    };
    function continueTreeAbort() {
      if (!abortRequested || closed) return;
      for (const id of [state.threadId!, ...agents.keys()]) if (threadBusy(id) && !aborting.has(id)) {
        void interruptThread(id).catch(async () => {
          emit({ type: "core_error", core: "codex", error: "Native tree interrupt requires app-server shutdown" });
          try { await close(); }
          catch { emit({ type: "core_error", core: "codex", error: "Codex process-tree cleanup failed; account lease retained" }); }
        });
      }
    }
    const close = () => closePromise ??= Promise.resolve().then(async () => {
      closed = true;
      // Do not release account custody until the app-server's process tree is stopped.
      await rpc?.close();
      await anthropic?.close();
      await accounting;
      await Promise.allSettled(subscriptions.values());
      await closeAccount();
    });
    try {
      const provider = argument(options.args, "--provider") ?? state.provider ?? "openai-codex";
      const startingModel = needString(argument(options.args, "--model") ?? state.model, "Starting --model or saved model");
      state.provider = provider;
      if (!codexProviderFamily(provider)) fail("Codex core requires an OpenAI or Anthropic account provider");
      const nativeHome = join(options.stateDir, "codex");
      mkdirSync(nativeHome, { recursive: true, mode: 0o700 });
      const sourceHome = options.env.CODEX_HOME ?? join(options.env.HOME ?? homedir(), ".codex");
      // Share native configuration/resources, never auth or thread storage.
      for (const resource of ["config.toml", "AGENTS.md", "skills", "agents", "rules", "plugins"]) {
        const source = join(sourceHome, resource), target = join(nativeHome, resource);
        if (source !== target && existsSync(source) && !existsSync(target)) symlinkSync(source, target);
      }
      account = await dependencies.openAccount({ ...options, args: [...options.args, "--provider", provider, "--model", startingModel] });
      const providerArgs: string[] = [];
      if (providerFamily() === "anthropic") {
        models = anthropicCodexModels();
        if (!models.some(model => model.model === startingModel)) fail("Anthropic model not found");
        anthropic = await (dependencies.openAnthropic ?? startCodexAnthropicAdapter)({
          sessionId: options.sessionId, cwd: options.cwd,
          recordUsage: async usage => {
            const operation = accounting.then(() => account!.recordUsage({ ...usage, sessionId: options.sessionId }));
            accounting = operation.catch(() => {
              accountingFailure = true;
              emit({ type: "core_error", core: "codex", error: "Anthropic account usage recording failed; new turns are blocked" });
            });
            await operation;
          },
          credentials: async request => {
            const credentials = await account!.credentials(request);
            guard.remember(credentials);
            return credentials;
          },
        });
        providerArgs.push("-c", 'model_provider="pistack-anthropic"', "-c",
          `model_providers.pistack-anthropic={name="Anthropic",base_url=${JSON.stringify(anthropic.baseUrl)},wire_api="responses",requires_openai_auth=false,request_max_retries=0,stream_max_retries=0,supports_websockets=false}`,
          "-c", 'web_search="disabled"');
      }
      rpc = (dependencies.openRpc ?? openCodexRpc)({ cwd: options.cwd,
        env: { ...process.env, ...options.env, CODEX_HOME: nativeHome, OPENAI_API_KEY: undefined, CODEX_API_KEY: undefined, ANTHROPIC_API_KEY: undefined },
        binary: dependencies.binary, args: [...(dependencies.appServerArgs ?? []), ...providerArgs, "-c", 'cli_auth_credentials_store="ephemeral"'],
        sanitizeError: message => guard.clean(message),
        notification(method, params) {
          if (closed) return;
          if (!ready) notifications.push([method, params]);
          else {
            try { applyNotification(method, params); reconcileLifecycle(); continueTreeAbort(); }
            catch { emit({ type: "core_error", core: "codex", error: "Codex event processing failed" }); background(close(), "cleanup"); }
          }
        }, serverRequest,
        exit(code) {
          void close().then(() => notifyExit(code), () => {
            emit({ type: "core_error", core: "codex", error: "Codex process-tree cleanup failed; account lease retained" });
            notifyExit(1);
          });
        },
      });
      await call("initialize", { clientInfo: { name: "pistack", title: "PiStack", version: "1" }, capabilities: { experimentalApi: true } });
      rpc.notify("initialized");
      if (providerFamily() === "openai-codex") {
        const credentials = await account.credentials();
        guard.remember(credentials);
        if (!credentials.chatgptAccountId) fail("OpenAI credentials require a ChatGPT account identity");
        await call("account/login/start", { type: "chatgptAuthTokens", accessToken: credentials.accessToken,
          chatgptAccountId: credentials.chatgptAccountId, chatgptPlanType: credentials.chatgptPlanType ?? null });
        models = await pages<Model>("model/list", { includeHidden: false, limit: 100 });
      }
      const settings = { cwd: options.cwd, model: startingModel, ...(anthropic ? { modelProvider: "pistack-anthropic" } : {}),
        approvalPolicy: "never", sandbox: argument(options.args, "--sandbox") ?? "danger-full-access" };
      const resume = state.threadId && (state.materialized || state.transfer || Object.values(state.receipts).some(receipt => receipt.state !== "rejected"));
      const response = await call<ThreadStartResponse>(resume ? "thread/resume" : "thread/start", {
        ...settings, ...(resume ? { threadId: state.threadId } : { ephemeral: false, historyMode: "paginated" }),
      });
      state.threadId = response.thread.id; state.model = response.model;
      nativeStatus.set(state.threadId, response.thread.status.type);
      state.effort = argument(options.args, "--thinking") ?? state.effort ?? response.reasoningEffort ?? undefined;
      state.name = argument(options.args, "--name") ?? state.name ?? response.thread.name ?? undefined;
      save();
      if (state.effort) {
        if (anthropic && !models.find(model => model.model === state.model)?.supportedReasoningEfforts.some(option => option.reasoningEffort === nativeEffort(state.effort!))) {
          fail("Anthropic model does not support this reasoning effort");
        }
        await call("thread/settings/update", { threadId: state.threadId, effort: nativeEffort(state.effort) });
      }
      if (state.name) await call("thread/name/set", { threadId: state.threadId, name: state.name });
      if (state.transfer === "pending") fail("Codex transfer outcome is unknown; inspect native history before continuing");
      if (options.transfer && state.transfer !== "complete") {
        if (resume && (response.thread.turns.length || (await turns(state.threadId)).length)) fail("Cross-core transfer requires an empty Codex thread");
        const items = transferItems(guard.clean(options.transfer));
        if (options.transfer.agents.length) items.push({ type: "message", role: "user", content: [{ type: "input_text", text: JSON.stringify({ sourceCore: options.transfer.sourceCore, agents: options.transfer.agents }) }] });
        state.transferProjection = guard.clean(options.transfer.messages);
        state.transfer = "pending"; save();
        if (items.length) await call("thread/inject_items", { threadId: state.threadId, items });
        state.transfer = "complete"; save();
      }
      // Codex does not materialize a fresh thread until its first user turn.
      const history = resume || state.transfer === "complete" ? await turns(state.threadId) : [];
      projection(state.threadId).restore(history, state.transferProjection);
      const running = history.find(turn => turn.status === "inProgress");
      if (running) active.set(state.threadId, running.id);
      for (const receipt of Object.values(state.receipts)) {
        if (receipt.state !== "pending") continue;
        const item = history.flatMap(turn => turn.items.map(item => ({ turn, item }))).find(({ item }) => item.type === "userMessage" && item.clientId && state.receipts[item.clientId] === receipt);
        if (item) { receipt.state = "accepted"; receipt.turnId = item.turn.id; }
      }
      save();
      ready = true;
      for (const [method, params] of notifications) applyNotification(method, params);
      notifications.length = 0;
      projection(state.threadId).context();
      await discover();
      reconcileLifecycle();
    } catch (error) {
      await close();
      throw new Error(error instanceof Failure || error instanceof CodexProcessError ? guard.clean(error.message) : "Codex session initialization failed");
    }
    function nativeEffort(level: string): string { return level === "off" ? "none" : level; }
    const target = (command: CoreCommand): string => {
      if (command.agentId === undefined) return state.threadId!;
      const id = needString(command.agentId, "agentId");
      if (!agents.has(id)) fail("Unknown Codex child agent");
      return id;
    };
    const input = async (command: CoreCommand): Promise<UserInput[]> => {
      const text = needString(command.message, "message");
      const data: UserInput[] = [{ type: "text", text, text_elements: [] }];
      if (Array.isArray(command.images)) for (const image of command.images) {
        if (!image || typeof image !== "object" || typeof image.data !== "string" || typeof image.mimeType !== "string") fail("Codex images require data and mimeType");
        data.push({ type: "image", url: `data:${image.mimeType};base64,${image.data}` });
      }
      const skill = /^\/skill:([^\s]+)(?:\s|$)/.exec(text);
      if (skill) {
        const list = await call<SkillsListResponse>("skills/list", { cwds: [options.cwd] });
        const selected = list.data.flatMap(entry => entry.skills).find(item => item.name === skill[1] && item.enabled);
        if (!selected) fail(`Codex skill not found: ${skill[1]}`);
        data.push({ type: "skill", name: selected!.name, path: selected!.path });
      } else if (text.startsWith("/")) fail("Codex app-server does not execute slash commands; use a runtime command or /skill:name");
      return data;
    };
    const readChild = async (threadId: string) => {
      const thread = (await call<{ thread: Thread }>("thread/read", { threadId, includeTurns: false })).thread;
      announce(thread);
      const history = await turns(threadId);
      const snapshot = new CodexProjection(() => nativeSettings.get(threadId)?.model ?? agents.get(threadId)?.model ?? "", () => {}, stamp);
      snapshot.restore(history);
      const running = history.find(turn => turn.status === "inProgress" && !completedTurns.has(turn.id));
      if (running) active.set(threadId, running.id);
      else if (thread.status.type !== "active") active.delete(threadId);
      return { thread, snapshot };
    };
    const run = async (command: CoreCommand): Promise<unknown> => {
      if (closed) fail("Codex session is closed");
      if (command.type === "core_agent_read" || command.type === "core_agent_command") {
        const id = needString(command.agentId, "agentId");
        if (!agents.has(id)) await discover();
      }
      const threadId = target(command), root = threadId === state.threadId;
      const current = projection(threadId);
      const selectedModel = root ? state.model : nativeSettings.get(threadId)?.model ?? agents.get(threadId)?.model;
      const selectedEffort = root ? state.effort : nativeSettings.get(threadId)?.effort;
      switch (command.type) {
        case "get_state": return { core: "codex", sessionId: root ? options.sessionId : threadId, nativeSessionId: threadId,
          sessionFile: statePath, nativeSessionDurable: !root || Boolean(state.materialized || state.transfer === "complete"),
          sessionName: root ? state.name : agents.get(threadId)?.name,
          model: models.find(model => model.model === selectedModel) ? publicModel(models.find(model => model.model === selectedModel)!, providerFamily()) : { id: selectedModel, provider: providerFamily() },
          thinkingLevel: selectedEffort === "none" ? "off" : selectedEffort,
          live: current.liveState(),
          isStreaming: root ? treeBusy() : threadBusy(threadId), coreBusy: root ? treeBusy() : threadBusy(threadId),
          isCompacting: root ? compactingThreads.size > 0 : compactingThreads.has(threadId),
          treeComplete: !treeBusy(),
          lastAssistantMessage: [...current.entries].reverse().find(entry => entry.message.role === "assistant")?.message,
          pendingMessageCount: 0, messageCount: current.entries.length, autoCompactionEnabled: true,
          contextProjection: "activity", capabilities: { core: "codex", nativeChildren: true, fork: true, compact: true, steer: true },
          unresolvedCommands: Object.entries(state.receipts).filter(([, receipt]) => receipt.state === "pending").map(([id]) => id) };
        case "get_available_models": return { models: models.map(model => publicModel(model, providerFamily())) };
        case "get_available_thinking_levels": return { levels: (models.find(model => model.model === selectedModel)?.supportedReasoningEfforts ?? []).map(value => value.reasoningEffort === "none" ? "off" : value.reasoningEffort) };
        case "get_commands": {
          const list = await call<SkillsListResponse>("skills/list", { cwds: [options.cwd] });
          if (list.data.some(entry => entry.errors.length)) fail("Codex skill discovery reported errors");
          return { commands: [{ name: "compact", description: "Compact native Codex context", source: "extension" },
            ...list.data.flatMap(entry => entry.skills.filter(skill => skill.enabled).map(skill => ({ name: `skill:${skill.name}`, description: skill.description, source: "skill" })))] };
        }
        case "core_agents": await discover(); return { agents: [...agents.values()] };
        case "core_agent_read": {
          const { thread, snapshot } = await readChild(threadId);
          const messages = snapshot.entries.map(entry => entry.message);
          return { agent: agents.get(threadId), messages, state: {
            ...await run({ type: "get_state", agentId: threadId }) as Json,
            isStreaming: active.has(threadId) || thread.status.type === "active",
            messageCount: messages.length,
            lastAssistantMessage: [...messages].reverse().find(message => message.role === "assistant"),
            canAcceptDirectInput: thread.canAcceptDirectInput,
          } };
        }
        case "core_agent_command": {
          if (command.action !== "steer" && command.action !== "abort") fail("Codex child action must be steer or abort");
          if (command.action === "abort") {
            const { thread } = await readChild(threadId);
            if (thread.status.type === "active" && !active.has(threadId)) fail("Codex child has no interruptible active turn");
          }
          const result = await run({ ...command, type: command.action });
          return { ...result as Json, accepted: true, agentId: threadId, action: command.action };
        }
        case "get_messages": case "get_entries": {
          const view = root ? current : (await readChild(threadId)).snapshot;
          if (command.type === "get_messages") return { messages: view.entries.map(entry => entry.message) };
          const since = command.since === undefined ? -1 : view.entries.findIndex(entry => entry.id === command.since);
          if (command.since !== undefined && since < 0) fail("Codex entry not found");
          return { entries: view.entries.slice(since + 1), leafId: view.entries.at(-1)?.id ?? null };
        }
        case "prompt": case "follow_up": case "steer": {
          if (accountingFailure) fail("Codex usage accounting needs repair before starting work");
          const content = await input(command);
          const key = typeof command.workId === "string" ? command.workId : command.id;
          const hash = createHash("sha256").update(JSON.stringify({ threadId, type: command.type, content })).digest("hex");
          if (key && state.receipts[key]) {
            const receipt = state.receipts[key];
            if (receipt.hash !== hash) fail("Codex command ID was reused with different content");
            if (receipt.state === "accepted") return { accepted: true, nativeTurnId: receipt.turnId };
            fail(receipt.state === "pending" ? "Codex command outcome is unknown; inspect native history, do not replay" : "Codex previously rejected this command ID");
          }
          if (compactingThreads.has(threadId)) fail("Codex thread is compacting");
          if (!root) {
            const thread = (await call<{ thread: Thread }>("thread/read", { threadId, includeTurns: false })).thread;
            announce(thread);
            if (thread.canAcceptDirectInput !== true) fail("This native Codex child does not accept direct input");
            await subscribeChild(threadId);
          }
          if (root && treeBusy() && (command.type !== "steer" || !active.has(threadId))) fail("Codex native tree is busy; PiStack must queue follow-up work until idle");
          if (!root && threadBusy(threadId) && command.type !== "steer") fail("Codex thread is busy; PiStack must queue follow-up work until idle");
          if (root) { abortRequested = false; interrupted.clear(); }
          const method = command.type === "steer" && active.has(threadId) ? "turn/steer" : "turn/start";
          const wasMaterialized = state.materialized;
          account!.setActive(true);
          dispatching++;
          try {
            state.materialized = true;
            if (key) state.receipts[key] = { hash, state: "pending" };
            save();
            uncertainThreads.add(threadId);
            reconcileLifecycle();
            const result = await rpc!.request<{ turn?: Turn; turnId?: string }>(method, { threadId, input: content,
              ...(key ? { clientUserMessageId: key } : {}), ...(method === "turn/steer" ? { expectedTurnId: active.get(threadId) } : {}) });
            if (!result.ok) {
              if (result.error.startsWith("Codex rejected")) {
                uncertainThreads.delete(threadId);
                state.materialized = wasMaterialized;
                if (key) state.receipts[key].state = "rejected";
                save();
              }
              fail(result.error);
            }
            const value = (result as { ok: true; value: { turn?: Turn; turnId?: string } }).value;
            const turnId = value.turn?.id ?? value.turnId;
            if (turnId) {
              uncertainThreads.delete(threadId);
              if (!completedTurns.has(turnId)) active.set(threadId, turnId);
            }
            if (key) { state.receipts[key] = { hash, state: "accepted", turnId }; save(); }
            return { accepted: true, nativeTurnId: turnId };
          } finally {
            dispatching--;
            reconcileLifecycle();
          }
        }
        case "abort": {
          if (!root) { await interruptThread(threadId); return { accepted: true }; }
          abortRequested = true;
          let agentIds: string[] = [];
          try {
            await discover();
            agentIds = [threadId, ...agents.keys()];
            const results = await Promise.allSettled(agentIds.map(interruptThread));
            if (results.some(result => result.status === "rejected")) fail("Native tree interrupt was incomplete");
          } catch {
            await close();
            return { accepted: true, agentIds, coreClosed: true, reason: "Native tree stop required app-server shutdown" };
          }
          if (closePromise) await closePromise;
          return { accepted: true, agentIds, coreClosed: closed };
        }
        case "compact": {
          if (command.customInstructions) fail("Codex native compaction does not accept custom instructions");
          if (root ? treeBusy() : threadBusy(threadId)) fail("Wait for the Codex native tree to become idle before compacting");
          if (accountingFailure) fail("Codex usage accounting needs repair before starting work");
          account!.setActive(true);
          dispatching++;
          setCompacting(threadId, true);
          try {
            reconcileLifecycle();
            const result = await rpc!.request("thread/compact/start", { threadId });
            if (!result.ok) {
              if (result.error.startsWith("Codex rejected")) setCompacting(threadId, false, { errorMessage: result.error });
              fail(result.error);
            }
            return { accepted: true };
          } finally {
            dispatching--;
            reconcileLifecycle();
          }
        }
        case "set_model": {
          if (codexProviderFamily(String(command.provider)) !== providerFamily()) fail("Changing provider requires a new Codex thread");
          const model = models.find(model => model.model === command.modelId);
          if (!model) fail("Codex model not found");
          await call("thread/settings/update", { threadId, model: model!.model });
          if (root) { state.model = model!.model; save(); }
          return publicModel(model!, providerFamily());
        }
        case "set_thinking_level": {
          const effort = nativeEffort(needString(command.level, "level"));
          if (!models.find(model => model.model === selectedModel)?.supportedReasoningEfforts.some(value => value.reasoningEffort === effort)) fail("Codex model does not support this reasoning effort");
          await call("thread/settings/update", { threadId, effort });
          if (root) { state.effort = effort; save(); }
          return {};
        }
        case "set_session_name": {
          const name = needString(command.name, "name").trim();
          await call("thread/name/set", { threadId, name });
          if (root) { state.name = name; save(); }
          return {};
        }
        case "fork": {
          if (!root) fail("Forking a native child into a PiStack root is not supported");
          if (treeBusy()) fail("Wait for the Codex native tree to become idle before forking");
          const selected = current.entries.find(entry => entry.id === command.entryId);
          if (!selected || selected.message.role !== "user") fail("Codex fork requires a user-message entry");
          if (selected.nativeTurnId === "transfer") fail("Codex cannot fork inside transferred pre-turn history");
          const first = current.entries.find(entry => entry.nativeTurnId === selected.nativeTurnId && entry.message.role === "user");
          if (first?.id !== selected.id) fail("Codex forks at turn boundaries; a mid-turn steering message cannot be edited separately");
          const fork = await call<ThreadStartResponse>("thread/fork", { threadId, beforeTurnId: selected.nativeTurnId, deferGoalContinuation: true });
          state.threadId = fork.thread.id; state.receipts = {}; save();
          await call("thread/unsubscribe", { threadId });
          const next = projection(state.threadId); next.restore(await turns(state.threadId), state.transferProjection);
          emit({ type: "conversation_replaced", messages: next.entries.map(entry => entry.message) });
          next.context();
          agents.clear(); await discover();
          return { cancelled: false, text: selected.message.content.filter(part => part.type === "text").map(part => part.text).join("\n"), nativeSessionId: state.threadId };
        }
        default: return fail(`Codex core does not support ${command.type}`);
      }
    };
    let commands = Promise.resolve();
    return {
      command(command) {
        const work = commands.then(async () => {
          handlingCommand = true;
          try {
            const data = await run(command);
            reconcileLifecycle();
            emit({ type: "response", id: command.id, command: command.type, success: true, data });
          } catch (error) { emit({ type: "response", id: command.id, command: command.type, success: false,
            error: error instanceof Failure ? error.message : "Codex command failed" }); }
          finally {
            handlingCommand = false;
            if (pendingExit) { const { code } = pendingExit; pendingExit = undefined; notifyExit(code); }
          }
        });
        commands = work;
        return work;
      },
      close,
    };
  };
}

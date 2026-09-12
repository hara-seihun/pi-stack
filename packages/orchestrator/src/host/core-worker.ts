import { createHash } from "node:crypto";
import type { CoreCommand, CoreExecutionSnapshot, CoreOutput, CoreSessionOptions, OpenCoreSession } from "../cores/contracts.js";
import { CoreController } from "../cores/controller.js";
import type { Run, RunActivity } from "../domain.js";
import { isCredentialError, isRateLimitError } from "../provider-errors.js";

type Json = Record<string, any>;
type Post = (path: string, value?: unknown) => Promise<any>;
export interface WorkerState extends Json {
  execution: CoreExecutionSnapshot;
  nativeSessionId?: string;
  portableSessionFile?: string;
  sessionFile?: string;
}

export function coreOptions(run: Run, env: NodeJS.ProcessEnv): CoreSessionOptions {
  if (!run.coreStateDir) throw new Error("Run has no pinned core state directory; recover it with its recorded worker release");
  if (run.core === "codex" && run.context) throw new Error("Codex core does not support isolated tools/extensions contracts");
  const args = ["--core", run.core ?? "pi", "--provider", run.provider!, "--model", run.model!];
  if (run.thinking) args.push("--thinking", run.thinking);
  if (run.sessionFile) args.push("--session", run.sessionFile);
  if (run.context) args.push("--orchestrator-context", JSON.stringify(run.context));
  return {
    cwd: run.cwd, args, sessionId: run.id, stateDir: run.coreStateDir,
    env: { ...env, PI_STACK_CORE: run.core ?? "pi", PI_ORCHESTRATOR_CORE_USAGE: "worker", PI_ORCHESTRATOR_ASSIGNED: "1", PI_ORCHESTRATOR_RUN_ID: run.id,
      PI_ORCHESTRATOR_NATIVE_SESSION_ID: run.nativeSessionId, PI_ORCHESTRATOR_PROVIDER: run.provider,
      PI_ORCHESTRATOR_ACCOUNT_ID: run.accountId },
  };
}

export function assistantUsage(event: CoreOutput): Json | undefined {
  if (event.type === "core_child_event" && event.event) {
    const child = assistantUsage(event.event as CoreOutput);
    if (child) return { ...child, receiptId: createHash("sha256").update(`${event.agentId}:${child.receiptId}`).digest("hex") };
    return;
  }
  if (event.type !== "message_end" || event.usageRecorded === true) return;
  const message = event.message as Json | undefined;
  if (message?.role !== "assistant" || !message.usage) return;
  return { receiptId: createHash("sha256").update(JSON.stringify(message)).digest("hex"), accountId: message.provider, model: message.model, usage: message.usage };
}

export async function runCoreWorker(run: Run, options: CoreSessionOptions, open: OpenCoreSession, post: Post, request: (path: string) => Promise<any>): Promise<void> {
  const root = `/internal/runs/${run.id}`;
  let liveText = "", liveThinking = "", activeTool: string | undefined, activity: RunActivity = "STARTING";
  let dirty = true, progress = true, aborting = false;
  let effects = Promise.resolve(), effectFailure: unknown, providerFailure = false;
  let blockedReason: string | undefined;
  let changed: (() => void) | undefined;
  const enqueue = (operation: () => Promise<unknown>): void => { effects = effects.then(operation).then(() => {}, error => { effectFailure ??= error; }); };
  const wire = new CoreController(event => {
    if (event.type === "core_error" && event.willRetry !== true) effectFailure ??= new Error(String(event.error ?? "Core failed"));
    if (event.type === "message_update") {
      const update = event.assistantMessageEvent as Json | undefined;
      activity = "WORKING";
      if (update?.type === "text_delta") liveText += update.delta ?? "";
      else if (update?.type === "thinking_start") { liveThinking = ""; activity = "THINKING"; }
      else if (update?.type === "thinking_delta") { liveThinking += update.delta ?? ""; activity = "THINKING"; }
    } else if (event.type === "tool_execution_start") { activeTool = String(event.toolName ?? "tool"); activity = "WAITING_ON_TOOL"; }
    else if (event.type === "tool_execution_end") { activeTool = undefined; activity = "WORKING"; }
    else if (event.type === "message_end") { liveText = ""; liveThinking = ""; activity = "WORKING"; }
    else if (event.type === "compaction_start") activity = "COMPACTING";
    const usage = assistantUsage(event);
    if (usage) enqueue(() => post(`${root}/usage`, usage));
    dirty = true; progress = true;
    changed?.();
  });
  const command = async (type: CoreCommand["type"], fields: Omit<CoreCommand, "type"> = {}): Promise<any> => {
    const outcome = await wire.request(type, fields);
    if (!outcome.ok) {
      if (outcome.error.kind === "unknown" || outcome.error.kind === "unsupported") blockedReason = outcome.error.message;
      throw new Error(outcome.error.message);
    }
    return outcome.value;
  };
  const workId = `run:${run.id}:initial`;
  let reporting = false, controlling = false;
  const heartbeat = async (): Promise<void> => {
    if (reporting || !dirty) return;
    reporting = true;
    const payload = { progress, activity, text: liveText, thinking: liveThinking, tool: activeTool };
    dirty = false; progress = false;
    try { await post(`${root}/heartbeat`, payload); }
    catch (error) { dirty = true; progress ||= payload.progress; effectFailure ??= error; }
    finally { reporting = false; }
  };
  let references = "", nativeSessionId = run.nativeSessionId;
  const state = async (): Promise<WorkerState> => {
    const value = await command("get_state", { workId }) as WorkerState;
    if (value.core !== (run.core ?? "pi")) throw new Error("Factory opened a different core than the run's pinned core");
    if (typeof value.nativeSessionId !== "string" || !value.nativeSessionId) throw new Error("Core get_state did not identify its native session");
    if (nativeSessionId && nativeSessionId !== value.nativeSessionId) throw new Error("Core recovery replaced the run's recorded native session");
    if (value.nativeSessionDurable !== false) nativeSessionId = value.nativeSessionId;
    const refs = { sessionFile: value.sessionFile, nativeSessionId, portableSessionFile: value.portableSessionFile ?? value.portableFile };
    const encoded = JSON.stringify(refs);
    if (encoded !== references) { await post(`${root}/state`, refs); references = encoded; }
    return value;
  };
  let reportTimer: ReturnType<typeof setInterval> | undefined, heartbeatTimer: ReturnType<typeof setInterval> | undefined, controlTimer: ReturnType<typeof setInterval> | undefined;
  const stopTimers = () => { clearInterval(reportTimer); clearInterval(heartbeatTimer); clearInterval(controlTimer); };
  try {
    wire.session = await open(options, wire.output, wire.exit);
    let current = await state();
    if (run.context) {
      const selected = current.context;
      if (!selected || JSON.stringify(selected.tools) !== JSON.stringify(run.context.tools) || JSON.stringify(selected.extensions ?? []) !== JSON.stringify(run.context.extensions ?? [])) {
        throw new Error("Core did not confirm the requested isolated tools/extensions contract; refusing to prompt");
      }
    }
    await post(`${root}/state`, { state: "running", progressAt: Date.now(), activity });
    reportTimer = setInterval(() => { void heartbeat(); }, 250);
    heartbeatTimer = setInterval(() => { dirty = true; }, 15_000);
    controlTimer = setInterval(() => {
      if (controlling) return;
      controlling = true;
      enqueue(async () => {
        try {
          const control = await request(`${root}/control`);
          if (control.abort && !aborting) {
            aborting = true;
            const dispatched = await wire.dispatch({ kind: "abort", workId: `run:${run.id}:abort` });
            if (!dispatched.ok) {
              if (dispatched.error.kind === "unknown" || dispatched.error.kind === "unsupported") blockedReason = dispatched.error.message;
              throw new Error(dispatched.error.message);
            }
          }
          if (control.steer && !aborting) {
            if (!control.steerWorkId) throw new Error("Fleet steer requires its own durable work identity");
            const dispatched = await wire.dispatch({ workId: control.steerWorkId, kind: "steer", message: String(control.steer) });
            if (!dispatched.ok) {
              if (dispatched.error.kind === "unknown" || dispatched.error.kind === "unsupported") blockedReason = dispatched.error.message;
              throw new Error(dispatched.error.message);
            }
          }
          if (control.results?.length) throw new Error("External child results belong to the recorded coordinator worker release, not a core-owned run");
        } finally { controlling = false; }
      });
    }, 2_000);
    if (!current.execution.operations.some(operation => operation.workId === workId)) {
      if (current.execution.operations.length) {
        blockedReason = "Recovered run has no receipt for its requested work; native reconciliation is required";
        throw new Error(blockedReason);
      }
      const dispatched = await wire.dispatch({ workId, kind: "prompt", message: run.prompt });
      if (!dispatched.ok) {
        if (dispatched.error.kind === "unknown" || dispatched.error.kind === "unsupported") blockedReason = dispatched.error.message;
        throw new Error(dispatched.error.message);
      }
      current = await state();
    }
    while (current.execution.status !== "idle") {
      if (current.execution.status === "blocked") {
        blockedReason = `Core execution is blocked: ${current.execution.operations.filter(operation => operation.state === "unknown").map(operation => `${operation.workId}: ${operation.error ?? "unknown outcome"}`).join("; ")}`;
        throw new Error(blockedReason);
      }
      if (effectFailure) throw effectFailure;
      await new Promise<void>(resolve => {
        const timer = setTimeout(() => { changed = undefined; resolve(); }, 1_000);
        changed = () => { clearTimeout(timer); changed = undefined; resolve(); };
      });
      current = await state();
    }
    stopTimers();
    await effects;
    if (effectFailure) throw effectFailure;
    await heartbeat();
    const operation = current.execution.operations.find(operation => operation.workId === workId);
    if (!operation) throw new Error(`Core lost execution receipt ${workId}`);
    if (operation.state === "failed") { providerFailure = true; throw new Error(operation.error ?? "Core operation failed"); }
    if (operation.state === "cancelled") {
      const closed = await wire.close();
      if (!closed.ok) throw new Error(closed.error.message);
      await post(`${root}/state`, { state: "aborted", failureKind: "operator", result: "aborted" });
      return;
    }
    if (operation.state !== "succeeded") throw new Error(`Core did not settle ${workId}: ${operation.state}`);
    const closed = await wire.close();
    if (!closed.ok) throw new Error(closed.error.message);
    await post(`${root}/state`, { state: "done", result: operation.result?.text ?? "" });
  } catch (error) {
    stopTimers();
    await effects;
    let detail = String(error);
    const cleanup = await wire.close();
    if (!cleanup.ok) detail += `; core cleanup failed: ${cleanup.error.message}`;
    if (blockedReason) {
      await post(`${root}/state`, { state: "waiting", result: detail });
      return;
    }
    const account = isRateLimitError(detail) || isCredentialError(detail);
    await post(`${root}/state`, { state: aborting ? "aborted" : "failed", failureKind: aborting ? "operator" : account ? "account" : providerFailure ? "provider" : "infrastructure", result: detail,
      ...(account ? { cooldownUntil: Date.now() + 30 * 60_000 } : {}) });
  } finally {
    stopTimers();
    await effects;
    await wire.close();
  }
}

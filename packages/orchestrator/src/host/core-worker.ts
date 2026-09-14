import { createHash, randomUUID } from "node:crypto";
import type { CoreCommand, CoreOutput, CoreSession, CoreSessionOptions, OpenCoreSession } from "../cores/contracts.js";
import type { Run, RunActivity } from "../domain.js";
import { interruptedTurnPrompt } from "./continuations.js";
import { isCredentialError, isRateLimitError } from "../provider-errors.js";

type Json = Record<string, any>;
type Post = (path: string, value?: unknown) => Promise<any>;
export interface WorkerState extends Json {
  treeComplete: boolean;
  nativeSessionId?: string;
  portableSessionFile?: string;
  sessionFile?: string;
  lastAssistantMessage?: Json;
}

export function coreOptions(run: Run, env: NodeJS.ProcessEnv): CoreSessionOptions {
  if (run.execution === "root-repair" && run.context) throw new Error("Root-repair workers require the full normal Pi context");
  if (!run.coreStateDir) throw new Error("Run has no pinned core state directory; recover it with its recorded worker release");
  if (run.core !== undefined && run.core !== "pi") throw new Error("Run needs its saved conversation imported into Pi before reopening");
  const args = ["--provider", run.provider!, "--model", run.model!];
  if (run.thinking) args.push("--thinking", run.thinking);
  if (run.sessionFile) args.push("--session", run.sessionFile);
  if (run.context) args.push("--orchestrator-context", JSON.stringify(run.context));
  return {
    cwd: run.cwd, args, sessionId: run.id, stateDir: run.coreStateDir,
    env: { ...env, PI_ORCHESTRATOR_EXECUTION: run.execution ?? "user", PI_ORCHESTRATOR_CORE_USAGE: "worker", PI_ORCHESTRATOR_ASSIGNED: "1", PI_ORCHESTRATOR_RUN_ID: run.id,
      PI_ORCHESTRATOR_NATIVE_SESSION_ID: run.nativeSessionId, PI_ORCHESTRATOR_PROVIDER: run.provider,
      PI_ORCHESTRATOR_ACCOUNT_ID: run.accountId },
  };
}

class CoreWire {
  session?: CoreSession;
  private readonly instance = randomUUID();
  private sequence = 0;
  private pending = new Map<string, { resolve(value: any): void; reject(error: Error): void }>();
  private failure?: Error;
  private closePromise?: Promise<void>;
  constructor(private readonly event: (event: CoreOutput) => void) {}
  output = (event: CoreOutput): void => {
    if (event.type !== "response") { this.event(event); return; }
    const waiter = this.pending.get(String(event.id));
    if (!waiter) return;
    this.pending.delete(String(event.id));
    if (event.success === false) waiter.reject(new Error(String(event.error ?? `Core command ${event.command} failed`)));
    else waiter.resolve(event.data);
  };
  exit = (code?: number): void => {
    this.failure = new Error(`Core process exited before worker close (${code ?? "unknown"})`);
    for (const waiter of this.pending.values()) waiter.reject(this.failure);
    this.pending.clear();
    this.event({ type: "core_exit" });
  };
  async command(type: string, fields: Json = {}): Promise<any> {
    if (this.failure) throw this.failure;
    const id = fields.id ?? `worker-${this.instance}-${++this.sequence}`;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const response = new Promise<any>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      if (type !== "prompt") timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`Core ${type} response timed out`)); }, 30_000);
    });
    // Attach the rejection handler before command(), which may emit a response synchronously.
    const waiting = response.finally(() => { if (timer) clearTimeout(timer); });
    void waiting.catch(() => {});
    try { await this.session!.command({ ...fields, type, id } as CoreCommand); }
    catch (error) { this.pending.get(id)?.reject(error instanceof Error ? error : new Error(String(error))); this.pending.delete(id); }
    return waiting;
  }
  close(): Promise<void> {
    return this.closePromise ??= Promise.resolve().then(async () => {
      for (const waiter of this.pending.values()) waiter.reject(new Error("Worker closed"));
      this.pending.clear();
      await this.session?.close();
    });
  }
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
  let dirty = true, progress = true, aborting = false, compactionFailure: string | undefined;
  let effects = Promise.resolve(), effectFailure: unknown, providerFailure = false;
  let changed: (() => void) | undefined;
  const enqueue = (operation: () => Promise<unknown>): void => { effects = effects.then(operation).then(() => {}, error => { effectFailure ??= error; }); };
  const wire = new CoreWire(event => {
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
    else if (event.type === "compaction_end") {
      if (event.result) compactionFailure = undefined;
      else if (event.errorMessage) compactionFailure = String(event.errorMessage);
    }
    const usage = assistantUsage(event);
    if (usage) enqueue(() => post(`${root}/usage`, usage));
    dirty = true; progress = true;
    changed?.();
  });
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
    const value = await wire.command("get_state") as WorkerState;
    if (typeof value?.treeComplete !== "boolean") throw new Error("Core get_state must report authoritative treeComplete");
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
          if (control.abort && !aborting) { aborting = true; await wire.command("abort"); }
          if (control.steer && !aborting) await wire.command("steer", { message: String(control.steer) });
          if (control.results?.length) throw new Error("External child results belong to the recorded coordinator worker release, not a core-owned run");
        } finally { controlling = false; }
      });
    }, 2_000);
    if (current.terminalError) throw new Error(String(current.terminalError));
    if (current.unresolvedCommands?.length) throw new Error(`Core has unresolved dispatch outcomes: ${current.unresolvedCommands.join(", ")}`);
    const recovered = Boolean(current.messageCount > 0 || current.lastAssistantMessage);
    const interrupted = current.lastAssistantMessage?.stopReason === "aborted";
    // Native interruption records process loss as well as operator cancellation.
    // The durable fleet control, not that native status, owns cancellation intent.
    if (interrupted) aborting = Boolean((await request(`${root}/control`)).abort);
    const active = current.coreBusy || current.isStreaming || current.isCompacting || current.pendingMessageCount > 0 || current.agents?.some((agent: Json) => agent.state === "running");
    const repairing = run.result === "recovering the recorded core session after infrastructure repair";
    if (!aborting && !active && (!recovered || !current.lastAssistantMessage || !current.treeComplete || interrupted || repairing)) {
      await wire.command("prompt", { ...(!recovered ? { id: `run:${run.id}:initial` } : {}),
        workId: !recovered ? `run:${run.id}:initial` : `run:${run.id}:continue:${current.nativeSessionId}:${current.messageCount}`,
        message: recovered
        ? interruptedTurnPrompt("the process hosting this session stopped", "I reopened this run's recorded core session.")
        : run.prompt });
      current = await state();
    }
    // Prompt acknowledgement is not settlement. The root may have stopped while its children continue.
    while (!current.treeComplete) {
      if (effectFailure) throw effectFailure;
      await new Promise<void>(resolve => {
        const timer = setTimeout(() => { changed = undefined; resolve(); }, 1_000);
        changed = () => { clearTimeout(timer); changed = undefined; resolve(); };
      });
      current = await state();
    }
    stopTimers();
    const finalUsage = assistantUsage({ type: "message_end", message: current.lastAssistantMessage, usageRecorded: current.usageRecorded });
    if (finalUsage) enqueue(() => post(`${root}/usage`, finalUsage));
    await effects;
    if (effectFailure) throw effectFailure;
    await heartbeat();
    const last = current.lastAssistantMessage;
    if (current.terminalError) throw new Error(String(current.terminalError));
    if (compactionFailure && !aborting) { providerFailure = true; throw new Error(compactionFailure); }
    if (last?.stopReason === "error") { providerFailure = true; throw new Error(last.errorMessage ?? "Provider failed"); }
    if (last?.stopReason === "aborted" && !aborting) aborting = Boolean((await request(`${root}/control`)).abort);
    if (last?.stopReason === "aborted" && !aborting) throw new Error("Core turn interrupted without an operator abort");
    if (aborting) {
      await wire.close();
      await post(`${root}/state`, { state: "aborted", failureKind: "operator", result: "aborted" });
      return;
    }
    if (!last) throw new Error("Core completed its tree without a final assistant result");
    const result = Array.isArray(last.content) ? last.content.filter((part: Json) => part.type === "text").map((part: Json) => String(part.text ?? "")).join("").trim() : "";
    await wire.close();
    await post(`${root}/state`, { state: "done", result });
  } catch (error) {
    stopTimers();
    await effects;
    let detail = String(error);
    try { await wire.close(); } catch (cleanup) { detail += `; core cleanup failed: ${String(cleanup)}`; }
    const account = isRateLimitError(detail) || isCredentialError(detail);
    await post(`${root}/state`, { state: aborting ? "aborted" : "failed", failureKind: aborting ? "operator" : account ? "account" : providerFailure ? "provider" : "infrastructure", result: detail,
      ...(account ? { cooldownUntil: Date.now() + 30 * 60_000 } : {}) });
  } finally {
    stopTimers();
    await effects;
    await wire.close();
  }
}

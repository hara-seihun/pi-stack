import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { closeSync, existsSync, fstatSync, openSync, readFileSync, readSync, watch } from "node:fs";
import { join } from "node:path";
import { Type } from "typebox";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { BeforeToolCallContext } from "@earendil-works/pi-agent-core";
import { checkpointPiSession } from "./pi-session-file.js";
import { managerCommand } from "./runner-resources.js";
import { parseBashWorkerReceipt } from "./pi-bash-receipt.js";

type Tool = AgentSession["agent"]["state"]["tools"][number];
type OperationError = "failed" | "cancelled" | "timed_out" | "uncertain";
type ToolResult = Awaited<ReturnType<Tool["execute"]>> & { isError?: boolean; operationError?: OperationError };
type Outcome = { kind: "complete"; result: ToolResult } | { kind: OperationError; error: string; result?: ToolResult };
type Initial = "attached" | "running" | "final";
export type BashWorkerOwner = { kind: "bash-worker"; directory: string; unit: string; user: boolean };
export const piOperationContext = new AsyncLocalStorage<{ operationId: string; sessionFile: string; own(owner: BashWorkerOwner): void }>();
type Operation = { operationId: string; toolCallId: string; toolName: string; digest: string; initial: Initial;
  state: "accepted" | "running" | "terminal"; outcome?: Outcome; sessionFile: string; owner?: BashWorkerOwner };
type LiveOperation = { record: Operation; controller: AbortController; done: Promise<void>; release(): void; partial?: ToolResult };
export type OperationCompletion = { type: "tool_operation_result"; operationId: string; toolCallId: string;
  workId: string; message: string; outcome: Outcome; result?: ToolResult };

/** Operation custody outlives Pi's observation of it. The native transcript is the ledger. */
export class PiExecution {
  private readonly runs = new AsyncLocalStorage<AbortSignal>();
  private readonly pending = new Set<Promise<unknown>>();
  private readonly operations = new Map<string, LiveOperation>();
  private readonly records = new Map<string, Operation>();
  private controller = new AbortController();
  private halting?: Promise<void>;
  private released = false;
  private serialTail: Promise<void> = Promise.resolve();
  private observers = new Set<() => void>();
  private session?: AgentSession;
  private readonly bound = new WeakSet<AgentSession>();
  private readonly prepared = new Map<string, BeforeToolCallContext>();
  private beforeToolCall?: AgentSession["agent"]["beforeToolCall"];
  private afterToolCall?: AgentSession["agent"]["afterToolCall"];
  private toolAdmission?: (toolName: string) => boolean;

  setToolAdmission(admit: (toolName: string) => boolean): void { this.toolAdmission = admit; }

  constructor(private readonly onIdle: () => void = () => {},
    private readonly onCompletion: (event: OperationCompletion) => void = () => {}) {}

  get boundSession() { return this.session; }
  get blocked() { return this.controller.signal.aborted; }
  get activeTools() { return this.operations.size; }
  get active() { return this.pending.size > 0; }

  private save(record: Operation): void {
    const session = this.session!;
    session.sessionManager.appendCustomEntry("tool_operation", { ...record });
    checkpointPiSession(session.sessionManager);
    this.records.set(record.operationId, record);
  }

  private completion(record: Operation): OperationCompletion {
    const outcome = record.outcome!;
    const result = outcome.result;
    const text = result ? result.content.filter(part => part.type === "text").map(part => part.text).join("\n") : outcome.kind === "complete" ? "" : outcome.error;
    return { type: "tool_operation_result", operationId: record.operationId, toolCallId: record.toolCallId,
      workId: `operation:${record.operationId}:terminal`, outcome, result,
      message: `Tool operation ${record.operationId} (${record.toolName}, call ${record.toolCallId}) ${outcome.kind}.\n${text}\nFull result is recorded in ${record.sessionFile}; inspect with tool_operation({action:"inspect",operationId:"${record.operationId}"}). Do not rerun the original operation.` };
  }

  flushCompletions(): void {
    for (const record of this.records.values()) if (record.state === "terminal" && record.initial === "running") this.onCompletion(this.completion(record));
  }

  inspectionTool(): Tool {
    return { name: "tool_operation", label: "Tool operation", description: "Inspect or explicitly cancel a durable tool operation. Inspection does not consume its automatic completion.",
      parameters: Type.Object({ action: Type.Union([Type.Literal("inspect"), Type.Literal("cancel")]), operationId: Type.String({ minLength: 1 }) }),
      execute: async (_id, input: unknown) => {
        const args = input as { action: "inspect" | "cancel"; operationId: string };
        const result = args.action === "inspect" ? this.inspect(args.operationId) : this.cancel(args.operationId);
        return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
      },
    };
  }

  inspect(operationId: string) {
    const record = this.records.get(operationId);
    return record ? { ok: true as const, value: { ...record, partial: this.operations.get(operationId)?.partial } }
      : { ok: false as const, error: { code: "operation_missing", message: `Unknown operation ${operationId}` } };
  }

  cancel(operationId: string) {
    const record = this.records.get(operationId);
    if (!record) return { ok: false as const, error: { code: "operation_missing", message: `Unknown operation ${operationId}` } };
    const live = this.operations.get(operationId);
    if (live) live.controller.abort(new Error("Explicit tool operation cancellation"));
    return { ok: true as const, value: { operationId, state: record.state, cancellationRequested: !!live } };
  }

  /** Call only after the complete input batch has entered Pi's steering queue. */
  releaseObservations(): void {
    this.released = true;
    for (const release of this.observers) release();
    this.observers.clear();
  }

  private track<T>(operation: () => Promise<T>): Promise<T> {
    const pending = this.run(() => Promise.resolve().then(() => { this.assertCurrent(); return operation(); }));
    this.pending.add(pending);
    const release = () => { this.pending.delete(pending); if (!this.active) queueMicrotask(this.onIdle); };
    void pending.then(release, release);
    return pending;
  }

  private handle(record: Operation): ToolResult {
    return { content: [{ type: "text", text: `Tool ${record.toolName} is ${record.state === "accepted" ? "queued" : record.state === "terminal" ? "finished (terminal receipt available)" : "running"} as ${record.operationId}. Inspect with tool_operation({action:"inspect",operationId:"${record.operationId}"}). Its final result will arrive automatically. Do not rerun the operation.` }],
      details: { operationId: record.operationId, toolCallId: record.toolCallId, state: record.state, resultRef: record.sessionFile } };
  }

  private final(record: Operation): ToolResult {
    if (record.outcome?.result) return record.outcome.result;
    throw new Error(record.outcome?.kind === "complete" ? "Tool operation has no final result" : record.outcome?.error ?? "Tool operation has no terminal outcome");
  }

  private async execute(tool: Tool, args: Parameters<Tool["execute"]>): Promise<ToolResult> {
    const [toolCallId, parameters, , onUpdate] = args;
    const session = this.session!;
    const operationId = `OP-${createHash("sha256").update(`${session.sessionId}:${toolCallId}`).digest("hex").slice(0, 32)}`;
    const digest = createHash("sha256").update(JSON.stringify({ tool: tool.name, parameters })).digest("hex");
    let record = this.records.get(operationId);
    if (record) {
      if (record.digest !== digest) throw new Error("tool_operation_identity_conflict");
      if (record.initial === "final") return this.final(record);
      if (record.initial === "running") return this.handle(record);
    }
    let live = this.operations.get(operationId);
    if (!record) {
      record = { operationId, toolCallId, toolName: tool.name, digest, initial: "attached", state: "accepted", sessionFile: session.sessionFile! };
      this.save(record);
      const controller = new AbortController();
      let complete!: () => void;
      live = { record, controller, done: new Promise(resolve => { complete = resolve; }), release: complete };
      this.operations.set(operationId, live);
      const current = live;
      const sequential = session.agent.toolExecution === "sequential" || tool.executionMode === "sequential";
      const before = sequential ? Promise.all([...this.operations.values()].filter(operation => operation !== current).map(operation => operation.done)).then(() => {}) : this.serialTail;
      if (sequential) this.serialTail = current.done;
      // Resource ordering belongs to raw operations, not the yielded Pi wrapper.
      void piOperationContext.run({ operationId, sessionFile: record.sessionFile, own: owner => { current.record.owner = owner; this.save(current.record); } },
        () => before.then(() => {
          controller.signal.throwIfAborted();
          current.record.state = "running";
          this.save(current.record);
          return this.executeRaw(tool, toolCallId, parameters, controller.signal, partial => {
            current.partial = partial;
            if (current.record.state !== "terminal" && current.record.initial === "attached") onUpdate?.(partial);
          });
        })).then(result => this.finish(current, result.isError ? { kind: result.operationError ?? "failed", result,
          error: result.content.filter(part => part.type === "text").map(part => part.text).join("\n") } : { kind: "complete", result }), error => this.finish(current,
        { kind: controller.signal.aborted ? "cancelled" : (error as { code?: string })?.code === "owner_lost" ? "uncertain"
          : /^Error: timeout:/.test(String(error)) ? "timed_out" : "failed", error: String(error) }));
    }
    if (!live) {
      record!.initial = "final";
      this.save(record!);
      return this.final(record!);
    }
    let release!: () => void;
    const yielded = new Promise<void>(resolve => { release = resolve; this.observers.add(resolve); });
    if (this.released) release();
    try {
      await Promise.race([live.done, yielded]);
      // Selection and terminal transition are synchronous under this one event-loop owner.
      if (record!.state === "terminal") { record!.initial = "final"; this.save(record!); return this.final(record!); }
      record!.initial = "running";
      this.save(record!);
      return this.handle(record!);
    } finally { this.observers.delete(release); }
  }

  private async executeRaw(tool: Tool, id: string, parameters: unknown, signal: AbortSignal, onUpdate: (partial: ToolResult) => void): Promise<ToolResult> {
    if (this.toolAdmission && !this.toolAdmission(tool.name)) throw new Error("Tool is outside this thread role");
    const prepared = this.prepared.get(id);
    this.prepared.delete(id);
    if (!prepared) return tool.execute(id, parameters, signal, onUpdate);
    const errorResult = (error: unknown): ToolResult => ({ content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }], details: undefined, isError: true,
      operationError: signal.aborted ? "cancelled" : (error as { code?: string })?.code === "owner_lost" ? "uncertain" : /^Error: timeout:/.test(String(error)) ? "timed_out" : "failed" });
    try {
      const admitted = await this.beforeToolCall?.(prepared, signal);
      if (admitted?.block) return { ...errorResult(admitted.reason ?? "Tool execution blocked"), ...(admitted.terminate === undefined ? {} : { terminate: admitted.terminate }) };
      signal.throwIfAborted();
    } catch (error) { return errorResult(error); }
    let result: ToolResult;
    try { result = await tool.execute(id, prepared.args, signal, onUpdate); }
    catch (error) { result = errorResult(error); }
    try {
      const transformed = await this.afterToolCall?.({ ...prepared, result, isError: result.isError === true }, signal);
      if (transformed) result = { ...result,
        content: transformed.content ?? result.content, details: transformed.details ?? result.details,
        usage: transformed.usage ?? result.usage, terminate: transformed.terminate ?? result.terminate,
        isError: transformed.isError ?? result.isError,
      };
    } catch (error) { result = errorResult(error); }
    return result;
  }

  private recoverBash(record: Operation): void {
    const owner = record.owner!;
    const controller = new AbortController();
    let complete!: () => void;
    const live: LiveOperation = { record, controller, done: new Promise(resolve => { complete = resolve; }), release: () => complete() };
    this.operations.set(record.operationId, live);
    const status = join(owner.directory, "result.json");
    const read = (): boolean => {
      if (!existsSync(status)) return false;
      const parsed = parseBashWorkerReceipt(readFileSync(status, "utf8"));
      if (!parsed.ok) { this.finish(live, { kind: "uncertain", error: parsed.error }); return true; }
      const receipt = parsed.value;
      const outputPath = join(owner.directory, "output.log");
      const fd = openSync(outputPath, "r");
      let text: string;
      try {
        const size = fstatSync(fd).size;
        const bytes = Buffer.alloc(Math.min(size, 50_000));
        readSync(fd, bytes, 0, bytes.length, Math.max(0, size - bytes.length));
        text = bytes.toString("utf8");
      } finally { closeSync(fd); }
      const outcome: Outcome = receipt.cleanupError ? { kind: "uncertain", error: receipt.cleanupError }
        : receipt.cancelled || receipt.timedOut ? { kind: receipt.timedOut ? "timed_out" : "cancelled", error: `${text}\n${receipt.timedOut ? "Command timed out" : "Command cancelled"}` }
        : receipt.exitCode !== 0 ? { kind: "failed", error: `${text}\nCommand exited with code ${receipt.exitCode}` }
        : { kind: "complete", result: { content: [{ type: "text", text: text || "(no output)" }], details: { fullOutputPath: join(owner.directory, "output.log"), exitCode: receipt.exitCode } } };
      this.finish(live, outcome);
      return true;
    };
    if (read()) return;
    let closed = false;
    const watcher = watch(owner.directory, () => { if (!closed && read()) close(); });
    const close = () => { closed = true; watcher.close(); clearInterval(reconcile); };
    const checkOwner = () => {
      if (closed) return;
      void managerCommand(["show", owner.unit, "--property=ActiveState", "--value"], process.env, owner.user).then(status => {
        if (closed) return;
        if (read()) { close(); return; }
        if (!["active", "activating", "deactivating"].includes(status.stdout.trim())) {
          close(); this.finish(live, { kind: "uncertain", error: `owner_lost: ${owner.unit} disappeared without a result; effects may have occurred. Never replay this operation.` });
        }
      }, error => { if (!closed) { close(); this.finish(live, { kind: "uncertain", error: `Worker ownership could not be recovered: ${String(error)}` }); } });
    };
    const reconcile = setInterval(checkOwner, 5000);
    // A worker may commit between the first check and observer registration.
    if (read()) close(); else checkOwner();
    controller.signal.addEventListener("abort", () => {
      import("node:fs").then(fs => fs.writeFileSync(join(owner.directory, "cancel"), "explicit cancellation\n", { mode: 0o600 }));
    }, { once: true });
  }

  private finish(live: LiveOperation, outcome: Outcome): void {
    const record = live.record;
    record.state = "terminal";
    record.outcome = outcome;
    // The terminal entry also owns the completion outbox; emission is retryable by stable workId.
    this.save(record);
    this.operations.delete(record.operationId);
    live.release();
    if (record.initial === "running") this.onCompletion(this.completion(record));
    queueMicrotask(this.onIdle);
  }

  bind(session: AgentSession): void {
    if (this.bound.has(session)) return;
    if (this.operations.size) throw new Error("Cannot replace a Pi tool context while operations still own it");
    if (!session.sessionFile || typeof session.sessionManager?.getEntries !== "function") throw new Error("Native tool operation custody requires a durable SDK SessionManager");
    this.bound.add(session);
    this.session = session;
    this.records.clear();
    for (const entry of session.sessionManager.getEntries()) if (entry.type === "custom" && entry.customType === "tool_operation") {
      const record = entry.data as Operation;
      this.records.set(record.operationId, record);
    }
    for (const record of this.records.values()) if (record.state !== "terminal") {
      if (record.owner?.kind === "bash-worker") this.recoverBash(record);
      else this.save({ ...record, state: "terminal", outcome: { kind: "uncertain", error: "owner_lost: admitted executor disappeared; effects may have occurred. This operation will not be replayed." } });
    }
    const branch = session.sessionManager.getBranch();
    const calls = new Set(branch.flatMap(entry => entry.type === "message" && entry.message.role === "assistant" ? entry.message.content.flatMap(part => part.type === "toolCall" ? [part.id] : []) : []));
    const resolvedCalls = new Set(branch.flatMap(entry => entry.type === "message" && entry.message.role === "toolResult" ? [entry.message.toolCallId] : []));
    // A predecessor can have persisted a tool call without an operation ledger or final
    // result. Absence of its result proves nothing about effects: never invoke it on adoption.
    const ownedCalls = new Set([...this.records.values()].map(record => record.toolCallId));
    for (const entry of branch) if (entry.type === "message" && entry.message.role === "assistant") for (const call of entry.message.content) {
      if (call.type !== "toolCall" || resolvedCalls.has(call.id) || ownedCalls.has(call.id)) continue;
      const operationId = `OP-${createHash("sha256").update(`${session.sessionId}:${call.id}`).digest("hex").slice(0, 32)}`;
      const record: Operation = { operationId, toolCallId: call.id, toolName: call.name,
        digest: createHash("sha256").update(JSON.stringify({ tool: call.name, parameters: call.arguments })).digest("hex"),
        initial: "attached", state: "terminal", sessionFile: session.sessionFile,
        outcome: { kind: "uncertain", error: "owner_lost: predecessor tool call has no terminal receipt. Effects may have occurred; it will not be replayed." } };
      this.save(record); ownedCalls.add(call.id);
    }
    for (const record of this.records.values()) if (calls.has(record.toolCallId) && !resolvedCalls.has(record.toolCallId)) {
      const result = record.state === "terminal" ? record.outcome?.result
        ?? { content: [{ type: "text" as const, text: record.outcome!.kind === "complete" ? "" : record.outcome!.error }], details: { operationId: record.operationId } }
        : this.handle(record);
      record.initial = record.state === "terminal" ? "final" : "running";
      this.save(record);
      session.sessionManager.appendMessage({ role: "toolResult", toolCallId: record.toolCallId, toolName: record.toolName,
        ...result, isError: record.state === "terminal" && record.outcome?.kind !== "complete", timestamp: Date.now() });
      checkpointPiSession(session.sessionManager);
    }
    session.agent.state.messages = session.sessionManager.buildSessionContext().messages;
    this.beforeToolCall = session.agent.beforeToolCall;
    this.afterToolCall = session.agent.afterToolCall;
    Object.defineProperty(session.agent, "beforeToolCall", { configurable: true,
      get: () => async (context: BeforeToolCallContext) => { this.prepared.set(context.toolCall.id, context); },
      set: (callback: AgentSession["agent"]["beforeToolCall"]) => { this.beforeToolCall = callback; } });
    Object.defineProperty(session.agent, "afterToolCall", { configurable: true,
      get: () => async (context: { result: ToolResult; isError: boolean }) => ({ isError: context.result.isError === undefined ? context.isError : context.result.isError }),
      set: (callback: AgentSession["agent"]["afterToolCall"]) => { this.afterToolCall = callback; } });
    session.agent.subscribe(event => {
      if (event.type === "message_start" && event.message.role === "assistant") this.released = false;
      if (event.type === "message_end") checkpointPiSession(session.sessionManager);
    });
    const state = session.agent.state;
    const descriptor = Object.getOwnPropertyDescriptor(state, "tools");
    if (!descriptor?.get || !descriptor.set) throw new Error("Pi tool state accessor is unavailable");
    const wrapped = new WeakMap<object, Tool>();
    const wrap = (tool: Tool): Tool => {
      const existing = wrapped.get(tool);
      if (existing) return existing;
      const next: Tool = { ...tool, execute: (...args) => this.track(() => this.execute(tool, args)) };
      wrapped.set(tool, next); wrapped.set(next, next);
      return next;
    };
    Object.defineProperty(state, "tools", { ...descriptor, get: () => descriptor.get!.call(state),
      set: tools => descriptor.set!.call(state, tools.map(wrap)) });
    state.tools = state.tools;
    for (const name of ["prompt", "continue"] as const) {
      const original = session.agent[name].bind(session.agent) as (...args: any[]) => Promise<void>;
      Object.defineProperty(session.agent, name, { configurable: true, writable: true, value: (...args: any[]) => this.track(() => original(...args)) });
    }
  }

  run<T>(operation: () => T): T { this.assertCurrent(); return this.runs.run(this.controller.signal, operation); }
  private assertCurrent(): void {
    if (this.blocked || this.runs.getStore()?.aborted) throw new Error("Pi execution has been cancelled");
  }

  halt(session: AgentSession, timeoutMs: number, settled: () => void = () => {}): Promise<void> {
    if (this.runs.getStore() && this.active) return Promise.reject(new Error("Cannot halt Pi execution from its own callback"));
    if (this.halting) return this.halting;
    this.controller.abort();
    for (const live of this.operations.values()) live.controller.abort(new Error("Explicit Stop"));
    this.releaseObservations();
    const stopped = Promise.resolve().then(async () => {
      session.abortBash();
      await session.abort();
      while (this.active) await Promise.allSettled(this.pending);
      await Promise.all([...this.operations.values()].map(operation => operation.done));
      await session.agent.waitForIdle();
      if (!session.isIdle || session.isBashRunning) throw new Error("Local Pi execution is still active");
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    this.halting = Promise.race([stopped, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Cancellation failed: local Pi execution did not stop within ${timeoutMs}ms`)), timeoutMs);
    })]).then(() => { settled(); this.controller = new AbortController(); })
      .finally(() => { clearTimeout(timer); this.halting = undefined; });
    return this.halting;
  }

  dispose(): void {
    if (this.operations.size) throw new Error("Tool operations still own this native context");
    this.controller.abort();
  }
}

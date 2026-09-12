import { randomUUID } from "node:crypto";
import type { CoreCommand, CoreDispatch, CoreExecutionSnapshot, CoreOperation, CoreOutcome, CoreOutput, CoreSession } from "./contracts.js";
import { isCoreExecutionSnapshot } from "./execution.js";

const failure = (kind: "unavailable" | "rejected" | "unknown" | "unsupported", message: string): CoreOutcome<never> => ({ ok: false, error: { kind, message } });

/** Stable host owner. Native engines may be replaced; receipts cannot. */
export class CoreController {
  session?: CoreSession;
  private execution?: CoreExecutionSnapshot;
  private readonly pending = new Map<string, { finish(result: CoreOutcome<unknown>): void }>();
  private unavailable?: string;
  private closePromise?: Promise<void>;
  constructor(private readonly event: (event: CoreOutput) => void = () => {}, private readonly timeoutMs = 30_000) {}

  observe(value: unknown): CoreOutcome<CoreExecutionSnapshot> {
    if (!isCoreExecutionSnapshot(value)) return failure("unsupported", "Core runtime does not provide the execution contract; retain its recorded release and do not infer settlement or replay work");
    if (this.execution && value.revision === this.execution.revision && JSON.stringify(value) !== JSON.stringify(this.execution)) {
      return failure("unavailable", "Core published different execution snapshots at the same revision");
    }
    if (!this.execution || value.revision > this.execution.revision) this.execution = structuredClone(value);
    return { ok: true, value: structuredClone(this.execution) };
  }
  snapshot(): CoreOutcome<CoreExecutionSnapshot> {
    return this.execution ? { ok: true, value: structuredClone(this.execution) } : failure("unavailable", "Core execution has not been observed");
  }
  operation(workId: string): CoreOutcome<CoreOperation | undefined> {
    const snapshot = this.snapshot();
    return snapshot.ok ? { ok: true, value: snapshot.value.operations.find(operation => operation.workId === workId) } : snapshot;
  }
  output = (event: CoreOutput): void => {
    if (event.type === "execution_update") {
      const observed = this.observe(event.execution);
      if (!observed.ok) { this.unavailable = observed.error.message; this.event({ type: "core_error", error: observed.error.message }); return; }
      this.event({ type: "execution_update", execution: observed.value });
      return;
    }
    if (event.type !== "response") { this.event(event); return; }
    const waiter = this.pending.get(String(event.id));
    if (!waiter) return;
    if (event.success === false) waiter.finish(failure(event.errorKind ?? "rejected", String(event.error ?? `Core ${event.command} failed`)));
    else if (event.command === "get_state") {
      const state = event.data as Record<string, unknown> | undefined;
      const observed = this.observe(state?.execution);
      waiter.finish(observed.ok ? { ok: true, value: { ...state, execution: observed.value } } : observed);
    } else waiter.finish({ ok: true, value: event.data });
  };
  exit = (code?: number): void => {
    this.unavailable = `Core exited (${code ?? "unknown"}); outstanding effects require native reconciliation`;
    for (const waiter of [...this.pending.values()]) waiter.finish(failure("unknown", this.unavailable));
    this.event({ type: "core_exit", error: this.unavailable });
  };
  request<T = unknown>(type: CoreCommand["type"], fields: Omit<CoreCommand, "type"> = {}, timeoutMs = this.timeoutMs): Promise<CoreOutcome<T>> {
    if (this.unavailable || !this.session) return Promise.resolve(failure("unavailable", this.unavailable ?? "Core is not attached"));
    const id = randomUUID();
    return new Promise<CoreOutcome<T>>(resolve => {
      const finish = (result: CoreOutcome<unknown>) => {
        if (!this.pending.delete(id)) return;
        if (timer) clearTimeout(timer);
        resolve(result as CoreOutcome<T>);
      };
      const timer = timeoutMs > 0 ? setTimeout(() => finish(failure("unknown", `Core ${type} acknowledgement timed out; do not replay ambiguous effects`)), timeoutMs) : undefined;
      this.pending.set(id, { finish });
      try {
        Promise.resolve(this.session!.command({ ...fields, type, id })).catch(error => finish(failure("unknown", String(error))));
      } catch (error) { finish(failure("unknown", String(error))); }
    });
  }
  async dispatch(request: CoreDispatch): Promise<CoreOutcome<CoreOperation>> {
    const revision = this.execution?.revision ?? -1;
    const fields = { workId: request.workId, ...("message" in request ? { message: request.message, images: request.images }
      : request.kind === "compact" ? { customInstructions: request.customInstructions } : {}) };
    const reply = request.agentId
      ? await this.request("core_agent_command", { ...fields, agentId: request.agentId, action: request.kind }, request.kind === "compact" ? 0 : this.timeoutMs)
      : await this.request(request.kind, fields, request.kind === "compact" ? 0 : this.timeoutMs);
    // Events may precede the reply. A response is never evidence of completion.
    if (!reply.ok && (reply.error.kind !== "unknown" || (this.execution?.revision ?? -1) <= revision)) return reply;
    let receipt = this.operation(request.workId);
    if (receipt.ok && receipt.value && receipt.value.state !== "pending") return { ok: true, value: receipt.value };
    if (!reply.ok) return reply;
    const state = await this.request("get_state", { workId: request.workId });
    if (!state.ok) return state;
    receipt = this.operation(request.workId);
    return receipt.ok && receipt.value ? { ok: true, value: receipt.value }
      : failure("unknown", `Core acknowledged ${request.workId} without an execution receipt`);
  }
  close(): Promise<CoreOutcome<void>> {
    return (this.closePromise ??= (async () => {
      this.unavailable = "Core controller closed";
      for (const waiter of [...this.pending.values()]) waiter.finish(failure("unknown", this.unavailable));
      await this.session?.close();
    })()).then(() => ({ ok: true, value: undefined }), error => failure("unavailable", String(error)));
  }
}

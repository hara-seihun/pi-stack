import { createHash } from "node:crypto";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { PiEvent } from "./contracts.js";
import type { PiExecution } from "./pi-execution.js";
import { checkpointPiSession } from "./pi-session-file.js";
import { inputReceipts } from "./pi-input-receipts.js";

export type NativeInput = { workId: string; message: string; images?: ImageContent[]; inputOrigin?: "human" | "machine" };
export function parseNativeInputs(value: unknown): { ok: true; value: NativeInput[] } | { ok: false; error: string } {
  if (!Array.isArray(value) || !value.length) return { ok: false, error: "input_batch requires nonempty inputs" };
  const inputs: NativeInput[] = [];
  for (const input of value) {
    if (!input || typeof input.workId !== "string" || !input.workId || typeof input.message !== "string"
      || input.inputOrigin !== undefined && input.inputOrigin !== "human" && input.inputOrigin !== "machine"
      || input.images !== undefined && (!Array.isArray(input.images) || input.images.some((image: any) => image?.type !== "image" || typeof image.data !== "string" || typeof image.mimeType !== "string"))) {
      return { ok: false, error: "Invalid input_batch envelope" };
    }
    inputs.push({ workId: input.workId, message: input.message,
      ...(input.images === undefined ? {} : { images: input.images }), ...(input.inputOrigin === undefined ? {} : { inputOrigin: input.inputOrigin }) });
  }
  if (new Set(inputs.map(input => input.workId)).size !== inputs.length) return { ok: false, error: "Duplicate workId inside input_batch" };
  return { ok: true, value: inputs };
}

/** One batch queue around upstream Pi, not a second model loop. */
export class PiInputBatch {
  private readonly pending = new Map<string, NativeInput>();
  private readonly known = new Map<string, NativeInput>();
  private readonly commands = new Map<string, string>();
  private readonly enqueued = new Set<string>();
  private phase: "idle" | "generating" | "tools" | "preparing" = "idle";
  private scheduled = false;
  private stopped = false;
  private readonly unsubscribe: () => void;
  private readonly unsubscribeSession: () => void;

  constructor(private readonly session: AgentSession, private readonly execution: PiExecution,
    private readonly output: (event: PiEvent) => void, private readonly accepted: (workId: string) => void) {
    const entries = session.sessionManager.getBranch();
    const landed = new Set(inputReceipts(entries).landedWorkIds);
    for (const entry of entries) if (entry.type === "custom" && entry.customType === "thread_input_batch_accepted") {
      const command = (entry.data as { command?: { id: string; digest: string } }).command;
      if (command) this.commands.set(command.id, command.digest);
    }
    const storedInputs = entries.flatMap(entry => entry.type === "custom" && entry.customType === "thread_input" ? [entry.data as NativeInput]
      : entry.type === "custom" && entry.customType === "thread_input_batch_accepted" ? (entry.data as { inputs: NativeInput[] }).inputs : []);
    for (const stored of storedInputs) {
      if (typeof stored.workId !== "string" || typeof stored.message !== "string") continue;
      const input: NativeInput = { workId: stored.workId, message: stored.message,
        ...(stored.images === undefined ? {} : { images: stored.images }), ...(stored.inputOrigin === undefined ? {} : { inputOrigin: stored.inputOrigin }) };
      this.known.set(input.workId, input);
      if (!landed.has(input.workId)) { this.pending.set(input.workId, input); accepted(input.workId); }
    }
    const prepare = session.agent.prepareRequest;
    session.agent.prepareRequest = async (request, signal) => {
      const update = (await prepare?.(request, signal)) || undefined;
      const context = update?.context ?? request.context;
      const late = [...this.pending.values()].filter(input => !this.enqueued.has(input.workId));
      if (!late.length) return update;
      const message = this.message(late);
      session.sessionManager.appendCustomMessageEntry(message.customType, message.content, message.display, message.details);
      checkpointPiSession(session.sessionManager);
      for (const workId of message.details.workIds) this.pending.delete(workId);
      session.agent.state.messages = [...session.agent.state.messages, message];
      this.output({ type: "message_start", message });
      this.output({ type: "message_end", message });
      this.output({ type: "thread_landed", ...message.details });
      return { ...update, context: { ...context, messages: [...context.messages, message] } };
    };
    this.unsubscribe = session.agent.subscribe(event => {
      if (event.type === "turn_start" || event.type === "turn_end") this.phase = "preparing";
      if (event.type === "message_start" && event.message.role === "assistant") this.phase = "generating";
      if (event.type === "message_end") {
        // AgentSession's earlier awaited subscriber has already committed this message.
        checkpointPiSession(session.sessionManager);
        if (event.message.role === "assistant") { this.phase = "tools"; this.pump(); }
        if (event.message.role === "custom" && event.message.customType === "thread_input_batch") {
          const details = event.message.details as { workIds: string[]; batchId: string };
          for (const workId of details.workIds) { this.pending.delete(workId); this.enqueued.delete(workId); }
          this.output({ type: "thread_landed", workIds: details.workIds, batchId: details.batchId });
        }
      }
    });
    this.unsubscribeSession = session.subscribe(event => {
      if (event.type === "agent_settled") {
        this.phase = "idle";
        // A provider error can leave steer messages queued outside a live loop.
        this.schedule();
      }
    });
  }

  get awaitingAdmission(): boolean { return this.pending.size > 0 || this.phase === "preparing"; }

  accept(inputs: NativeInput[], identity?: { commandId: string; batchId: string }): { ok: true } | { ok: false; error: string } {
    if (this.stopped) return { ok: false, error: "Native inbox is closed" };
    const command = identity ? { id: identity.commandId, digest: createHash("sha256").update(JSON.stringify({ batchId: identity.batchId, inputs })).digest("hex") } : undefined;
    if (command && this.commands.has(command.id) && this.commands.get(command.id) !== command.digest) return { ok: false, error: `batch_identity_conflict:${command.id}` };
    for (const input of inputs) {
      const previous = this.known.get(input.workId);
      if (previous && JSON.stringify(previous) !== JSON.stringify(input)) return { ok: false, error: `input_identity_conflict:${input.workId}` };
    }
    const fresh = inputs.filter(input => !this.known.has(input.workId));
    if (fresh.length || command && !this.commands.has(command.id)) {
      this.session.sessionManager.appendCustomEntry("thread_input_batch_accepted", { inputs: fresh, ...(command ? { command } : {}) });
      checkpointPiSession(this.session.sessionManager);
      if (command) this.commands.set(command.id, command.digest);
      for (const input of fresh) {
        this.known.set(input.workId, input);
        this.pending.set(input.workId, input);
        this.accepted(input.workId);
      }
    }
    if (this.phase === "tools" && this.session.isStreaming) this.pump(); else this.schedule();
    return { ok: true };
  }

  resume(): void {
    if (this.stopped || this.execution.blocked || this.session.isStreaming || this.phase !== "idle") return;
    if (this.pending.size) { this.pump(); return; }
    this.phase = "preparing";
    const last = this.session.messages.at(-1);
    const continued = last?.role === "assistant" ? this.session.sendCustomMessage({ customType: "thread_recovery", display: true,
      content: "Continue the accepted unfinished work from the exact conversation above. This is recovery, not a new assignment. Inspect existing operation handles and receipts; do not replay admitted effects.", details: {} }, { triggerTurn: true, deliverAs: "steer" })
      : this.session.agent.continue();
    void continued.catch(error => { this.phase = "idle"; this.output({ type: "extension_error", error: `Native recovery failed: ${String(error)}` }); });
  }

  private schedule(): void {
    if (this.scheduled || this.stopped) return;
    this.scheduled = true;
    queueMicrotask(() => { this.scheduled = false; this.pump(); });
  }

  private message(inputs: NativeInput[]) {
    const workIds = inputs.map(input => input.workId);
    const batchId = `BATCH-${createHash("sha256").update(JSON.stringify(workIds)).digest("hex").slice(0, 32)}`;
    const content: (TextContent | ImageContent)[] = inputs.flatMap(input => [
      { type: "text" as const, text: JSON.stringify({ workId: input.workId, inputOrigin: input.inputOrigin, message: input.message }) }, ...(input.images ?? []),
    ]);
    return { role: "custom" as const, timestamp: Date.now(), customType: "thread_input_batch", content, display: true, details: { batchId, workIds } };
  }

  private pump(): void {
    if (this.stopped || this.phase === "generating" || this.phase === "preparing" || this.execution.blocked) return;
    const inputs = [...this.pending.values()].filter(input => !this.enqueued.has(input.workId));
    if (!inputs.length) {
      if (this.session.isIdle && this.session.agent.hasQueuedMessages()) {
        void this.session.agent.continue().catch(error => this.output({ type: "extension_error", error: String(error) }));
      }
      return;
    }
    const message = this.message(inputs);
    const { workIds, batchId } = message.details;
    for (const workId of workIds) this.enqueued.add(workId);
    const live = this.session.isStreaming;
    if (!live) this.phase = "preparing";
    const sent = this.session.sendCustomMessage(message,
      { triggerTurn: true, deliverAs: "steer" });
    // sendCustomMessage's live branch enqueues synchronously; release only after that.
    if (live) this.execution.releaseObservations();
    void sent.catch(error => {
      // Entries whose message_end committed are already removed; retain only unlanded bytes.
      for (const workId of workIds) this.enqueued.delete(workId);
      this.phase = "idle";
      this.output({ type: "extension_error", error: `Native input batch ${batchId} retained after admission failure: ${String(error)}` });
    });
  }

  close(): void { this.stopped = true; this.unsubscribe(); this.unsubscribeSession(); }
}

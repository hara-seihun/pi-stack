import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import { catalogModel } from "./catalog.js";
import { completionCanonical, completionError, isCompletionExecution, isCompletionInput, isCompletionRequestId, type CompletionExecution, type CompletionInput, type CompletionOutcome, type CompletionRecord } from "./completion-contract.js";
import type { Store } from "./store.js";

interface StoredCompletion {
  input: CompletionInput;
  record: CompletionRecord;
  attemptId?: string;
  receipt?: CompletionExecution;
}
export interface CompletionClaim {
  readonly execute: boolean;
  readonly record: CompletionRecord;
  readonly input?: CompletionInput;
}
const terminal = (record: CompletionRecord) => record.state !== "queued" && record.state !== "running";

export class CompletionService {
  constructor(private readonly store: Store, private readonly cwd: string) {}

  private stored(requestId: string): StoredCompletion | undefined {
    const value = this.store.control(`completion:${requestId}`);
    return value ? JSON.parse(value) : undefined;
  }
  private save(value: StoredCompletion): void {
    this.store.setControl(`completion:${value.record.requestId}`, JSON.stringify(value));
  }
  private requestId(runId: string): string | undefined {
    return this.store.control(`completion-run:${runId}`);
  }
  private synchronize(value: StoredCompletion): void {
    if (terminal(value.record)) return;
    const run = this.store.run(value.record.runId);
    if (!run || !["done", "failed", "aborted"].includes(run.state)) return;
    const state = run.state === "aborted" ? "cancelled" : value.attemptId ? "indeterminate" : "failed";
    value.record = { ...value.record, state, updatedAt: Date.now(), error: {
      code: state === "failed" ? "provider" : state,
      message: run.result ?? "Completion worker ended without a durable provider result.",
    } };
    this.save(value);
  }

  submit(requestId: string, input: unknown): CompletionOutcome<CompletionRecord> {
    if (!isCompletionRequestId(requestId) || !isCompletionInput(input)) return completionError("invalid-request", "Expected a request ID, Luna or Terra, prompt, and supported completion options.");
    if (input.maxOutputTokens !== undefined) return completionError("unsupported-option", "OpenAI Codex rejects max_output_tokens for Luna and Terra. No run was created; a provider-enforced output cap is unavailable.");
    const selected = catalogModel(input.model)!;
    const model = builtinProviders().find(provider => provider.id === selected.provider)?.getModels().find(model => model.id === selected.model);
    if (!model || (input.maxOutputTokens !== undefined && input.maxOutputTokens > model.maxTokens)) return completionError("invalid-request", "maxOutputTokens exceeds the selected provider model's output limit.");
    return this.store.transaction(() => {
      const previous = this.stored(requestId);
      if (previous) {
        if (completionCanonical(previous.input) !== completionCanonical(input)) return completionError("request-conflict", "This request ID already belongs to different completion input.");
        this.synchronize(previous);
        return { ok: true, value: previous.record };
      }
      const [runId] = this.store.createRuns({ count: 1, source: "direct", prompt: input.prompt, cwd: this.cwd, profile: input.model, budget: "force", context: { tools: [] } });
      const now = Date.now();
      const record: CompletionRecord = { requestId, runId: runId!, model: input.model, metadata: input.metadata, state: "queued", createdAt: now, updatedAt: now };
      this.save({ input, record });
      this.store.setControl(`completion-run:${runId}`, requestId);
      return { ok: true, value: record };
    });
  }

  get(requestId: string): CompletionRecord | undefined {
    return this.store.transaction(() => {
      const value = this.stored(requestId);
      if (!value) return undefined;
      this.synchronize(value);
      return value.record;
    });
  }
  byRun(runId: string): CompletionRecord | undefined {
    const requestId = this.requestId(runId);
    return requestId === undefined ? undefined : this.get(requestId);
  }

  claim(runId: string, attemptId: string): CompletionOutcome<CompletionClaim> {
    if (typeof attemptId !== "string" || !/^[A-Za-z0-9-]{1,128}$/.test(attemptId)) return completionError("invalid-request", "Invalid completion attempt ID.");
    return this.store.transaction(() => {
      const requestId = this.requestId(runId), value = requestId === undefined ? undefined : this.stored(requestId);
      if (!value) return completionError("not-found", "Completion not found.");
      this.synchronize(value);
      if (terminal(value.record)) return { ok: true, value: { execute: false, record: value.record } };
      const run = this.store.run(runId)!;
      if (!run.accountId || !run.provider || !run.model) return completionError("invalid-state", "Completion has no admitted account assignment.");
      if (value.attemptId && value.attemptId !== attemptId) {
        value.record = { ...value.record, state: "indeterminate", updatedAt: Date.now(), error: { code: "indeterminate", message: "A prior worker claimed the provider request without returning a durable result. It will not be sent again." } };
        this.save(value);
        this.store.updateRun(runId, { state: "failed", failureKind: "infrastructure", result: value.record.error.message });
        return { ok: true, value: { execute: false, record: value.record } };
      }
      value.attemptId = attemptId;
      value.record = { ...value.record, state: "running", updatedAt: Date.now() };
      this.save(value);
      this.store.updateRun(runId, { state: "running", progressAt: Date.now() });
      return { ok: true, value: { execute: true, record: value.record, input: value.input } };
    });
  }

  settle(runId: string, attemptId: string, outcome: unknown): CompletionOutcome<CompletionRecord> {
    if (!isCompletionExecution(outcome)) return completionError("invalid-request", "Invalid completion receipt.");
    return this.store.transaction(() => {
      const requestId = this.requestId(runId), value = requestId === undefined ? undefined : this.stored(requestId);
      if (!value) return completionError("not-found", "Completion not found.");
      this.synchronize(value);
      if (value.attemptId !== attemptId) return completionError("request-conflict", "Receipt does not belong to the claimed attempt.");
      if (value.receipt) return completionCanonical(value.receipt) === completionCanonical(outcome)
        ? { ok: true, value: value.record } : completionError("request-conflict", "Completion already has a different receipt.");
      const run = this.store.run(runId)!;
      if (outcome.state === "completed") {
        if (outcome.result.provider !== run.provider) return completionError("invalid-request", "Receipt provider differs from the admitted provider.");
        for (const component of ["input", "output", "cacheRead", "cacheWrite"] as const) {
          this.store.recordUsage({ accountId: run.accountId!, hour: Math.floor(Date.now() / 3_600_000) * 3_600_000, source: "completion", runId, model: outcome.result.model, component, tokens: outcome.result.usage[component] });
        }
      }
      value.receipt = outcome;
      if (value.record.state !== "cancelled") value.record = { requestId: value.record.requestId, runId, model: value.record.model, metadata: value.record.metadata, createdAt: value.record.createdAt, updatedAt: Date.now(), ...outcome };
      this.save(value);
      if (value.record.state !== "cancelled") this.store.finishCompletionRun(runId, {
        state: outcome.state === "completed" ? "done" : outcome.state === "cancelled" ? "aborted" : "failed",
        result: outcome.state === "completed" ? outcome.result.text : outcome.error.message,
        ...(outcome.state === "completed" ? {} : { failureKind: outcome.state === "cancelled" ? "operator" as const : "provider" as const }),
      });
      return { ok: true, value: value.record };
    });
  }

  cancel(requestId: string): CompletionOutcome<CompletionRecord> {
    return this.store.transaction(() => {
      const value = this.stored(requestId);
      if (!value) return completionError("not-found", "Completion not found.");
      this.synchronize(value);
      if (!terminal(value.record)) {
        value.record = { ...value.record, state: "cancelled", updatedAt: Date.now(), error: { code: "cancelled", message: "Cancelled by caller. An in-flight provider request may already have spent tokens." } };
        this.save(value);
        this.store.setControl(`abort:${value.record.runId}`, "abort");
        this.store.updateRun(value.record.runId, { state: "aborted", failureKind: "operator", result: value.record.error.message });
      }
      return { ok: true, value: value.record };
    });
  }
}

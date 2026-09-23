import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import { catalogModel } from "./catalog.js";
import { completionCanonical, completionError, isCompletionExecution, isCompletionInput, isCompletionRequestId, type CompletionExecution, type CompletionInput, type CompletionOutcome, type CompletionRecord, type CompletionAttempt } from "./completion-contract.js";
import type { Store } from "./store.js";
import { recordCompletionRejection, recordCompletionSuccess } from "./completion-feedback.js";

export interface CompletionAccess { principal: string; accounts: string[]; models: string[] }
interface StoredCompletion {
  input: CompletionInput;
  access?: CompletionAccess;
  record: CompletionRecord;
  attemptId?: string;
  receipt?: CompletionExecution;
  attemptCount?: number;
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

  private evidence(key: string, value: unknown): void {
    const previous = this.store.control(key), encoded = JSON.stringify(value);
    if (previous) { if (completionCanonical(JSON.parse(previous)) !== completionCanonical(value)) throw new Error(`Conflicting immutable completion evidence ${key}`); return; }
    this.store.setControl(key, encoded);
  }
  private rememberAttempt(value: StoredCompletion): void {
    if (!value.attemptId) return;
    const run = this.store.run(value.record.runId)!;
    const key = `completion-attempt:${run.id}:${value.attemptId}`;
    if (!this.store.control(key)) this.evidence(key, { attemptId: value.attemptId, runId: run.id, accountId: run.accountId!, provider: run.provider!, model: run.model!, startedAt: run.startedAt ?? value.record.createdAt } satisfies CompletionAttempt);
    if (value.receipt) this.evidence(`completion-receipt:${run.id}:${value.attemptId}`, value.receipt);
  }
  attempts(requestId: string): CompletionAttempt[] | undefined {
    const value = this.stored(requestId); if (!value) return;
    const prefix = `completion-attempt:${value.record.runId}:`;
    const attempts = (this.store.db.prepare("SELECT value FROM control WHERE key>=? AND key<?").all(prefix, prefix + '\uffff') as {value:string}[]).map(row => {
      const attempt = JSON.parse(row.value) as CompletionAttempt;
      const outcome = this.store.control(`completion-receipt:${attempt.runId}:${attempt.attemptId}`);
      const recoveryReason = this.store.control(`completion-recovery:${attempt.runId}:${attempt.attemptId}`);
      return { ...attempt, ...(outcome ? { outcome: JSON.parse(outcome) as CompletionExecution } : {}), ...(recoveryReason ? { recoveryReason: JSON.parse(recoveryReason) as string } : {}) };
    });
    return attempts.sort((a,b) => a.startedAt-b.startedAt || a.attemptId.localeCompare(b.attemptId));
  }
  private requeue(value: StoredCompletion, retryAt: number): CompletionRecord {
    const { requestId, runId, model, metadata, createdAt } = value.record;
    value.attemptCount ??= value.attemptId ? 1 : 0;
    value.record = { requestId, runId, model, metadata, createdAt, updatedAt: Date.now(), state: "queued", attemptCount: value.attemptCount, retryAt };
    delete value.attemptId; delete value.receipt;
    this.store.requeueRejectedCompletion(runId);
    this.save(value);
    return value.record;
  }
  retry(requestId: string): CompletionOutcome<CompletionRecord> {
    return this.store.transaction(() => {
      const value = this.stored(requestId); if (!value) return completionError("not-found", "Completion not found.");
      this.synchronize(value);
      if (["queued", "running", "completed"].includes(value.record.state)) return { ok: true, value: value.record };
      const receipt = value.receipt;
      const explicit = receipt?.state === "failed" && ((receipt.error.code === "rate-limited" && receipt.error.httpStatus === 429)
        || (receipt.error.code === "provider" && receipt.error.message.trim() === '{"detail":"Rate limit exceeded"}'));
      if (value.record.state !== "failed" || !explicit || !value.attemptId) return completionError("invalid-state", "Only explicit pre-execution rate-limit rejection can be retried. Cancelled and indeterminate outcomes remain fenced.");
      const run = this.store.run(value.record.runId)!;
      this.rememberAttempt(value);
      this.evidence(`completion-recovery:${run.id}:${value.attemptId}`, "Caller-authorized recovery of an explicit Codex rate-limit rejection; original receipt retained.");
      const observed = Number((this.store.db.prepare("SELECT count(*) n FROM run WHERE account_id=? AND started_at<=? AND (ended_at IS NULL OR ended_at>=?)").get(run.accountId!, value.record.updatedAt, value.record.updatedAt) as {n:number}).n);
      const retryAt = recordCompletionRejection(this.store, run.accountId!, Date.now(), undefined, Math.max(1, observed));
      return { ok: true, value: this.requeue(value, retryAt) };
    });
  }

  submit(requestId: string, input: unknown, access?: CompletionAccess): CompletionOutcome<CompletionRecord> {
    if (!isCompletionRequestId(requestId) || !isCompletionInput(input)) return completionError("invalid-request", "Expected a request ID, Luna, prompt, and supported completion options.");
    if (input.maxOutputTokens !== undefined) return completionError("unsupported-option", "OpenAI Codex rejects max_output_tokens for Luna. No run was created; a provider-enforced output cap is unavailable.");
    const selected = catalogModel(input.model)!;
    const model = builtinProviders().find(provider => provider.id === selected.provider)?.getModels().find(model => model.id === selected.model);
    if (!model || (input.maxOutputTokens !== undefined && input.maxOutputTokens > model.maxTokens)) return completionError("invalid-request", "maxOutputTokens exceeds the selected provider model's output limit.");
    return this.store.transaction(() => {
      const previous = this.stored(requestId);
      if (previous) {
        // A request is identified by its input and its owner. The accounts recorded with it are
        // provenance, and they move while a request waits, so a replay after a grant change resumes
        // the same work instead of conflicting with itself.
        if (completionCanonical(previous.input) !== completionCanonical(input) || previous.access?.principal !== access?.principal) return completionError("request-conflict", "This request ID already belongs to different completion input.");
        this.synchronize(previous);
        return { ok: true, value: previous.record };
      }
      const [runId] = this.store.createRuns({ count: 1, source: "direct", prompt: input.prompt, cwd: this.cwd, profile: input.model, budget: "force", context: { tools: [] } });
      const now = Date.now();
      const record: CompletionRecord = { requestId, runId: runId!, model: input.model, metadata: input.metadata, state: "queued", createdAt: now, updatedAt: now };
      this.save({ input, record, ...(access ? { access } : {}) });
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
      if (terminal(value.record) || this.store.control(`completion-receipt:${runId}:${attemptId}`)) return { ok: true, value: { execute: false, record: value.record } };
      const run = this.store.run(runId)!;
      if (!run.accountId || !run.provider || !run.model) return completionError("invalid-state", "Completion has no admitted account assignment.");
      if (value.attemptId && value.attemptId !== attemptId) {
        value.record = { ...value.record, state: "indeterminate", updatedAt: Date.now(), error: { code: "indeterminate", message: "A prior worker claimed the provider request without returning a durable result. It will not be sent again." } };
        this.save(value);
        this.store.updateRun(runId, { state: "failed", failureKind: "infrastructure", result: value.record.error.message });
        return { ok: true, value: { execute: false, record: value.record } };
      }
      if (!value.attemptId) value.attemptCount = (value.attemptCount ?? 0) + 1;
      value.attemptId = attemptId;
      this.rememberAttempt(value);
      value.record = { ...value.record, state: "running", updatedAt: Date.now(), attemptCount: value.attemptCount ?? 1 };
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
      const previous = this.store.control(`completion-receipt:${runId}:${attemptId}`);
      if (previous) return completionCanonical(JSON.parse(previous)) === completionCanonical(outcome)
        ? { ok: true, value: value.record } : completionError("request-conflict", "Attempt already has a different immutable receipt.");
      if (value.attemptId !== attemptId) return completionError("request-conflict", "Receipt does not belong to the claimed attempt.");
      if (value.receipt) return completionCanonical(value.receipt) === completionCanonical(outcome)
        ? { ok: true, value: value.record } : completionError("request-conflict", "Completion already has a different receipt.");
      const run = this.store.run(runId)!;
      if (outcome.state === "completed" && outcome.result.provider !== run.provider) return completionError("invalid-request", "Receipt provider differs from the admitted provider.");
      this.rememberAttempt(value);
      this.evidence(`completion-receipt:${runId}:${attemptId}`, outcome);
      if (outcome.state === "failed" && outcome.error.code === "rate-limited" && outcome.error.httpStatus === 429 && value.record.state !== "cancelled") {
        const retryAt = recordCompletionRejection(this.store, run.accountId!, Date.now(), outcome.error.retryAfterMs);
        return { ok: true, value: this.requeue(value, retryAt) };
      }
      if (outcome.state === "completed") {
        recordCompletionSuccess(this.store, run.accountId!, Date.now());
        for (const component of ["input", "output", "cacheRead", "cacheWrite"] as const) {
          this.store.recordUsage({ accountId: run.accountId!, hour: Math.floor(Date.now() / 3_600_000) * 3_600_000, source: "completion", runId, model: outcome.result.model, component, tokens: outcome.result.usage[component] });
        }
      }
      value.receipt = outcome;
      if (value.record.state !== "cancelled") value.record = { requestId: value.record.requestId, runId, model: value.record.model, metadata: value.record.metadata, createdAt: value.record.createdAt, updatedAt: Date.now(), attemptCount: value.attemptCount ?? 1, ...outcome };
      this.save(value);
      if (value.record.state !== "cancelled") this.store.finishCompletionRun(runId, {
        state: outcome.state === "completed" ? "done" : outcome.state === "cancelled" ? "aborted" : "failed",
        result: outcome.state === "completed" ? outcome.result.text : outcome.error.message,
        ...(outcome.state === "completed" ? {} : { failureKind: outcome.state === "cancelled" ? "operator" as const : "provider" as const }),
      });
      this.store.endLease(`run:${runId}`);
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
        if (value.attemptId) this.store.db.prepare("UPDATE lease SET ended_at=NULL WHERE id=?").run(`run:${value.record.runId}`);
      }
      return { ok: true, value: value.record };
    });
  }
}

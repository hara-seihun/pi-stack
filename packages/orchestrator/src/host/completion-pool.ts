import { join } from "node:path";
import type { OrchestratorConfig, Run } from "../domain.js";
import type { Store } from "../store.js";
import type { CompletionService } from "../completion.js";
import { executeCompletion } from "./completion-provider.js";
import { reconcileCompletionReceipts, saveCompletionReceipt } from "./completion-receipts.js";

/** Tool-free requests share the daemon, not an AgentSession or a process per request. */
export class CompletionPool {
  private readonly active = new Map<string, { controller: AbortController; done: Promise<void> }>();
  private readonly directory: string;
  constructor(private readonly store: Store, private readonly service: CompletionService, private readonly config: OrchestratorConfig, private readonly execute = executeCompletion) {
    this.directory = join(config.agentDir, "completion-receipts");
  }
  get size(): number { return this.active.size; }
  owns(run: Run): boolean { return run.workerUnit === `completion:${run.id}`; }
  start(run: Run): void {
    if (this.active.has(run.id)) return;
    const controller = new AbortController();
    const entry = { controller, done: Promise.resolve() };
    this.active.set(run.id, entry);
    entry.done = this.work(run, controller).catch(cause => {
      this.store.updateRun(run.id, { state: "failed", failureKind: "infrastructure", result: `Completion execution failed: ${String(cause)}` });
      console.error(`completion ${run.id}:`, cause);
    }).finally(() => this.active.delete(run.id));
  }
  tick(): void {
    if (!this.active.size) return;
    this.store.transaction(() => {
      for (const [id, entry] of this.active) {
        if (this.store.control(`abort:${id}`)) entry.controller.abort();
        this.store.heartbeatLease(`run:${id}`);
      }
    });
  }
  async close(): Promise<void> {
    for (const entry of this.active.values()) entry.controller.abort();
    await Promise.all([...this.active.values()].map(entry => entry.done));
  }
  private async work(run: Run, controller: AbortController): Promise<void> {
    const attemptId = crypto.randomUUID();
    const claim = this.service.claim(run.id, attemptId);
    if (!claim.ok) throw new Error(`${claim.error.code}: ${claim.error.message}`);
    if (!claim.value.execute) return;
    if (!claim.value.input) throw new Error("Completion claim omitted input");
    let outcome = await this.execute(claim.value.input, run, { authPath: this.config.authPath, signal: controller.signal });
    if (outcome.state === "cancelled" && !this.store.control(`abort:${run.id}`)) outcome = {
      state: "indeterminate", error: { code: "indeterminate", message: "Completion host stopped before a durable provider result. This request will not be sent again." },
    };
    saveCompletionReceipt(this.directory, { runId: run.id, attemptId, outcome });
    reconcileCompletionReceipts(this.service, this.directory);
  }
}

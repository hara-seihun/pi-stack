import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { Run } from "../domain.js";
import type { CompletionExecution } from "../completion-contract.js";
import type { Store } from "../store.js";
import type { CompletionService } from "../completion.js";
import { executeCompletion } from "./completion-provider.js";
import { reconcileCompletionReceipts, saveCompletionReceipt } from "./completion-receipts.js";

/** Lives in the independent host, never in the admission controller. */
export class CompletionExecutionPool {
  private readonly active = new Map<string, { controller: AbortController; done: Promise<void> }>();
  private readonly directory: string;
  constructor(private readonly store: Store, private readonly service: CompletionService,
    private readonly config: { agentDir: string; authPath: string }, private readonly execute = executeCompletion) {
    this.directory = join(config.agentDir, "completion-receipts");
  }
  get size(): number { return this.active.size; }
  get runIds(): string[] { return [...this.active.keys()]; }
  start(run: Run): void {
    if (this.active.has(run.id)) return;
    const controller = new AbortController();
    const entry = { controller, done: Promise.resolve() };
    this.active.set(run.id, entry);
    entry.done = this.work(run, controller).finally(() => this.active.delete(run.id));
    // An unrecoverable claim/receipt persistence failure must stop the host. Its
    // replacement will fence the claimed attempt rather than dispatch it again.
    void entry.done.catch(cause => { console.error(`completion ${run.id}:`, cause); process.exitCode = 1; });
  }
  tick(): void {
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
    const attemptId = randomUUID();
    const claim = this.service.claim(run.id, attemptId);
    if (!claim.ok) throw new Error(`${claim.error.code}: ${claim.error.message}`);
    if (!claim.value.execute) return;
    if (!claim.value.input) throw new Error("Completion claim omitted input");
    let outcome: CompletionExecution;
    try { outcome = await this.execute(claim.value.input, run, { authPath: this.config.authPath, signal: controller.signal }); }
    catch (cause) { outcome = { state: "indeterminate" as const, error: { code: "indeterminate" as const, message: `Completion execution ended without a durable result: ${String(cause)}` } }; }
    if (outcome.state === "cancelled" && !this.store.control(`abort:${run.id}`)) outcome = {
      state: "indeterminate", error: { code: "indeterminate", message: "Completion host stopped before a durable provider result. This request will not be sent again." },
    };
    saveCompletionReceipt(this.directory, { runId: run.id, attemptId, outcome });
    reconcileCompletionReceipts(this.service, this.directory);
  }
}

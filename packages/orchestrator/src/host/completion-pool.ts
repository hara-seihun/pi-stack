import { resolve } from "node:path";
import { setMaxListeners } from "node:events";
import type { OrchestratorConfig, Run } from "../domain.js";
import type { Store } from "../store.js";
import type { CompletionService } from "../completion.js";
import { completionHostSocket, completionHostRequest, ensureCompletionHost, launchCompletionHost,
  type CompletionHostBoundary, type CompletionHostStatus } from "./completion-transport.js";

export interface CompletionPoolOptions {
  socketPath?: string;
  launch?: typeof launchCompletionHost;
}
/** Admission and observation only. Provider execution belongs to the systemd host. */
export class CompletionPool {
  private readonly active = new Map<string, { pending?: Promise<void> }>();
  private readonly boundary: CompletionHostBoundary | undefined;
  private readonly socketPath: string | undefined;
  private readonly observation = new AbortController();
  private ensuring?: Promise<CompletionHostStatus>;
  private detached = false;
  constructor(private readonly store: Store, _service: CompletionService, config: OrchestratorConfig,
    private readonly options: CompletionPoolOptions = {}) {
    setMaxListeners(0, this.observation.signal);
    this.boundary = store.path === ":memory:" ? undefined : { ledgerPath: resolve(store.path), authPath: resolve(config.authPath), agentDir: resolve(config.agentDir) };
    this.socketPath = this.boundary === undefined ? undefined : options.socketPath ?? completionHostSocket(this.boundary.ledgerPath);
  }
  get size(): number { return this.active.size; }
  owns(run: Run): boolean { return run.workerUnit === `completion:${run.id}`; }
  start(run: Run): void {
    this.requireAttached();
    this.requirePersistent();
    if (!this.owns(run)) throw new Error("Completion pool cannot start an unassigned run");
    if (this.active.has(run.id)) return;
    const entry = {};
    this.active.set(run.id, entry);
    this.observe(run.id, entry);
  }
  tick(): void {
    this.requireAttached();
    for (const [id, entry] of this.active) {
      const run = this.store.run(id);
      const lease = this.store.db.prepare("SELECT ended_at FROM lease WHERE id=?").get(`run:${id}`) as { ended_at: number | null } | undefined;
      if (!run || !this.owns(run) || !lease || lease.ended_at !== null) { this.active.delete(id); continue; }
      this.observe(id, entry);
    }
  }
  detach(): void {
    if (this.detached) return;
    this.detached = true;
    this.observation.abort();
    this.active.clear();
  }
  /** Explicit host cancellation; replacement uses detach, never close. */
  async close(): Promise<void> {
    this.requireAttached();
    const { socketPath } = this.requirePersistent();
    await completionHostRequest(socketPath, { type: "close" });
    this.detach();
  }
  private requireAttached(): void {
    if (this.detached) throw new Error("Completion controller is detached");
  }
  private requirePersistent(): { boundary: CompletionHostBoundary; socketPath: string } {
    if (!this.boundary || !this.socketPath) throw new Error("Durable completions require a persistent ledger");
    return { boundary: this.boundary, socketPath: this.socketPath };
  }
  private ensure(): Promise<CompletionHostStatus> {
    const { boundary, socketPath } = this.requirePersistent();
    if (!this.ensuring) this.ensuring = ensureCompletionHost(boundary, socketPath,
      this.options.launch ?? launchCompletionHost, this.observation.signal).finally(() => { this.ensuring = undefined; });
    return this.ensuring;
  }
  private observe(id: string, entry: { pending?: Promise<void> }): void {
    if (entry.pending) return;
    entry.pending = (async () => {
      const status = await this.ensure();
      if (this.detached) return;
      if (!status.runIds.includes(id)) await completionHostRequest(this.requirePersistent().socketPath, { type: "start", runId: id }, this.observation.signal);
      if (!this.detached) this.store.setControl(`completion-host-error:${id}`, "");
    })().catch(cause => {
      // Lost acknowledgement is not failed execution. The admitted ledger entry
      // and host-side claim remain the authority; tick/successor reattaches.
      if (!this.detached) this.store.setControl(`completion-host-error:${id}`, String(cause));
    }).finally(() => { entry.pending = undefined; });
  }
}

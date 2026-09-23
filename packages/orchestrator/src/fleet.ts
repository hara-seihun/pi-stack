import { createHash } from "node:crypto";
import type { OrchestratorConfig } from "./domain.js";
import { assign, commitMeterAdmission } from "./policy.js";
import { isCredentialError, isRateLimitError } from "./provider-errors.js";
import type { Store } from "./store.js";
import type { PiEvent, Result, Thread, ThreadSettings } from "./threads/contracts.js";
import type { ThreadAdmission } from "./threads/service.js";
import { BROKER_ROUTES } from "./model-broker-contract.js";

/** Account policy for thread execution. ThreadService owns work and settlement. */
export class Fleet {
  private readonly leases = new Map<string, { leaseId: string; accountId: string; timer: ReturnType<typeof setInterval> }>();
  private readonly brokerExecutions = new Map<string, string>();
  constructor(private readonly store: Store, private readonly config: OrchestratorConfig) {}

  async admit(thread: Thread, settings: ThreadSettings, recovering: boolean, executionId: string): Promise<Result<ThreadAdmission>> {
    const rootRepair = thread.metadata?.execution === "root-repair";
    const scheduled = !!thread.parentId || thread.metadata?.source === "lane" || thread.metadata?.source === "direct";
    if (scheduled && !settings.model.startsWith("openai-codex/")) return { ok: false, error: { code: "invalid_request", message: "Orchestrator-scheduled work requires an OpenAI Codex model" } };
    if (this.config.modelBrokerUrl) return this.admitBroker(thread, settings, recovering, executionId);
    if (rootRepair && thread.metadata?.context) return { ok: false, error: { code: "invalid_request", message: "Root repair cannot use an isolated application context" } };
    const slash = settings.model.indexOf("/");
    const candidate = { provider: settings.model.slice(0, slash), model: settings.model.slice(slash + 1), thinking: settings.thinkingLevel };
    return this.store.transaction(() => {
      const leaseId = `thread:${executionId}`;
      const held = recovering ? this.store.db.prepare("SELECT account_id FROM lease WHERE id=? AND run_id=?").get(leaseId, thread.id) as { account_id: string } | undefined : undefined;
      if (recovering && !held) return { ok: false, error: { code: "unavailable", message: `Execution ${executionId} has no recorded account lease` } };
      const selected = held ? { assignment: { ...candidate, accountId: held.account_id }, refusals: [] }
        : assign(this.store, "thread", thread.parentId ? "force" : thread.admission,
          { ...this.config, profiles: { thread: [candidate] } }, Date.now(), undefined, thread.id, rootRepair ? "root-repair" : scheduled ? "user" : "interactive");
      if (!selected.assignment) return { ok: false, error: { code: "unavailable", message: selected.refusals.map(item => `${item.accountId}: ${item.reason}`).join("; ") } };
      const assignment = selected.assignment;
      this.store.createLease(leaseId, assignment.accountId, "fleet", thread.id);
      if (rootRepair) this.store.setControl("repair-owner", thread.id);
      if (!recovering) commitMeterAdmission(this.store, assignment);
      const timer = setInterval(() => this.store.heartbeatLease(leaseId), 15_000); timer.unref();
      this.leases.set(thread.id, { leaseId, accountId: assignment.accountId, timer });
      return { ok: true, value: {
        env: { PI_ORCHESTRATOR_ASSIGNED: "1", PI_THREAD_USAGE: "service", PI_ORCHESTRATOR_ACCOUNT_ID: assignment.accountId,
          PI_ORCHESTRATOR_PROVIDER: assignment.provider, PI_THREAD_ADMISSION: thread.parentId ? "force" : thread.admission },
        release: () => this.release(thread.id, executionId),
      } };
    });
  }

  private admitBroker(thread: Thread, settings: ThreadSettings, recovering: boolean, executionId: string): Result<ThreadAdmission> {
    if (thread.metadata?.execution === "root-repair") return { ok: false, error: { code: "invalid_request", message: "Root repair is unavailable when this daemon uses a model broker" } };
    const slash = settings.model.indexOf("/");
    const provider = slash > 0 ? settings.model.slice(0, slash) : "";
    if (!(provider in BROKER_ROUTES)) return { ok: false, error: { code: "invalid_request", message: `Model provider ${provider || settings.model} is unavailable through the model broker` } };
    return this.store.transaction(() => {
      const key = `broker-execution:${executionId}`;
      const recorded = this.store.control(key);
      if (recovering && recorded !== thread.id) return { ok: false, error: { code: "unavailable", message: `Execution ${executionId} has no recorded model-broker custody` } };
      if (!recovering) {
        if (this.store.control("launches") === "paused") return { ok: false, error: { code: "unavailable", message: "emergency halt" } };
        if (this.store.control("ordinary-launches") === "paused") return { ok: false, error: { code: "unavailable", message: "ordinary work paused" } };
        if (this.brokerExecutions.size >= this.config.maxConcurrentSessions) return { ok: false, error: { code: "unavailable", message: "machine session ceiling" } };
        this.store.setControl(key, thread.id);
      }
      this.brokerExecutions.set(thread.id, executionId);
      return { ok: true, value: {
        env: { PI_MODEL_BROKER_URL: this.config.modelBrokerUrl, PI_THREAD_USAGE: "service", PI_THREAD_ADMISSION: thread.parentId ? "force" : thread.admission },
        release: () => this.releaseBroker(thread.id, executionId),
      } };
    });
  }

  private releaseBroker(threadId: string, executionId: string): void {
    if (this.brokerExecutions.get(threadId) === executionId) this.brokerExecutions.delete(threadId);
    const key = `broker-execution:${executionId}`;
    if (this.store.control(key) === threadId) this.store.db.prepare("DELETE FROM control WHERE key=?").run(key);
  }

  private release(threadId: string, executionId: string): void {
    const leaseId = `thread:${executionId}`, lease = this.leases.get(threadId);
    if (lease?.leaseId === leaseId) { clearInterval(lease.timer); this.leases.delete(threadId); }
    this.store.endLease(leaseId);
    if (!this.leases.has(threadId) && this.store.control("repair-owner") === threadId) this.store.db.prepare("DELETE FROM control WHERE key='repair-owner'").run();
  }

  event(threadId: string, event: PiEvent): void {
    if (event.type === "thread_settled") {
      if (this.config.modelBrokerUrl) this.releaseBroker(threadId, String(event.executionId));
      else this.release(threadId, String(event.executionId));
      return;
    }
    if (this.config.modelBrokerUrl) return;
    if (event.type !== "message_end") return;
    const lease = this.leases.get(threadId), message = event.message as Record<string, any> | undefined;
    if (!lease || message?.role !== "assistant") return;
    const failure = String(message.errorMessage ?? "");
    if (message.stopReason === "error" && (isCredentialError(failure) || isRateLimitError(failure))) this.store.setCooldown(lease.accountId, Date.now() + 30 * 60_000);
    if (!message.usage) return;
    const receipt = `thread-usage:${threadId}:${createHash("sha256").update(JSON.stringify(message)).digest("hex")}`;
    this.store.transaction(() => {
      if (this.store.control(receipt)) return;
      for (const component of ["input", "output", "cacheRead", "cacheWrite"] as const) {
        const tokens = message.usage[component];
        if (Number.isFinite(tokens) && tokens > 0) this.store.recordUsage({ accountId: lease.accountId, hour: Math.floor(Date.now() / 3_600_000) * 3_600_000,
          source: "fleet", runId: threadId, model: String(message.model ?? ""), component, tokens });
      }
      this.store.setControl(receipt, "1");
    });
  }
}

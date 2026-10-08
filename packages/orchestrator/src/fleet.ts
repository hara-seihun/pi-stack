import { createHash } from "node:crypto";
import type { OrchestratorConfig } from "./domain.js";
import { assign, commitMeterAdmission } from "./policy.js";
import { isCredentialError, isRateLimitError, providerAccepted, rateLimitCooldownMs } from "./provider-errors.js";
import type { Store } from "./store.js";
import type { PiEvent, Result, Thread, ThreadSettings } from "./threads/contracts.js";
import type { ThreadAdmission } from "./threads/service.js";
import { BROKER_ROUTES } from "./model-broker-contract.js";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import { modelDrainsMeter } from "./catalog.js";
import { providerOAuth } from "./auth/shared-oauth.js";
import { codexTierExclusions } from "./auth/codex-capabilities.js";
import { accountModelExcluded, noEntitledAccountError, recordAccountModelUnsupported } from "./auth/model-entitlement.js";
import { allowsAccountUse } from "./domain.js";
import { requestedSpeedError } from "./threads/speed.js";
import { assertNever, requireRuntimeEvent, type RuntimeEvent } from "./threads/runtime-events.js";

/** Account spending urgency is separate from the global agent execution limit. */
function admissionClass(thread: Thread): Thread["admission"] {
  return thread.admission === "live" ? "live" : thread.parentId ? "force" : thread.admission;
}

/** Account policy for thread execution. ThreadService owns work and settlement. */
export class Fleet {
  private readonly leases = new Map<string, { leaseId: string; accountId: string; timer: ReturnType<typeof setInterval> }>();
  private readonly brokerExecutions = new Map<string, string>();
  constructor(private readonly store: Store, private readonly config: OrchestratorConfig) {}

  async admit(thread: Thread, settings: ThreadSettings, recovering: boolean, executionId: string): Promise<Result<ThreadAdmission>> {
    const slash = settings.model.indexOf("/");
    const speedError = requestedSpeedError({ provider: settings.model.slice(0, slash), id: settings.model.slice(slash + 1) }, settings.speed);
    if (speedError) return { ok: false, error: { code: "invalid_request", message: speedError } };
    const rootRepair = thread.metadata?.execution === "root-repair";
    const brokerUrl = settings.speed === "ultrafast" ? this.config.ultrafastModelBrokerUrl ?? this.config.modelBrokerUrl : this.config.modelBrokerUrl;
    if (brokerUrl) return this.admitBroker(thread, settings, recovering, executionId, brokerUrl);
    if (rootRepair && thread.metadata?.context) return { ok: false, error: { code: "invalid_request", message: "Root repair cannot use an isolated application context" } };
    const candidate = { provider: settings.model.slice(0, slash), model: settings.model.slice(slash + 1), thinking: settings.thinkingLevel };
    const codex = settings.speed === "ultrafast" ? builtinProviders().find(provider => provider.id === candidate.provider && provider.id === "openai-codex") : undefined;
    const excluded = codex ? await codexTierExclusions(this.store, providerOAuth(codex, this.config.authPath), candidate.model, settings.speed, new Set()) : new Set<string>();
    return this.store.transaction(() => {
      const leaseId = `thread:${executionId}`;
      const held = recovering ? this.store.db.prepare("SELECT account_id FROM lease WHERE id=? AND run_id=?").get(leaseId, thread.id) as { account_id: string } | undefined : undefined;
      if (recovering && !held) return { ok: false, error: { code: "unavailable", message: `Execution ${executionId} has no recorded account lease` } };
      if (held && excluded.has(held.account_id)) return { ok: false, error: { code: "unavailable", message: `Recorded account ${held.account_id} does not currently advertise ${settings.speed} for ${candidate.model}` } };
      const selected = held ? { assignment: { ...candidate, accountId: held.account_id }, refusals: [] }
        : assign(this.store, "thread", admissionClass(thread),
          { ...this.config, profiles: { thread: [candidate] } }, Date.now(), undefined, thread.id, rootRepair ? "root-repair" : "user", excluded);
      if (!selected.assignment) {
        const now=Date.now();
        // Every account that could serve this provider refuses the model itself: a capacity wait would wait forever.
        const usable=this.store.accounts().filter(account=>account.provider===candidate.provider&&allowsAccountUse(account,"fleet")&&!excluded.has(account.id));
        if(usable.length&&usable.every(account=>accountModelExcluded(this.store,account.id,candidate.model,now)))
          return {ok:false,error:{code:"invalid_request",message:noEntitledAccountError(candidate.provider,candidate.model)}};
        const opportunities=this.store.accounts().filter(account=>account.provider===candidate.provider&&!excluded.has(account.id)).map(account=>{
          const exhausted=this.store.latestMeters(account.id).filter(meter=>meter.used_percent>=100&&modelDrainsMeter(candidate.provider,candidate.model,meter.meter_id));
          return Math.max(account.cooldownUntil??0,...exhausted.map(meter=>meter.reset_at>now?meter.reset_at:now+60_000));
        }).filter(time=>time>now);
        return {ok:false,error:{code:"unavailable",message:selected.refusals.map(item=>`${item.accountId}: ${item.reason}`).join("; "),retryAt:opportunities.length?Math.min(...opportunities):now+60_000}};
      }
      const assignment = selected.assignment;
      this.store.createLease(leaseId, assignment.accountId, "fleet", thread.id);
      if (rootRepair) this.store.setControl("repair-owner", thread.id);
      if (!recovering) commitMeterAdmission(this.store, assignment);
      const timer = setInterval(() => this.store.heartbeatLease(leaseId), 15_000); timer.unref();
      this.leases.set(thread.id, { leaseId, accountId: assignment.accountId, timer });
      return { ok: true, value: {
        env: { PI_ORCHESTRATOR_ASSIGNED: "1", PI_THREAD_USAGE: "service", PI_ORCHESTRATOR_ACCOUNT_ID: assignment.accountId,
          PI_ORCHESTRATOR_PROVIDER: assignment.provider, PI_THREAD_ADMISSION: admissionClass(thread) },
        release: () => this.release(thread.id, executionId),
      } };
    });
  }

  private admitBroker(thread: Thread, settings: ThreadSettings, recovering: boolean, executionId: string, brokerUrl: string): Result<ThreadAdmission> {
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
        this.store.setControl(key, thread.id);
      }
      this.brokerExecutions.set(thread.id, executionId);
      return { ok: true, value: {
        env: { PI_MODEL_BROKER_URL: brokerUrl, PI_THREAD_USAGE: "service", PI_THREAD_ADMISSION: admissionClass(thread) },
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

  event(threadId: string, input: PiEvent): void {
    const event = requireRuntimeEvent(input);
    switch (event.type) {
      case "thread_settled":
        if (this.brokerExecutions.has(threadId)) this.releaseBroker(threadId, String(event.executionId));
        else this.release(threadId, String(event.executionId));
        return;
      case "message_end": return this.recordMessageEnd(threadId, event);
      // Lease release requires durable settlement; usage requires a finished assistant message.
      case "agent_start": case "agent_end": case "agent_settled": case "turn_start": case "turn_end":
      case "message_start": case "message_update": case "queue_update":
      case "tool_execution_start": case "tool_execution_update": case "tool_execution_end":
      case "compaction_start": case "compaction_end": case "auto_compaction_start": case "auto_compaction_end":
      case "auto_retry_start": case "auto_retry_end": case "summarization_retry_scheduled":
      case "summarization_retry_attempt_start": case "summarization_retry_finished":
      case "entry_appended": case "session_info_changed": case "thinking_level_changed": case "bash_execution_update":
      case "response": case "extension_ui_request": case "extension_error": case "user_bash":
      case "owner_execution_phase": case "model_request_start": case "session_changed":
      case "command_settled": case "runner_attached": case "thread_error": case "thread_message_inserted": return;
    }
    assertNever(event);
  }

  private recordMessageEnd(threadId: string, event: Extract<RuntimeEvent, { type: "message_end" }>): void {
    if (this.brokerExecutions.has(threadId)) return;
    const lease = this.leases.get(threadId), message = event.message as Record<string, any> | undefined;
    if (!lease || message?.role !== "assistant") return;
    const failure = String(message.errorMessage ?? "");
    const model = typeof message.model === "string" ? message.model : undefined;
    // Entitlement refusal is account/model evidence for future admission; it neither cools the account nor blames the task.
    if (message.stopReason === "error" && model) recordAccountModelUnsupported(this.store, lease.accountId, model, failure);
    // A burst throttle must not bench the account for half an hour, and a monthly
    // spend ceiling must not be retried after thirty minutes (September 24, 2026:
    // one throttle cooled the only healthy Anthropic account while three workers
    // kept being admitted onto one at its monthly limit, and all three failed).
    if (message.stopReason === "error" && isRateLimitError(failure)) this.store.transaction(()=>this.store.setCooldown(lease.accountId,
      Math.max(this.store.account(lease.accountId)?.cooldownUntil??0,Date.now()+rateLimitCooldownMs(failure)),{model}));
    else if (message.stopReason === "error" && isCredentialError(failure)) this.store.setCooldown(lease.accountId, Date.now() + 30 * 60_000, { model });
    else if (providerAccepted(message)) this.store.recordProviderSuccess(lease.accountId, { model: model!, startedAt: Number(message.timestamp), source: "fleet" });
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

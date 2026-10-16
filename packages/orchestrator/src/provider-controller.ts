import { dirname, join } from "node:path";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import { providerOAuth } from "./auth/shared-oauth.js";
import { codexTierExclusions } from "./auth/codex-capabilities.js";
import { ORCHESTRATOR_CATALOG } from "./catalog.js";
import { prioritizeReservedCompletions } from "./account-reservation.js";
import { CompletionService, completionModel } from "./completion.js";
import { CodexMeterSampler } from "./meters-codex.js";
import { AnthropicMeterSampler } from "./meters-anthropic.js";
import { CompletionPool, type CompletionPoolOptions } from "./host/completion-pool.js";
import { reconcileCompletionReceipts } from "./host/completion-receipts.js";
import { assignCompletion } from "./policy.js";
import type { Store } from "./store.js";
import type { ModelAvailabilityStore } from "./threads/model-availability.js";

export interface ProviderControllerConfig {
  authPath: string;
  agentDir: string;
  meterMaxAgeMs: number;
  autoReset: boolean;
}

/** One admission/observation owner. Provider attempts remain in the independent host. */
export class ProviderController {
  readonly completions: CompletionService;
  private readonly pool: CompletionPool;
  private readonly codexMeters: CodexMeterSampler;
  private readonly anthropicMeters: AnthropicMeterSampler;
  private readonly observation = new AbortController();
  private pending?: Promise<void>;
  private detached = false;

  constructor(readonly store: Store, readonly config: ProviderControllerConfig,
    private readonly availability: ModelAvailabilityStore,
    private readonly releasePath = dirname(dirname(realpathSync(fileURLToPath(import.meta.url)))),
    poolOptions: CompletionPoolOptions = {}) {
    this.completions = new CompletionService(store, process.cwd());
    this.pool = new CompletionPool(store, this.completions, config, poolOptions);
    this.codexMeters = new CodexMeterSampler(store, { auth: providerOAuth(openaiCodexProvider(), config.authPath), meters: ORCHESTRATOR_CATALOG.meters.filter(meter => meter.provider === "openai-codex"), autoReset: config.autoReset });
    this.anthropicMeters = new AnthropicMeterSampler(store, { auth: providerOAuth(anthropicProvider(), config.authPath) });
  }

  reconcile(): Promise<void> {
    if (this.detached) return Promise.resolve();
    if (!this.pending) this.pending = this.observe().finally(() => { this.pending = undefined; });
    return this.pending;
  }

  private async observe(): Promise<void> {
    reconcileCompletionReceipts(this.completions, join(this.config.agentDir, "completion-receipts"));
    const retained = this.store.db.prepare("SELECT r.id FROM run r JOIN lease l ON l.id='run:'||r.id WHERE l.ended_at IS NULL AND r.worker_unit='completion:'||r.id").all() as { id: string }[];
    for (const { id } of retained) this.pool.start(this.store.run(id)!);
    this.pool.tick();
    const samples = (await Promise.all([this.codexMeters.sample(Date.now(), this.observation.signal), this.anthropicMeters.sample(Date.now(), this.observation.signal)])).flat();
    if (this.detached) return;
    for (const account of this.store.accounts()) {
      const observed = samples.filter(sample => sample.accountId === account.id && sample.outcome !== "not-due");
      if (!account.enabled) { this.store.setControl(`meter-error:${account.id}`, ""); continue; }
      if (!observed.length) continue;
      const failures = observed.filter(sample => !["recorded", "stale-reading", "reset-credits-unreadable", "reset-pending"].includes(sample.outcome));
      this.store.setControl(`meter-error:${account.id}`, failures.length ? JSON.stringify(failures) : "");
    }
    for (const run of prioritizeReservedCompletions(this.store, this.store.admissionQueue())) {
      if (this.detached) return;
      if (!this.completions.byRun(run.id)) continue;
      const requestId = this.store.control(`completion-run:${run.id}`)!;
      const input = JSON.parse(this.store.control(`completion:${requestId}`)!).input;
      const selected = completionModel(input.model);
      const excluded = input.speed === "ultrafast" && selected
        ? await codexTierExclusions(this.store, providerOAuth(openaiCodexProvider(), this.config.authPath), selected.model, "ultrafast", new Set(), this.observation.signal)
        : new Set<string>();
      if (this.detached) return;
      const assigned = this.store.transaction(() => {
        const choice = assignCompletion(this.store, run.id, run.profile, this.config, this.availability, Date.now(), excluded);
        if (!choice.assignment) { this.store.setControl(`refusal:${run.id}`, choice.refusals.map(refusal => `${refusal.accountId}: ${refusal.reason}`).join("; ")); return false; }
        if (!this.store.assignRun(run.id, { ...choice.assignment, unit: `completion:${run.id}`, releasePath: this.releasePath })) return false;
        this.store.setControl(`refusal:${run.id}`, "");
        return true;
      });
      if (assigned) this.pool.start(this.store.run(run.id)!);
    }
  }

  tick(): void { if (!this.detached) this.pool.tick(); }

  async detach(): Promise<void> {
    if (this.detached) return;
    this.detached = true;
    this.observation.abort();
    this.pool.detach();
    await this.pending;
  }
}

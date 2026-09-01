import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { BrokerConfig, ModelCandidate } from "./broker/broker.js";
import type { MeterSpec } from "./calibrator/types.js";
import { catalogMeter, catalogModel, ORCHESTRATOR_CATALOG } from "./catalog.js";
import { type CooldownPolicy, rateLimitCooldownMs } from "./provider-errors.js";
import { TIERS, type Tier } from "./tasks/types.js";

/**
 * Operator deployment configuration: which catalog models serve each tier,
 * plus private deployment providers, meter topology, and cost weighting.
 * Catalog ids resolve to provider API names here; everything downstream works
 * in tiers and measured facts.
 *
 * Cost weighting turns raw token components (usage-logger class ids are
 * `model:component`) into price-comparable cost units at calibrator replay
 * time — weights are relative prices, the single per-meter scale is
 * measured. `modelClasses` buckets models whose usage drains different
 * meters (Anthropic's opus/fable weekly coupling); unlisted models fall in
 * the `default` bucket.
 */

export interface ProviderConfig {
  readonly meters: readonly { id: string; drainedBy: readonly string[]; windowHours: number }[];
  /** Relative price per token component (input/output/cacheRead/cacheWrite).
   * A family with no meters prices nothing, so it may omit them. */
  readonly costWeights?: Readonly<Record<string, number>>;
  /** model id -> model class; models absent here class as "default". */
  readonly modelClasses?: Readonly<Record<string, string>>;
  /** Concurrent sessions each account of this family may hold, declared by
   * the operator instead of measured.
   *
   * Measurement answers "how many sessions does this plan sustain" by
   * dividing a paced allowance by observed drain, which needs a plan window
   * to drain. A pay-as-you-go API key has none: nothing resets, nothing is
   * allocated, and the only real limit is how much concurrency the operator
   * wants to buy or how much the endpoint will take. Such a family declares
   * that number here and skips calibration entirely — it is the answer, not
   * a bootstrap floor or a ceiling on a measurement. */
  readonly sessionCapacity?: number;
  /** How long an account of this family sits out a rate-limit error that
   * named no window.
   *
   * Plan-metered families want the long default: their unnamed 429 means an
   * empty window. A family that throttles bursts instead is out for seconds
   * (measured burst throttles have cleared in 3–15s), so the default would
   * bench a healthy account for two orders of magnitude longer than the
   * condition lasts. Such a family declares its own class here. */
  readonly throttleCooldownMs?: number;
}

export interface OrchestratorConfig {
  readonly tiers: Readonly<Record<Tier, readonly ModelCandidate[]>>;
  readonly providers: Readonly<Record<string, ProviderConfig>>;
  /** Concurrent sessions this machine will host, whatever provider quota is
   * left. Sessions run inside the runner process, so this is a memory bound
   * and belongs to the deployment, not to any plan. */
  readonly maxConcurrentSessions?: number;
  /** Launches advertised per tier per cycle: a ramp limiter, not a
   * concurrency limit. */
  readonly maxSlotsPerTier?: number;
  /** Authoritative lane definitions reconciled at controller startup. */
  readonly taskManifest?: string;
}

export function defaultConfigPath(): string {
  return (
    process.env.PI_ORCHESTRATOR_CONFIG ??
    join(homedir(), ".config", "pi-orchestrator", "config.json")
  );
}

type CandidateDocument = ModelCandidate | string | { readonly id: string; readonly thinking?: string };
type MeterDocument = string | {
  readonly id: string;
  readonly drainedBy?: readonly string[];
  readonly windowHours?: number;
};
type ProviderDocument = Omit<ProviderConfig, "meters"> & {
  readonly meters: readonly MeterDocument[];
};
type ConfigDocument = Omit<OrchestratorConfig, "tiers" | "providers"> & {
  readonly tiers: Readonly<Record<Tier, readonly CandidateDocument[]>>;
  readonly providers: Readonly<Record<string, ProviderDocument>>;
};

function resolveCandidate(candidate: CandidateDocument, tier: Tier): ModelCandidate {
  if (typeof candidate !== "string" && !("id" in candidate)) return candidate;
  const id = typeof candidate === "string" ? candidate : candidate.id;
  const model = catalogModel(id);
  if (model === undefined) throw new Error(`config: tier ${tier} references unknown catalog model ${id}`);
  const thinking = typeof candidate === "string" ? model.thinking : candidate.thinking ?? model.thinking;
  return { provider: model.provider, model: model.model, ...(thinking === undefined ? {} : { thinking }) };
}

export function loadConfig(path = defaultConfigPath()): OrchestratorConfig {
  const document = JSON.parse(readFileSync(path, "utf8")) as ConfigDocument;
  const tiers = {} as Record<Tier, readonly ModelCandidate[]>;
  for (const tier of TIERS) {
    tiers[tier] = (document.tiers[tier] ?? []).map((candidate) => resolveCandidate(candidate, tier));
  }
  const providers = Object.fromEntries(Object.entries(document.providers).map(([name, provider]) => [
    name,
    {
      ...provider,
      meters: provider.meters.map((raw) => {
        const id = typeof raw === "string" ? raw : raw.id;
        const known = catalogMeter(id);
        if (known !== undefined && known.provider !== name) {
          throw new Error(`config: meter ${id} belongs to provider ${known.provider}, not ${name}`);
        }
        const drainedBy = (typeof raw === "string" ? undefined : raw.drainedBy) ?? known?.drainedBy;
        const windowHours = (typeof raw === "string" ? undefined : raw.windowHours) ?? known?.windowHours;
        if (drainedBy === undefined || windowHours === undefined) {
          throw new Error(`config: provider ${name} meter ${id} needs drainedBy and windowHours or a catalog definition`);
        }
        return { id, drainedBy, windowHours };
      }),
      modelClasses: {
        ...Object.fromEntries(ORCHESTRATOR_CATALOG.models
          .filter((model) => model.provider === name && model.meterClass !== undefined)
          .map((model) => [model.model, model.meterClass!])),
        ...(provider.modelClasses ?? {}),
      },
    },
  ]));
  const taskManifest = document.taskManifest === undefined
    ? undefined
    : isAbsolute(document.taskManifest)
      ? document.taskManifest
      : resolve(dirname(path), document.taskManifest);
  const cfg: OrchestratorConfig = { ...document, providers, tiers, taskManifest };
  for (const tier of TIERS) {
    for (const candidate of cfg.tiers[tier] ?? []) {
      if (cfg.providers[candidate.provider] === undefined) {
        throw new Error(`config: tier ${tier} references unknown provider ${candidate.provider}`);
      }
    }
  }
  for (const [name, provider] of Object.entries(cfg.providers)) {
    if (
      provider.throttleCooldownMs !== undefined &&
      (!Number.isFinite(provider.throttleCooldownMs) || provider.throttleCooldownMs < 0)
    ) {
      throw new Error(`config: provider ${name} throttleCooldownMs must be a non-negative number`);
    }
    if (provider.sessionCapacity !== undefined) {
      if (!Number.isInteger(provider.sessionCapacity) || provider.sessionCapacity < 1) {
        throw new Error(`config: provider ${name} sessionCapacity must be a positive integer`);
      }
      continue;
    }
    if (provider.meters.length === 0) {
      throw new Error(
        `config: provider ${name} has no meters and declares no sessionCapacity, so nothing ` +
        `can say how many sessions it may run`,
      );
    }
  }
  return cfg;
}

/** Every surface that cools an account down asks this: the ledger says which
 * family the account belongs to, config says what that family's rate limits
 * are made of. */
export function cooldownPolicy(cfg: OrchestratorConfig): CooldownPolicy {
  return (family, message) =>
    rateLimitCooldownMs(
      message,
      family === undefined ? undefined : cfg.providers[family]?.throttleCooldownMs,
    );
}

/** Maps a logged `model:component` usage class onto its cost class. */
export function costTransform(
  cfg: OrchestratorConfig,
  family: string,
): (classId: string, tokens: number) => { classId: string; tokens: number } {
  const provider = cfg.providers[family];
  return (classId, tokens) => {
    const split = classId.lastIndexOf(":");
    const model = split >= 0 ? classId.slice(0, split) : classId;
    const component = split >= 0 ? classId.slice(split + 1) : "";
    const modelClass = provider?.modelClasses?.[model] ?? "default";
    const weight = provider?.costWeights?.[component] ?? 1;
    return { classId: `${modelClass}:cost`, tokens: tokens * weight };
  };
}

export function meterSpecs(cfg: OrchestratorConfig, family: string): MeterSpec[] {
  return (cfg.providers[family]?.meters ?? []).map((m) => ({
    id: m.id,
    drainedBy: m.drainedBy,
    nominalWindowMs: m.windowHours * 3_600_000,
  }));
}

/** Broker wiring from operator config. The transform dispatches per account
 * family at replay time; meters are per family. */
export function brokerConfig(
  cfg: OrchestratorConfig,
): Pick<BrokerConfig, "tiers" | "meters" | "modelClasses" | "declaredCapacity" | "transform"> &
  Partial<Pick<BrokerConfig, "maxConcurrentSessions" | "maxSlotsPerTier">> {
  const meters: Record<string, MeterSpec[]> = {};
  const modelClasses: Record<string, Record<string, string>> = {};
  const declaredCapacity: Record<string, number> = {};
  const transforms = new Map<string, (c: string, t: number) => { classId: string; tokens: number }>();
  for (const family of Object.keys(cfg.providers)) {
    meters[family] = meterSpecs(cfg, family);
    modelClasses[family] = { ...(cfg.providers[family]?.modelClasses ?? {}) };
    const declared = cfg.providers[family]?.sessionCapacity;
    if (declared !== undefined) declaredCapacity[family] = declared;
    transforms.set(family, costTransform(cfg, family));
  }
  return {
    tiers: cfg.tiers,
    meters,
    modelClasses,
    declaredCapacity,
    ...(cfg.maxConcurrentSessions === undefined
      ? {}
      : { maxConcurrentSessions: cfg.maxConcurrentSessions }),
    ...(cfg.maxSlotsPerTier === undefined ? {} : { maxSlotsPerTier: cfg.maxSlotsPerTier }),
    transform: (provider, classId, tokens) =>
      transforms.get(provider)?.(classId, tokens) ?? { classId, tokens },
  };
}

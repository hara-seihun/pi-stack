import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { BrokerConfig, ModelCandidate } from "./broker/broker.js";
import type { MeterSpec } from "./calibrator/types.js";
import { TIERS, type Tier } from "./tasks/types.js";

/**
 * Operator deployment configuration: which models serve which tier, and each
 * provider family's meter topology and cost weighting. This file is the only
 * place model names appear; everything downstream works in tiers and
 * measured facts.
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
  /** Relative price per token component (input/output/cacheRead/cacheWrite). */
  readonly costWeights: Readonly<Record<string, number>>;
  /** model id -> model class; models absent here class as "default". */
  readonly modelClasses?: Readonly<Record<string, string>>;
}

export interface OrchestratorConfig {
  readonly tiers: Readonly<Record<Tier, readonly ModelCandidate[]>>;
  readonly providers: Readonly<Record<string, ProviderConfig>>;
}

export function defaultConfigPath(): string {
  return (
    process.env.PI_ORCHESTRATOR_CONFIG ??
    join(homedir(), ".config", "pi-orchestrator", "config.json")
  );
}

export function loadConfig(path = defaultConfigPath()): OrchestratorConfig {
  const cfg = JSON.parse(readFileSync(path, "utf8")) as OrchestratorConfig;
  for (const tier of TIERS) {
    for (const candidate of cfg.tiers[tier] ?? []) {
      if (cfg.providers[candidate.provider] === undefined) {
        throw new Error(`config: tier ${tier} references unknown provider ${candidate.provider}`);
      }
    }
  }
  for (const [name, provider] of Object.entries(cfg.providers)) {
    if (provider.meters.length === 0) throw new Error(`config: provider ${name} has no meters`);
  }
  return cfg;
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
    const weight = provider?.costWeights[component] ?? 1;
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
): Pick<BrokerConfig, "tiers" | "meters" | "transform"> {
  const meters: Record<string, MeterSpec[]> = {};
  const transforms = new Map<string, (c: string, t: number) => { classId: string; tokens: number }>();
  for (const family of Object.keys(cfg.providers)) {
    meters[family] = meterSpecs(cfg, family);
    transforms.set(family, costTransform(cfg, family));
  }
  return {
    tiers: cfg.tiers,
    meters,
    transform: (provider, classId, tokens) =>
      transforms.get(provider)?.(classId, tokens) ?? { classId, tokens },
  };
}

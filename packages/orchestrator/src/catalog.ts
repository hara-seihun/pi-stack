export interface ModelCandidate {
  readonly provider: string;
  readonly model: string;
  readonly thinking?: string;
}

/**
 * Stable identities shared by scheduling, observation, and operator clients.
 * Provider API names and meter topology belong here once; a deployment may
 * still add private models with a full ModelCandidate in its operator config.
 */
export interface CatalogModel extends ModelCandidate {
  readonly id: string;
  readonly label: string;
  readonly aliases: readonly string[];
  readonly icon: string;
  readonly accent: string;
  /** Usage class when this model drains a provider meter separately. */
  readonly meterClass?: string;
}

export interface CatalogMeter {
  readonly id: string;
  readonly provider: string;
  readonly drainedBy: readonly string[];
  readonly windowHours: number;
}

export interface PlanMetric {
  readonly id: string;
  readonly model: string;
  readonly label?: string;
  readonly name?: string;
  /** The most depleted fresh meter is the binding meter for this metric. */
  readonly meters: readonly string[];
}

export interface PlanDefinition {
  readonly id: string;
  readonly label: string;
  readonly icon: string;
  readonly provider: string;
  readonly maxReadingAgeMs: number;
  readonly metrics: readonly PlanMetric[];
}

export interface OrchestratorCatalog {
  readonly models: readonly CatalogModel[];
  readonly meters: readonly CatalogMeter[];
  readonly agentOrder: readonly string[];
  readonly plans: readonly PlanDefinition[];
}

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

export const ORCHESTRATOR_CATALOG: OrchestratorCatalog = {
  models: [
    { id: "astra", provider: "openai-codex", model: "gpt-6-astra", thinking: "xhigh", label: "ASTRA", aliases: ["astra"], icon: "astra", accent: "#5a6673", meterClass: "astra" },
    { id: "luna", provider: "openai-codex", model: "gpt-5.6-luna", thinking: "max", label: "LUNA", aliases: ["luna"], icon: "luna", accent: "#5a6673", meterClass: "luna" },
    { id: "terra", provider: "openai-codex", model: "gpt-5.6-terra", thinking: "max", label: "TERRA", aliases: ["terra"], icon: "terra", accent: "#5a6673", meterClass: "terra" },
    { id: "opus", provider: "anthropic", model: "claude-opus-5", thinking: "xhigh", label: "OPUS", aliases: ["opus"], icon: "opus", accent: "#d9663d", meterClass: "opus" },
    { id: "fable", provider: "anthropic", model: "claude-fable-5-1", thinking: "high", label: "FABLE", aliases: ["fable"], icon: "fable", accent: "#e6a23c", meterClass: "fable" },
    { id: "sonnet", provider: "anthropic", model: "claude-sonnet", thinking: "high", label: "SONNET", aliases: ["sonnet"], icon: "sonnet", accent: "#d9663d" },
  ],
  meters: [
    { id: "codex-5h", provider: "openai-codex", drainedBy: ["luna:cost", "astra:cost", "terra:cost"], windowHours: 5 },
    { id: "codex-7d", provider: "openai-codex", drainedBy: ["luna:cost", "astra:cost", "terra:cost"], windowHours: 168 },
    { id: "anthropic-5h", provider: "anthropic", drainedBy: ["default:cost", "opus:cost", "fable:cost"], windowHours: 5 },
    { id: "anthropic-7d", provider: "anthropic", drainedBy: ["default:cost", "opus:cost", "fable:cost"], windowHours: 168 },
    { id: "anthropic-7d_oi", provider: "anthropic", drainedBy: ["fable:cost"], windowHours: 168 },
  ],
  agentOrder: ["astra", "luna", "terra", "fable", "opus", "sonnet"],
  plans: [
    {
      id: "openai", label: "OpenAI", icon: "openai", provider: "openai-codex", maxReadingAgeMs: HOUR,
      metrics: [{ id: "remaining", model: "astra", meters: ["codex-5h", "codex-7d"] }],
    },
    {
      id: "anthropic", label: "Anthropic", icon: "anthropic", provider: "anthropic", maxReadingAgeMs: 14 * DAY,
      metrics: [
        { id: "fable", model: "fable", label: "F", name: "Fable weekly", meters: ["anthropic-7d_oi"] },
        { id: "weekly", model: "opus", label: "W", name: "Weekly, all models including Opus", meters: ["anthropic-7d"] },
      ],
    },
  ],
};

export function catalogModel(id: string): CatalogModel | undefined {
  return ORCHESTRATOR_CATALOG.models.find((model) => model.id === id);
}

export function catalogMeter(id: string): CatalogMeter | undefined {
  return ORCHESTRATOR_CATALOG.meters.find((meter) => meter.id === id);
}

export function catalogAgentType(raw: string): { key: string; label: string } {
  const value = raw.toLowerCase();
  const match = ORCHESTRATOR_CATALOG.models.find((model) => {
    const names = [model.model, `${model.provider}/${model.model}`, ...model.aliases];
    return names.some((name) => value === name.toLowerCase() || value.includes(name.toLowerCase()));
  });
  if (match) return { key: match.id, label: match.label };
  const bare = raw.split("/").at(-1)?.split(":")[0] || "unknown";
  return { key: bare.toLowerCase().replace(/[^a-z0-9]+/g, "-") || "unknown", label: bare.toUpperCase() };
}

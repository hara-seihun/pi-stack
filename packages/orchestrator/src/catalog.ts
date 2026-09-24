import customModelConfig from "./models.json" with { type: "json" };

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
  /** All listed windows must be fresh before the metric reports available quota. */
  readonly requireAllMeters?: boolean;
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

export const SUBAGENT_MODEL_DESCRIPTIONS = [
  "Sol is a senior engineer.",
  "Luna is a junior engineer.",
  'With the exception of the fact that even weaker models are very good at classification tasks and inference tasks. If the goal is "here\'s a big chunk of text, discover something" or "here\'s a big chunk of text, make an inference," basically any model can do that almost perfectly.',
].join(" ");

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

export const ORCHESTRATOR_CATALOG: OrchestratorCatalog = {
  models: [
    { id: "astra", provider: "openai-codex", model: "gpt-6-astra", thinking: "high", label: "ASTRA", aliases: ["astra"], icon: "⭐", accent: "#5a6673", meterClass: "astra" },
    { id: "sol", provider: "openai-codex", model: "gpt-6-sol", thinking: "high", label: "SOL", aliases: ["sol"], icon: "☀️", accent: "#5a6673", meterClass: "sol" },
    { id: "luna", provider: "openai-codex", model: "gpt-6-luna", thinking: "max", label: "LUNA", aliases: ["luna"], icon: "🌙", accent: "#5a6673", meterClass: "luna" },
    { id: "opus", provider: "anthropic", model: "claude-opus-5-5", thinking: "high", label: "OPUS", aliases: ["opus"], icon: customModelConfig.providers.anthropic.models.find(model => model.id === "claude-opus-5-5")!.icon, accent: "#d9663d", meterClass: "opus" },
    { id: "fable", provider: "anthropic", model: "claude-fable-5-1", thinking: "high", label: "FABLE", aliases: ["fable"], icon: customModelConfig.providers.anthropic.models.find(model => model.id === "claude-fable-5-1")!.icon, accent: "#e6a23c", meterClass: "fable" },
    { id: "sonnet", provider: "anthropic", model: "claude-sonnet-5", thinking: "high", label: "SONNET", aliases: ["sonnet"], icon: "sonnet", accent: "#d9663d" },
  ],
  meters: [
    { id: "codex-5h", provider: "openai-codex", drainedBy: ["astra:cost", "sol:cost", "luna:cost"], windowHours: 5 },
    { id: "codex-7d", provider: "openai-codex", drainedBy: ["astra:cost", "sol:cost", "luna:cost"], windowHours: 168 },
    { id: "anthropic-5h", provider: "anthropic", drainedBy: ["default:cost", "opus:cost", "fable:cost"], windowHours: 5 },
    { id: "anthropic-7d", provider: "anthropic", drainedBy: ["default:cost", "opus:cost", "fable:cost"], windowHours: 168 },
    { id: "anthropic-7d_oi", provider: "anthropic", drainedBy: ["fable:cost"], windowHours: 168 },
  ],
  agentOrder: ["astra", "sol", "luna", "fable", "opus", "sonnet"],
  plans: [
    {
      id: "openai", label: "OpenAI", icon: "openai", provider: "openai-codex", maxReadingAgeMs: HOUR,
      metrics: [{ id: "remaining", model: "astra", meters: ["codex-5h", "codex-7d"] }],
    },
    {
      id: "anthropic", label: "Anthropic", icon: "anthropic", provider: "anthropic", maxReadingAgeMs: 14 * DAY,
      metrics: [
        { id: "fable", model: "fable", label: "F", name: "Fable weekly", meters: ["anthropic-7d", "anthropic-7d_oi"], requireAllMeters: true },
        { id: "weekly", model: "opus", label: "W", name: "Weekly, all models including Opus", meters: ["anthropic-7d"] },
      ],
    },
  ],
};

export function catalogModel(id: string): CatalogModel | undefined {
  return ORCHESTRATOR_CATALOG.models.find((model) => model.id === id);
}

export function admissionThinking(candidate: Pick<ModelCandidate, "provider" | "model">): "high" | "max" {
  const luna = catalogModel("luna")!;
  return candidate.provider === luna.provider && candidate.model === luna.model ? "max" : "high";
}

export function catalogMeter(id: string): CatalogMeter | undefined {
  return ORCHESTRATOR_CATALOG.meters.find((meter) => meter.id === id);
}

export function modelDrainsMeter(provider: string, model: string, meterId: string): boolean {
  const meter = catalogMeter(meterId);
  if (!meter || meter.provider !== provider) return true;
  const candidate = ORCHESTRATOR_CATALOG.models.find(item => item.provider === provider && item.model === model);
  if (!candidate) return true;
  const meterClass = candidate.meterClass ?? "default";
  return meter.drainedBy.some(key => key.startsWith(`${meterClass}:`) || key.startsWith("default:"));
}

export function catalogAgentType(raw: string): { key: string; label: string } {
  const value = raw.toLowerCase();
  const match = ORCHESTRATOR_CATALOG.models.find((model) => {
    const names = [model.model, `${model.provider}/${model.model}`, ...model.aliases];
    return names.some((name) => {
      const escaped = name.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      return new RegExp(`(^|[^a-z0-9])${escaped}($|[^a-z0-9])`).test(value);
    });
  });
  if (match) return { key: match.id, label: match.label };
  const bare = raw.split("/").at(-1)?.split(":")[0] || "unknown";
  return { key: bare.toLowerCase().replace(/[^a-z0-9]+/g, "-") || "unknown", label: bare.toUpperCase() };
}

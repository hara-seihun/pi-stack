import type { ModelCandidate } from "./broker/broker.js";

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
}

export interface CatalogMeter {
  readonly id: string;
  readonly windowHours: number;
}

export interface PlanMetric {
  readonly id: string;
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
    { id: "sol", provider: "openai-codex", model: "gpt-5.6-sol", thinking: "xhigh", label: "SOL", aliases: ["sol"], icon: "sol", accent: "#5a6673" },
    { id: "luna", provider: "openai-codex", model: "gpt-5.6-luna", thinking: "max", label: "LUNA", aliases: ["luna"], icon: "luna", accent: "#5a6673" },
    { id: "terra", provider: "openai-codex", model: "gpt-5.6-terra", thinking: "max", label: "TERRA", aliases: ["terra"], icon: "terra", accent: "#5a6673" },
    { id: "opus", provider: "anthropic", model: "claude-opus-5", thinking: "xhigh", label: "OPUS", aliases: ["opus"], icon: "opus", accent: "#d9663d" },
    { id: "fable", provider: "anthropic", model: "claude-fable-5", thinking: "high", label: "FABLE", aliases: ["fable"], icon: "fable", accent: "#e6a23c" },
    { id: "sonnet", provider: "anthropic", model: "claude-sonnet", thinking: "high", label: "SONNET", aliases: ["sonnet"], icon: "sonnet", accent: "#d9663d" },
    { id: "grok", provider: "cursor", model: "grok-4.6", thinking: "xhigh", label: "GROK", aliases: ["grok"], icon: "grok", accent: "#111111" },
    { id: "pro", provider: "chatgpt-pro", model: "gpt-5-6-pro-literal", thinking: "max", label: "PRO", aliases: ["pro", "gpt-5-6-pro", "gpt-5.6-pro"], icon: "pro", accent: "#5a6673" },
  ],
  meters: [
    { id: "codex-5h", windowHours: 5 },
    { id: "codex-7d", windowHours: 168 },
    { id: "anthropic-5h", windowHours: 5 },
    { id: "anthropic-7d", windowHours: 168 },
    { id: "anthropic-7d_oi", windowHours: 168 },
    { id: "cursor-month", windowHours: 720 },
  ],
  agentOrder: ["sol", "luna", "terra", "pro", "fable", "opus", "grok", "sonnet"],
  plans: [
    {
      id: "openai", label: "OpenAI", icon: "openai", provider: "openai-codex", maxReadingAgeMs: HOUR,
      metrics: [{ id: "remaining", meters: ["codex-5h", "codex-7d"] }],
    },
    {
      id: "anthropic", label: "Anthropic", icon: "anthropic", provider: "anthropic", maxReadingAgeMs: 14 * DAY,
      metrics: [
        { id: "fable", label: "F", name: "Fable weekly", meters: ["anthropic-7d_oi"] },
        { id: "weekly", label: "W", name: "Weekly, all models including Opus", meters: ["anthropic-7d"] },
      ],
    },
    {
      id: "cursor", label: "Cursor", icon: "cursor", provider: "cursor", maxReadingAgeMs: HOUR,
      metrics: [{ id: "remaining", meters: ["cursor-month"] }],
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

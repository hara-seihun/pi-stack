import { getSupportedThinkingLevels, type Model as ProviderModel } from "@earendil-works/pi-ai";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import additions from "../models.json" with { type: "json" };
import type { Model } from "./codex-protocol/v2/Model.js";

export function codexProviderFamily(provider: string): "openai-codex" | "anthropic" | undefined {
  if (provider === "openai" || /^openai-codex(?:-\d+)?$/.test(provider)) return "openai-codex";
  if (/^anthropic(?:-\d+)?$/.test(provider)) return "anthropic";
  return undefined;
}

export function anthropicModels(): ProviderModel<"anthropic-messages">[] {
  const models = new Map(anthropicProvider().getModels().map(model => [model.id, model]));
  for (const model of additions.providers.anthropic.models) models.set(model.id, model as ProviderModel<"anthropic-messages">);
  return [...models.values()];
}

export function anthropicCodexModels(): Model[] {
  return anthropicModels().map(model => ({
    id: model.id, model: model.id, displayName: model.name, description: model.name,
    upgrade: null, upgradeInfo: null, availabilityNux: null, modelSpecialty: null, hidden: false,
    supportedReasoningEfforts: getSupportedThinkingLevels(model).map(level => ({
      reasoningEffort: level === "off" ? "none" : level, description: level,
    })),
    defaultReasoningEffort: model.reasoning ? "high" : "none", inputModalities: model.input,
    supportsPersonality: false, multiAgentVersion: null, additionalSpeedTiers: [], serviceTiers: [],
    defaultServiceTier: null, isDefault: model.id === "claude-fable-5-1",
  }));
}

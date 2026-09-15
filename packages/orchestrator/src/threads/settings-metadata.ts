import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import { withCustomModels } from "../extension/routing.js";
import type { ThreadSettings } from "./contracts.js";

const models = builtinProviders().filter(provider => provider.id === "openai-codex" || provider.id === "anthropic")
  .flatMap(provider => [...withCustomModels(provider).getModels()]);

export function threadSettingsMetadata(settings: ThreadSettings) {
  const separator = settings.model.indexOf("/");
  const provider = settings.model.slice(0, separator), id = settings.model.slice(separator + 1);
  const model = models.find(model => model.provider === provider && model.id === id);
  return {
    model: model ?? { provider, id },
    models,
    thinkingLevel: settings.thinkingLevel,
    thinkingLevels: model ? getSupportedThinkingLevels(model) : [settings.thinkingLevel],
    speedMode: settings.speed,
    speedModes: provider === "openai-codex" ? ["standard", "priority"] : [],
  };
}

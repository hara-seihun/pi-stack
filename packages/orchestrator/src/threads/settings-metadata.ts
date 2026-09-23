import { nativeThreadModels, type ThreadModelCatalog } from "./model-catalog.js";
import { ORCHESTRATOR_CATALOG } from "../catalog.js";
import type { ThreadSettings } from "./contracts.js";

export function threadSettingsMetadata(settings: ThreadSettings, catalog: ThreadModelCatalog = { models: nativeThreadModels, configuredModels: [] }) {
  const nativeModels = catalog.models;
  const models = nativeModels.filter(model => ORCHESTRATOR_CATALOG.models.some(candidate =>
    candidate.provider === model.provider && candidate.model === model.id) || catalog.configuredModels.some(candidate =>
    candidate.provider === model.provider && candidate.id === model.id));
  const separator = settings.model.indexOf("/");
  const provider = settings.model.slice(0, separator).replace(/^(openai-codex|anthropic)-\d+$/, "$1");
  const id = settings.model.slice(separator + 1);
  const model = nativeModels.find(model => model.provider === provider && model.id === id);
  const selected = model ?? { provider, id };
  return {
    model: selected,
    models: models.some(model => model.provider === provider && model.id === id) ? models : [...models, selected],
    thinkingLevel: settings.thinkingLevel,
    thinkingLevels: model ? model.thinkingLevels : [settings.thinkingLevel],
    speedMode: settings.speed,
    speedModes: provider === "openai-codex" ? ["standard", "priority"] : [],
  };
}

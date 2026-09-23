import type { Model, Provider } from "@earendil-works/pi-ai";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import customModelConfig from "./models.json" with { type: "json" };

export function isSupportedModel(model: { id: string }): boolean {
  return !/(^|[-_./:])terra($|[-_./:])/i.test(model.id);
}

export function withCustomModels(provider: Provider): Provider {
  const custom = provider.id === "anthropic" ? customModelConfig.providers.anthropic.models as unknown as Model<"anthropic-messages">[] : [];
  const replacements = new Set(custom.map(model => model.id));
  return { ...provider, getModels: () => [...provider.getModels().filter(model => isSupportedModel(model) && !replacements.has(model.id)), ...custom] };
}

export const nativeProviders = builtinProviders().map(withCustomModels);
export const nativeModels = nativeProviders.flatMap(provider => [...provider.getModels()]);

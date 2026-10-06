import type { Api, Model, Provider } from "@earendil-works/pi-ai";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import customModelConfig from "./models.json" with { type: "json" };

export function isSupportedModel(model: { id: string }): boolean {
  return !/(^|[-_./:])terra($|[-_./:])/i.test(model.id);
}

/** Custom definitions replace builtins by id; retired models remain available to accounting. */
export function modelsWithCustomDefinitions(provider: Provider): Model<Api>[] {
  const providers = customModelConfig.providers as unknown as Record<string, { models: Model<Api>[] }>;
  const custom = providers[provider.id]?.models ?? [];
  const replacements = new Set(custom.map(model => model.id));
  return [...provider.getModels().filter(model => !replacements.has(model.id)), ...custom];
}

export function withCustomModels(provider: Provider): Provider {
  return { ...provider, getModels: () => modelsWithCustomDefinitions(provider).filter(isSupportedModel) };
}

export const nativeProviders = builtinProviders().map(withCustomModels);
export const nativeModels = nativeProviders.flatMap(provider => [...provider.getModels()]);

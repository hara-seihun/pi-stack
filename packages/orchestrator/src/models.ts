import type { Model, Provider } from "@earendil-works/pi-ai";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import customModelConfig from "./models.json" with { type: "json" };

export function withCustomModels(provider: Provider): Provider {
  if (provider.id !== "anthropic") return provider;
  const custom = customModelConfig.providers.anthropic.models as unknown as Model<"anthropic-messages">[];
  const replacements = new Set(custom.map(model => model.id));
  return { ...provider, getModels: () => [...provider.getModels().filter(model => !replacements.has(model.id)), ...custom] };
}

export const nativeProviders = builtinProviders().map(withCustomModels);
export const nativeModels = nativeProviders.flatMap(provider => [...provider.getModels()]);

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { getAgentDir, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { getSupportedThinkingLevels, type Model, type Api } from "@earendil-works/pi-ai";
import { isSupportedModel, nativeModels, nativeProviders } from "../models.js";
import { ORCHESTRATOR_CATALOG } from "../catalog.js";

export type ThreadModelMetadata = Pick<Model<Api>, "id" | "provider" | "name" | "reasoning" | "thinkingLevelMap" | "input" | "contextWindow" | "maxTokens" | "cost"> & {
  thinkingLevels: ReturnType<typeof getSupportedThinkingLevels>;
  /** How pickers and thread rows show the model: an emoji or a client asset name. Every configured model has one; native models carry theirs in the orchestrator catalog. */
  icon?: string;
};

/** The icon a models.json entry supplies, or the orchestrator catalog's for a model it already names. */
export function configuredModelIcon(provider: string, entry: { id: string; icon?: unknown }): string | undefined {
  if (typeof entry.icon === "string" && entry.icon.trim()) return entry.icon.trim();
  return ORCHESTRATOR_CATALOG.models.find(model => model.provider === provider && model.model === entry.id)?.icon;
}

export function threadModelMetadata(model: Model<Api>): ThreadModelMetadata {
  const { id, provider, name, reasoning, thinkingLevelMap, input, contextWindow, maxTokens, cost } = model;
  return { id, provider, name, reasoning, thinkingLevelMap, input, contextWindow, maxTokens, cost, thinkingLevels: getSupportedThinkingLevels(model) };
}

export const nativeThreadModels = nativeModels.map(threadModelMetadata);

export interface ThreadModelCatalog {
  models: ThreadModelMetadata[];
  configuredModels: ThreadModelMetadata[];
}

export async function loadThreadModelCatalog(agentDir = getAgentDir()): Promise<ThreadModelCatalog> {
  const modelsPath = join(agentDir, "models.json");
  const runtime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath, allowModelNetwork: false });
  const anthropic = nativeProviders.find(provider => provider.id === "anthropic")!;
  runtime.registerNativeProvider(anthropic);
  if (runtime.getError()) throw new Error(`Cannot load thread models: ${runtime.getError()}`);
  let config: { providers?: Record<string, { models?: { id: string; icon?: unknown }[] }> };
  try { config = JSON.parse(await readFile(modelsPath, "utf8")); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    config = {};
  }
  const available = new Set((await runtime.getAvailable()).map(model => `${model.provider}/${model.id}`));
  const configuredModels = Object.entries(config.providers ?? {}).flatMap(([provider, config]) =>
    (config.models ?? []).flatMap((entry) => {
      const model = runtime.getModel(provider, entry.id);
      if (!model || !isSupportedModel(model) || !available.has(`${provider}/${entry.id}`)) return [];
      const icon = configuredModelIcon(provider, entry);
      if (!icon) throw new Error(`Cannot load thread models: ${provider}/${entry.id} in ${modelsPath} has no icon. Every model needs one; give the entry an "icon" (an emoji such as "🌳", or a client asset name) before it can be offered.`);
      return [{ ...threadModelMetadata(model), icon }];
    }));
  return { models: runtime.getModels().filter(isSupportedModel).map(threadModelMetadata), configuredModels };
}

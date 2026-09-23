import { ORCHESTRATOR_CATALOG, type ThreadModelMetadata } from "pi-orchestrator/api";

const SHARED_THREAD_MODELS = ["astra", "sol", "luna", "fable", "opus"];

export function threadModelOptions(configured: readonly ThreadModelMetadata[]) {
  const models = new Map(ORCHESTRATOR_CATALOG.models.map(model => [model.id, {
    id: model.id, label: model.label, icon: model.icon, accent: model.accent,
    provider: model.provider, modelId: model.model,
  }]));
  for (const model of configured) {
    const id = `${model.provider}/${model.id}`;
    const known = [...models.values()].find(option => option.provider === model.provider && option.modelId === model.id);
    if (!known && !model.icon) throw new Error(`Thread model ${id} has no icon; every offered model needs one`);
    const option = known ?? { id, label: model.name || model.id, icon: model.icon!, accent: "#8b949e", provider: model.provider, modelId: model.id };
    models.set(id, option);
    if (!models.has(model.provider)) models.set(model.provider, option);
  }
  return models;
}

export function configuredThreadDestinations(destinations: ThreadDestination[], configured: readonly ThreadModelMetadata[]): ThreadDestination[] {
  const options = threadModelOptions(configured);
  return destinations.map(destination => {
    const resolve = (id: string) => {
      const model = options.get(id);
      if (!model) throw new Error(`Unknown thread model ${id} in profile ${destination.id}`);
      return model.id;
    };
    const defaultModel = resolve(destination.defaultModel);
    const models = [...new Set([
      ...SHARED_THREAD_MODELS,
      ...destination.models,
      defaultModel,
      ...configured.map(model => `${model.provider}/${model.id}`),
    ].map(resolve))];
    return { ...destination, models, defaultModel };
  });
}

export function recentThreadModels(
  destination: Pick<ThreadDestination, "id" | "models">,
  history: readonly { profileId: string; model: string; updatedAt: number }[],
  options: ReadonlyMap<string, { id: string }>,
): string[] {
  const recent = new Map<string, number>();
  for (const thread of history) {
    if (thread.profileId !== destination.id) continue;
    const id = options.get(thread.model)?.id ?? thread.model;
    recent.set(id, Math.max(recent.get(id) ?? 0, thread.updatedAt));
  }
  return [...destination.models].sort((a, b) => (recent.get(b) ?? 0) - (recent.get(a) ?? 0));
}

export interface ThreadDestination {
  id: string;
  label: string;
  icon: string;
  accent: string;
  workspaceId: string;
  thinkingLevel: string;
  models: string[];
  defaultModel: string;
  /** The model receives only the conversation: no system prompt, tools, extensions, skills or instruction files. */
  raw?: boolean;
  /** Folder inside the destination's workspace whose top-level Markdown files the picker offers as optional thread context. */
  contextDir?: string;
}

export function defaultThreadDestinations(personalWorkspaceId?: string): ThreadDestination[] {
  const destinations = [
    ...(personalWorkspaceId === undefined ? [] : [
      { id: "personal", label: "PERSONAL", icon: "personal", accent: "#a371f7", workspaceId: personalWorkspaceId, contextDir: "context" },
    ]),
    { id: "home", label: "HOME", icon: "house", accent: "#3fb950", workspaceId: "home" },
    { id: "raw", label: "RAW", icon: "raw", accent: "#8b949e", workspaceId: "home", raw: true },
  ];
  return destinations.map(destination => ({
    ...destination,
    thinkingLevel: "high",
    models: [...SHARED_THREAD_MODELS],
    defaultModel: "astra",
  }));
}

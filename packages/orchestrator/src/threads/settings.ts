import { ORCHESTRATOR_CATALOG } from "../catalog.js";
import { isSupportedModel, nativeModels, nativeProviders } from "../models.js";
import { threadMode } from "./modes.js";
import { isSpeed, requestedSpeedError } from "./speed.js";
import { isThinkingLevel, type Result, type SettingsOverrides, type Thread, type ThreadSettings } from "./contracts.js";

export function resolveSpawnSettings(input: SettingsOverrides | undefined, parent: Thread | null, requestedMode?: unknown, defaultModel?: string): Result<ThreadSettings> {
  const mode = threadMode(parent ? parent.metadata?.mode : requestedMode);
  // This is an owner-selected default, never a request-supplied identity or a model migration.
  // Declared mode choices are permitted selections, not the disabled legacy fallback.
  // Merge only outside modes; explicit models and validation remain unchanged.
  if (!mode && defaultModel !== undefined && (input === undefined || input && typeof input === "object" && !Array.isArray(input))) {
    input = { ...input, model: input?.model ?? defaultModel };
  }
  if (!parent) return mode ? resolveModeSettings(input, mode.conversation.settings) : resolveThreadSettings(input);
  return mode ? resolveModeSettings(input, mode.worker.settings) : resolveThreadSettings(input, { model: "sol", thinkingLevel: "high", speed: "standard" });
}

/** A mode's declared settings are the defaults; a model override keeps the mode's thinking and speed unless those are overridden too. */
function resolveModeSettings(input: SettingsOverrides = {}, declared: Required<SettingsOverrides>): Result<ThreadSettings> {
  if (!input || typeof input !== "object" || Array.isArray(input)) return resolveThreadSettings(input);
  return resolveThreadSettings({ ...input, model: input.model ?? declared.model, thinkingLevel: input.thinkingLevel ?? declared.thinkingLevel, speed: input.speed ?? declared.speed });
}

const settingFields = ["model", "thinkingLevel", "speed"];

export function validateThreadSettings(input: unknown): Result<ThreadSettings> {
  if (!input || typeof input !== "object" || Array.isArray(input)
    || Object.keys(input).some(key => !settingFields.includes(key))
    || !("model" in input) || typeof input.model !== "string" || !input.model.trim()
    || !("thinkingLevel" in input) || !isThinkingLevel(input.thinkingLevel)
    || !("speed" in input) || !isSpeed(input.speed)) {
    return { ok: false, error: { code: "invalid_request", message: "Complete thread settings require model, thinkingLevel and speed" } };
  }
  return resolveThreadSettings({ model: input.model, thinkingLevel: input.thinkingLevel, speed: input.speed });
}

export function resolveThreadSettings(input: SettingsOverrides = {}, current?: ThreadSettings): Result<ThreadSettings> {
  if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some(key => !settingFields.includes(key))) return { ok: false, error: { code: "invalid_request", message: "Expected model, thinkingLevel and speed overrides" } };
  const requested = input.model ?? current?.model ?? "astra";
  if (typeof requested !== "string") return { ok: false, error: { code: "invalid_request", message: "Model must be a catalog name or provider/model" } };
  const separator = requested.indexOf("/");
  const lookup = separator < 0 ? ORCHESTRATOR_CATALOG.models.find(candidate => candidate.id === requested.toLowerCase())?.id ?? requested : requested;
  const provider = requested.slice(0, separator).replace(/-\d+$/, ""), physical = separator < 0 ? undefined : requested.slice(separator + 1);
  const model = ORCHESTRATOR_CATALOG.models.find(candidate => candidate.id === lookup || candidate.model === lookup || physical === candidate.model && provider === candidate.provider);
  const canonical = model ? `${model.provider}/${model.model}` : requested;
  const family = model?.provider ?? provider, modelId = model?.model ?? physical;
  const knownProvider = nativeProviders.some(candidate => candidate.id === family);
  if (!isSupportedModel({ id: lookup }) || (!model && !/^[\w.-]+\/[^\s]+$/.test(requested)) || knownProvider && !nativeModels.some(candidate => candidate.provider === family && candidate.id === modelId)) return { ok: false, error: { code: "invalid_request", message: `Unknown model ${requested}; use an installed model or catalog name (${ORCHESTRATOR_CATALOG.models.filter(candidate => nativeModels.some(native => native.provider === candidate.provider && native.id === candidate.model)).map(candidate => candidate.id).join(", ")})` } };
  const changed = input.model !== undefined && canonical !== current?.model;
  const thinkingLevel = input.thinkingLevel ?? (!changed ? current?.thinkingLevel : undefined) ?? (model?.id === "luna" ? "max" : "high");
  const speed = input.speed ?? (!changed ? current?.speed : undefined) ?? "standard";
  if (!isThinkingLevel(thinkingLevel) || !isSpeed(speed)) return { ok: false, error: { code: "invalid_request", message: "Invalid thinking level or provider speed" } };
  const speedError = requestedSpeedError({ provider: family, id: modelId ?? "" }, speed);
  if (speedError) return { ok: false, error: { code: "invalid_request", message: speedError } };
  return { ok: true, value: { model: canonical, thinkingLevel, speed } };
}

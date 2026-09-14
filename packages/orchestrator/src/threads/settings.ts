import { ORCHESTRATOR_CATALOG } from "../catalog.js";
import type { Result, SettingsOverrides, ThreadSettings, ThinkingLevel } from "./contracts.js";

const levels: readonly ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

export function resolveThreadSettings(input: SettingsOverrides = {}, current?: ThreadSettings): Result<ThreadSettings> {
  if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some(key => !["model", "thinkingLevel", "speed"].includes(key))) return { ok: false, error: { code: "invalid_request", message: "Expected model, thinkingLevel and speed overrides" } };
  const requested = input.model ?? current?.model ?? "astra";
  if (typeof requested !== "string") return { ok: false, error: { code: "invalid_request", message: "Model must be a catalog name or provider/model" } };
  const separator = requested.indexOf("/");
  const provider = requested.slice(0, separator), physical = separator < 0 ? undefined : requested.slice(separator + 1);
  const model = ORCHESTRATOR_CATALOG.models.find(candidate => candidate.id === requested || candidate.model === requested || physical === candidate.model && (provider === candidate.provider || provider?.startsWith(`${candidate.provider}-`)));
  if (!model && !/^[\w.-]+\/[^\s]+$/.test(requested)) return { ok: false, error: { code: "invalid_request", message: `Unknown model ${requested}; use a catalog name or provider/model` } };
  const canonical = model ? `${model.provider}/${model.model}` : requested;
  const changed = input.model !== undefined && canonical !== current?.model;
  const thinkingLevel = input.thinkingLevel ?? (!changed ? current?.thinkingLevel : undefined) ?? (model?.id === "luna" ? "max" : "high");
  const speed = input.speed ?? (!changed ? current?.speed : undefined) ?? "standard";
  if (!levels.includes(thinkingLevel) || !["standard", "priority"].includes(speed)) return { ok: false, error: { code: "invalid_request", message: "Invalid thinking level or provider speed" } };
  return { ok: true, value: { model: canonical, thinkingLevel, speed } };
}

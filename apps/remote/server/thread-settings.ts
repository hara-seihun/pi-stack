import type { Result, SettingsOverrides, Thread, ThreadApi } from "pi-orchestrator/api";
import { BASH_TIMEOUT_OPTIONS } from "./protocol.js";

export async function updateThreadSettings(owner: Pick<ThreadApi, "control">, thread: Thread, body: unknown): Promise<Result<Thread>> {
  const invalid = (message: string): Result<Thread> => ({ ok: false, error: { code: "invalid_request", message } });
  if (!body || typeof body !== "object" || Array.isArray(body)) return invalid("Expected thread settings object");
  const input = body as Record<string, unknown>;
  if (Object.keys(input).some(key => !["modelProvider", "modelId", "thinkingLevel", "speedMode", "bashTimeoutSeconds"].includes(key))) return invalid("Unknown thread setting");
  if ((input.modelId != null || input.modelProvider != null)
    && (typeof input.modelId !== "string" || !input.modelId || typeof input.modelProvider !== "string" || !input.modelProvider)) return invalid("Model provider and ID are required together");
  if (input.bashTimeoutSeconds != null && !(BASH_TIMEOUT_OPTIONS as readonly unknown[]).includes(input.bashTimeoutSeconds)) return invalid("Invalid bash timeout");
  const settings: SettingsOverrides = {};
  if (input.modelId != null) settings.model = `${input.modelProvider}/${input.modelId}`;
  if (input.thinkingLevel != null) settings.thinkingLevel = input.thinkingLevel as SettingsOverrides["thinkingLevel"];
  if (input.speedMode != null) settings.speed = input.speedMode as SettingsOverrides["speed"];
  const changed = await owner.control({ threadId: thread.id, action: "settings", settings });
  if (!changed.ok || input.bashTimeoutSeconds == null) return changed;
  const timeout = await owner.control({ threadId: thread.id, action: "update", metadata: { ...changed.value.metadata, bashTimeoutSeconds: input.bashTimeoutSeconds } });
  if (!timeout.ok) return { ok: false, error: { ...timeout.error,
    message: `Model, thinking and speed settings were saved, but the bash timeout update was not confirmed: ${timeout.error.message}` } };
  return timeout;
}

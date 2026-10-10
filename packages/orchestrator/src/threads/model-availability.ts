import { readFileSync, mkdirSync, writeFileSync, chmodSync, renameSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { ORCHESTRATOR_CATALOG } from "../catalog.js";
import type { Result } from "./contracts.js";

export function modelAvailabilityPath(env: NodeJS.ProcessEnv = process.env): string {
  return env.PI_STACK_MODEL_AVAILABILITY_PATH ?? "/var/lib/pi-stack/model-availability/policy.json";
}

export function modelAvailabilityKey(model: string): string {
  const separator = model.indexOf("/");
  const provider = separator < 0 ? "" : model.slice(0, separator).replace(/-\d+$/, "");
  const physical = separator < 0 ? model : model.slice(separator + 1);
  const known = ORCHESTRATOR_CATALOG.models.find(candidate =>
    separator < 0 ? candidate.id === model.toLowerCase() || candidate.model === model : candidate.provider === provider && candidate.model === physical);
  return known ? `${known.provider}/${known.model}` : separator < 0 ? model : `${provider}/${physical}`;
}

/** The household's decision about one model. Thread start and the model broker both ask for it,
 * so neither can admit a model the other would refuse. `key` is the canonical provider/model. */
export type ModelAvailability =
  | { state: "enabled"; model: string; key: string }
  | { state: "disabled"; model: string; key: string; policy: string };

/** Why a shared (granted) model request is refused. A grant shares a model; it never re-enables
 * one the household has disabled. The model broker and brokered completion admission use this. */
export type SharedModelRefusal =
  | { code: "model-disabled"; model: string; policy: string; message: string }
  | { code: "model-policy-unavailable"; model: string; message: string };
export function sharedModelRefusal(availability: Pick<ModelAvailabilityStore, "decide">, model: string): SharedModelRefusal | null {
  const decision = availability.decide(model);
  if (!decision.ok) return { code: "model-policy-unavailable", model, message: decision.error.message };
  switch (decision.value.state) {
    case "enabled": return null;
    case "disabled": {
      const { key, policy } = decision.value;
      return { code: "model-disabled", model: key, policy,
        message: `${key} is disabled by the household model availability policy (${policy}); a model grant does not override it. An administrator can enable it in Machine → Models.` };
    }
  }
}

const failure = (cause: unknown): Result<never> => ({ ok: false, error: { code: "unavailable", message: `Could not read or save model availability: ${cause instanceof Error ? cause.message : String(cause)}` } });

export class ModelAvailabilityStore {
  constructor(readonly path: string) {}

  disabled(): Result<ReadonlySet<string>> {
    try {
      let text: string;
      try { text = readFileSync(this.path, "utf8"); }
      catch (cause) {
        if ((cause as NodeJS.ErrnoException).code === "ENOENT") return { ok: true, value: new Set() };
        return failure(cause);
      }
      const policy = JSON.parse(text);
      if (!policy || policy.version !== 1 || !Array.isArray(policy.disabled) || policy.disabled.some((id: unknown) => typeof id !== "string" || !id.trim()))
        return failure(new Error(`Invalid policy in ${this.path}; expected version 1 and a disabled model list`));
      return { ok: true, value: new Set(policy.disabled.map(modelAvailabilityKey)) };
    } catch (cause) { return failure(cause); }
  }

  /** Re-reads the policy on every call: a disable reaches the next decision without a restart. */
  decide(model: string): Result<ModelAvailability> {
    const policy = this.disabled();
    if (!policy.ok) return policy;
    const key = modelAvailabilityKey(model);
    return { ok: true, value: policy.value.has(key) ? { state: "disabled", model, key, policy: this.path } : { state: "enabled", model, key } };
  }

  /** Thread-start admission. */
  admit(model: string): Result<void> {
    const decision = this.decide(model);
    if (!decision.ok) return decision;
    return decision.value.state === "disabled"
      ? { ok: false, error: { code: "invalid_request", message: `${model} is disabled for new threads. Enable it in Machine → Models.` } }
      : { ok: true, value: undefined };
  }

  set(model: string, enabled: boolean): Result<void> {
    if (typeof enabled !== "boolean") return { ok: false, error: { code: "invalid_request", message: "enabled must be a boolean" } };
    const policy = this.disabled();
    if (!policy.ok) return policy;
    const disabled = new Set(policy.value), key = modelAvailabilityKey(model);
    if (enabled) disabled.delete(key); else disabled.add(key);
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      writeFileSync(temporary, JSON.stringify({ version: 1, disabled: [...disabled].sort() }, null, 2) + "\n", { mode: 0o644, flag: "wx" });
      chmodSync(temporary, 0o644);
      renameSync(temporary, this.path);
      return { ok: true, value: undefined };
    } catch (cause) {
      rmSync(temporary, { force: true });
      return failure(cause);
    }
  }
}

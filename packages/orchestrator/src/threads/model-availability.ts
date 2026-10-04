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

  admit(model: string): Result<void> {
    const policy = this.disabled();
    if (!policy.ok) return policy;
    return policy.value.has(modelAvailabilityKey(model))
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

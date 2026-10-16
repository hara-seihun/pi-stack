import { isDeepStrictEqual } from "node:util";
import type { CoreConfig } from "./contracts.js";
import type { CoreResult } from "./config.js";

export function validateCoreReload(current: CoreConfig, next: CoreConfig): CoreResult<void> {
  const denied = (message: string): CoreResult<never> => ({ ok: false, error: { code: "ownership-conflict", message } });
  for (const key of ["host", "port", "statePath", "releaseCommit"] as const) {
    if (current[key] !== next[key]) return denied(`Reload cannot change ${key}; use the owning release transaction`);
  }
  for (const previous of current.scopes) {
    const replacement = next.scopes.find(scope => scope.id === previous.id);
    if (!replacement) return denied(`Reload cannot discard scope ${previous.id}`);
    for (const key of ["principalId", "resource", "storage", "manager"] as const) {
      if (!isDeepStrictEqual(previous[key], replacement[key])) return denied(`Reload changes existing ${previous.id}/${key} custody`);
    }
    if (previous.availability.kind === "adopt") {
      if (replacement.availability.kind !== "adopt" || !isDeepStrictEqual(previous.custody, replacement.custody)) return denied(`Reload cannot abandon an adopted ${previous.id} generation`);
    }
  }
  if (current.broker.kind === "configured") {
    if (next.broker.kind !== "configured") return denied("Reload cannot discard provider custody");
    for (const previous of current.broker.retainedLedgers) {
      const replacement = next.broker.retainedLedgers.find(owner => owner.id === previous.id);
      if (!replacement || replacement.databasePath !== previous.databasePath || replacement.uid !== previous.uid || replacement.gid !== previous.gid) return denied(`Reload cannot replace retained completion owner ${previous.id}`);
    }
    if (current.broker.primaryConfigPath !== next.broker.primaryConfigPath) return denied("Reload cannot replace primary completion custody");
  }
  if (current.root.kind === "configured") {
    if (next.root.kind !== "configured" || current.root.consultationScopeId !== next.root.consultationScopeId
      || !isDeepStrictEqual(current.root.requests, next.root.requests) || !isDeepStrictEqual(current.root.consent, next.root.consent)) return denied("Reload cannot replace confidential request custody");
    const owners = next.root.consultationOwners;
    if (current.root.consultationOwners.some(owner => !owners.some(candidate => isDeepStrictEqual(candidate, owner)))) return denied("Reload cannot discard an original consultation owner");
  }
  if (current.memory.kind === "configured" && (next.memory.kind !== "configured" || current.memory.databasePath !== next.memory.databasePath || current.memory.custodyScopeId !== next.memory.custodyScopeId)) return denied("Reload cannot replace memory custody");
  return { ok: true, value: undefined };
}

export type ReloadableCore = { close(): Promise<CoreResult<void>> };
export class CoreReloadOwner {
  private queue: Promise<void> = Promise.resolve();
  private stopping = false;
  private running: ReloadableCore | null;
  constructor(private config: CoreConfig, running: ReloadableCore,
    private readonly load: () => CoreResult<CoreConfig>,
    private readonly serve: (config: CoreConfig) => Promise<CoreResult<ReloadableCore>>) { this.running = running; }

  reload(): Promise<CoreResult<void>> {
    return this.enqueue(async () => {
      if (this.stopping) return { ok: false, error: { code: "unavailable", message: "Core is stopping" } };
      const loaded = this.load();
      if (!loaded.ok) return loaded;
      const valid = validateCoreReload(this.config, loaded.value);
      if (!valid.ok) return valid;
      if (this.running && isDeepStrictEqual(this.config, loaded.value)) return { ok: true, value: undefined };
      if (this.running) {
        const drained = await this.running.close();
        if (!drained.ok) return drained;
        this.running = null;
      }
      if (this.stopping) return { ok: true, value: undefined };
      const started = await this.serve(loaded.value);
      if (!started.ok) return started;
      this.config = loaded.value;
      this.running = started.value;
      return { ok: true, value: undefined };
    });
  }

  stop(): Promise<CoreResult<void>> {
    this.stopping = true;
    return this.enqueue(async () => {
      if (!this.running) return { ok: true, value: undefined };
      const result = await this.running.close();
      if (result.ok) this.running = null;
      return result;
    });
  }

  private enqueue(operation: () => Promise<CoreResult<void>>): Promise<CoreResult<void>> {
    const result = this.queue.then(async (): Promise<CoreResult<void>> => {
      try { return await operation(); }
      catch (cause) { return { ok: false, error: { code: "unavailable", message: `Core lifecycle failed: ${cause instanceof Error ? cause.message : String(cause)}` } }; }
    });
    this.queue = result.then(() => undefined);
    return result;
  }
}

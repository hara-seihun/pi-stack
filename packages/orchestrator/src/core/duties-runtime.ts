import { isAbsolute, resolve } from "node:path";
import { authorize, type PermissionPolicy, type Principal } from "../permissions.js";
import { WatchList } from "../threads/watch-list.js";
import type { SpawnThread, ThreadApi, ThreadError } from "../threads/contracts.js";
import type { ThreadService } from "../threads/service.js";
import { adoptMarkdownDuties, validateMarkdownDutyCustody, type MarkdownDutyReceipt } from "./duties.js";
import { acquireDatabaseOwnership, WATCH_CUSTODY_TABLES, type ScopeOwnership } from "./ownership.js";
import type { CoreScope } from "./contracts.js";
import type { CoreResult } from "./config.js";

export { WATCH_CUSTODY_TABLES } from "./ownership.js";
export type CoreDutySpec = {
  scopeId: string; path: string;
  watch: { kind: "none" } | { kind: "existing"; databasePath: string; adoptionReceiptPath: string; acceptedSpool: "drain" | "hold" };
};
export type CoreDutiesConfig = { kind: "disabled" } | { kind: "configured"; entries: CoreDutySpec[] };
export type CoreDutyScope = { threads: ThreadService; runtime: { path(logicalPath: string): string } };
export interface CoreDutiesOptions {
  scopes: readonly CoreScope[];
  principals: readonly Principal[];
  policy: PermissionPolicy;
  owner(scopeId: string): CoreResult<CoreDutyScope>;
  enabled(): boolean;
  /** Authorized directory of the already-owned scope; no new controller or principal is created. */
  threads?(scopeId: string): Pick<ThreadApi, "spawn" | "list" | "questions">;
}
const invalid = (message: string): CoreResult<never> => ({ ok: false, error: { code: "invalid-config", message } });
const unavailable = (message: string): CoreResult<never> => ({ ok: false, error: { code: "unavailable", message } });
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const exact = (value: Record<string, unknown>, keys: readonly string[]) => Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const absolute = (value: unknown): value is string => typeof value === "string" && isAbsolute(value) && resolve(value) === value && !value.includes("\0");

export function parseCoreDutiesConfig(value: unknown): CoreResult<CoreDutiesConfig> {
  if (!object(value)) return invalid("Core duties require explicit disabled or configured state");
  if (value.kind === "disabled" && exact(value, ["kind"])) return { ok: true, value: { kind: "disabled" } };
  if (value.kind !== "configured" || !exact(value, ["kind", "entries"]) || !Array.isArray(value.entries) || !value.entries.length) return invalid("Configured duties require explicit entries");
  const scopes = new Set<string>(), paths = new Set<string>(), databases = new Set<string>();
  for (const entry of value.entries) {
    if (!object(entry) || !exact(entry, ["scopeId", "path", "watch"]) || typeof entry.scopeId !== "string" || !/^[a-zA-Z0-9_.:-]+$/.test(entry.scopeId)
      || scopes.has(entry.scopeId) || !absolute(entry.path) || paths.has(entry.path) || !object(entry.watch)) return invalid("Duty entries require unique scope IDs and canonical Markdown paths");
    const watch = entry.watch;
    if (watch.kind === "none") {
      if (!exact(watch, ["kind"])) return invalid("No-watch custody accepts only kind none");
    } else if (watch.kind === "existing") {
      if (!exact(watch, ["kind", "databasePath", "adoptionReceiptPath", "acceptedSpool"]) || !absolute(watch.databasePath) || !absolute(watch.adoptionReceiptPath)
        || databases.has(watch.databasePath) || watch.databasePath === entry.path || watch.adoptionReceiptPath === entry.path
        || watch.acceptedSpool !== "drain" && watch.acceptedSpool !== "hold") return invalid("Existing watch custody requires its exact database, receipt and drain/hold decision");
      databases.add(watch.databasePath);
    } else return invalid("Watch custody must be none or existing");
    scopes.add(entry.scopeId); paths.add(entry.path);
  }
  return { ok: true, value: value as unknown as CoreDutiesConfig };
}

export type DutyCustodyError = {
  scopeId: string; path: string;
  stage: "scope-owner" | "watch-owner" | "markdown" | "manager-pointer" | "resources" | "accepted-spool";
  error: { code: ThreadError["code"] | Extract<CoreResult<never>, { ok: false }>["error"]["code"]; message: string };
};

type AdoptedDuty = {
  spec: CoreDutySpec; scope: CoreScope; owner: CoreDutyScope; principal: Principal;
  watch: WatchList | null; unbindWatch: (() => void) | null; ownership: ScopeOwnership | null; receipt: MarkdownDutyReceipt;
};

/** The main clock calls tick. This adapter adopts old duties and drains only their original accepted spool. */
export class CoreDuties {
  private readonly adopted = new Map<string, AdoptedDuty>();
  private readonly custodyErrors = new Map<string, DutyCustodyError>();
  private state: "new" | "started" | "closed" = "new";
  private ticking?: Promise<CoreResult<void>>;
  constructor(private readonly config: CoreDutiesConfig, private readonly options: CoreDutiesOptions) {}

  async start(): Promise<CoreResult<void>> {
    if (this.state !== "new") return unavailable("Core duties start requires new custody");
    const parsed = parseCoreDutiesConfig(this.config);
    if (!parsed.ok) return parsed;
    if (parsed.value.kind === "disabled") { this.state = "started"; return { ok: true, value: undefined }; }
    for (const spec of parsed.value.entries) {
      const scope = this.options.scopes.find(scope => scope.id === spec.scopeId);
      if (!scope) { await this.close(); return invalid(`Duty scope is unregistered: ${spec.scopeId}`); }
      if (scope.availability.kind === "unavailable") continue;
      const principal = this.options.principals.find(principal => principal.id === scope.principalId);
      if (!principal) { await this.close(); return invalid(`Duty scope has no registered principal: ${scope.id}`); }
      const owned = this.options.owner(spec.scopeId);
      if (!owned.ok) { this.fail(spec, "scope-owner", owned.error); continue; }
      const owner = owned.value;
      owner.threads.suspendScheduledWakes();
      let watch: WatchList | null = null, ownership: ScopeOwnership | null = null;
      try {
        const path = owner.runtime.path(spec.path);
        if (spec.watch.kind === "existing") {
          const ownedWatch = acquireDatabaseOwnership({ id: `${spec.scopeId}:watch`, databasePath: spec.watch.databasePath,
            adoptionReceiptPath: spec.watch.adoptionReceiptPath, uid: scope.custody.uid, requiredTables: WATCH_CUSTODY_TABLES, owningScopeId: scope.id }, logical => owner.runtime.path(logical));
          if (!ownedWatch.ok) {
            this.fail(spec, "watch-owner", ownedWatch.error);
            continue;
          }
          ownership = ownedWatch.value;
          watch = new WatchList({ databasePath: owner.runtime.path(spec.watch.databasePath), existingStore: true,
            threads: this.options.threads?.(scope.id) ?? owner.threads,
            placement: () => ({ ok: false, error: { code: "invalid_request", message: "Future duty checks belong to Markdown, not a worker factory" } }),
            checkOutcome: id => owner.threads.watchCheckOutcome(id),
            occurrenceAdmission: input => this.admitOccurrence(scope, principal, owner, input),
            onError: () => {},
          });
        }
        const adopted = adoptMarkdownDuties({ service: owner.threads, ...(watch ? { watch } : {}), path, uid: scope.custody.uid, gid: scope.custody.gid });
        if (!adopted.ok) {
          await watch?.close(); ownership?.close();
          this.fail(spec, "markdown", adopted.error);
          continue;
        }
        if (scope.manager.kind === "existing") {
          const pointed = owner.threads.update(scope.manager.threadId, { metadata: { markdownDutiesPath: spec.path } });
          if (!pointed.ok) {
            await watch?.close(); ownership?.close();
            this.fail(spec, "manager-pointer", pointed.error);
            continue;
          }
        }
        const unbindWatch = watch ? owner.threads.setWatchList(watch) : null;
        this.adopted.set(scope.id, { spec, scope, owner, principal, watch, unbindWatch, ownership, receipt: { ...adopted.value, path: spec.path } });
      } catch (error) {
        await watch?.close(); ownership?.close();
        this.fail(spec, "resources", { code: "unavailable", message: error instanceof Error ? error.message : String(error) });
      }
    }
    this.state = "started";
    return { ok: true, value: undefined };
  }

  receipts(): MarkdownDutyReceipt[] { return [...this.adopted.values()].map(duty => duty.receipt); }
  errors(): DutyCustodyError[] { return [...this.custodyErrors.values()].map(failure => ({ ...failure, error: { ...failure.error } })); }
  private fail(spec: CoreDutySpec, stage: DutyCustodyError["stage"], error: DutyCustodyError["error"]): void {
    this.custodyErrors.set(spec.scopeId, { scopeId: spec.scopeId, path: spec.path, stage, error });
  }

  private admitOccurrence(scope: CoreScope, principal: Principal, owner: CoreDutyScope, input: SpawnThread): import("../threads/contracts.js").Result<boolean> {
    if (this.state !== "started" || this.custodyErrors.has(scope.id) || !this.options.enabled() || scope.availability.kind !== "adopt") return { ok: true, value: false };
    try { owner.runtime.path(input.cwd); }
    catch (error) { return { ok: false, error: { code: "unavailable", message: `Accepted duty workspace is outside its declared scope: ${error instanceof Error ? error.message : String(error)}` } }; }
    const allowed = authorize(this.options.policy, { principal, resource: scope.resource, action: "dispatch", now: Date.now() });
    if (!allowed.ok) return { ok: false, error: { code: "unavailable", message: `Duty dispatch denied for ${scope.id}: ${allowed.error.message}` } };
    const existing = input.id ? owner.threads.get(input.id) : null;
    if (existing?.held || existing?.metadata?.archived) return { ok: true, value: false };
    if (input.parentId) {
      const parent = owner.threads.get(input.parentId);
      if (!parent) return { ok: false, error: { code: "unavailable", message: "Accepted watch occurrence's original parent custody is unavailable" } };
      if (parent.held || parent.metadata?.archived) return { ok: true, value: false };
    }
    return { ok: true, value: true };
  }

  tick(now = Date.now()): Promise<CoreResult<void>> {
    if (this.state !== "started") return Promise.resolve(unavailable("Core duties are not started"));
    if (this.ticking) return this.ticking;
    this.ticking = this.drain(now).finally(() => { this.ticking = undefined; });
    return this.ticking;
  }
  private async drain(now: number): Promise<CoreResult<void>> {
    if (!this.options.enabled()) return { ok: true, value: undefined };
    for (const duty of this.adopted.values()) {
      if (this.state !== "started" || !this.options.enabled()) break;
      if (this.custodyErrors.has(duty.scope.id) || duty.spec.watch.kind !== "existing" || duty.spec.watch.acceptedSpool !== "drain" || !duty.watch) continue;
      try {
        for (const logical of [duty.spec.path, duty.spec.watch.databasePath, duty.spec.watch.adoptionReceiptPath]) duty.owner.runtime.path(logical);
        const validated = validateMarkdownDutyCustody(duty.owner.runtime.path(duty.spec.path), duty.receipt.receipt);
        if (!validated.ok) { this.fail(duty.spec, "markdown", validated.error); continue; }
        const drained = await duty.watch.tick(now);
        if (!drained.ok) this.fail(duty.spec, "accepted-spool", drained.error);
      } catch (error) { this.fail(duty.spec, "resources", { code: "unavailable", message: error instanceof Error ? error.message : String(error) }); }
    }
    return { ok: true, value: undefined };
  }
  async close(): Promise<void> {
    if (this.state === "closed") return;
    this.state = "closed";
    for (const duty of this.adopted.values()) { duty.unbindWatch?.(); duty.watch?.stop(); }
    await this.ticking;
    for (const duty of this.adopted.values()) {
      await duty.watch?.close(); duty.ownership?.close();
    }
    this.adopted.clear();
  }
}

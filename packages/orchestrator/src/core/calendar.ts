import { statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { Database } from "bun:sqlite";
import { CalendarMemory, parseCalendarCommand, calendarCommandAction } from "kenan-memory/calendar-data";
import { memoryFolder } from "kenan-memory/markdown";
import { ActionJournal } from "kenan-memory/journal";
import type { MemoryDataProjection, MemoryResult } from "kenan-memory/contract";
import { authorize, validatePermissionPolicy, type PermissionPolicy, type Principal, type Resource } from "../permissions.js";
import { CustodyResources } from "./custody-resources.js";
import { acquireDatabaseOwnership, type ScopeOwnership } from "./ownership.js";
import type { CoreResult } from "./config.js";
import type { CoreScope } from "./contracts.js";
export type CoreCalendarConfig = { id: string; person: string; custodyScopeId: string; databasePath: string; adoptionReceiptPath: string; memoryFolder: string; journalDirectory: string; resource: Resource };
export type CoreCalendarData = { id: string; execute(principal: Principal, requestId: string, command: unknown): Promise<MemoryResult<MemoryDataProjection>>; close(): Promise<void> };
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const id = (value: unknown): value is string => typeof value === "string" && /^[a-zA-Z0-9_.:-]+$/.test(value);
const path = (value: unknown): value is string => typeof value === "string" && isAbsolute(value) && resolve(value) === value && !/[\0\r\n]/.test(value);
const invalid = (message: string): CoreResult<never> => ({ ok: false, error: { code: "invalid-config", message } });
export function parseCoreCalendarConfig(value: unknown): CoreResult<CoreCalendarConfig> {
  if (!object(value) || !id(value.id) || !id(value.person) || !id(value.custodyScopeId) || ![value.databasePath, value.adoptionReceiptPath, value.memoryFolder, value.journalDirectory].every(path) || !object(value.resource)) return invalid("Calendar memory requires explicit dataset/owner, custody scope, exact database/receipt and Markdown folder");
  const resource = value.resource as Resource;
  const checked = authorize({ revision: 1, grants: [], consents: [] }, { principal: { kind: "service", id: "validation" }, resource, action: "read", now: 0 });
  if (!checked.ok && checked.error.code === "invalid-request") return invalid(checked.error.message);
  if (resource.id !== value.id || resource.kind !== "data" || resource.owner !== value.person || resource.privacy === "public" || resource.subjects.length !== 1 || resource.subjects[0] !== value.person) return invalid("Calendar dataset is the person's private memory data resource, never a public feed");
  return { ok: true, value: value as unknown as CoreCalendarConfig };
}
export function createCoreCalendar(options: { config: CoreCalendarConfig; policy: PermissionPolicy; scopes: readonly CoreScope[]; owner(scopeId: string): CoreResult<{ runtime: { path(logical: string): string } }> }): CoreResult<CoreCalendarData> {
  const parsed = parseCoreCalendarConfig(options.config); if (!parsed.ok) return parsed;
  const policy = validatePermissionPolicy(options.policy); if (!policy.ok) return invalid(policy.error.message);
  const config = parsed.value, scope = options.scopes.find(scope => scope.id === config.custodyScopeId);
  if (!scope || scope.resource.privacy === "public" || scope.resource.owner !== config.person) return invalid("Calendar custody requires its registered owner's private scope");
  const unavailable = (): CoreResult<CoreCalendarData> => ({ ok: true, value: {
    id: config.id,
    async execute(principal, _requestId, input) {
      const command = parseCalendarCommand(input);
      if (!command.ok) return { ok: false, error: "invalid-request", message: command.error.message };
      const action = calendarCommandAction(command.value);
      for (const actual of action === "read" ? [action] : ["read" as const, action]) {
        if (!authorize(options.policy, { principal, resource: config.resource, action: actual, now: Date.now() }).ok) return { ok: false, error: "unauthenticated", message: "Structured memory dataset is unavailable to this principal/action" };
      }
      return { ok: false, error: "unavailable", message: "Dataset owner custody is locked or not adopted; unlock and reload the core configuration" };
    },
    async close() {},
  } });
  if (scope.availability.kind === "unavailable") return unavailable();
  const adopted = options.owner(scope.id); if (!adopted.ok) return unavailable();
  let pinned: CustodyResources | undefined, lock: ScopeOwnership | undefined, db: Database | undefined;
  try {
    pinned = new CustodyResources(scope.custody);
    const mapped = (logical: string) => {
      const visible = adopted.value.runtime.path(logical), a = statSync(visible, { bigint: true }), b = statSync(pinned!.directory(logical), { bigint: true });
      if (a.dev !== b.dev || a.ino !== b.ino) throw new Error("Calendar data is outside its prepared custody namespace");
      return visible;
    };
    const folder = memoryFolder(mapped(config.memoryFolder)); if (!folder.ok) { pinned.close(); return invalid(folder.error.message); }
    const owned = acquireDatabaseOwnership({ id: config.id, databasePath: config.databasePath, adoptionReceiptPath: config.adoptionReceiptPath, uid: scope.custody.uid, namespaces: { data: scope.custody.namespace, retained: scope.custody.retainedRunnerNamespace } }, mapped);
    if (!owned.ok) { pinned.close(); return owned; }
    lock = owned.value;
    db = new Database(mapped(config.databasePath), { strict: true, create: false });
    const journal = new ActionJournal({ directory: mapped(config.journalDirectory), person: config.person, enabled: () => true, autoDrain: false });
    const calendar = new CalendarMemory(db, config.person, journal);
    let closed = false, closing: Promise<void> | undefined;
    return { ok: true, value: {
      id: config.id,
      async execute(principal, requestId, input) {
        if (closed) return { ok: false, error: "unavailable", message: "Memory data is closing" };
        const command = parseCalendarCommand(input);
        if (!command.ok) return { ok: false, error: "invalid-request", message: command.error.message };
        const action = calendarCommandAction(command.value);
        const actions = action === "read" ? [action] : ["read" as const, action];
        for (const actual of actions) {
          const permission = authorize(options.policy, { principal, resource: config.resource, action: actual, now: Date.now() });
          if (!permission.ok) return { ok: false, error: "unauthenticated", message: "Structured memory dataset is unavailable to this principal/action" };
        }
        try { pinned!.assert(); } catch { return { ok: false, error: "unavailable", message: "Calendar custody namespace changed" }; }
        const result = await calendar.execute(command.value, requestId, Date.now());
        if (result.ok) return { ok: true, value: { value: { dataset: config.id, data: result.value }, subjects: config.resource.subjects, obviouslyPrivate: true } };
        switch (result.error.code) {
          case "invalid-command": return { ok: false, error: "invalid-request", message: result.error.message };
          case "not-found": return { ok: false, error: "not-found", message: result.error.message };
          case "conflict": return { ok: false, error: "conflict", message: result.error.message };
          case "unavailable": return { ok: false, error: "unavailable", message: result.error.message };
          case "denied": return { ok: false, error: "unauthenticated", message: result.error.message };
        }
      },
      close() {
        if (closing) return closing;
        closed = true;
        closing = calendar.close().then(() => { db!.close(); lock!.close(); pinned!.close(); });
        return closing;
      },
    } };
  } catch { db?.close(); lock?.close(); pinned?.close(); return { ok: false, error: { code: "unavailable", message: "Calendar memory cannot adopt its exact existing custody" } }; }
}

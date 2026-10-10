import { statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { memoryUseFenced, projectForget, recoverForget, projectionInvalidation } from "kenan-memory/forget-projection";
import type { ForgetMode, MemoryResult, MemoryValue } from "kenan-memory/contract";
import type { MemoryStore } from "kenan-memory/store";
import { authorize, type PermissionPolicy, type Principal, type Resource } from "../permissions.js";
import { CustodyResources } from "./custody-resources.js";
import type { CoreScope } from "./contracts.js";
import type { CoreResult } from "./config.js";
export type MarkdownOwner = { subject: string; custodyScopeId: string; folder: string; resource: Resource };
export function parseMarkdownOwners(value: unknown): CoreResult<MarkdownOwner[]> {
  const fail = (): CoreResult<never> => ({ ok: false, error: { code: "invalid-config", message: "Markdown owners require unique subject/folder, explicit custody scope and private memory resource" } });
  if (!Array.isArray(value)) return fail();
  const owners: MarkdownOwner[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object" || typeof entry.subject !== "string" || !entry.subject || typeof entry.custodyScopeId !== "string" || !entry.custodyScopeId || typeof entry.folder !== "string" || !isAbsolute(entry.folder) || resolve(entry.folder) !== entry.folder || /[\0\r\n]/.test(entry.folder)) return fail();
    const resource = entry.resource as Resource;
    const validation = authorize({ revision: 1, grants: [], consents: [] }, { principal: { kind: "service", id: "validation" }, resource, action: "read", now: 0 });
    if (!validation.ok && validation.error.code === "invalid-request" || resource.kind !== "memory" || resource.privacy === "public" || resource.subjects.length !== 1 || resource.subjects[0] !== entry.subject || owners.some(owner => owner.subject === entry.subject || owner.folder === entry.folder)) return fail();
    owners.push(entry);
  }
  return { ok: true, value: owners };
}
type Available = { owner: MarkdownOwner; path: string; custody: CustodyResources };
export function createMemoryMarkdown(options: { owners: readonly MarkdownOwner[]; maintenance: Principal | null; scopes: readonly CoreScope[]; owner(id: string): CoreResult<{ runtime: { path(logical: string): string } }>; policy: PermissionPolicy; store: MemoryStore; signatureKey: string | undefined }): CoreResult<{ fenced(subjects: readonly string[]): boolean; forget(principal: Principal, ids: string[], mode: ForgetMode): MemoryResult<MemoryValue>; close(): void }> {
  const pinned: CustodyResources[] = [], folders: Available[] = [], unavailable: MarkdownOwner[] = [];
  const denied = (): MemoryResult<never> => ({ ok: false, error: "unavailable", message: "Dependency invalidation is pending its registered housekeeping grants; active use stays fenced" });
  try {
    if (options.owners.length && (options.signatureKey === undefined || options.signatureKey.length < 32 || options.maintenance?.kind !== "service")) throw new Error("Projection requires explicit service authority and existing private signing custody");
    for (const owner of options.owners) {
      const scope = options.scopes.find(scope => scope.id === owner.custodyScopeId);
      if (!scope || scope.resource.privacy === "public" || scope.resource.owner !== owner.resource.owner) throw new Error("Markdown folder scope ownership differs");
      if (scope.availability.kind === "unavailable") { unavailable.push(owner); continue; }
      const adopted = options.owner(owner.custodyScopeId);
      if (!adopted.ok) { unavailable.push(owner); continue; }
      const custody = new CustodyResources(scope.custody); pinned.push(custody);
      const path = adopted.value.runtime.path(owner.folder), a = statSync(path, { bigint: true }), b = statSync(custody.directory(owner.folder), { bigint: true });
      if (a.dev !== b.dev || a.ino !== b.ino || !a.isDirectory()) throw new Error("Markdown folder is outside exact registered custody");
      folders.push({ owner, path, custody });
    }
    const descriptors = folders.map(folder => ({ path: folder.path, subject: folder.owner.subject }));
    const canMaintain = () => folders.every(folder => {
      folder.custody.assert();
      return options.maintenance !== null && ["read", "invalidate"].every(action => authorize(options.policy, { principal: options.maintenance!, resource: folder.owner.resource, action: action as "read" | "invalidate", now: Date.now() }).ok);
    });
    const sweep = (ids: string[], mode: ForgetMode): MemoryResult<MemoryValue> => {
      const items = options.store.authorizationItems(ids);
      const allowed = canMaintain();
      const invalidated = allowed ? projectionInvalidation(descriptors, [...options.store.forgottenSources(), ...ids]) : [...options.store.forgottenSources(), ...ids];
      const result = projectForget({ folders: descriptors, items, invalidated, metadataReadable: allowed, mode, signatureKey: options.signatureKey!, includeText: item => allowed && !options.store.rootAdmission(item.setting.threadId ?? ""), commit: (ids, mode) => { if (!allowed) throw new Error("Missing maintenance authority"); return options.store.forget(ids, mode); } });
      return result.ok ? result : denied();
    };
    const recoveryFailures = new Set<string>();
    if (canMaintain()) {
      for (const folder of folders) {
        const recovery = recoverForget(folder.path, options.signatureKey!, (ids, mode) => options.store.forget(ids, mode));
        if (!recovery.ok) recoveryFailures.add(folder.owner.subject);
      }
      if (recoveryFailures.size === 0 && options.store.forgottenSources().length) {
        const recovered = sweep([], "stop-using");
        if (!recovered.ok) for (const folder of folders) recoveryFailures.add(folder.owner.subject);
      }
    } else if (options.store.forgottenSources().length || folders.some(folder => memoryUseFenced(folder.path))) {
      for (const folder of folders) {
        recoveryFailures.add(folder.owner.subject);
        if (!memoryUseFenced(folder.path)) {
          const staged = projectForget({ folders: [{ path: folder.path, subject: folder.owner.subject }], items: [], invalidated: [], metadataReadable: false, mode: "stop-using", signatureKey: options.signatureKey!, includeText: () => false, commit: () => { throw new Error("Projection awaits maintenance grants"); } });
          if (staged.ok) throw new Error("Unpermitted projection staging unexpectedly completed");
        }
      }
    }
    return { ok: true, value: {
      fenced(subjects) { return subjects.some(subject => recoveryFailures.has(subject) || unavailable.some(owner => owner.subject === subject)) || folders.some(folder => subjects.includes(folder.owner.subject) && memoryUseFenced(folder.path)); },
      forget(_requester, ids, mode) {
        if (folders.length === 0 && unavailable.length === 0) return { ok: true, value: options.store.forget(ids, mode) };
        return sweep(ids, mode);
      },
      close() { for (const resources of pinned) resources.close(); },
    } };
  } catch { for (const resources of pinned) resources.close(); return { ok: false, error: { code: "unavailable", message: "Markdown projection custody is unavailable; original records and pending fences remain intact" } }; }
}

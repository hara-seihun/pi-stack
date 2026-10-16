import type { CoreConfig, CoreScope } from "./contracts.js";
type ImageScopeAuthority = Pick<CoreConfig, "principals" | "policy"> & { scopes: Array<Pick<CoreScope, "id" | "principalId" | "resource"> & { custody: Pick<CoreScope["custody"], "uid" | "gid"> }> };
import type { CoreResult } from "./config.js";
import { authorize } from "../permissions.js";

export function authorizeRelatedImageScope(config: ImageScopeAuthority, registryScopeId: string, relatedScopeId: string): CoreResult<void> {
  const registry = config.scopes.find(scope => scope.id === registryScopeId);
  const related = config.scopes.find(scope => scope.id === relatedScopeId);
  if (!registry || !related || registry.id === related.id) return { ok: false, error: { code: "invalid-config", message: "Related image scope must name a distinct registered owner" } };
  const sameSubjects = registry.resource.subjects.length === related.resource.subjects.length && registry.resource.subjects.every(subject => related.resource.subjects.includes(subject));
  if (registry.principalId !== related.principalId || registry.resource.owner !== related.resource.owner || registry.resource.privacy !== related.resource.privacy
    || registry.resource.consent !== related.resource.consent || !sameSubjects || registry.custody.uid !== related.custody.uid || registry.custody.gid !== related.custody.gid) {
    return { ok: false, error: { code: "ownership-conflict", message: "Related image source crosses its declared principal, data domain or filesystem owner" } };
  }
  const principal = config.principals.find(value => value.id === registry.principalId);
  if (!principal) return { ok: false, error: { code: "invalid-config", message: "Image principal is unregistered" } };
  const permitted = authorize(config.policy, { principal, resource: related.resource, action: "read", now: Date.now() });
  return permitted.ok ? { ok: true, value: undefined } : { ok: false, error: { code: "ownership-conflict", message: permitted.error.message } };
}

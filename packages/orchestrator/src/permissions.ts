export type PermissionResult<T> = { ok: true; value: T } | { ok: false; error: PermissionError };
export type PermissionError = { code: "invalid-policy" | "invalid-request" | "denied" | "consent-required"; message: string };
export type Principal =
  | { kind: "person"; id: string; person: string }
  | { kind: "service"; id: string }
  | { kind: "room"; id: string; audience: readonly string[] };
export type ResourceKind = "operation" | "model" | "thread" | "memory" | "data" | "tool";
export type PermissionAction = "read" | "write" | "delete" | "execute" | "use" | "dispatch" | "control" | "disclose" | "grant";
export type Resource = {
  id: string;
  kind: ResourceKind;
  owner: string;
  privacy: "public" | "private" | "confidential";
  subjects: readonly string[];
  consent: "not-required" | "required";
};
export type ResourceSelector = { kind: "exact"; id: string } | { kind: "owned-kind"; owner: string; resourceKind: ResourceKind };
export type Grant = {
  id: string;
  principal: string;
  resource: ResourceSelector;
  actions: readonly PermissionAction[];
  effect: "allow" | "deny";
  validFrom: number;
  validUntil: number | null;
  issuedBy: string;
  source: string;
};
export type Consent = {
  id: string;
  subject: string;
  principal: string;
  resource: string;
  actions: readonly PermissionAction[];
  validFrom: number;
  validUntil: number | null;
  source: string;
};
export type PermissionPolicy = { revision: number; grants: readonly Grant[]; consents: readonly Consent[] };
export type PermissionRequest = { principal: Principal; resource: Resource; action: PermissionAction; now: number };
export type Authorization = { policyRevision: number; principal: string; resource: string; action: PermissionAction; grantIds: readonly string[]; consentIds: readonly string[]; audience: readonly string[] };
const actions = new Set<string>(["read", "write", "delete", "execute", "use", "dispatch", "control", "disclose", "grant"]);
const kinds = new Set<string>(["operation", "model", "thread", "memory", "data", "tool"]);
const text = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;
const list = (value: unknown): value is string[] => Array.isArray(value) && value.every(text) && new Set(value).size === value.length;
const period = (value: { validFrom: number; validUntil: number | null }) => Number.isFinite(value.validFrom) && (value.validUntil === null || Number.isFinite(value.validUntil) && value.validUntil > value.validFrom);
const validActions = (value: unknown): value is PermissionAction[] => list(value) && value.length > 0 && value.every(action => actions.has(action));
const active = (value: { validFrom: number; validUntil: number | null }, now: number) => value.validFrom <= now && (value.validUntil === null || now < value.validUntil);
const fail = (code: PermissionError["code"], message: string): PermissionResult<never> => ({ ok: false, error: { code, message } });
const matches = (selector: ResourceSelector, resource: Resource) => selector.kind === "exact" ? selector.id === resource.id : selector.owner === resource.owner && selector.resourceKind === resource.kind;

export function validatePermissionPolicy(input: unknown): PermissionResult<PermissionPolicy> {
  if (!input || typeof input !== "object") return fail("invalid-policy", "Permission policy is required");
  const policy = input as PermissionPolicy;
  if (!Number.isInteger(policy.revision) || policy.revision < 1 || !Array.isArray(policy.grants) || !Array.isArray(policy.consents)) return fail("invalid-policy", "Policy revision, grants and consents must be explicit");
  const ids = new Set<string>();
  for (const grant of policy.grants) {
    if (!grant || !text(grant.id) || ids.has(grant.id) || !text(grant.principal) || !text(grant.issuedBy) || !text(grant.source) || !validActions(grant.actions) || !period(grant) || !["allow", "deny"].includes(grant.effect)) return fail("invalid-policy", "Invalid or duplicate grant");
    const selector = grant.resource;
    if (!selector || !(selector.kind === "exact" && text(selector.id) || selector.kind === "owned-kind" && text(selector.owner) && kinds.has(selector.resourceKind))) return fail("invalid-policy", "Grant resource must be exact or an explicit owner/kind");
    ids.add(grant.id);
  }
  for (const consent of policy.consents) {
    if (!consent || !text(consent.id) || ids.has(consent.id) || !text(consent.subject) || !text(consent.principal) || !text(consent.resource) || !text(consent.source) || !validActions(consent.actions) || !period(consent)) return fail("invalid-policy", "Invalid or duplicate consent");
    ids.add(consent.id);
  }
  return { ok: true, value: policy };
}

export function authorize(policy: PermissionPolicy, request: PermissionRequest): PermissionResult<Authorization> {
  const parsed = validatePermissionPolicy(policy);
  if (!parsed.ok) return parsed;
  const { principal, resource, action, now } = request;
  if (!principal || !resource || !text(principal.id) || !text(resource.id) || !text(resource.owner) || !kinds.has(resource.kind) || !actions.has(action) || !Number.isFinite(now) || !list(resource.subjects) || resource.consent === "required" && resource.subjects.length === 0 || !["public", "private", "confidential"].includes(resource.privacy) || !["not-required", "required"].includes(resource.consent)) return fail("invalid-request", "Invalid principal, resource, action or time");
  if (!(principal.kind === "person" && text(principal.person) || principal.kind === "service" || principal.kind === "room" && list(principal.audience) && principal.audience.length > 0)) return fail("invalid-request", "Principal requires a verified identity and rooms their full audience");
  const audience = principal.kind === "room" ? [...principal.audience] : principal.kind === "person" ? [principal.person] : [];
  const selected = parsed.value.grants.filter(grant => grant.principal === principal.id && active(grant, now) && grant.actions.includes(action) && matches(grant.resource, resource));
  if (selected.some(grant => grant.effect === "deny") || !selected.some(grant => grant.effect === "allow")) return fail("denied", "No active grant permits this principal/resource/action");
  const grantIds = selected.filter(grant => grant.effect === "allow").map(grant => grant.id);
  if (principal.kind === "room" && (action === "read" || action === "disclose")) {
    for (const person of audience) {
      const personGrants = parsed.value.grants.filter(grant => grant.principal === person && active(grant, now) && grant.actions.includes(action) && matches(grant.resource, resource));
      if (personGrants.some(grant => grant.effect === "deny") || !personGrants.some(grant => grant.effect === "allow")) return fail("denied", "The complete room audience must have access");
      grantIds.push(...personGrants.filter(grant => grant.effect === "allow").map(grant => grant.id));
    }
  }
  const consentIds: string[] = [];
  if (resource.consent === "required") {
    for (const subject of resource.subjects) {
      const recipients = principal.kind === "room" && (action === "read" || action === "disclose") ? [principal.id, ...audience] : [principal.id];
      for (const recipient of recipients) {
        const consent = parsed.value.consents.find(consent => consent.subject === subject && consent.principal === recipient && consent.resource === resource.id && consent.actions.includes(action) && active(consent, now));
        if (!consent) return fail("consent-required", "Every protected subject must consent to the actual action and audience");
        consentIds.push(consent.id);
      }
    }
  }
  return { ok: true, value: { policyRevision: policy.revision, principal: principal.id, resource: resource.id, action, grantIds: [...new Set(grantIds)], consentIds: [...new Set(consentIds)], audience } };
}

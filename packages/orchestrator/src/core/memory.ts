import type { IncomingMessage, ServerResponse } from "node:http";
import { readFileSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { memoryService, type MemoryAuth, type MemoryPrincipal, type MemoryServiceOptions } from "kenan-memory/service";
import { MemoryStore } from "kenan-memory/store";
import { authorize, validatePermissionPolicy, type PermissionAction, type PermissionPolicy, type Principal, type Resource } from "../permissions.js";
import type { CoreResult } from "./config.js";
import { acquireDatabaseOwnership, type ScopeOwnership } from "./ownership.js";
import { openSqlite } from "../sqlite.js";
import { CustodyResources } from "./custody-resources.js";
import type { CoreScope } from "./contracts.js";
import { readTimezoneProjection } from "../person-timezone.js";
import { roomAudienceResolver } from "./room-audience.js";
import { createCoreCalendar, parseCoreCalendarConfig, type CoreCalendarConfig, type CoreCalendarData } from "./calendar.js";

export type CoreMemoryIdentity = { principalId: string } & (
  | { kind: "person-role"; person: string; role: "person" | "root"; threadId: string | null }
  | { kind: "supervisor"; person: string }
  | { kind: "publisher" | "root-service" }
);
export type CoreMemoryRoute = { principalId: string; route: string; operation: string | null; resourceId: string; action: PermissionAction };
export type CoreMemoryConfig = { kind: "disabled" } | {
  kind: "configured";
  id: string;
  uid: number;
  custodyScopeId: string;
  databasePath: string;
  adoptionReceiptPath: string;
  authFile: string;
  roomAudience: { kind: "none" } | { kind: "registry"; databasePath: string; custodian: string };
  timezones: { kind: "none" } | { kind: "auth-files" };
  identities: CoreMemoryIdentity[];
  resources: Resource[];
  routes: CoreMemoryRoute[];
  datasets: CoreCalendarConfig[];
};
export type CoreMemoryAdapter = { request(request: IncomingMessage, response: ServerResponse): void; close(): Promise<void> };
const invalid = (message: string): CoreResult<never> => ({ ok: false, error: { code: "invalid-config", message } });
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const id = (value: unknown): value is string => typeof value === "string" && /^[a-zA-Z0-9_.:-]+$/.test(value);
const absolute = (value: unknown): value is string => typeof value === "string" && isAbsolute(value) && !/[\0\r\n]/.test(value);
const memoryActions: Record<string, PermissionAction> = { write: "write", search: "read", read: "read", forget: "delete", "log-disclosure": "write", disclosures: "read", "finalize-turn": "disclose", data: "execute" };
const endpointActions: Record<string, PermissionAction> = { "/v1/sessions": "execute", "/v1/root/admit": "dispatch", "/v1/root/finalize-reply": "disclose", "/v1/root/resume-consent": "dispatch", "/v1/root/log-consent": "write", "/v1/root/authorize-request": "read", "/v1/root/authenticate-caller": "read", "/v1/root/resume-request": "read", "/v1/root/log-notification": "disclose", "/v1/root/log-request-status": "write" };
const routes = new Set(["/v1/memory", "/v1/sessions", "/v1/root/admit", "/v1/root/finalize-reply", "/v1/root/resume-consent", "/v1/root/log-consent", "/v1/root/authorize-request", "/v1/root/authenticate-caller", "/v1/root/resume-request", "/v1/root/log-notification", "/v1/root/log-request-status"]);
const key = (identity: CoreMemoryIdentity) => identity.kind === "person-role" ? JSON.stringify([identity.kind, identity.person, identity.role, identity.threadId]) : identity.kind === "supervisor" ? JSON.stringify([identity.kind, identity.person]) : identity.kind;
function matches(identity: CoreMemoryIdentity, caller: MemoryPrincipal): boolean {
  if (identity.kind === "supervisor") return caller.kind === "person" && caller.role === "person" && caller.threadId === undefined && caller.person === identity.person;
  return identity.kind === "person-role" ? caller.kind === "person" && caller.threadId !== undefined && identity.person === caller.person && identity.role === caller.role && (identity.threadId === null || identity.threadId === caller.threadId) : identity.kind === caller.kind;
}

export function parseCoreMemoryConfig(value: unknown, principals: readonly Principal[]): CoreResult<CoreMemoryConfig> {
  if (!object(value)) return invalid("Core memory must be explicitly configured or disabled");
  if (value.kind === "disabled" && Object.keys(value).length === 1) return { ok: true, value: { kind: "disabled" } };
  if (value.kind !== "configured" || !id(value.id) || !id(value.custodyScopeId) || !Number.isSafeInteger(value.uid) || Number(value.uid) < 0 || !absolute(value.databasePath) || !absolute(value.adoptionReceiptPath) || !absolute(value.authFile) || !Array.isArray(value.identities) || !Array.isArray(value.resources) || !Array.isArray(value.routes) || !Array.isArray(value.datasets)) return invalid("Memory requires existing database/auth paths and explicit identities, resources and routes");
  if (!object(value.roomAudience) || !(value.roomAudience.kind === "none" || value.roomAudience.kind === "registry" && absolute(value.roomAudience.databasePath) && id(value.roomAudience.custodian))) return invalid("Memory room audience requires explicit none or an existing registry and custodian");
  if (!object(value.timezones) || !["none", "auth-files"].includes(String(value.timezones.kind))) return invalid("Memory timezones require explicit none or existing authenticated supervisor files");
  const identities: CoreMemoryIdentity[] = [];
  for (const item of value.identities) {
    if (!object(item) || !id(item.principalId)) return invalid("Memory identity requires a registered principal");
    const principal = principals.find(principal => principal.id === item.principalId);
    if (!principal) return invalid("Memory identity names an unregistered principal");
    if (item.kind === "person-role") {
      if (!id(item.person) || !["person", "root"].includes(String(item.role)) || !(item.threadId === null || id(item.threadId))) return invalid("Person memory identity requires explicit person, role and thread selector");
      if (item.role === "person" && !(principal.kind === "person" && principal.person === item.person || principal.kind === "room" && item.threadId !== null)) return invalid("Person/room credentials must bind the actual registered person or exact room thread");
      if (item.role === "root" && principal.kind !== "service") return invalid("Admitted private consultations require a separately registered service principal");
    } else if (item.kind === "supervisor") {
      if (!id(item.person) || !(principal.kind === "person" && principal.person === item.person || principal.kind === "service")) return invalid("Supervisor credentials must bind their actual person or a declared issuer service");
    } else if (!["publisher", "root-service"].includes(String(item.kind)) || principal.kind !== "service") return invalid("Custody credentials must bind a registered service principal");
    const identity = item as CoreMemoryIdentity;
    if (identities.some(prior => key(prior) === key(identity) || prior.kind === "person-role" && identity.kind === "person-role" && prior.person === identity.person && prior.role === identity.role && (prior.threadId === null || identity.threadId === null))) return invalid("Memory identities must have unique nonoverlapping authenticated selectors");
    identities.push(identity);
  }
  if (value.roomAudience.kind === "none" && identities.some(identity => principals.find(principal => principal.id === identity.principalId)?.kind === "room")) return invalid("Room memory identities require their current audience registry");
  const resources: Resource[] = [];
  for (const resourceValue of value.resources) {
    if (!object(resourceValue) || !id(resourceValue.id) || resources.some(resource => resource.id === resourceValue.id)) return invalid("Memory resources require unique registered IDs");
    const result = authorize({ revision: 1, grants: [], consents: [] }, { principal: { kind: "service", id: "resource-validation" }, resource: resourceValue as Resource, action: "read", now: 0 });
    if (!result.ok && result.error.code === "invalid-request") return invalid(result.error.message);
    resources.push(resourceValue as Resource);
  }
  const mapped: CoreMemoryRoute[] = [];
  for (const item of value.routes) {
    if (!object(item) || !id(item.principalId) || !identities.some(identity => identity.principalId === item.principalId) || typeof item.route !== "string" || !routes.has(item.route) || !id(item.resourceId) || !resources.some(resource => resource.id === item.resourceId)) return invalid("Memory route must bind an authenticated principal, exact endpoint and declared resource");
    if (!(item.route === "/v1/memory" ? typeof item.operation === "string" && Object.hasOwn(memoryActions, item.operation) : item.operation === null)) return invalid("Memory route operation must be exact; nonmemory endpoints use explicit null");
    const requiredAction = item.route === "/v1/memory" ? memoryActions[String(item.operation)] : endpointActions[item.route];
    if (item.action !== requiredAction) return invalid("Memory route action must match the operation's actual effect");
    const probe = validatePermissionPolicy({ revision: 1, consents: [], grants: [{ id: "route-validation", principal: item.principalId, resource: { kind: "exact", id: item.resourceId }, actions: [item.action], effect: "allow", validFrom: 0, validUntil: null, issuedBy: "route-validation", source: "route-validation" }] });
    if (!probe.ok) return invalid(probe.error.message);
    if (mapped.some(prior => prior.principalId === item.principalId && prior.route === item.route && prior.operation === item.operation)) return invalid("Memory principal/endpoint/operation mapping must be unique");
    mapped.push(item as CoreMemoryRoute);
  }
  const datasets: CoreCalendarConfig[] = [];
  for (const input of value.datasets) {
    const parsed = parseCoreCalendarConfig(input);
    if (!parsed.ok) return parsed;
    if (datasets.some(dataset => dataset.id === parsed.value.id || dataset.databasePath === parsed.value.databasePath) || parsed.value.databasePath === value.databasePath) return invalid("Memory datasets require distinct identifiers and existing custody databases");
    datasets.push(parsed.value);
  }
  return { ok: true, value: { kind: "configured", id: value.id, uid: Number(value.uid), custodyScopeId: value.custodyScopeId, databasePath: value.databasePath, adoptionReceiptPath: value.adoptionReceiptPath, authFile: value.authFile, roomAudience: value.roomAudience as Extract<CoreMemoryConfig, { kind: "configured" }>["roomAudience"], timezones: value.timezones as Extract<CoreMemoryConfig, { kind: "configured" }>["timezones"], identities, resources, routes: mapped, datasets } };
}

export async function createCoreMemory(options: {
  config: CoreMemoryConfig;
  principals: readonly Principal[];
  policy: PermissionPolicy;
  enabled: () => boolean;
  scopes: readonly CoreScope[];
  owner: (scopeId: string) => CoreResult<{ runtime: { path(logicalPath: string): string } }>;
  releaseCommit?: string;
}): Promise<CoreResult<CoreMemoryAdapter>> {
  const parsed = parseCoreMemoryConfig(options.config, options.principals);
  if (!parsed.ok) return parsed;
  const policy = validatePermissionPolicy(options.policy);
  if (!policy.ok) return invalid(policy.error.message);
  const config = parsed.value;
  if (config.kind === "disabled") return { ok: true, value: { request: (_request, response) => { response.writeHead(503, { "content-type": "application/json" }); response.end(JSON.stringify({ ok: false, error: "disabled", message: "Memory custody is disabled" })); }, close: async () => {} } };
  const scope = options.scopes.find(scope => scope.id === config.custodyScopeId);
  if (!scope || scope.custody.uid !== config.uid || scope.resource.privacy !== "confidential") return invalid("Memory custody requires its exact registered confidential scope and UID");
  const adopted = options.owner(scope.id);
  if (!adopted.ok) return adopted;
  let store: MemoryStore | undefined;
  let ownership: ScopeOwnership | undefined;
  let resources: CustodyResources | undefined;
  const datasets: CoreCalendarData[] = [];
  try {
    resources = new CustodyResources(scope.custody);
    const allowed = new Set([config.databasePath, config.authFile, config.adoptionReceiptPath, ...(config.roomAudience.kind === "registry" ? [config.roomAudience.databasePath] : [])]);
    const path = (logical: string) => {
      if (!allowed.has(logical)) throw new Error("Unregistered memory custody resource");
      const actual = adopted.value.runtime.path(logical);
      const visible = statSync(actual, { bigint: true });
      const registered = statSync(resources!.directory(logical), { bigint: true });
      if (visible.dev !== registered.dev || visible.ino !== registered.ino) throw new Error("Memory resource is outside its prepared namespace view");
      return actual;
    };
    const reject = (message: string): CoreResult<never> => { resources!.close(); return invalid(message); };
    const databasePath = path(config.databasePath);
    const authPath = path(config.authFile);
    if (!statSync(databasePath).isFile()) return reject("Memory adoption must use the exact existing database");
    const authStat = statSync(authPath);
    if (!authStat.isFile() || authStat.uid !== 0 || (authStat.mode & 0o022) !== 0) return reject("Memory auth custody must be root-owned and not group/world writable");
    const auth: MemoryAuth = JSON.parse(readFileSync(authPath, "utf8"));
    if (!Array.isArray(auth.supervisors) || auth.supervisors.some(entry => !id(entry.person) || typeof entry.token !== "string" || entry.token.length < 32)) return reject("Memory auth supervisors are invalid");
    const tokens = [...auth.supervisors.map(entry => entry.token), auth.publisherToken, auth.rootToken].filter(token => token !== undefined);
    if (tokens.some(token => typeof token !== "string" || token.length < 32) || new Set(tokens).size !== tokens.length) return reject("Memory credentials must be distinct existing random strings");
    if (auth.uidPersons && (!object(auth.uidPersons) || Object.entries(auth.uidPersons).some(([uid, person]) => !/^\d+$/.test(uid) || !id(person)))) return reject("Memory UID bindings are invalid");
    if (config.timezones.kind === "auth-files") {
      for (const supervisor of auth.supervisors) {
        if (supervisor.timezoneFile === undefined) continue;
        if (!absolute(supervisor.timezoneFile)) return reject("Authenticated timezone files must be canonical absolute paths");
        allowed.add(supervisor.timezoneFile);
        path(supervisor.timezoneFile);
      }
    }
    if (config.roomAudience.kind === "registry") path(config.roomAudience.databasePath);
    const roomAudience: MemoryServiceOptions["roomAudience"] = (person, threadId) => config.roomAudience.kind === "none" ? undefined : roomAudienceResolver(path(config.roomAudience.databasePath), config.roomAudience.custodian)(person, threadId);
    const timezone: MemoryServiceOptions["timezone"] = person => {
      if (config.timezones.kind === "none") return { ok: true, value: null };
      const file = auth.supervisors.find(supervisor => supervisor.person === person)?.timezoneFile;
      if (file === undefined) return { ok: false, error: { code: "unavailable", message: "Authenticated person has no declared timezone projection" } };
      return readTimezoneProjection(path(file));
    };
    const owned = acquireDatabaseOwnership({ id: config.id, databasePath: config.databasePath, adoptionReceiptPath: config.adoptionReceiptPath, uid: config.uid, namespaces: { data: scope.custody.namespace, retained: scope.custody.retainedRunnerNamespace } }, path);
    if (!owned.ok) { resources.close(); return owned; }
    ownership = owned.value;
    const existing = openSqlite(databasePath, true);
    try {
      const tables = new Set((existing.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map(table => table.name));
      if (["memories", "disclosures", "sessions", "root_runs", "dedup"].some(table => !tables.has(table))) throw new Error("Adopted memory ledger is missing its existing schema");
    } finally { existing.close(); }
    store = new MemoryStore(databasePath);
    for (const datasetConfig of config.datasets) {
      const dataset = createCoreCalendar({ config: datasetConfig, scopes: options.scopes, owner: options.owner, policy: options.policy });
      if (!dataset.ok) {
        await Promise.all(datasets.map(dataset => dataset.close()));
        store.close(); ownership.close(); resources.close();
        return dataset;
      }
      datasets.push(dataset.value);
    }
    const server = memoryService({ store, auth, enabled: options.enabled, roomAudience, timezone, releaseCommit: options.releaseCommit,
      data: async ({ caller, request }) => {
        const identities = config.identities.filter(identity => matches(identity, caller));
        const principal = identities.length === 1 ? options.principals.find(principal => principal.id === identities[0]!.principalId) : undefined;
        if (!principal) return { ok: false, error: "unauthenticated", message: "Memory data requires its unique registered principal" };
        const dataset = datasets.find(dataset => dataset.id === request.dataset);
        if (!dataset) return { ok: false, error: "unauthenticated", message: "Memory data is unavailable to this principal" };
        return dataset.execute(principal, request.requestId, request.command);
      },
      authorize: ({ caller, route, input, record }) => {
        const identities = config.identities.filter(identity => matches(identity, caller));
        if (identities.length !== 1) return { ok: false, error: { code: "denied", message: "Memory credential has no unique registered principal" } };
        const identity = identities[0]!;
        const principal = options.principals.find(principal => principal.id === identity.principalId)!;
        const operation = route === "/v1/memory" && object(input) && typeof input.operation === "string" ? input.operation : null;
        const mapping = config.routes.find(mapping => mapping.principalId === principal.id && mapping.route === route && mapping.operation === operation);
        if (!mapping) return { ok: false, error: { code: "denied", message: "Memory action has no explicit resource mapping" } };
        const resource = config.resources.find(resource => resource.id === mapping.resourceId)!;
        const dataset = operation === "data" && object(input) ? config.datasets.find(dataset => dataset.id === input.dataset) : undefined;
        const actual = record ?? (dataset ? { about: dataset.resource.subjects, obviouslyPrivate: true } : undefined);
        if (operation === "data" && !dataset || actual && (!Array.isArray(actual.about) || actual.about.length === 0 || actual.about.some(subject => !resource.subjects.includes(subject)) || resource.privacy === "public" && actual.obviouslyPrivate !== false)) return { ok: false, error: { code: "denied", message: "The actual memory records are outside this resource's granted subject/privacy scope" } };
        return authorize(options.policy, { principal, resource, action: mapping.action, now: Date.now() });
      },
    });
    const handle = server.listeners("request")[0] as (request: IncomingMessage, response: ServerResponse) => Promise<void>;
    let closed = false;
    let closePromise: Promise<void> | undefined;
    let active = 0;
    let finish: (() => void) | undefined;
    const settle = () => { active--; if (closed && active === 0) finish?.(); };
    return { ok: true, value: {
      request: (request, response) => {
        if (closed) { response.writeHead(503, { "content-type": "application/json" }); response.end(JSON.stringify({ ok: false, error: "unavailable", message: "Memory custody is closing" })); return; }
        try { resources!.assert(); } catch { response.writeHead(503, { "content-type": "application/json" }); response.end(JSON.stringify({ ok: false, error: "unavailable", message: "Memory custody namespace changed" })); return; }
        active++;
        void handle(request, response).then(settle, () => {
          if (!response.headersSent && !response.destroyed) { response.writeHead(500, { "content-type": "application/json" }); response.end(JSON.stringify({ ok: false, error: "unavailable", message: "Memory custody could not finish the request" })); }
          settle();
        });
      },
      close: () => {
        if (closePromise) return closePromise;
        closed = true;
        closePromise = (async () => {
          if (active > 0) await new Promise<void>(resolve => { finish = resolve; });
          await Promise.all(datasets.map(dataset => dataset.close()));
          store!.close();
          ownership!.close();
          resources!.close();
        })();
        return closePromise;
      },
    } };
  } catch {
    await Promise.all(datasets.map(dataset => dataset.close()));
    store?.close();
    ownership?.close();
    resources?.close();
    return { ok: false, error: { code: "unavailable", message: "Memory custody could not attach the existing store/auth resources" } };
  }
}

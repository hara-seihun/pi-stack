import { chownSync, statSync } from "node:fs";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import { providerOAuth } from "../auth/shared-oauth.js";
import { acquireDatabaseOwnership, type ScopeOwnership } from "./ownership.js";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Store } from "../store.js";
import { createModelBroker, loadBrokerConfig, type ModelBrokerConfig, type BrokerListener } from "../model-broker.js";
import { completionCanonical, isCompletionRequestId } from "../completion-contract.js";
import { completionHttp, directCompletionOperation } from "../completion-http.js";
import { ProviderController } from "../provider-controller.js";
import { completionHostSocket, launchCompletionHostForCustody } from "../host/completion-transport.js";
import { providerHttp, type ProviderThreadStatus } from "../provider-http.js";
import { ModelAvailabilityStore } from "../threads/model-availability.js";
import { authorize, type PermissionPolicy, type Principal, type Resource } from "../permissions.js";
import type { CoreResult } from "./config.js";
import { isBrokerListenerBinding, verifyBrokerDrainReceipt, verifyLiveBrokerIdentity, type RetainedBrokerListeners } from "./broker-transports.js";
import { verifyFreshBrokerAdmission, type FreshBrokerListener } from "./fresh-broker-transports.js";
import { personUsageAcrossStores } from "../person-usage.js";
import type { BudgetClass } from "../domain.js";

export interface CoreRetainedProviderLedger {
  id: string;
  ownerPrincipal: string;
  databasePath: string;
  adoptionReceiptPath: string;
  uid: number; gid: number; home: string;
  authPath: string; agentDir: string;
  meterMaxAgeMs: number; autoReset: boolean;
}
export interface CoreCompletionAlias { principal: string; requestId: string; storedRequestId: string; ownerId: string }
export interface CoreGrantFootprint { configPath: string; ledgerOwnerIds: string[] }
export interface CoreProviderOwnerRoute {
  ownerId: string;
  scopeId: string;
  callerPrincipals: string[];
  budget: BudgetClass;
  resources: { completionRead: Resource; completionSubmit: Resource; completionRetry: Resource; completionCancel: Resource; providerRead: Resource; providerControl: Resource };
}
export type CoreProviderConfig = { kind: "disabled" } | {
  kind: "configured";
  primaryConfigPath: string;
  configPaths: string[];
  grantFootprints: CoreGrantFootprint[];
  adoptionReceiptPath: string;
  uid: number; gid: number; home: string;
  agentDir: string; availabilityPath: string; releasePath: string;
  meterMaxAgeMs: number; autoReset: boolean;
  resource: Resource;
  peopleUsageResource: Resource;
  ownerPrincipal: string;
  retainedListeners: RetainedBrokerListeners;
  freshListeners: FreshBrokerListener[];
  retainedLedgers: CoreRetainedProviderLedger[];
  completionAliases: CoreCompletionAlias[];
  ownerRoutes: CoreProviderOwnerRoute[];
};
export type ProviderScopeStatus = Omit<ProviderThreadStatus, "budget">;
export type CoreProvider = {
  imageAccounts: { store: Store; shared: ReturnType<typeof providerOAuth> };
  request(principal: Principal, request: Request, req: IncomingMessage, res: ServerResponse): Promise<Response | void>;
  startTransports(): Promise<CoreResult<void>>;
  reconcile(): Promise<void>;
  tick(): void;
  close(): Promise<void>;
};
const absolute = (path: unknown): path is string => typeof path === "string" && path.startsWith("/") && !path.includes("\0");
const record = (value: unknown): value is Record<string, any> => !!value && typeof value === "object" && !Array.isArray(value);
const ids = (value: unknown): value is string[] => Array.isArray(value) && value.every(id => typeof id === "string" && !!id) && new Set(value).size === value.length;
const policyPair = (value: { meterMaxAgeMs?: unknown; autoReset?: unknown }) => Number.isSafeInteger(value.meterMaxAgeMs) && Number(value.meterMaxAgeMs) > 0 && typeof value.autoReset === "boolean";
export function parseCoreProviderConfig(value: unknown, policy: PermissionPolicy, principal: Principal): CoreResult<CoreProviderConfig> {
  const invalid = (message: string): CoreResult<never> => ({ ok: false, error: { code: "invalid-config", message } });
  if (!record(value)) return invalid("Core provider configuration must be an object");
  if (value.kind === "disabled") return { ok: true, value: { kind: "disabled" } };
  const v = value as Extract<CoreProviderConfig, { kind: "configured" }>;
  if (v.kind !== "configured" || !ids(v.configPaths) || !v.configPaths.length || !v.configPaths.every(absolute) || !v.configPaths.includes(v.primaryConfigPath)
    || ![v.adoptionReceiptPath, v.agentDir, v.availabilityPath, v.releasePath, v.home].every(absolute)
    || !Number.isSafeInteger(v.uid) || v.uid < 0 || !Number.isSafeInteger(v.gid) || v.gid < 0 || !policyPair(v)
    || typeof v.ownerPrincipal !== "string" || !v.ownerPrincipal || !record(v.retainedListeners)
    || !Array.isArray(v.retainedLedgers) || !Array.isArray(v.completionAliases) || !Array.isArray(v.ownerRoutes) || !Array.isArray(v.grantFootprints) || !Array.isArray(v.freshListeners)) return invalid("Core provider requires explicit original configs, custody, per-controller meter policy, grant footprints and owner routes");
  if (!(v.retainedListeners.kind === "disabled" || v.retainedListeners.kind === "uid-bound" && absolute(v.retainedListeners.adoptionReceiptPath) && ids(v.retainedListeners.admissionDeltaPaths) && v.retainedListeners.admissionDeltaPaths.length <= 256 && v.retainedListeners.admissionDeltaPaths.every(absolute) && Array.isArray(v.retainedListeners.bindings) && v.retainedListeners.bindings.length)) return invalid("Disable retained transports explicitly or declare exact UID-bound listeners, an immutable drain receipt and explicit admission delta paths (empty when none)");
  const transportPorts = new Set<number>(), freshPaths = new Set<string>(), freshPrincipals = new Set<string>();
  if (v.retainedListeners.kind === "uid-bound") for (const b of v.retainedListeners.bindings) {
    if (!isBrokerListenerBinding(b) || transportPorts.has(b.port)) return invalid("Retained listeners require exact unique ports, principals and host UID gates");
    transportPorts.add(b.port);
  }
  for (const fresh of v.freshListeners) {
    if (!record(fresh) || !absolute(fresh.configPath) || !v.configPaths.includes(fresh.configPath) || !absolute(fresh.admissionReceiptPath) || !isBrokerListenerBinding(fresh.binding)
      || transportPorts.has(fresh.binding.port) || freshPaths.has(fresh.configPath) || freshPrincipals.has(fresh.binding.principalId)) return invalid("Fresh listeners require their distinct personal config, prior-owner-none admission and exact host UID binding");
    transportPorts.add(fresh.binding.port); freshPaths.add(fresh.configPath); freshPrincipals.add(fresh.binding.principalId);
  }
  const ownerIds = new Set(["current"]), paths = new Set<string>();
  for (const o of v.retainedLedgers) {
    if (!record(o) || typeof o.ownerPrincipal !== "string" || !o.ownerPrincipal || typeof o.id !== "string" || !/^[A-Za-z0-9._-]+$/.test(o.id) || ownerIds.has(o.id)
      || ![o.databasePath, o.adoptionReceiptPath, o.authPath, o.agentDir, o.home].every(absolute) || paths.has(o.databasePath)
      || !Number.isSafeInteger(o.uid) || o.uid < 0 || !Number.isSafeInteger(o.gid) || o.gid < 0 || !policyPair(o)) return invalid("Retained ledgers require unique exact custody and their own meter freshness/reset policy");
    ownerIds.add(o.id); paths.add(o.databasePath);
  }
  if (v.grantFootprints.length !== v.configPaths.length || new Set(v.grantFootprints.map(f => f.configPath)).size !== v.configPaths.length
    || v.grantFootprints.some(f => !record(f) || !v.configPaths.includes(f.configPath) || !ids(f.ledgerOwnerIds) || f.ledgerOwnerIds.some(id => !ownerIds.has(id)))) return invalid("Every original broker config requires its exact publication footprint (empty is explicit)");
  const publicIds = new Set<string>(), storedIds = new Set<string>();
  for (const a of v.completionAliases) {
    if (!record(a) || typeof a.principal !== "string" || !a.principal || !isCompletionRequestId(a.requestId) || !isCompletionRequestId(a.storedRequestId) || !ownerIds.has(a.ownerId)) return invalid("Aliases require proved principal/public/stored IDs and an original owner");
    const p = JSON.stringify([a.principal, a.requestId]), s = JSON.stringify([a.ownerId, a.storedRequestId]);
    if (publicIds.has(p) || storedIds.has(s)) return invalid("Completion identities must be immutable and unique");
    publicIds.add(p); storedIds.add(s);
  }
  const resourceCheck = (resource: Resource) => { const r = authorize(policy, { principal, resource, action: "read", now: Date.now() }); return r.ok || r.error.code !== "invalid-request"; };
  if (!resourceCheck(v.resource) || !resourceCheck(v.peopleUsageResource) || v.peopleUsageResource.id === v.resource.id || v.peopleUsageResource.kind !== "data") return invalid("People analytics require a separate valid data resource; its descriptor issues no grant");
  const routeOwners = new Set<string>();
  for (const route of v.ownerRoutes) {
    if (!record(route) || !ownerIds.has(route.ownerId) || routeOwners.has(route.ownerId) || typeof route.scopeId !== "string" || !route.scopeId || !ids(route.callerPrincipals)
      || !["force", "background", "live"].includes(route.budget) || !record(route.resources)) return invalid("Owner routes require exact owner/scope, old caller ceiling and status budget");
    const keys = ["completionRead", "completionSubmit", "completionRetry", "completionCancel", "providerRead", "providerControl"] as const;
    if (!keys.every(key => resourceCheck(route.resources[key])) || new Set(keys.map(key => route.resources[key].id)).size !== keys.length) return invalid("Owner operations need separate exact resources; no common broker-user control grant");
    routeOwners.add(route.ownerId);
  }
  return { ok: true, value: v };
}
export function createCoreProvider(config: Extract<CoreProviderConfig, {kind: "configured"}>, policy: PermissionPolicy, principals: readonly Principal[], statusForScope?: (scopeId: string) => CoreResult<ProviderScopeStatus>): CoreResult<CoreProvider> {
  const owners: { id: string; ownerPrincipal: string; accountPoolId: string; store: Store; lock: ScopeOwnership; controller: ProviderController }[] = [];
  const brokers: { path: string; config: ModelBrokerConfig; broker: ReturnType<typeof createModelBroker>; footprint: string[] }[] = [];
  const clean = () => { for (const owner of [...owners].reverse()) { owner.store.close(); owner.lock.close(); } };
  const identity = (path: string) => { const s = statSync(path, { bigint: true }); if (!s.isFile()) throw Error("Existing provider storage is unavailable; core never initializes it"); return `${s.dev}:${s.ino}`; };
  const registered = (id: string) => principals.find(principal => principal.id === id);
  try {
    const originals = config.configPaths.map(path => ({ path, config: loadBrokerConfig(path), footprint: config.grantFootprints.find(f => f.configPath === path)!.ledgerOwnerIds }));
    const primaryConfig = originals.find(b => b.path === config.primaryConfigPath)!.config;
    if (originals.some(b => identity(b.config.ledgerPath) !== identity(primaryConfig.ledgerPath) || b.config.authPath !== primaryConfig.authPath && identity(b.config.authPath) !== identity(primaryConfig.authPath))) throw Error("Original brokers must share exact provider ledger and OAuth custody");
    if (config.retainedListeners.kind === "uid-bound") { const r = verifyBrokerDrainReceipt(config.retainedListeners, primaryConfig.ledgerPath); if (!r.ok) return r; }
    for (const fresh of config.freshListeners) {
      const source = originals.find(b => b.path === fresh.configPath); if (!source) throw Error("Fresh transport source is undeclared");
      if (originals.some(b => b.path !== source.path && b.config.listeners.some(l => l.principal === fresh.binding.principalId))) throw Error("Fresh personal listener cannot reuse an existing principal's endpoint");
      const proof = verifyFreshBrokerAdmission(fresh, source.config, source.footprint); if (!proof.ok) return proof;
    }
    if ([config.ownerPrincipal, ...config.retainedLedgers.map(o => o.ownerPrincipal), ...originals.flatMap(b => b.config.listeners.map(l => l.principal)), ...config.ownerRoutes.flatMap(r => r.callerPrincipals)].some(id => !registered(id))) return { ok: false, error: { code: "invalid-config", message: "Provider callers and original owners must be registered core principals" } };
    const listeners = originals.flatMap(b => b.config.listeners);
    if (new Set(listeners.map(l => l.port)).size !== listeners.length) throw Error("Original broker ports collide");
    if (config.retainedListeners.kind === "uid-bound" && config.retainedListeners.bindings.some(b => !listeners.some(l => l.principal === b.principalId && l.port === b.port))) throw Error("Retained bindings must match exact original principal/ports");
    if (config.ownerRoutes.length && !statusForScope) throw Error("Owner status requires its exact adopted thread scope");
    const declarations = [{ id: "current", ownerPrincipal: config.ownerPrincipal, custodyId: "provider", databasePath: primaryConfig.ledgerPath, adoptionReceiptPath: config.adoptionReceiptPath, uid: config.uid, gid: config.gid, home: config.home, authPath: primaryConfig.authPath, agentDir: config.agentDir, meterMaxAgeMs: config.meterMaxAgeMs, autoReset: config.autoReset }, ...config.retainedLedgers.map(o => ({ ...o, custodyId: o.id }))];
    if (new Set(declarations.map(o => identity(o.databasePath))).size !== declarations.length) throw Error("Provider registry refers to one ledger twice");
    const availability = new ModelAvailabilityStore(config.availabilityPath);
    for (const o of declarations) {
      const lock = acquireDatabaseOwnership({ id: o.custodyId, databasePath: o.databasePath, adoptionReceiptPath: o.adoptionReceiptPath, uid: o.uid }, path => path); if (!lock.ok) { clean(); return lock; }
      let store: Store; try { store = Store.open(o.databasePath); } catch (cause) { lock.value.close(); throw cause; }
      try {
        for (const suffix of ["-wal", "-shm"]) { const path = `${o.databasePath}${suffix}`; let s; try { s = statSync(path); } catch (cause) { if ((cause as NodeJS.ErrnoException).code === "ENOENT") continue; throw cause; } if (s.uid !== o.uid || s.gid !== o.gid) chownSync(path, o.uid, o.gid); }
        const controller = new ProviderController(store, { authPath: o.authPath, agentDir: o.agentDir, meterMaxAgeMs: o.meterMaxAgeMs, autoReset: o.autoReset }, availability, config.releasePath, { socketPath: completionHostSocket(o.databasePath, o.uid), launch: (boundary, socket) => launchCompletionHostForCustody(boundary, socket, o) });
        owners.push({ id: o.id, ownerPrincipal: o.ownerPrincipal, accountPoolId: o.authPath, store, lock: lock.value, controller });
      } catch (cause) { store.close(); lock.value.close(); throw cause; }
    }
    const publish = (values: typeof originals) => {
      const partitions = new Map<string, { store: Store; owner: string | undefined; listeners: Map<string, BrokerListener> }>();
      for (const b of values) for (const id of b.footprint) {
        const owner = owners.find(o => o.id === id); if (!owner) throw Error("Unknown grant publication ledger");
        const key = JSON.stringify([id, b.config.grantOwner ?? null]);
        let p = partitions.get(key); if (!p) { p = { store: owner.store, owner: b.config.grantOwner, listeners: new Map() }; partitions.set(key, p); }
        for (const l of b.config.listeners) { const prior = p.listeners.get(l.principal); if (prior && completionCanonical(prior) !== completionCanonical(l)) throw Error("Original owner partition has conflicting principal ceilings"); p.listeners.set(l.principal, l); }
      }
      for (const p of partitions.values()) p.store.publishBrokerGrants([...p.listeners.values()].map(l => ({ principal: l.principal, accounts: l.accounts, models: l.models })), p.owner);
    };
    publish(originals);
    const primary = owners.find(o => o.id === "current")!;
    for (const b of originals) brokers.push({ ...b, broker: createModelBroker(b.config, availability, fetch, { store: primary.store, controller: primary.controller, completionOwners: owners.filter(o => o.id !== "current"), grantPublication: { kind: "borrowed" }, async authorizeRequest(id) { const actor = registered(id); if (!actor) return { ok: false, status: 403, message: "Unknown core principal" }; const r = authorize(policy, { principal: actor, resource: config.resource, action: "use", now: Date.now() }); return r.ok ? { ok: true } : { ok: false, status: 403, message: r.error.message }; } }) });
    for (const a of config.completionAliases) {
      const candidates = brokers.filter(b => b.footprint.includes(a.ownerId) && b.config.listeners.some(l => l.principal === a.principal));
      if (candidates.length !== 1) throw Error("Alias has no unique proved original grant partition; preserve its owner/stored-ID route");
      const adopted = candidates[0]!.broker.adoptCompletion(a.principal, a.requestId, a.storedRequestId, a.ownerId); if (!adopted.ok) { clean(); return { ok: false, error: { code: "ownership-conflict", message: `Alias ${a.ownerId}/${a.storedRequestId}: ${adopted.error.code}: ${adopted.error.message}` } }; }
    }
    let closing: Promise<void> | undefined, starting: Promise<CoreResult<void>> | undefined;
    return { ok: true, value: {
      imageAccounts: { store: primary.store, shared: providerOAuth(openaiCodexProvider(), primaryConfig.authPath) },
      async request(principal, request, req, res) {
        const fail = (status: number, code: string, message: string) => Response.json({ error: { code, message } }, { status });
        if (closing) return fail(503, "unavailable", "Provider custody is draining");
        const url = new URL(request.url), ownerPath = /^\/v1\/providers\/owners\/([A-Za-z0-9._-]+)(\/v1\/.*)$/.exec(url.pathname);
        if (ownerPath) {
          const route = config.ownerRoutes.find(r => r.ownerId === ownerPath[1]), owner = owners.find(o => o.id === ownerPath[1]);
          if (!route || !owner || !route.callerPrincipals.includes(principal.id)) return fail(403, "denied", "Caller is outside the original owner route ceiling");
          const subpath = ownerPath[2]!, operation = directCompletionOperation(request.method, subpath);
          const key = operation ? ({ read: "completionRead", submit: "completionSubmit", retry: "completionRetry", cancel: "completionCancel" } as const)[operation] : request.method === "GET" ? "providerRead" : "providerControl";
          const grant = authorize(policy, { principal, resource: route.resources[key], action: request.method === "GET" ? "read" : operation === "submit" ? "use" : "control", now: Date.now() });
          if (!grant.ok) return Response.json(grant, { status: 403 });
          const selected = new Request(new URL(`${subpath}${url.search}`, request.url), request);
          if (subpath.startsWith("/v1/completions/")) return await completionHttp(owner.controller, selected);
          let threads: ProviderThreadStatus | undefined;
          if (subpath === "/v1/status") { const status = statusForScope!(route.scopeId); if (!status.ok) return Response.json(status, { status: 503 }); threads = { ...status.value, budget: route.budget }; }
          return await providerHttp(owner.controller, selected, "/v1", threads);
        }
        if (url.pathname === "/v1/providers/people-usage") {
          const grant = authorize(policy, { principal, resource: config.peopleUsageResource, action: "read", now: Date.now() }); if (!grant.ok) return Response.json(grant, { status: 403 });
          const period = url.searchParams.get("period"); if (request.method !== "GET" || !["day", "week"].includes(period ?? "") || [...url.searchParams.keys()].some(k => k !== "period") || url.searchParams.getAll("period").length !== 1) return fail(400, "invalid-request", "Require GET and explicit period=day|week");
          const now = Date.now(); try { return Response.json(personUsageAcrossStores(owners, now - (period === "day" ? 24 : 7 * 24) * 3_600_000, now)); } catch { return fail(503, "unavailable", "Retained people usage is unavailable"); }
        }
        const brokerRoute = url.pathname.startsWith("/v1/model-broker/");
        const grant = authorize(policy, { principal, resource: config.resource, action: brokerRoute ? "use" : request.method === "GET" ? "read" : "write", now: Date.now() }); if (!grant.ok) return Response.json(grant, { status: 403 });
        if (!brokerRoute) return await providerHttp(primary.controller, request);
        const candidates = brokers.filter(b => b.config.listeners.some(l => l.principal === principal.id));
        if (candidates.length !== 1) return fail(503, "unavailable", "Caller has no unique original broker ceiling; use its retained bound transport");
        req.url = `${url.pathname.slice("/v1/model-broker".length)}${url.search}`; await candidates[0]!.broker.request(principal.id, req, res);
      },
      startTransports() {
        if (!starting) starting = (async (): Promise<CoreResult<void>> => {
          const retained = config.retainedListeners;
          if (retained.kind === "uid-bound") { const drained = verifyBrokerDrainReceipt(retained, primaryConfig.ledgerPath); if (!drained.ok) return drained; }
          for (const fresh of config.freshListeners) { const source = brokers.find(b => b.path === fresh.configPath)!; const proof = verifyFreshBrokerAdmission(fresh, source.config, source.footprint); if (!proof.ok) return proof; }
          const declaredBindings = [...(retained.kind === "uid-bound" ? retained.bindings : []), ...config.freshListeners.map(f => f.binding)];
          for (const binding of declaredBindings) { const proof = await verifyLiveBrokerIdentity(binding); if (!proof.ok) return proof; }
          try {
            for (const b of brokers) {
              const bindings = declaredBindings.filter(binding => b.config.listeners.some(l => l.port === binding.port && l.principal === binding.principalId));
              if (!bindings.length) continue;
              await b.broker.listen(bindings.map(binding => binding.principalId), async id => { const binding = bindings.find(binding => binding.principalId === id)!; const proof = await verifyLiveBrokerIdentity(binding); return proof.ok ? { ok: true } : { ok: false, status: 503, message: proof.error.message }; });
            }
            return { ok: true, value: undefined };
          } catch (cause) { return { ok: false, error: { code: "unavailable", message: `Retained transport adoption failed: ${cause instanceof Error ? cause.message : String(cause)}` } }; }
        })(); return starting;
      },
      async reconcile() {
        const reloaded = brokers.map(b => ({ path: b.path, footprint: b.footprint, config: loadBrokerConfig(b.path) }));
        const topology = (c: ModelBrokerConfig) => c.listeners.map(l => `${l.principal}:${l.port}`).sort().join(",");
        for (const [i, b] of reloaded.entries()) { const old = brokers[i]!.config; if (b.config.grantOwner !== old.grantOwner || topology(b.config) !== topology(old) || b.config.ledgerPath !== old.ledgerPath || b.config.authPath !== old.authPath) throw Error("Broker reload changed original publication/custody partition"); }
        if (reloaded.some((b, i) => completionCanonical(b.config) !== completionCanonical(brokers[i]!.config))) { publish(reloaded); for (const [i, b] of reloaded.entries()) { brokers[i]!.broker.applyGrants(b.config.listeners); brokers[i]!.config = b.config; } }
        await Promise.all(owners.map(o => o.controller.reconcile()));
      },
      tick() { for (const o of owners) o.controller.tick(); },
      close() { if (!closing) closing = (async () => { await Promise.all(brokers.map(b => b.broker.close())); await Promise.all(owners.map(o => o.controller.detach())); clean(); })(); return closing; },
    } };
  } catch (cause) { clean(); return { ok: false, error: { code: "unavailable", message: `Provider adoption failed: ${cause instanceof Error ? cause.message : String(cause)}` } }; }
}

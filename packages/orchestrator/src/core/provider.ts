import { chownSync, statSync } from "node:fs";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import { providerOAuth } from "../auth/shared-oauth.js";
import { acquireDatabaseOwnership, type ScopeOwnership } from "./ownership.js";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Store } from "../store.js";
import { createModelBroker, loadBrokerConfig } from "../model-broker.js";
import { isCompletionRequestId } from "../completion-contract.js";
import { ProviderController } from "../provider-controller.js";
import { completionHostSocket, launchCompletionHostForCustody } from "../host/completion-transport.js";
import { providerHttp } from "../provider-http.js";
import { ModelAvailabilityStore } from "../threads/model-availability.js";
import { authorize, type PermissionPolicy, type Principal, type Resource } from "../permissions.js";
import type { CoreResult } from "./config.js";

export interface CoreRetainedProviderLedger {
  /** Also the scopeId bound by this ledger's detached-owner adoption receipt. */
  id: string;
  databasePath: string;
  adoptionReceiptPath: string;
  uid: number;
  gid: number;
  home: string;
  authPath: string;
  agentDir: string;
}
export interface CoreCompletionAlias {
  principal: string;
  requestId: string;
  storedRequestId: string;
  ownerId: string;
}
export type CoreProviderConfig = { kind: "disabled" } | {
  kind: "configured";
  configPath: string;
  adoptionReceiptPath: string;
  uid: number;
  gid: number;
  home: string;
  agentDir: string;
  availabilityPath: string;
  releasePath: string;
  meterMaxAgeMs: number;
  autoReset: boolean;
  resource: Resource;
  retainedLedgers: CoreRetainedProviderLedger[];
  completionAliases: CoreCompletionAlias[];
};
export type CoreProvider = {
  imageAccounts: { store: Store; shared: ReturnType<typeof providerOAuth> };
  request(principal: Principal, request: Request, req: IncomingMessage, res: ServerResponse): Promise<Response | void>;
  reconcile(): Promise<void>;
  tick(): void;
  close(): Promise<void>;
};
const absolute = (path: unknown): path is string => typeof path === "string" && path.startsWith("/") && !path.includes("\0");
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
export function parseCoreProviderConfig(value: unknown, policy: PermissionPolicy, principal: Principal): CoreResult<CoreProviderConfig> {
  const invalid = (message: string): CoreResult<never> => ({ ok: false, error: { code: "invalid-config", message } });
  if (!record(value)) return invalid("Core provider configuration must be an object");
  if (value.kind === "disabled") return { ok: true, value: { kind: "disabled" } };
  const v = value as unknown as Extract<CoreProviderConfig, { kind: "configured" }>;
  if (v.kind !== "configured" || ![v.configPath, v.adoptionReceiptPath, v.agentDir, v.availabilityPath, v.releasePath].every(absolute)
    || !Number.isSafeInteger(v.uid) || v.uid < 0 || !Number.isSafeInteger(v.gid) || v.gid < 0 || !absolute(v.home) || !Number.isSafeInteger(v.meterMaxAgeMs) || v.meterMaxAgeMs <= 0 || typeof v.autoReset !== "boolean"
    || !Array.isArray(v.retainedLedgers) || !Array.isArray(v.completionAliases)) return invalid("Core provider requires explicit paths, meter policy, retained ledgers and completion aliases (empty arrays when none)");
  const ownerIds = new Set(["current"]), paths = new Set<string>();
  for (const owner of v.retainedLedgers) {
    if (!record(owner) || typeof owner.id !== "string" || !/^[A-Za-z0-9._-]+$/.test(owner.id) || ownerIds.has(owner.id)
      || ![owner.databasePath, owner.adoptionReceiptPath, owner.authPath, owner.agentDir].every(absolute)
      || paths.has(owner.databasePath as string) || !Number.isSafeInteger(owner.uid) || Number(owner.uid) < 0 || !Number.isSafeInteger(owner.gid) || Number(owner.gid) < 0 || !absolute(owner.home)) return invalid("Retained provider ledgers require unique identities, exact paths and custody UIDs");
    ownerIds.add(owner.id); paths.add(owner.databasePath as string);
  }
  const publicIds = new Set<string>(), storedIds = new Set<string>();
  for (const alias of v.completionAliases) {
    if (!record(alias) || typeof alias.principal !== "string" || !/^[a-z_][a-z0-9_-]*$/.test(alias.principal)
      || !isCompletionRequestId(alias.requestId) || !isCompletionRequestId(alias.storedRequestId) || typeof alias.ownerId !== "string" || !ownerIds.has(alias.ownerId)) return invalid("Completion aliases must bind a principal, exact public/stored IDs and a declared ledger owner");
    const publicId = JSON.stringify([alias.principal, alias.requestId]), storedId = JSON.stringify([alias.ownerId, alias.storedRequestId]);
    if (publicIds.has(publicId) || storedIds.has(storedId)) return invalid("A completion may have only one immutable public and stored identity");
    publicIds.add(publicId); storedIds.add(storedId);
  }
  const permission = authorize(policy, { principal, resource: v.resource, action: "read", now: Date.now() });
  if (!permission.ok && permission.error.code === "invalid-request") return invalid(permission.error.message);
  return { ok: true, value: v };
}
export function createCoreProvider(config: Extract<CoreProviderConfig, {kind: "configured"}>, policy: PermissionPolicy): CoreResult<CoreProvider> {
  const owners: { id: string; store: Store; lock: ScopeOwnership; controller: ProviderController }[] = [];
  let broker: ReturnType<typeof createModelBroker> | undefined;
  const clean = () => { for (const owner of [...owners].reverse()) { owner.store.close(); owner.lock.close(); } };
  try {
    const brokerConfig = loadBrokerConfig(config.configPath);
    const ledgerPaths = [brokerConfig.ledgerPath, ...config.retainedLedgers.map(owner => owner.databasePath)];
    // Inodes, not spelling, define custody: opening a symlink alias twice would split admission.
    const identities = ledgerPaths.map(path => { const s = statSync(path, { bigint: true }); if (!s.isFile()) throw new Error("Existing provider ledger is unavailable; core will not create it"); return `${s.dev}:${s.ino}`; });
    if (new Set(identities).size !== identities.length) throw new Error("Provider registry refers to the same ledger more than once");
    const availability = new ModelAvailabilityStore(config.availabilityPath);
    const declarations = [{ id: "current", custodyId: "provider", databasePath: brokerConfig.ledgerPath, adoptionReceiptPath: config.adoptionReceiptPath, uid: config.uid, gid: config.gid, home: config.home, authPath: brokerConfig.authPath, agentDir: config.agentDir },
      ...config.retainedLedgers.map(owner => ({ ...owner, custodyId: owner.id }))];
    for (const declaration of declarations) {
      const adopted = acquireDatabaseOwnership({ id: declaration.custodyId, databasePath: declaration.databasePath, adoptionReceiptPath: declaration.adoptionReceiptPath, uid: declaration.uid }, path => path);
      if (!adopted.ok) { clean(); return adopted; }
      let store: Store;
      try { store = Store.open(declaration.databasePath); } catch (cause) { adopted.value.close(); throw cause; }
      try {
        // SQLite creates WAL/SHM files under the process UID. The root core and
        // the retained user host must share the original writing boundary.
        for (const suffix of ["-wal", "-shm"]) {
          const path = `${declaration.databasePath}${suffix}`;
          let identity;
          try { identity = statSync(path); } catch (cause) { if ((cause as NodeJS.ErrnoException).code === "ENOENT") continue; throw cause; }
          if (identity.uid !== declaration.uid || identity.gid !== declaration.gid) chownSync(path, declaration.uid, declaration.gid);
        }
        const controller = new ProviderController(store, { authPath: declaration.authPath, agentDir: declaration.agentDir, meterMaxAgeMs: config.meterMaxAgeMs, autoReset: config.autoReset }, availability, config.releasePath, { socketPath: completionHostSocket(declaration.databasePath, declaration.uid), launch: (boundary, socketPath) => launchCompletionHostForCustody(boundary, socketPath, declaration) });
        owners.push({ id: declaration.id, store, lock: adopted.value, controller });
      } catch (cause) { store.close(); adopted.value.close(); throw cause; }
    }
    const primary = owners[0]!;
    broker = createModelBroker(brokerConfig, availability, fetch, { store: primary.store, controller: primary.controller, completionOwners: owners.slice(1) });
    for (const alias of config.completionAliases) {
      const adopted = broker.adoptCompletion(alias.principal, alias.requestId, alias.storedRequestId, alias.ownerId);
      if (!adopted.ok) { clean(); return { ok: false, error: { code: "ownership-conflict", message: `Completion alias ${alias.ownerId}/${alias.storedRequestId}: ${adopted.error.code}: ${adopted.error.message}` } }; }
    }
    const ownedBroker = broker;
    let closing: Promise<void> | undefined;
    return { ok: true, value: {
      imageAccounts: { store: primary.store, shared: providerOAuth(openaiCodexProvider(), brokerConfig.authPath) },
      async request(principal, request, req, res) {
        const url = new URL(request.url);
        const brokerRoute = url.pathname.startsWith("/v1/model-broker/");
        const permission = authorize(policy, { principal, resource: config.resource, action: brokerRoute ? "use" : request.method === "GET" ? "read" : "write", now: Date.now() });
        if (!permission.ok) return Response.json(permission, { status: 403 });
        if (!brokerRoute) return await providerHttp(primary.controller, request);
        req.url = `${url.pathname.slice("/v1/model-broker".length)}${url.search}`;
        await ownedBroker.request(principal.id, req, res);
      },
      async reconcile() { await Promise.all(owners.map(owner => owner.controller.reconcile())); },
      tick() { for (const owner of owners) owner.controller.tick(); },
      close() {
        if (!closing) closing = (async () => { await ownedBroker.close(); await Promise.all(owners.map(owner => owner.controller.detach())); clean(); })();
        return closing;
      },
    } };
  } catch (cause) {
    clean();
    return { ok: false, error: { code: "unavailable", message: `Provider adoption failed: ${cause instanceof Error ? cause.message : String(cause)}` } };
  }
}

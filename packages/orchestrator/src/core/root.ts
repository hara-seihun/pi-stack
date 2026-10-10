import { readFileSync, statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import type { ThreadService } from "../threads/service.js";
import type { CoreResult } from "./config.js";
import type { CoreScope } from "./contracts.js";
import type { CoreRuntime } from "./custody.js";
import { sharedCustodyFlag } from "./feature-stop.js";
import { CustodyResources } from "./custody-resources.js";
import { acquireDatabaseOwnership, type ScopeOwnership } from "./ownership.js";

export type CoreRootConfig = { kind: "disabled" } | {
  kind: "configured";
  consultationScopeId: string;
  consultationOwners: { rootSessionId: string; scopeId: string }[];
  configPath: string;
  privateDir: string;
  memoryUrl: string;
  routerUrl: string;
  credentials: { memoryRootTokenFile: string; adminCapabilityFile: string; consentCapabilityFile: string };
  requests: { id: string; databasePath: string; adoptionReceiptPath: string };
  consent: { id: string; databasePath: string; adoptionReceiptPath: string };
};
export type CoreRootPlugin = {
  fetch(request: Request): Promise<Response>;
  reconcile(): Promise<{ errors: number }>;
  drain(): Promise<void>;
  close(): Promise<void>;
};
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const absolute = (value: unknown): value is string => typeof value === "string" && isAbsolute(value) && resolve(value) === value && !value.includes("\0");
const identifier = (value: unknown): value is string => typeof value === "string" && /^[a-zA-Z0-9_.:-]+$/.test(value);
const localUrl = (value: unknown) => {
  try { const url = new URL(String(value)); return url.protocol === "http:" && ["127.0.0.1", "[::1]"].includes(url.hostname) && !!url.port && !url.username && !url.password && url.pathname === "/" && !url.search && !url.hash; }
  catch { return false; }
};

export function parseCoreRootConfig(value: unknown): CoreResult<CoreRootConfig> {
  const invalid = (): CoreResult<never> => ({ ok: false, error: { code: "invalid-config", message: "Root integration requires explicit scope, private store, local endpoints, credential files and both database adoption receipts" } });
  if (!record(value)) return invalid();
  if (value.kind === "disabled") return { ok: true, value: { kind: "disabled" } };
  if (value.kind !== "configured" || !identifier(value.consultationScopeId) || !absolute(value.configPath) || !absolute(value.privateDir)
    || !localUrl(value.memoryUrl) || !localUrl(value.routerUrl) || !record(value.credentials)
    || ![value.credentials.memoryRootTokenFile, value.credentials.adminCapabilityFile, value.credentials.consentCapabilityFile].every(absolute)) return invalid();
  if (!Array.isArray(value.consultationOwners) || value.consultationOwners.some(entry => !record(entry)
    || typeof entry.rootSessionId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(entry.rootSessionId)
    || !identifier(entry.scopeId)) || new Set(value.consultationOwners.map(entry => entry.rootSessionId)).size !== value.consultationOwners.length) return invalid();
  for (const storage of [value.requests, value.consent])
    if (!record(storage) || !identifier(storage.id) || !absolute(storage.databasePath) || !absolute(storage.adoptionReceiptPath)) return invalid();
  if ((value.requests as Record<string, unknown>).id === (value.consent as Record<string, unknown>).id
    || (value.requests as Record<string, unknown>).databasePath === (value.consent as Record<string, unknown>).databasePath) return invalid();
  return { ok: true, value: value as unknown as CoreRootConfig };
}

export async function createCoreRootIntegration(config: CoreRootConfig, scopes: CoreScope[],
  owner: (scopeId: string) => CoreResult<{ threads: ThreadService; runtime: CoreRuntime }>,
  lifecycle: { releaseCommit: string; shutdownSignal: AbortSignal;
    authorizeAdmin(request: Request, scopeId: string, actions: readonly ("read" | "control")[]): CoreResult<void> }): Promise<CoreResult<CoreRootPlugin | null>> {
  if (config.kind === "disabled") return { ok: true, value: null };
  const scope = scopes.find(item => item.id === config.consultationScopeId);
  if (!scope || scope.resource.privacy !== "confidential")
    return { ok: false, error: { code: "invalid-config", message: "Consultation scope must be an explicitly registered confidential resource" } };
  const consultationScopes = [...new Set([scope.id, ...config.consultationOwners.map(entry => entry.scopeId)])];
  const owners = new Map<string, { threads: ThreadService; runtime: import("./native-session.js").CoreInProcessRuntime }>();
  for (const scopeId of consultationScopes) {
    const registered = scopes.find(item => item.id === scopeId);
    if (registered?.resource.privacy !== "confidential") return { ok: false, error: { code: "invalid-config", message: "Every consultation owner must bind a registered confidential scope" } };
    const custody = owner(scopeId);
    if (!custody.ok) return custody;
    if (!("register" in custody.value.runtime)) return { ok: false, error: { code: "invalid-config", message: "Consultation scope requires the shared in-process native adapter" } };
    owners.set(scopeId, custody.value as { threads: ThreadService; runtime: import("./native-session.js").CoreInProcessRuntime });
  }
  const consultationOwnerFor = (id: string, origin: "new" | "existing") => {
    const recorded = config.consultationOwners.find(entry => entry.rootSessionId === id);
    const selected = owners.get(recorded?.scopeId ?? scope.id)!;
    if (origin === "existing" && !recorded && !selected.threads.get(id))
      return { ok: false as const, message: "Existing consultation has no registered original core owner; it will not be respawned" };
    if (recorded && !selected.threads.get(id))
      return { ok: false as const, message: "Registered original consultation thread is unavailable; its identity will not be replaced" };
    return { ok: true as const, value: selected };
  };
  const locks: ScopeOwnership[] = [];
  let resources: CustodyResources | undefined;
  try {
    resources = new CustodyResources(scope.custody);
    const paths = new Set([config.configPath, config.privateDir, config.requests.databasePath, config.requests.adoptionReceiptPath, config.consent.databasePath, config.consent.adoptionReceiptPath,
      ...Object.values(config.credentials), ...(scope.environment.PI_STACK_HOST_CONFIG ? [scope.environment.PI_STACK_HOST_CONFIG] : [])]);
    const path = (logical: string) => {
      if (!paths.has(logical)) throw new Error("Unregistered private integration resource");
      const current = statSync(logical, { bigint: true });
      const registered = statSync(resources!.directory(logical), { bigint: true });
      if (current.dev !== registered.dev || current.ino !== registered.ino) throw new Error("Private integration resource is outside the prepared shared mount view");
      return logical;
    };
    for (const storage of [config.requests, config.consent]) {
      const ownership = acquireDatabaseOwnership({ ...storage, uid: scope.custody.uid }, path);
      if (!ownership.ok) { for (const lock of locks) lock.close(); resources.close(); return ownership; }
      locks.push(ownership.value);
    }
    const credential = (logical: string) => {
      const file = path(logical), stat = statSync(file);
      if (!stat.isFile() || stat.mode & 0o077 || ![0, process.getuid?.()].includes(stat.uid)) throw new Error("Root integration credential is not a private own-identity file");
      const value = readFileSync(file, "utf8").trim();
      if (!value) throw new Error("Root integration credential is empty");
      return value;
    };
    const [{ createRootIntegration }, { readRootConfig }] = await Promise.all([import("kenan-root/integration"), import("kenan-root/runtime")]);
    const integration = createRootIntegration({ consultationOwnerFor,
      drainConsultations: async () => { await Promise.all([...owners.values()].map(item => item.runtime.drain())); },
      config: readRootConfig(path(config.configPath)), privateDir: path(config.privateDir),
      memoryRootToken: credential(config.credentials.memoryRootTokenFile), adminCapability: credential(config.credentials.adminCapabilityFile),
      consentCapability: credential(config.credentials.consentCapabilityFile), memoryUrl: config.memoryUrl, routerUrl: config.routerUrl,
      requestStorePath: config.requests.databasePath, consentStorePath: config.consent.databasePath, enabled: () => !lifecycle.shutdownSignal.aborted && sharedCustodyFlag(scope, path).state === "enabled",
      releaseCommit: lifecycle.releaseCommit, shutdownSignal: lifecycle.shutdownSignal });
    if (!integration.ok) { for (const lock of locks) lock.close(); resources.close(); return { ok: false, error: { code: "unavailable", message: integration.error.message } }; }
    const plugin = integration.value, pinned = resources;
    return { ok: true, value: { ...plugin,
      async fetch(request) {
        const url = new URL(request.url);
        if (url.pathname.startsWith("/v1/admin/")) {
          const headers = new Headers(request.headers);
          if (!headers.has("authorization")) {
            const token = headers.get("x-pi-kenan-admin");
            if (token) headers.set("authorization", `Bearer ${token}`);
          }
          const transcript = /^\/v1\/admin\/root-sessions\/([0-9a-f-]{36})\/transcript$/.exec(url.pathname);
          let transcriptScope: string | undefined;
          if (transcript) {
            const recorded = config.consultationOwners.find(entry => entry.rootSessionId === transcript[1]);
            transcriptScope = recorded?.scopeId ?? (owners.get(scope.id)!.threads.get(transcript[1]!) ? scope.id : undefined);
            if (!transcriptScope) return Response.json({ error: "Private consultation access denied" }, { status: 404 });
          }
          const requiredScopes = transcriptScope ? [transcriptScope]
            : url.pathname === "/v1/admin/root-sessions" ? consultationScopes : [scope.id];
          for (const scopeId of requiredScopes) {
            const authorization = lifecycle.authorizeAdmin(new Request(request, { headers }), scopeId, request.method === "GET" ? ["read"] : ["control"]);
            if (!authorization.ok) return Response.json({ error: "Private consultation access denied" }, { status: 404 });
          }
        }
        return plugin.fetch(request);
      },
      async close() { await plugin.close(); for (const lock of locks) lock.close(); pinned.close(); }
    } };
  } catch (cause) {
    for (const lock of locks) lock.close(); resources?.close();
    return { ok: false, error: { code: "unavailable", message: `Private consultation integration cannot adopt custody: ${String(cause)}` } };
  }
}

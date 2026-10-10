import { readFileSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { authorize, validatePermissionPolicy } from "../permissions.js";
import type { CoreConfig, CoreScope } from "./contracts.js";
import { parseCoreProviderConfig } from "./provider.js";
import { parseCoreRootConfig } from "./root.js";
import { parseCoreImagesConfig } from "./images.js";
import { parseCoreMemoryConfig } from "./memory.js";
import { parseCoreDutiesConfig } from "./duties-runtime.js";

export type CoreResult<T> = { ok: true; value: T } | { ok: false; error: { code: "invalid-config" | "io" | "ownership-conflict" | "unavailable"; message: string } };
const invalid = (message: string): CoreResult<never> => ({ ok: false, error: { code: "invalid-config", message } });
const id = (value: unknown): value is string => typeof value === "string" && /^[a-zA-Z0-9_.:-]+$/.test(value);
const absolute = (value: unknown): value is string => typeof value === "string" && isAbsolute(value) && !value.includes("\0");
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const integer = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;

export function parseCoreConfig(value: unknown): CoreResult<CoreConfig> {
  if (!record(value) || value.version !== 1 || !["127.0.0.1", "::1"].includes(String(value.host))
    || !integer(value.port) || value.port < 1 || value.port > 65535 || !absolute(value.statePath)
    || !Array.isArray(value.principals) || value.principals.length === 0 || !Array.isArray(value.credentials) || !Array.isArray(value.scopes)) return invalid("Core requires explicit version, loopback address, port, state path, principals, credentials and scopes");
  const policy = validatePermissionPolicy(value.policy);
  if (!policy.ok) return invalid(policy.error.message);
  const principalIds = new Set<string>();
  for (const principal of value.principals) {
    if (!record(principal) || !id(principal.id) || principalIds.has(principal.id)) return invalid("Core principal IDs must be unique canonical identifiers");
    if (!(principal.kind === "person" && id(principal.person) || principal.kind === "service"
      || principal.kind === "room" && Array.isArray(principal.audience) && principal.audience.length > 0 && principal.audience.every(id)
      && new Set(principal.audience).size === principal.audience.length)) return invalid(`Invalid principal ${principal.id}`);
    principalIds.add(principal.id);
  }
  const scopeIds = new Set<string>();
  const databases = new Set<string>();
  for (const scope of value.scopes) {
    if (!record(scope) || !id(scope.id) || scopeIds.has(scope.id) || !id(scope.principalId) || !principalIds.has(scope.principalId)) return invalid("Every scope requires a unique ID and registered principal");
    if (!record(scope.availability) || !(scope.availability.kind === "adopt" || scope.availability.kind === "unavailable" && ["locked", "inactive"].includes(String(scope.availability.reason)))) return invalid(`Scope ${scope.id} requires explicit adoption availability`);
    const storage = scope.storage, custody = scope.custody;
    if (!record(storage) || ![storage.databasePath, storage.sessionsDir, storage.capabilityKeyPath, storage.adoptionReceiptPath].every(absolute)
      || databases.has(storage.databasePath as string)) return invalid(`Scope ${scope.id} requires distinct existing absolute storage descriptors`);
    if (!record(custody) || !integer(custody.uid) || !integer(custody.gid) || !absolute(custody.dataDir) || !absolute(custody.socketDir)
      || !record(custody.namespace)) return invalid(`Scope ${scope.id} requires explicit runtime custody`);
    for (const namespace of [custody.namespace, custody.retainedRunnerNamespace]) {
      if (!record(namespace) || !(namespace.kind === "host" || namespace.kind === "pinned" && absolute(namespace.path) && typeof namespace.mountNamespaceInode === "string" && /^\d+$/.test(namespace.mountNamespaceInode)
        || namespace.kind === "process" && integer(namespace.pid) && namespace.pid > 0 && typeof namespace.startTicks === "string" && /^\d+$/.test(namespace.startTicks)
        && typeof namespace.mountNamespaceInode === "string" && /^\d+$/.test(namespace.mountNamespaceInode))) return invalid(`Scope ${scope.id} has invalid data/retained-runner namespace identity`);
    }
    if (!Array.isArray(scope.resources) || scope.resources.some(resource => !record(resource) || !absolute(resource.path) || !["file", "directory"].includes(String(resource.kind)))) return invalid(`Scope ${scope.id} needs an explicit resource registry`);
    if (!record(scope.environment) || Object.entries(scope.environment).some(([key, item]) => !/^[A-Z_][A-Z0-9_]*$/.test(key) || typeof item !== "string" || item.includes("\0"))) return invalid(`Scope ${scope.id} has invalid environment`);
    if (!record(scope.manager) || !(scope.manager.kind === "none" || scope.manager.kind === "existing" && id(scope.manager.threadId))) return invalid(`Scope ${scope.id} requires an explicit manager identity or none`);
    const principal = value.principals.find(item => item.id === scope.principalId);
    const resourceCheck = authorize(policy.value, { principal, resource: scope.resource as CoreScope["resource"], action: "read", now: Date.now() });
    if (!resourceCheck.ok && resourceCheck.error.code === "invalid-request") return invalid(`Scope ${scope.id}: ${resourceCheck.error.message}`);
    scopeIds.add(scope.id);
    databases.add(storage.databasePath as string);
  }
  const digests = new Set<string>();
  for (const credential of value.credentials) {
    if (!record(credential) || typeof credential.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(credential.sha256) || digests.has(credential.sha256)
      || !principalIds.has(String(credential.principalId)) || !["person", "service"].includes(String(credential.purpose))
      || !Array.isArray(credential.scopeIds) || credential.scopeIds.some(scope => !scopeIds.has(scope))
      || new Set(credential.scopeIds).size !== credential.scopeIds.length) return invalid("Credential digests must bind a registered principal, purpose and explicit scope set");
    digests.add(credential.sha256);
  }
  const broker = parseCoreProviderConfig(value.broker, policy.value, value.principals[0]);
  if (!broker.ok) return broker;
  const root = parseCoreRootConfig(value.root);
  if (!root.ok) return root;
  if (root.value.kind === "configured" && !scopeIds.has(root.value.consultationScopeId)) return invalid("Root consultation scope is unregistered");
  const images = parseCoreImagesConfig(value.images);
  if (!images.ok) return images;
  const memory = parseCoreMemoryConfig(value.memory, value.principals);
  if (!memory.ok) return memory;
  const duties = parseCoreDutiesConfig(value.duties);
  if (!duties.ok) return duties;
  if (typeof value.releaseCommit !== "string" || !/^[a-f0-9]{40}$/.test(value.releaseCommit)) return invalid("Core requires its exact immutable release commit");
  return { ok: true, value: value as unknown as CoreConfig };
}

export function loadCoreConfig(path: string): CoreResult<CoreConfig> {
  try {
    const stat = statSync(path);
    if (!stat.isFile() || stat.uid !== 0 || (stat.mode & 0o022) !== 0) return invalid("Core configuration must be a root-owned file not writable by group or others");
    return parseCoreConfig(JSON.parse(readFileSync(path, "utf8")));
  } catch (cause) {
    return { ok: false, error: { code: "io", message: `Cannot load core configuration: ${cause instanceof Error ? cause.message : String(cause)}` } };
  }
}

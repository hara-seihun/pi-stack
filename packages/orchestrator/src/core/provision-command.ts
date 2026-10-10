import { spawnSync } from "node:child_process";
import { closeSync, constants, fstatSync, openSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { parseCoreConfig, type CoreResult } from "./config.js";
import { CustodyResources } from "./custody-resources.js";
import type { CoreProvisionRegistration, CoreProvisionReceipt } from "./provision.js";
import type { ProvisionWorkerInput } from "./provision-worker.js";

export type RegisteredAccountProvisionInput = { configPath: string; registrationPath: string; requestId: string };
function ownerDocument(path: string): unknown {
  if (!isAbsolute(path) || resolve(path) !== path || realpathSync(path) !== path) throw new Error("Account creation document must be a canonical nonredirected path");
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.uid !== 0 || (st.mode & 0o022) !== 0) throw new Error("Account creation documents must be root-owned and not writable by group or others");
    return JSON.parse(readFileSync(fd, "utf8"));
  } finally { closeSync(fd); }
}

/** Called by the root-owned account-creation/binding source after it records the
 * authenticated creator and explicit registration/grants. No user-supplied actor,
 * scope, credential or permission is accepted at this command boundary.
 */
export async function provisionRegisteredAccount(input: RegisteredAccountProvisionInput): Promise<CoreResult<CoreProvisionReceipt>> {
  let resources: CustodyResources | undefined;
  try {
    if (process.getuid?.() !== 0) return { ok: false, error: { code: "unavailable", message: "Account registration provisioning requires the owning root operation" } };
    const config = parseCoreConfig(ownerDocument(input.configPath));
    if (!config.ok) return config;
    const document = ownerDocument(input.registrationPath) as { version: number; registration: CoreProvisionRegistration };
    if (!document || document.version !== 1 || !document.registration || Object.keys(document).some(key => !["version", "registration"].includes(key))) return { ok: false, error: { code: "invalid-config", message: "Explicit versioned account creation registration is required" } };
    const registration = document.registration;
    const scope = config.value.scopes.find(scope => scope.id === registration.scope?.id);
    if (!scope || !isDeepStrictEqual(scope, registration.scope)) return { ok: false, error: { code: "invalid-config", message: "Account creation registration must exactly match its owner-configured scope" } };
    if (scope.availability.kind !== "adopt") return { ok: false, error: { code: "unavailable", message: "Account registration cannot unlock locked or inactive storage" } };
    if (!registration.images || !["none", "fresh"].includes(registration.images.kind)) return { ok: false, error: { code: "invalid-config", message: "Account registration must explicitly declare image provisioning" } };
    if (registration.images.kind === "fresh" && (config.value.images.kind !== "configured" || !config.value.images.registries.some(spec => isDeepStrictEqual(spec, registration.images.kind === "fresh" ? registration.images.registry : null)))) return { ok: false, error: { code: "invalid-config", message: "Fresh image registration must exactly match its owner-configured registry" } };
    if (registration.images.kind === "none" && config.value.images.kind === "configured" && config.value.images.registries.some(spec => spec.scopeId === scope.id)) return { ok: false, error: { code: "invalid-config", message: "A configured new account image registry requires explicit fresh provisioning" } };
    const resourcesForGrant = [registration.operation, scope.resource, ...(registration.images.kind === "fresh" ? [registration.images.registry.dataResource] : [])];
    const ancestor = dirname(registration.directory);
    if (!scope.resources.some(resource => resource.kind === "directory" && resource.path === ancestor)) return { ok: false, error: { code: "invalid-config", message: "Fresh storage parent must be an explicitly registered directory" } };
    resources = new CustodyResources(scope.custody);
    const namespace = scope.custody.namespace;
    const namespaceInode = namespace.kind === "host" ? statSync("/proc/1/ns/mnt", { bigint: true }).ino.toString() : namespace.mountNamespaceInode;
    const principalIds = new Set([registration.creatorPrincipalId, scope.principalId]);
    const payload: ProvisionWorkerInput = { registration, input: { registrationId: registration.id, requestId: input.requestId }, actor: registration.creatorPrincipalId, namespaceInode,
      principals: config.value.principals.filter(principal => principalIds.has(principal.id)),
      policy: { revision: config.value.policy.revision,
        grants: config.value.policy.grants.filter(grant => {
          const selector = grant.resource;
          return principalIds.has(grant.principal) && (selector.kind === "exact" ? resourcesForGrant.some(resource => resource.id === selector.id)
            : resourcesForGrant.some(resource => resource.owner === selector.owner && resource.kind === selector.resourceKind));
        }),
        consents: config.value.policy.consents.filter(consent => principalIds.has(consent.principal) && resourcesForGrant.some(resource => resource.id === consent.resource)) },
    };
    const worker = fileURLToPath(new URL(import.meta.url.endsWith(".ts") ? "./provision-worker.ts" : "./provision-worker.js", import.meta.url));
    const command = resources.launch([process.execPath, worker]);
    const child = spawnSync(command[0]!, command.slice(1), { input: JSON.stringify(payload), encoding: "utf8", env: { PATH: "/usr/local/bin:/usr/bin:/bin", LANG: "C" }, timeout: 15_000, maxBuffer: 2_000_000 });
    if (child.error || child.signal) return { ok: false, error: { code: "unavailable", message: "Account preparation acknowledgement is uncertain; recover the same registration/request, never replace storage" } };
    const result = JSON.parse(child.stdout) as CoreResult<CoreProvisionReceipt>;
    if (typeof result?.ok !== "boolean" || result.ok && (child.status !== 0 || !isDeepStrictEqual(result.value?.scope, scope) || result.value.managerThreadId !== (scope.manager.kind === "existing" ? scope.manager.threadId : null))) throw new Error("Invalid account owner preparation receipt");
    return result;
  } catch (cause) {
    return { ok: false, error: { code: "io", message: `Account creation registration unavailable: ${cause instanceof Error ? cause.message : String(cause)}` } };
  } finally { resources?.close(); }
}

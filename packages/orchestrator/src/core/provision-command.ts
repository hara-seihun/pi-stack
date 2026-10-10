import { closeSync, constants, existsSync, fstatSync, openSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, resolve, sep } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { parseCoreConfig, type CoreResult } from "./config.js";
import { CustodyResources } from "./custody-resources.js";
import { CoreProvisioner, type CoreProvisionRegistration, type CoreProvisionReceipt } from "./provision.js";

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
    const ancestor = dirname(registration.directory);
    if (!scope.resources.some(resource => resource.kind === "directory" && resource.path === ancestor)) return { ok: false, error: { code: "invalid-config", message: "Fresh storage parent must be an explicitly registered directory" } };
    resources = new CustodyResources(scope.custody);
    const custody = resources;
    const exact = new Set([registration.directory, ancestor, registration.manager.cwd, ...Object.values(scope.storage)]);
    const provisioner = new CoreProvisioner([registration], { principals: config.value.principals, policy: config.value.policy, path(_scope, logical) {
      custody.assert();
      if (!isAbsolute(logical) || resolve(logical) !== logical || !exact.has(logical)) throw new Error("Unregistered fresh account resource");
      let existing = logical;
      while (!existsSync(existing)) existing = dirname(existing);
      const visible = statSync(existing, { bigint: true }), registered = statSync(custody.directory(existing), { bigint: true });
      if (visible.dev !== registered.dev || visible.ino !== registered.ino) throw new Error("Account storage is not mounted in its registered namespace view");
      const root = logical === registration.manager.cwd ? registration.manager.cwd : ancestor;
      const actual = realpathSync(existing), realRoot = realpathSync(root);
      if (actual !== realRoot && !actual.startsWith(realRoot + sep)) throw new Error("Fresh account path escapes its registered ancestor");
      return logical;
    } });
    return await provisioner.provision({ registrationId: registration.id, requestId: input.requestId }, registration.creatorPrincipalId);
  } catch (cause) {
    return { ok: false, error: { code: "io", message: `Account creation registration unavailable: ${cause instanceof Error ? cause.message : String(cause)}` } };
  } finally { resources?.close(); }
}

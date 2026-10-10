import { readFileSync, existsSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import type { PermissionPolicy, Principal } from "../permissions.js";
import type { CoreResult } from "./config.js";
import { CoreProvisioner, type CoreProvisionInput, type CoreProvisionRegistration, type CoreProvisionReceipt } from "./provision.js";

export type ProvisionWorkerInput = {
  registration: CoreProvisionRegistration;
  principals: Principal[];
  policy: PermissionPolicy;
  input: CoreProvisionInput;
  actor: string;
  namespaceInode: string;
};
/** Finite schema/receipt preparation as the person's Unix identity, not a runner.
 * The root registration command owns launching and authorizing this process.
 */
export async function prepareRegisteredStorage(input: ProvisionWorkerInput): Promise<CoreResult<CoreProvisionReceipt>> {
  try {
    const { registration } = input;
    if (statSync("/proc/self/ns/mnt", { bigint: true }).ino.toString() !== input.namespaceInode) return { ok: false, error: { code: "ownership-conflict", message: "Provision worker is outside the owning namespace" } };
    const scope = registration.scope, ancestor = dirname(registration.directory);
    const markdown = registration.markdown.kind === "configured" ? registration.markdown.folder : undefined;
    const exact = new Set([registration.directory, ancestor, registration.manager.cwd, ...Object.values(scope.storage), ...(markdown ? [markdown, `${markdown}/README.md`, `${markdown}/AGENTS.md`] : [])]);
    const provisioner = new CoreProvisioner([registration], { principals: input.principals, policy: input.policy, path(_scope, logical) {
      if (!isAbsolute(logical) || resolve(logical) !== logical || !exact.has(logical)) throw new Error("Unregistered fresh account resource");
      let existing = logical;
      while (!existsSync(existing)) existing = dirname(existing);
      const root = markdown && (logical === markdown || dirname(logical) === markdown) ? markdown : logical === registration.manager.cwd ? registration.manager.cwd : ancestor;
      const actual = realpathSync(existing), realRoot = realpathSync(root);
      if (actual !== realRoot && !actual.startsWith(realRoot + sep)) throw new Error("Fresh account path escapes its registered ancestor");
      return logical;
    } });
    return await provisioner.provision(input.input, input.actor);
  } catch (cause) { return { ok: false, error: { code: "io", message: `Account owner preparation failed: ${cause instanceof Error ? cause.message : String(cause)}` } }; }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const text = readFileSync(0, "utf8");
    if (text.length > 2_000_000) throw new Error("Provision registration exceeds bounded input");
    const result = await prepareRegisteredStorage(JSON.parse(text));
    process.stdout.write(JSON.stringify(result));
    if (!result.ok) process.exitCode = 1;
  } catch { process.stdout.write(JSON.stringify({ ok: false, error: { code: "invalid-config", message: "Malformed owning account provision payload" } })); process.exitCode = 1; }
}

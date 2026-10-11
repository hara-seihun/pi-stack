import { createHash } from "node:crypto";
import { types } from "node:util";

export const residentShellProtocol = "resident-local-shell-v1";
export const shellFunctionHash = fn => createHash("sha256").update(Function.prototype.toString.call(fn)).digest("hex");
const failure = (code, message) => ({ ok: false, error: { code, message } });

// Operation objects are the retained tool's lexical bindings, not reconstructed tools.
// Existing executions retain their captured function and original cancellation owner.
export function adoptResidentLocalShells(plan) {
  if (!plan || typeof plan !== "object" || types.isProxy(plan)) return failure("invalid-plan", "An explicit resident local-shell plan is required");
  const { protocol, entries, factory, factorySha256 } = plan;
  if (protocol !== residentShellProtocol || !Array.isArray(entries) || entries.length === 0)
    return failure("invalid-plan", "An explicit nonempty resident local-shell plan is required");
  if (typeof factory !== "function" || !/^[a-f0-9]{64}$/.test(factorySha256) || shellFunctionHash(factory) !== factorySha256)
    return failure("candidate-mismatch", "Candidate shell factory differs from the sealed source");
  const changes = [], seen = new Set();
  for (const entry of entries) {
    if (entry?.kind !== "local-shell" || typeof entry.id !== "string" || !entry.id ||
        typeof entry.shellName !== "string" || !entry.shellName || typeof entry.resolveShellConfig !== "function" ||
        !/^[a-f0-9]{64}$/.test(entry.expectedExecSha256))
      return failure("invalid-plan", "Every local shell requires its identity, predecessor hash and original shell configuration binding");
    const operations = entry.operations;
    if (!operations || types.isProxy(operations) || ![Object.prototype, null].includes(Object.getPrototypeOf(operations)) || seen.has(operations))
      return failure("invalid-target", `Operation identity is invalid or repeated: ${entry.id}`);
    seen.add(operations);
    const before = Object.getOwnPropertyDescriptor(operations, "exec");
    if (typeof before?.value !== "function" || !before.writable || shellFunctionHash(before.value) !== entry.expectedExecSha256)
      return failure("predecessor-conflict", `Resident local exec differs from approved predecessor: ${entry.id}`);
    let candidate;
    try { candidate = factory(entry.shellName, entry.resolveShellConfig); }
    catch (error) { return failure("candidate-failed", String(error)); }
    if (!candidate || typeof candidate !== "object" || types.isProxy(candidate)) return failure("candidate-failed", `Candidate operations are invalid: ${entry.id}`);
    const next = Object.getOwnPropertyDescriptor(candidate, "exec");
    if (typeof next?.value !== "function") return failure("candidate-failed", `Candidate has no local exec: ${entry.id}`);
    changes.push({ operations, before, exec: next.value, id: entry.id });
  }
  // No await, user callbacks or process effects occur between validation and CAS.
  for (const change of changes) {
    const current = Object.getOwnPropertyDescriptor(change.operations, "exec");
    if (!current || current.value !== change.before.value || current.writable !== change.before.writable ||
        current.configurable !== change.before.configurable || current.enumerable !== change.before.enumerable)
      return failure("predecessor-conflict", `Resident changed during preflight: ${change.id}`);
  }
  for (const change of changes) Object.defineProperty(change.operations, "exec", { ...change.before, value: change.exec });
  return { ok: true, value: { protocol: residentShellProtocol, factorySha256,
    installed: changes.map(change => ({ id: change.id, predecessorSha256: shellFunctionHash(change.before.value), execSha256: shellFunctionHash(change.exec) })) } };
}

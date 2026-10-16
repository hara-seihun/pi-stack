import { createHash } from "node:crypto";
import { types } from "node:util";
import { inspectWrite, localFileSize, requireWriteInspection } from "./file-write-guard.mjs";

export const residentWriteProtocol = "resident-local-write-v1";
export const writeFunctionHash = fn => createHash("sha256").update(Function.prototype.toString.call(fn)).digest("hex");
const failure = (code, message) => ({ ok: false, error: { code, message } });
const installed = new WeakMap();

export function adoptResidentLocalWrites(plan) {
  if (!plan || types.isProxy(plan) || plan.protocol !== residentWriteProtocol || !Array.isArray(plan.entries) || plan.entries.length === 0)
    return failure("invalid-plan", "An explicit nonempty resident local-write plan is required");
  const changes = [], seen = new Set();
  for (const entry of plan.entries) {
    if (entry?.kind !== "local-write" || typeof entry.id !== "string" || !entry.id || !/^[a-f0-9]{64}$/.test(entry.expectedWriteSha256))
      return failure("invalid-plan", "Every write target needs identity and approved local predecessor hash");
    const operations = entry.operations;
    if (!operations || types.isProxy(operations) || ![Object.prototype, null].includes(Object.getPrototypeOf(operations)) || seen.has(operations))
      return failure("invalid-target", `Invalid or repeated operation identity: ${entry.id}`);
    seen.add(operations);
    const before = Object.getOwnPropertyDescriptor(operations, "writeFile");
    if (typeof before?.value !== "function" || !before.writable)
      return failure("invalid-target", `writeFile is not an own writable function: ${entry.id}`);
    const previous = installed.get(operations);
    if (previous?.guard === before.value && previous.predecessor === entry.expectedWriteSha256) {
      changes.push({ id: entry.id, operations, before, guard: before.value, alreadyInstalled: true });
      continue;
    }
    if (writeFunctionHash(before.value) !== entry.expectedWriteSha256)
      return failure("predecessor-conflict", `Resident local write differs from approved predecessor: ${entry.id}`);
    const original = before.value;
    const guard = async function(path, content) {
      requireWriteInspection(await inspectWrite(path, content, undefined, localFileSize));
      return original.call(this, path, content);
    };
    changes.push({ id: entry.id, operations, before, guard, predecessor: entry.expectedWriteSha256, alreadyInstalled: false });
  }
  for (const change of changes) {
    const current = Object.getOwnPropertyDescriptor(change.operations, "writeFile");
    if (!current || current.value !== change.before.value || current.writable !== change.before.writable ||
        current.configurable !== change.before.configurable || current.enumerable !== change.before.enumerable)
      return failure("predecessor-conflict", `Resident changed during preflight: ${change.id}`);
  }
  for (const change of changes) if (!change.alreadyInstalled) {
    Object.defineProperty(change.operations, "writeFile", { ...change.before, value: change.guard });
    installed.set(change.operations, { guard: change.guard, predecessor: change.predecessor });
  }
  return { ok: true, value: { protocol: residentWriteProtocol, installed: changes.map(change => ({ id: change.id,
    writeSha256: writeFunctionHash(change.guard), alreadyInstalled: change.alreadyInstalled })) } };
}

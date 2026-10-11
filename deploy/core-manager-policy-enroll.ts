#!/usr/bin/env bun
import { createHash, randomBytes } from "node:crypto";
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { managerPolicyAuthority, managerNoticeCapability, parseManagerPolicyBinding, type ManagerPolicyBinding } from "../apps/remote/server/canonical-manager-policy";

import { managerContextCapability } from "../apps/remote/server/canonical-manager-context";

const STORE = "/etc/pi-stack/canonical-manager-policy.json", ROOT = "/etc/pi-stack/manager-policy";
function guarded(path: string) {
  const s = lstatSync(path); if (!s.isFile() || s.uid !== 0 || (s.mode & 0o777) !== 0o600 || s.size > 65536) throw new Error("Protected root-owned 0600 enrollment file required");
  return readFileSync(path, "utf8");
}
function write(path: string, body: string) { const fd = openSync(path, "wx", 0o600); try { writeFileSync(fd, body); fsyncSync(fd); } finally { closeSync(fd); } }
function same(a: unknown, b: unknown): boolean { return isDeepStrictEqual(a, b); }
function replace(path: string, value: unknown) {
  const temporary = `${path}.${process.pid}.tmp`; write(temporary, JSON.stringify(value, null, 2) + "\n"); renameSync(temporary, path);
  const fd = openSync(path.slice(0, path.lastIndexOf("/")), "r"); try { fsyncSync(fd); } finally { closeSync(fd); }
}
function amendOrigin(plan: Record<string, unknown>) {
  if (Object.keys(plan).sort().join(",") !== ["version", "id", "source", "target", "origin", "previousOrigin", "credentialSha256"].sort().join(",") || typeof plan.id !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/.test(plan.id)) throw new Error("Exact same-identity origin amendment plan required");
  const directory = `${ROOT}/${plan.id}`, path = `${directory}/binding.json`;
  const before = parseManagerPolicyBinding(JSON.parse(guarded(path))); if (!before.ok) throw new Error(before.error.message);
  const { previousOrigin, ...input } = plan;
  const after = parseManagerPolicyBinding({ ...input, direction: before.value.direction, credentialFile: before.value.credentialFile }); if (!after.ok) throw new Error(after.error.message);
  const original = { ...after.value, origin: previousOrigin };
  if (!parseManagerPolicyBinding(original).ok || !(same(before.value, original) || same(before.value, after.value))) throw new Error("Origin amendment cannot alter enrolled identities or authority");
  const token = guarded(after.value.credentialFile).trim(); if (!/^[a-f0-9]{64}$/.test(token) || createHash("sha256").update(token).digest("hex") !== after.value.credentialSha256) throw new Error("Original enrolled credential required");
  if ((after.value.direction === "outgoing" ? after.value.source.host : after.value.target.host) !== hostname()) throw new Error("Origin amendment names another host");
  const authority = managerPolicyAuthority(JSON.parse(readFileSync("/etc/pi-stack/core.json", "utf8")), after.value); if (!authority.ok) throw new Error(authority.error.message);
  const store = JSON.parse(guarded(STORE));
  if (!store || store.version !== 1 || !Array.isArray(store.bindings) || Object.keys(store).sort().join(",") !== "bindings,version" || store.bindings.some((b: unknown) => !parseManagerPolicyBinding(b).ok)) throw new Error("Protected binding store invalid");
  const selected = store.bindings.filter((b: ManagerPolicyBinding) => b.id === after.value.id);
  if (selected.length !== 1 || !(same(selected[0], original) || same(selected[0], after.value))) throw new Error("Origin amendment conflicts with protected route");
  const intent = `${directory}/origin-amendment.json`, record = { version: 1, before: original, after: after.value };
  if (existsSync(intent)) { if (!same(JSON.parse(guarded(intent)), record)) throw new Error("Another origin amendment owns this route"); }
  else replace(intent, record);
  if (!same(selected[0], after.value)) replace(STORE, { ...store, bindings: store.bindings.map((b: ManagerPolicyBinding) => b.id === after.value.id ? after.value : b) });
  if (!same(before.value, after.value)) replace(path, after.value);
  console.log(JSON.stringify({ state: "origin-amended", binding: after.value, previousOrigin, credentialChanged: false, managerIdentityChanged: false, uiGrantsChanged: false, runtimeLifecycle: false }));
}
async function main() {
  if (process.getuid?.() !== 0) throw new Error("Manager-policy enrollment requires the host owner");
  if (process.env.PI_MANAGER_POLICY_ENROLLMENT_LOCK !== "held") {
    const locked = spawnSync("/usr/bin/flock", ["--nonblock", "/etc/pi-stack/manager-policy-enrollment.lock", process.execPath, fileURLToPath(import.meta.url), ...process.argv.slice(2)], { env: { ...process.env, PI_MANAGER_POLICY_ENROLLMENT_LOCK: "held" }, stdio: "inherit" });
    if (locked.error || locked.status === null) throw new Error("Enrollment lock or worker unavailable");
    process.exitCode = locked.status; return;
  }
  const [action, planPath, ...rest] = process.argv.slice(2);
  if (action === "enable-notices" || action === "enable-context") {
    if (!planPath || rest.length !== (action === "enable-context" ? 1 : 0) || !/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/.test(planPath)) throw new Error("Use enable-notices ID or enable-context ID RECIPROCAL_LOOPBACK_ORIGIN");
    const directory = `${ROOT}/${planPath}`;
    const parsed = parseManagerPolicyBinding(JSON.parse(guarded(`${directory}/binding.json`)));
    if (!parsed.ok) throw new Error(parsed.error.message);
    const binding = parsed.value;
    if ((binding.direction === "outgoing" ? binding.source.host : binding.target.host) !== hostname()) throw new Error("Notice enrollment names another host");
    const authority = managerPolicyAuthority(JSON.parse(readFileSync("/etc/pi-stack/core.json", "utf8")), binding);
    if (!authority.ok) throw new Error(authority.error.message);
    const store = JSON.parse(guarded(STORE));
    const selected = store.bindings?.filter((row: ManagerPolicyBinding) => row.id === binding.id);
    if (!selected || selected.length !== 1 || !same(selected[0], binding)) throw new Error("Exact current protected route required");
    const token = guarded(binding.credentialFile).trim();
    if (!/^[a-f0-9]{64}$/.test(token) || createHash("sha256").update(token).digest("hex") !== binding.credentialSha256) throw new Error("Original enrolled credential required");
    const context = action === "enable-context" ? managerContextCapability(binding, rest[0]!) : null;
    if (context && !context.ok) throw new Error(context.error.message);
    const path = `${directory}/${action === "enable-context" ? "context" : "notices"}.json`, capability = context?.ok ? context.value : managerNoticeCapability(binding);
    if (existsSync(path)) { if (!same(JSON.parse(guarded(path)), capability)) throw new Error("Notice capability identity changed"); }
    else replace(path, capability);
    console.log(JSON.stringify({ state: action === "enable-context" ? "context-enrolled" : "notices-enrolled", id: binding.id, direction: binding.direction, managerThreadId: binding.target.managerThreadId, uiGrantsChanged: false, credentialChanged: false }));
    return;
  }
  if (action === "amend-origin") {
    if (!planPath || rest.length) throw new Error("Use amend-origin PLAN");
    amendOrigin(JSON.parse(readFileSync(planPath, "utf8"))); return;
  }
  if (!["source", "target", "export-credential"].includes(action ?? "") || !planPath || rest.length !== (action === "target" ? 1 : 0) || action === "target" && rest[0] !== "--credential-stdin") throw new Error("Use source PLAN, target PLAN --credential-stdin, or export-credential PLAN");
  const plan: Record<string, unknown> = JSON.parse(readFileSync(planPath, "utf8"));
  if (!plan || Array.isArray(plan) || Object.keys(plan).sort().join(",") !== ["version", "id", "source", "target", "origin", ...(action === "target" || action === "export-credential" ? ["credentialSha256"] : [])].sort().join(",")) throw new Error("Exact source/target enrollment plan required");
  if (typeof plan.id !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/.test(plan.id)) throw new Error("Enrollment id must be one exact path component");
  const directory = `${ROOT}/${plan.id}`, tokenPath = `${directory}/token`;
  const existing = existsSync(`${directory}/binding.json`) ? JSON.parse(guarded(`${directory}/binding.json`)) : undefined;
  let token: string;
  if (action === "target") {
    let input = ""; for await (const chunk of process.stdin) { input += chunk; if (input.length > 65) throw new Error("Credential stdin must contain exactly one enrolled 32-byte token"); }
    token = input.trim(); if (!/^[a-f0-9]{64}$/.test(token)) throw new Error("Exact enrolled token required");
  } else if (existing !== undefined) token = guarded(tokenPath).trim();
  else if (action === "source") token = randomBytes(32).toString("hex");
  else throw new Error("Existing outgoing enrollment required; export cannot create a credential");
  const sha = createHash("sha256").update(token).digest("hex");
  if (plan.credentialSha256 !== undefined && plan.credentialSha256 !== sha) throw new Error("Credential identity differs from the declared source enrollment");
  const candidate = { ...plan, credentialSha256: sha, credentialFile: tokenPath, direction: action === "target" ? "incoming" : "outgoing" };
  const parsed = parseManagerPolicyBinding(candidate); if (!parsed.ok) throw new Error(parsed.error.message);
  const binding = parsed.value, host = binding.direction === "outgoing" ? binding.source.host : binding.target.host;
  if (host !== hostname()) throw new Error("Enrollment names another host");
  const coreRaw = readFileSync("/etc/pi-stack/core.json", "utf8"), authority = managerPolicyAuthority(JSON.parse(coreRaw), binding);
  if (!authority.ok) throw new Error(authority.error.message);
  if (existing !== undefined && !same(existing, binding)) throw new Error("Existing enrollment identity differs; no replacement occurred");
  if (action === "export-credential") { process.stdout.write(token); return; }
  mkdirSync(ROOT, { recursive: true, mode: 0o700 });
  const root = lstatSync(ROOT); if (!root.isDirectory() || root.uid !== 0 || (root.mode & 0o777) !== 0o700) throw new Error("Enrollment root requires root-owned 0700 custody");
  if (existing === undefined) {
    const temp = mkdtempSync(`${ROOT}/.enroll-`);
    try {
      write(`${temp}/binding.json`, JSON.stringify(binding) + "\n"); write(`${temp}/token`, token);
      const staged = openSync(temp, "r"); try { fsyncSync(staged); } finally { closeSync(staged); }
      renameSync(temp, directory);
      const parent = openSync(ROOT, "r"); try { fsyncSync(parent); } finally { closeSync(parent); }
    }
    finally { if (existsSync(temp)) rmSync(temp, { recursive: true }); }
  } else if (guarded(tokenPath).trim() !== token) throw new Error("Existing credential differs; no replacement occurred");
  const store: { version: number; bindings: ManagerPolicyBinding[] } = existsSync(STORE) ? JSON.parse(guarded(STORE)) : { version: 1, bindings: [] };
  if (store.version !== 1 || !Array.isArray(store.bindings) || Object.keys(store).sort().join(",") !== "bindings,version") throw new Error("Existing policy store is invalid");
  for (const row of store.bindings) if (!parseManagerPolicyBinding(row).ok) throw new Error("Existing binding is invalid");
  const previous = store.bindings.find(row => row.id === binding.id);
  if (previous && !same(previous, binding)) throw new Error("Enrolled route differs; no authority replacement occurred");
  if (!previous) {
    store.bindings.push(binding); const temporary = `${STORE}.${process.pid}.tmp`; write(temporary, JSON.stringify(store, null, 2) + "\n"); renameSync(temporary, STORE);
    const fd = openSync("/etc/pi-stack", "r"); try { fsyncSync(fd); } finally { closeSync(fd); }
  }
  console.log(JSON.stringify({ state: "enrolled", binding, coreConfigSha256: createHash("sha256").update(coreRaw).digest("hex"), uiGrantsChanged: false, managerIdentityChanged: false, runtimeLifecycle: false }));
}
main().catch(error => { console.log(JSON.stringify({ state: "refused", error: error instanceof Error ? error.message : "Enrollment failed", secretOutput: false })); process.exitCode = 1; });

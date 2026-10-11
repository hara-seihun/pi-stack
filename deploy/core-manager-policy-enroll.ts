#!/usr/bin/env bun
import { createHash, randomBytes } from "node:crypto";
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { managerPolicyAuthority, parseManagerPolicyBinding, type ManagerPolicyBinding } from "../apps/remote/server/canonical-manager-policy";

const STORE = "/etc/pi-stack/canonical-manager-policy.json", ROOT = "/etc/pi-stack/manager-policy";
function guarded(path: string) {
  const s = lstatSync(path); if (!s.isFile() || s.uid !== 0 || (s.mode & 0o777) !== 0o600 || s.size > 65536) throw new Error("Protected root-owned 0600 enrollment file required");
  return readFileSync(path, "utf8");
}
function write(path: string, body: string) { const fd = openSync(path, "wx", 0o600); try { writeFileSync(fd, body); fsyncSync(fd); } finally { closeSync(fd); } }
function same(a: unknown, b: unknown): boolean { return isDeepStrictEqual(a, b); }
async function main() {
  if (process.getuid?.() !== 0) throw new Error("Manager-policy enrollment requires the host owner");
  if (process.env.PI_MANAGER_POLICY_ENROLLMENT_LOCK !== "held") {
    const locked = spawnSync("/usr/bin/flock", ["--nonblock", "/etc/pi-stack/manager-policy-enrollment.lock", process.execPath, fileURLToPath(import.meta.url), ...process.argv.slice(2)], { env: { ...process.env, PI_MANAGER_POLICY_ENROLLMENT_LOCK: "held" }, stdio: "inherit" });
    if (locked.error || locked.status === null) throw new Error("Enrollment lock or worker unavailable");
    process.exitCode = locked.status; return;
  }
  const [action, planPath, ...rest] = process.argv.slice(2);
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

#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, renameSync, openSync, fsyncSync, closeSync, mkdirSync } from "node:fs";
import { dirname, join, isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

const digest = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const requireValue = (condition, message) => { if (!condition) throw new Error(message); };
const names = values => [...values].sort().join("\n");
export function validatePlan(plan, owners) {
  requireValue(plan?.version === 1 && typeof plan.barrierId === "string" && plan.barrierId && /^[a-f0-9]{40}$/.test(plan.releaseCommit), "Explicit barrier identity and immutable release commit required");
  requireValue(isAbsolute(plan.stateDir ?? "") && Array.isArray(plan.hosts) && plan.hosts.length > 0, "Absolute state directory and every host required");
  requireValue(new Set(plan.hosts.map(host => host.id)).size === plan.hosts.length, "Duplicate bootstrap host");
  requireValue(names(plan.hosts.map(host => host.id)) === names(new Set(owners.map(owner => owner.host))), "Bootstrap must cover every configured authority host");
  for (const host of plan.hosts) for (const operation of ["gate", "verify", "census", "doctors", "restore"]) {
    const command = host[operation];
    requireValue(command && isAbsolute(command.command ?? "") && Array.isArray(command.args) && command.args.every(arg => typeof arg === "string")
      && isAbsolute(command.cwd ?? "") && Number.isSafeInteger(command.timeoutMs) && command.timeoutMs > 0 && command.timeoutMs <= 50_000,
    `${host.id} ${operation} needs an explicit executable, argv, cwd and <=50s deadline`);
  }
}
export function validateBarrier(plan, host, receipt, owners) {
  requireValue(receipt?.version === 1 && receipt.barrierId === plan.barrierId && receipt.host === host.id && receipt.releaseCommit === plan.releaseCommit, `${host.id}: barrier identity/release mismatch`);
  requireValue(Array.isArray(receipt.oldControllers) && receipt.oldControllers.length === 0, `${host.id}: old controllers can still admit work`);
  const direct = receipt.directIngress;
  requireValue(direct?.cli === "managed" && direct.sdk === "managed" && direct.root === "idle-managed", `${host.id}: agent launchers/root have not selected managed execution`);
  requireValue(direct.evidence?.releaseCommit === plan.releaseCommit, `${host.id}: managed ingress release evidence missing`);
  const expected = owners.filter(owner => owner.host === host.id).map(owner => owner.id);
  requireValue(Array.isArray(receipt.owners) && receipt.owners.length === expected.length && names(receipt.owners.map(owner => owner.ownerId)) === names(expected), `${host.id}: barrier does not cover every configured owner`);
  for (const owner of receipt.owners) {
    requireValue(["gated", "inactive"].includes(owner.state) && owner.coverage === "complete" && Array.isArray(owner.unavailableSources) && owner.unavailableSources.length === 0,
      `${host.id}/${owner.ownerId}: census coverage unavailable: ${(owner.unavailableSources ?? []).join(", ")}`);
  }
  return receipt;
}
function validateCensuses(plan, censuses, owners) {
  const entries = [], covered = [];
  for (const host of plan.hosts) {
    const census = censuses[host.id];
    requireValue(census?.version === 1 && census.barrierId === plan.barrierId && Array.isArray(census.hosts) && census.hosts.length === 1
      && census.hosts[0].host === host.id && Number.isFinite(Date.parse(census.hosts[0].capturedAt)), `${host.id}: invalid barrier census`);
    requireValue(names(census.hosts[0].owners ?? []) === names(owners.filter(owner => owner.host === host.id).map(owner => owner.id)), `${host.id}: missing census owner`);
    requireValue(Array.isArray(census.entries), `${host.id}: missing execution census`);
    for (const entry of census.entries) requireValue(typeof entry.agentId === "string" && entry.agentId && typeof entry.executionId === "string" && entry.executionId
      && typeof entry.source === "string" && typeof entry.uncertain === "boolean" && owners.some(owner => owner.host === host.id && owner.id === entry.ownerId), `${host.id}: invalid execution custody`);
    entries.push(...census.entries); covered.push(...census.hosts);
  }
  requireValue(new Set(entries.map(entry => entry.agentId)).size === entries.length && new Set(entries.map(entry => entry.executionId)).size === entries.length, "Overlapping native execution custody; cutover remains closed");
  requireValue(entries.length <= 100, `Initial census overcapacity ${entries.length}/100; preserve native work and recapture after natural settlement`);
  return { version: 1, barrierId: plan.barrierId, hosts: covered, entries };
}

/** One durable phase per invocation. Failure retains sealed ingress; never reopen old producers as rollback. */
export async function advanceBootstrap(plan, ledger, dependencies) {
  const { owners, snapshot, initialize, reconcile, run, save } = dependencies;
  validatePlan(plan, owners);
  requireValue(ledger.version === 1 && ledger.planHash === digest(plan), "Bootstrap plan changed after custody acceptance");
  const verify = async () => {
    for (const host of plan.hosts) { ledger.gates[host.id] = validateBarrier(plan, host, await run(host.verify), owners); save(ledger); }
  };
  switch (ledger.phase) {
    case "unprepared":
      requireValue(!snapshot().initialized, "Authority already initialized without this bootstrap's custody; do not reseed");
      for (const host of plan.hosts) {
        await run(host.gate);
        const receipt = validateBarrier(plan, host, await run(host.verify), owners);
        ledger.gates[host.id] = receipt; save(ledger);
      }
      ledger.phase = "gated"; break;
    case "gated":
      requireValue(!snapshot().initialized, "Authority initialized before the all-owner census");
      await verify();
      for (const host of plan.hosts) { ledger.censuses[host.id] = await run(host.census); save(ledger); }
      ledger.census = validateCensuses(plan, ledger.censuses, owners);
      ledger.phase = "censused"; break;
    case "censused":
    case "initializing": {
      await verify();
      validateCensuses(plan, ledger.censuses, owners);
      if (snapshot().initialized) {
        requireValue(ledger.phase === "initializing" && ledger.initializationIntent === digest(ledger.census), "Unexpected authority initialization; cutover remains sealed");
        requireValue(reconcile(ledger.census.entries), "Authority cannot reconcile the seeded execution identities");
      } else {
        ledger.initializationIntent = digest(ledger.census); ledger.phase = "initializing"; save(ledger);
        const result = initialize(ledger.census.entries);
        requireValue(result.ok, result.ok ? "" : result.error.message);
      }
      requireValue(snapshot().initialized && snapshot().active <= 100, "Authority did not accept bounded census");
      ledger.phase = "initialized"; break;
    }
    case "initialized":
      requireValue(snapshot().initialized && snapshot().active <= 100, "Initialized bounded authority required before model doctors");
      await verify();
      for (const host of plan.hosts) await run(host.doctors);
      ledger.phase = "proved"; break;
    case "proved":
      await verify();
      requireValue(snapshot().initialized && snapshot().active <= 100, "Capacity authority unavailable before restoring ingress");
      for (const host of plan.hosts) await run(host.restore);
      ledger.phase = "opened"; break;
    case "opened": return ledger;
    default: throw new Error(`Unknown bootstrap phase ${ledger.phase}`);
  }
  save(ledger); return ledger;
}
export function newBootstrapLedger(plan) { return { version: 1, planHash: digest(plan), phase: "unprepared", gates: {}, censuses: {} }; }
function atomicWrite(path, value) {
  const temporary = `${path}.${process.pid}.tmp`, fd = openSync(temporary, "wx", 0o600);
  try { writeFileSync(fd, JSON.stringify(value, null, 2) + "\n"); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(temporary, path);
  const directory = openSync(dirname(path), "r"); try { fsyncSync(directory); } finally { closeSync(directory); }
}
async function main(args) {
  requireValue(args.length === 2 && ["advance", "status"].includes(args[0]) && isAbsolute(args[1]), "Usage: deploy/capacity-bootstrap advance|status /absolute/PLAN.json");
  const plan = JSON.parse(readFileSync(args[1], "utf8"));
  requireValue(isAbsolute(plan.authorityModule ?? "") && isAbsolute(plan.authorityConfig ?? ""), "Absolute compiled authority module and configuration required");
  const { AgentCapacityAuthority, readAgentCapacityAuthorityConfig } = await import(pathToFileURL(plan.authorityModule).href);
  const config = readAgentCapacityAuthorityConfig(plan.authorityConfig);
  validatePlan(plan, config.owners);
  mkdirSync(plan.stateDir, { recursive: true, mode: 0o700 });
  const path = join(plan.stateDir, "bootstrap.json");
  let ledger;
  try { ledger = JSON.parse(readFileSync(path, "utf8")); } catch (error) { if (error.code !== "ENOENT") throw error; ledger = newBootstrapLedger(plan); atomicWrite(path, ledger); }
  if (args[0] === "status") { console.log(JSON.stringify(ledger)); return; }
  const authority = new AgentCapacityAuthority(config.databasePath);
  try {
    await advanceBootstrap(plan, ledger, {
      owners: config.owners, snapshot: () => authority.status(), initialize: entries => authority.initialize(entries),
      reconcile: entries => entries.every(entry => { const observed = authority.inspect(entry.ownerId, entry); return observed.ok && ["active", "released"].includes(observed.value.state); }),
      save: value => atomicWrite(path, value),
      run: async command => {
        const result = spawnSync(command.command, command.args, { cwd: command.cwd, timeout: command.timeoutMs, encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
        requireValue(!result.error && result.status === 0, `Bootstrap host command failed (${result.error?.code ?? result.status}); barrier retained: ${result.stderr?.slice(-3000) ?? ""}`);
        requireValue(result.stdout?.trim(), "Bootstrap command omitted its explicit JSON receipt");
        return JSON.parse(result.stdout);
      },
    });
    console.log(JSON.stringify({ barrierId: plan.barrierId, phase: ledger.phase, authority: authority.status() }));
  } finally { authority.close(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main(process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 1; });

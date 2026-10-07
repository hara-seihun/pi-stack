#!/usr/bin/env node
import { readFileSync, writeFileSync, mkdirSync, renameSync, openSync, fsyncSync, closeSync } from "node:fs";
import { dirname, join, isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

const need = (condition, message) => { if (!condition) throw new Error(message); };
const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
export function candidateCommand(host, argv) {
  need(host.sshAlias === null || /^[a-zA-Z0-9_.-]+$/.test(host.sshAlias), "Explicit local/null or SSH host alias required");
  return host.sshAlias === null ? { command: argv[0], args: argv.slice(1) }
    : { command: "/usr/bin/ssh", args: ["-o", "BatchMode=yes", host.sshAlias, argv.map(quote).join(" ")] };
}
function writeAtomic(path, value) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`, fd = openSync(temporary, "wx", 0o600);
  try { writeFileSync(fd, JSON.stringify(value, null, 2) + "\n"); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(temporary, path);
}
export async function runCandidate(template, commit, execute, write = writeAtomic) {
  need(template?.version === 1 && /^[a-f0-9]{40}$/.test(commit) && typeof template.barrierId === "string" && /^[a-zA-Z0-9_.-]+$/.test(template.barrierId), "Immutable candidate/barrier identity required");
  for (const field of ["stateRoot", "authorityModule", "authorityConfig"]) need(isAbsolute(template[field] ?? ""), `Absolute ${field} required`);
  need(Array.isArray(template.hosts) && template.hosts.length && template.hosts.filter(host => host.sshAlias === null).length === 1, "Exactly one local authority host and every remote host required");
  need(/^[a-zA-Z0-9_.-]+$/.test(template.operatorUser), "Explicit administrator Unix identity required for its own SSH profile");
  const local = template.hosts.find(host => host.sshAlias === null);
  const stateDir = join(template.stateRoot, template.barrierId, commit);
  const hosts = [];
  const asOperator = command => ({ command: "/usr/sbin/runuser", args: ["-u", template.operatorUser, "--", command.command, ...command.args] });
  for (const host of template.hosts) {
    need(typeof host.id === "string" && host.id, "Host identity required");
    for (const field of ["releaseWrapper", "checkout", "preparedHostPlan", "hostPlan"]) need(isAbsolute(host[field] ?? ""), `Absolute ${host.id}/${field} required`);
    // Existing release owners retain immutable source, dependencies and deployment locks.
    // Publication-only selection never invokes model doctors or activates controllers.
    await execute(asOperator(candidateCommand(host, ["/usr/bin/env", "PI_STACK_HOST_PHASE=publication", host.releaseWrapper, commit])),  { timeoutMs: 900_000, receipt: false });
    const read = ["/usr/bin/sudo", "-n", "/usr/local/bin/node", "-e", 'process.stdout.write(require("node:fs").readFileSync(process.argv[1],"utf8"))', host.preparedHostPlan];
    const plan = JSON.parse(await execute(host.sshAlias === null ? candidateCommand(host, read) : asOperator(candidateCommand(host, read)), { timeoutMs: 10_000, receipt: true }));
    need(plan.version === 1 && plan.host === host.id, "Prepared inventory belongs to another host");
    plan.releaseCommit = commit; plan.barrierId = template.barrierId; plan.checkout = host.checkout;
    const install = ["/usr/bin/sudo", "-n", "/usr/local/bin/node", "-e", 'const fs=require("node:fs"),p=require("node:path"),file=process.argv[1];fs.mkdirSync(p.dirname(file),{recursive:true,mode:448});const tmp=file+"."+process.pid;fs.writeFileSync(tmp,fs.readFileSync(0),{mode:384,flag:"wx"});fs.renameSync(tmp,file)', host.hostPlan];
    await execute(host.sshAlias === null ? candidateCommand(host, install) : asOperator(candidateCommand(host, install)), { timeoutMs: 10_000, receipt: false, input: JSON.stringify(plan) });
    const hooks = {};
    for (const operation of ["gate", "verify", "census", "doctors", "restore"]) {
      const command = candidateCommand(host, ["/usr/bin/sudo", "-n", "/usr/bin/nsenter", "--target", "1", "--mount", "--", "/usr/local/bin/node", join(host.checkout, "deploy/capacity-host.mjs"), operation, host.hostPlan]);
      const owned = host.sshAlias === null ? command : asOperator(command);
      hooks[operation] = { ...owned, cwd: local.checkout, timeoutMs: 50_000 };
    }
    hosts.push({ id: host.id, ...hooks });
  }
  const plan = { version: 1, barrierId: template.barrierId, releaseCommit: commit, stateDir,
    authorityModule: template.authorityModule, authorityConfig: template.authorityConfig, hosts };
  const path = join(stateDir, "plan.json"); write(path, plan);
  // The durable caller owns this finite sequence and its exit receipt; no model polls it.
  for (let step = 0; step < 5; step++) await execute({ command: "/usr/bin/sudo", args: ["-n", "/usr/bin/nsenter", "--target", "1", "--mount", "--",
    join(local.checkout, "deploy/capacity-bootstrap"), "advance", path] }, { timeoutMs: 900_000, receipt: false });
  return { barrierId: template.barrierId, candidateCommit: commit, plan: path, phase: "opened" };
}
async function main(args) {
  need(args.length === 2 && isAbsolute(args[0]), "Usage: node deploy/capacity-bootstrap-candidate.mjs /absolute/TEMPLATE.json IMMUTABLE_COMMIT (run under a durable job owner)");
  const template = JSON.parse(readFileSync(args[0], "utf8"));
  const result = await runCandidate(template, args[1], async (command, options) => {
    const result = spawnSync(command.command, command.args, { input: options.input, encoding: "utf8", timeout: options.timeoutMs, maxBuffer: 16 * 1024 * 1024 });
    if (result.stderr) process.stderr.write(result.stderr);
    if (!options.receipt && result.stdout) process.stderr.write(result.stdout);
    need(!result.error && result.status === 0, `Candidate cutover step failed (${result.error?.code ?? result.status}); retained barrier and receipts require same-plan recovery`);
    return result.stdout;
  });
  console.log(JSON.stringify(result));
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main(process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 75; });

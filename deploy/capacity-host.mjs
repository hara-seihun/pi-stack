#!/usr/bin/env node
import { readFileSync, mkdirSync, chmodSync, statSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

const need = (condition, message) => { if (!condition) throw new Error(message); };
const sourceKinds = ["threadDatabase", "threadDatabaseDirectory", "inactivePersonal"];
export function inactivePersonalProof(procRoot, source) {
  need(isAbsolute(source.dataDir ?? "") && Number.isSafeInteger(source.uid) && source.uid >= 0, "Inactive-person lifecycle needs actual UID and configured data directory");
  const absolute = resolve(source.dataDir);
  const longest = join(absolute, "thread-sockets", `${"0".repeat(16)}.${"0".repeat(16)}.sock`);
  const socketDir = Buffer.byteLength(longest) <= 107 ? absolute : `/run/user/${source.uid}/pi/${createHash("sha256").update(absolute).digest("hex").slice(0, 16)}`;
  const retained = [];
  for (const name of readdirSync(procRoot).filter(name => /^\d+$/.test(name))) {
    try {
      const args = readFileSync(join(procRoot, name, "cmdline"), "utf8").split("\0").filter(Boolean);
      const native = args.some(arg => /(?:runner-host\.(?:js|ts)|(?:shared-)?runtime-host\.(?:mjs|ts)|pi-coding-agent\/dist\/(?:bundle\/)?cli\.js)$/.test(arg));
      if (native && args.some(arg => arg.startsWith(`${socketDir}/`) || arg.startsWith(`${absolute}/`))) retained.push(Number(name));
    } catch (error) { if (!["ENOENT", "ESRCH"].includes(error.code)) throw new Error(`Inactive-person process census unavailable for PID ${name}`); }
  }
  need(retained.length === 0, `${source.namespaceUnit}: inactive supervisor retains native processes ${retained.join(",")}; encrypted source cannot be omitted`);
  return { unit: source.namespaceUnit, path: source.path, dataDir: absolute, uid: source.uid, nativeProcesses: retained, socketDir };
}
export function validateHostPlan(plan) {
  need(plan?.version === 1 && typeof plan.host === "string" && plan.host && typeof plan.barrierId === "string" && plan.barrierId
    && /^[a-f0-9]{40}$/.test(plan.releaseCommit), "Host/barrier/release identity required");
  for (const field of ["checkout", "hostFile", "preparedClientConfig", "activeClientConfig", "orchestrator", "stateDir"]) need(isAbsolute(plan[field] ?? ""), `Absolute ${field} required`);
  need(Array.isArray(plan.capacityServices) && plan.capacityServices.every(unit => /^[a-zA-Z0-9@_.-]+\.service$/.test(unit)), "Explicit capacity service/tunnel units required");
  need(Array.isArray(plan.owners) && plan.owners.length && new Set(plan.owners.map(owner => owner.ownerId)).size === plan.owners.length, "Every distinct configured host owner required");
  for (const owner of plan.owners) {
    need(typeof owner.ownerId === "string" && owner.ownerId && Array.isArray(owner.controllers) && Array.isArray(owner.sources), "Owner controller/source inventory required");
    for (const controller of owner.controllers) need(/^[a-zA-Z0-9@_.-]+\.service$/.test(controller.unit) && ["daemon", "remote", "root"].includes(controller.kind)
      && /^http:\/\/127\.0\.0\.1:\d+\/v1\/health$/.test(controller.healthUrl), "Exact loopback controller health/unit/kind required");
    for (const source of owner.sources) need(sourceKinds.includes(source.kind) && isAbsolute(source.path ?? "")
      && (source.namespaceUnit === null || /^[a-zA-Z0-9@_.-]+\.service$/.test(source.namespaceUnit))
      && (source.kind !== "inactivePersonal" || source.namespaceUnit !== null && isAbsolute(source.dataDir ?? "") && Number.isSafeInteger(source.uid) && source.uid >= 0), "Explicit source path and namespace unit/null required");
    for (const controller of owner.controllers.filter(controller => controller.kind === "remote")) need(owner.sources.some(source => source.namespaceUnit === controller.unit && ["threadDatabase", "threadDatabaseDirectory", "inactivePersonal"].includes(source.kind)), `${owner.ownerId}: person source/lifecycle inventory missing for ${controller.unit}`);
  }
}
export function hostOperations(plan, system) {
  validateHostPlan(plan);
  const { run, health, inactivePersonal } = system;
  const command = (file, args, env, input) => run(file, args, env, input);
  let manifest;
  const clientManifest = () => manifest ??= JSON.parse(command("/usr/bin/cat", [plan.preparedClientConfig]));
  const fleetUser = () => {
    const user = JSON.parse(command("/usr/bin/cat", [plan.hostFile])).fleetUser;
    need(typeof user === "string" && /^[a-zA-Z0-9_.-]+$/.test(user), "Configured fleet administrator required for release ownership");
    return user;
  };
  const release = (executable, args, phase) => command("/usr/sbin/runuser", ["-u", fleetUser(), "--", "/usr/bin/env", ...(phase ? [`PI_STACK_HOST_PHASE=${phase}`] : []), executable, ...args]);
  const userCache = new Map();
  const ownerUser = ownerId => {
    if (userCache.has(ownerId)) return userCache.get(ownerId);
    const owner = clientManifest().owners.find(owner => owner.ownerId === ownerId);
    need(owner && Number.isSafeInteger(owner.uid), `${ownerId}: actual configured UID missing`);
    const user = command("/usr/bin/getent", ["passwd", String(owner.uid)]).trim().split(":")[0];
    need(/^[a-zA-Z0-9_.-]+$/.test(user), `${ownerId}: configured UID has no Unix identity`);
    userCache.set(ownerId, user); return user;
  };
  const unitCache = new Map();
  const unit = (name, property) => {
    const key = `${name}/${property}`;
    if (!unitCache.has(key)) unitCache.set(key, command("/usr/bin/systemctl", ["show", name, "-p", property, "--value"]).trim());
    return unitCache.get(key);
  };
  const inNamespace = (ownerId, source, executable, args, input) => {
    const user = ownerUser(ownerId), own = ["/usr/sbin/runuser", "-u", user, "--", executable, ...args];
    if (source.namespaceUnit === null) return command(own[0], own.slice(1), undefined, input);
    const pid = unit(source.namespaceUnit, "MainPID");
    need(/^[1-9][0-9]*$/.test(pid), `${source.path}: owner namespace ${source.namespaceUnit} unavailable (locked or inactive)`);
    need(unit(source.namespaceUnit, "User") === user, `${source.namespaceUnit}: namespace belongs to another configured UID`);
    return command("/usr/bin/nsenter", ["--target", pid, "--mount", "--", ...own], undefined, input);
  };
  const checkArtifacts = () => {
    for (const path of ["/srv/pi/runtime", plan.orchestrator, "/srv/pi/pi-remote"]) need(command("/usr/bin/cat", [join(path, ".pi-stack-commit")]).trim() === plan.releaseCommit, `${path}: source preparation/selection not complete; use capacity-host prepare under durable publication custody`);
  };
  const checkSelection = () => {
    checkArtifacts();
    need(command("/usr/bin/cmp", ["--silent", plan.preparedClientConfig, plan.activeClientConfig]) === "", "Capacity client configuration differs from prepared ownership");
    const manifest = JSON.parse(command("/usr/bin/cat", [plan.activeClientConfig]));
    need(Array.isArray(manifest.owners) && manifest.owners.length === plan.owners.length
      && new Set(manifest.owners.map(owner => owner.ownerId)).size === plan.owners.length
      && plan.owners.every(owner => manifest.owners.some(entry => entry.ownerId === owner.ownerId)), "Configured client owner inventory does not match host plan");
  };
  return {
    async prepare() {
      need(release("/usr/bin/git", ["-C", plan.checkout, "rev-parse", "HEAD"]).trim() === plan.releaseCommit, "Checkout does not contain immutable gated release");
      release(join(plan.checkout, "deploy/prepare"), []);
      release(join(plan.checkout, "deploy/host"), [plan.hostFile], "publication");
      checkArtifacts();
      return { source: "selected", host: plan.host, releaseCommit: plan.releaseCommit };
    },
    async gate() {
      checkArtifacts();
      command("/usr/bin/install", ["-m", "644", plan.preparedClientConfig, plan.activeClientConfig]);
      if (plan.capacityServices.length) command("/usr/bin/systemctl", ["enable", "--now", ...plan.capacityServices]);
      const fleet = JSON.parse(command("/usr/bin/cat", [plan.hostFile])).fleetUser;
      need(typeof fleet === "string" && fleet, "Configured fleet user required for authority reachability");
      command("/usr/sbin/runuser", ["-u", fleet, "--", "/usr/local/bin/node", join(plan.checkout, "deploy/capacity-ready.mjs"), "uninitialized", join(plan.orchestrator, "dist/agent-capacity.js")]);
      release(join(plan.checkout, "deploy/host"), [plan.hostFile], "activation");
      command("/usr/bin/python3", [join(plan.checkout, "deploy/one-kenan-activate"), "activate", "--host", plan.hostFile, "--expected", plan.releaseCommit]);
      return { gate: "applied", host: plan.host, barrierId: plan.barrierId };
    },
    async verify() {
      checkSelection();
      const owners = [], oldControllers = [], inactivePersonalSources = [];
      for (const owner of plan.owners) {
        let active = 0;
        for (const controller of owner.controllers) {
          const state = unit(controller.unit, "ActiveState");
          need(["active", "inactive", "failed"].includes(state), `${controller.unit}: transition/unknown custody ${state}`);
          if (state !== "active") continue;
          active++;
          const receipt = await health(controller.healthUrl);
          if (receipt?.ok !== true || receipt.releaseCommit !== plan.releaseCommit || controller.kind === "daemon" && receipt.agentCapacityRequired !== true) oldControllers.push(controller.unit);
        }
        need(owner.sources.length > 0 || active === 0, `${owner.ownerId}: active controller has no execution sources`);
        const unavailableSources = [], groups = new Map();
        for (const source of owner.sources) {
          if (source.kind === "inactivePersonal") {
            try {
              need(["inactive", "failed"].includes(unit(source.namespaceUnit, "ActiveState")), `${source.namespaceUnit}: personal controller is not inactive`);
              need(clientManifest().owners.find(entry => entry.ownerId === owner.ownerId)?.uid === source.uid, "Inactive-person proof UID does not match configured owner");
              inactivePersonalSources.push({ ownerId: owner.ownerId, ...inactivePersonal(source) });
            } catch { unavailableSources.push(source.path); }
          } else { const group = groups.get(source.namespaceUnit) ?? []; group.push(source); groups.set(source.namespaceUnit, group); }
        }
        for (const sources of groups.values()) {
          try {
            const probe = 'const fs=require("node:fs"); const paths=JSON.parse(fs.readFileSync(0,"utf8")); console.log(JSON.stringify(paths.filter(path=>{try{fs.accessSync(path,fs.constants.R_OK);return false}catch{return true}})));';
            const unavailable = JSON.parse(inNamespace(owner.ownerId, sources[0], "/usr/local/bin/node", ["-e", probe], JSON.stringify(sources.map(source => source.path))));
            need(Array.isArray(unavailable) && unavailable.every(path => sources.some(source => source.path === path)), "Invalid namespace source-access proof");
            unavailableSources.push(...unavailable);
          } catch { unavailableSources.push(...sources.map(source => source.path)); }
        }
        owners.push({ ownerId: owner.ownerId, state: active ? "gated" : "inactive", coverage: unavailableSources.length ? "unavailable" : "complete", unavailableSources });
      }
      const directIngress = JSON.parse(command(join(plan.checkout, "deploy/direct-agent-ingress"), [plan.releaseCommit, plan.hostFile]));
      return { version: 1, host: plan.host, barrierId: plan.barrierId, releaseCommit: plan.releaseCommit, oldControllers, owners, directIngress, inactivePersonalSources };
    },
    async census() {
      const barrier = await this.verify();
      need(!barrier.oldControllers.length && barrier.owners.every(owner => owner.coverage === "complete"), "All owner namespaces/gated controllers must be available before census");
      const entries = [];
      for (const owner of plan.owners) {
          const groups = new Map();
          for (const source of owner.sources.filter(source => source.kind !== "inactivePersonal")) { const group = groups.get(source.namespaceUnit) ?? []; group.push(source); groups.set(source.namespaceUnit, group); }
          for (const sources of groups.values()) {
            const censusPlan = { host: plan.host, barrierId: plan.barrierId, owners: [{ ownerId: owner.ownerId,
              threadDatabases: sources.filter(source => source.kind === "threadDatabase").map(source => source.path),
              threadDatabaseDirectories: sources.filter(source => source.kind === "threadDatabaseDirectory").map(source => source.path) }] };
            const census = JSON.parse(inNamespace(owner.ownerId, sources[0], "/usr/local/bin/node", [join(plan.orchestrator, "dist/agent-capacity-cli.js"), "census", "-"], JSON.stringify(censusPlan)));
            need(census.version === 1 && census.barrierId === plan.barrierId && Array.isArray(census.entries), "Owner omitted valid census receipt");
            for (const entry of census.entries) {
              const prior = entries.find(other => other.agentId === entry.agentId || other.executionId === entry.executionId);
              need(!prior || prior.agentId === entry.agentId && prior.executionId === entry.executionId && prior.ownerId === entry.ownerId, "Overlapping execution custody across owner namespaces");
              if (!prior) entries.push(entry);
            }
          }
      }
      return { version: 1, barrierId: plan.barrierId, hosts: [{ host: plan.host, capturedAt: new Date().toISOString(), owners: plan.owners.map(owner => owner.ownerId) }], entries };
    },
    async doctors() {
      checkSelection();
      const fleet = JSON.parse(command("/usr/bin/cat", [plan.hostFile])).fleetUser;
      need(typeof fleet === "string" && fleet, "Configured fleet user required for actual-UID doctor admission");
      for (const args of [
        ["node", join(plan.checkout, "deploy/capacity-ready.mjs"), join(plan.orchestrator, "dist/agent-capacity.js")],
        [join(plan.checkout, "deploy/runtime-doctors"), "browser", plan.checkout, fleet, plan.checkout],
        [join(plan.checkout, "deploy/runtime-doctors"), "model", plan.checkout, fleet, plan.checkout],
      ]) command("/usr/sbin/runuser", ["-u", fleet, "--", ...args]);
      return { doctors: "passed", host: plan.host };
    },
    async restore() {
      const receipt = await this.verify();
      need(!receipt.oldControllers.length && receipt.owners.every(owner => owner.coverage === "complete"), "Do not restore ingress over unknown owner custody");
      command("/usr/bin/systemctl", ["start", "pi-remote-router.service"]);
      return { ingress: "guarded", host: plan.host };
    },
  };
}
async function main(args) {
  need(args.length === 2 && ["prepare", "gate", "verify", "census", "doctors", "restore"].includes(args[0]) && isAbsolute(args[1]), "Usage: node deploy/capacity-host.mjs prepare|gate|verify|census|doctors|restore /absolute/HOST_PLAN.json");
  need(process.getuid() === 0, "Host capacity bootstrap requires administrator identity in PID1 mount namespace");
  need(statSync("/proc/self/ns/mnt").ino === statSync("/proc/1/ns/mnt").ino, "Run host bootstrap with sudo nsenter -t 1 -m --");
  const plan = JSON.parse(readFileSync(args[1], "utf8"));
  const ops = hostOperations(plan, {
    run: (executable, argv, env, input) => {
      const result = spawnSync(executable, argv, { env: { ...process.env, ...env }, input, encoding: "utf8", ...(args[0] === "prepare" ? {} : { timeout: 50_000 }), maxBuffer: 8 * 1024 * 1024 });
      need(!result.error && result.status === 0, `${executable} failed (${result.error?.code ?? result.status}); barrier retained: ${result.stderr?.slice(-3000) ?? ""}`);
      if (result.stderr) process.stderr.write(result.stderr);
      return result.stdout;
    },
    health: async url => { const response = await fetch(url, { signal: AbortSignal.timeout(5000), redirect: "error" }); need(response.ok, `${url}: controller health unavailable`); return response.json(); },
    inactivePersonal: source => inactivePersonalProof("/proc", source),
  });
  mkdirSync(plan.stateDir, { recursive: true, mode: 0o700 }); chmodSync(plan.stateDir, 0o700);
  console.log(JSON.stringify(await ops[args[0]]()));
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main(process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 75; });

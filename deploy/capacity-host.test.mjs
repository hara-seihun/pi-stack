import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hostOperations, inactivePersonalProof } from "./capacity-host.mjs";
import { candidateCommand, runCandidate } from "./capacity-bootstrap-candidate.mjs";

function fixture() {
  const plan = { version: 1, host: "alpha", barrierId: "test", releaseCommit: "a".repeat(40), checkout: "/checkout", hostFile: "/host.json",
    preparedClientConfig: "/prepared.json", activeClientConfig: "/active.json", orchestrator: "/srv/pi/pi-orchestrator", stateDir: "/state",
    capacityServices: [], owners: [{ ownerId: "alpha/person", controllers: [{ unit: "pi-remote@person.service", healthUrl: "http://127.0.0.1:18790/v1/health", kind: "remote" },
      { unit: "pi-orchestrator@person.service", healthUrl: "http://127.0.0.1:2460/v1/health", kind: "daemon" }],
      sources: [{ kind: "threadDatabase", path: "/public/threads.sqlite3", namespaceUnit: null },
        { kind: "threadDatabase", path: "/private/threads.sqlite3", namespaceUnit: "pi-remote@person.service" },
        { kind: "threadDatabaseDirectory", path: "/private/root-sessions", namespaceUnit: "pi-remote@person.service" }] }] };
  const calls = [], manifest = { owners: [{ uid: 1000, ownerId: "alpha/person" }] };
  let busyRoot = false, oldDaemon = false, locked = false;
  const system = { run: (exe, args, env, input) => {
    calls.push({ exe, args, env, input });
    if (exe === "/usr/bin/git" || args.includes("/usr/bin/git")) return plan.releaseCommit;
    if (exe === "/usr/bin/cat") {
      if (args[0].endsWith(".pi-stack-commit")) return plan.releaseCommit;
      return JSON.stringify(args[0] === "/host.json" ? { fleetUser: "person" } : manifest);
    }
    if (exe === "/usr/bin/getent") return "person:x:1000:1000::/home/person:/bin/bash";
    if (exe === "/usr/bin/systemctl" && args[0] === "show") return args[3] === "ActiveState" ? "active" : args[3] === "User" ? "person" : "123";
    if (exe.endsWith("direct-agent-ingress")) return JSON.stringify({ cli: "managed", sdk: "managed", root: "idle-managed", evidence: { releaseCommit: plan.releaseCommit } });
    if (exe === "/usr/bin/python3" && busyRoot) throw new Error("Root has active native work");
    if (exe === "/usr/sbin/runuser" || exe === "/usr/bin/nsenter") {
      assert.ok(args.includes("person"));
      if (args.includes("-e")) return JSON.stringify(locked && exe.endsWith("nsenter") ? ["/private/threads.sqlite3"] : []);
      if (args.includes("census")) {
        assert.equal(args.at(-1), "-");
        const own = JSON.parse(input).owners[0]; assert.equal(own.ownerId, "alpha/person");
        return JSON.stringify({ version: 1, barrierId: "test", entries: [...own.threadDatabases, ...own.threadDatabaseDirectories.map(path => `${path}/request-uuid/threads.sqlite3`)].map(path => ({ ownerId: own.ownerId,
          agentId: path, executionId: `execution:${path}`, source: path, uncertain: true })) });
      }
    }
    return "";
  }, health: async url => ({ ok: true, releaseCommit: oldDaemon && url.includes("2460") ? "b".repeat(40) : plan.releaseCommit, agentCapacityRequired: true }),
    inactivePersonal: () => ({ nativeProcesses: [] }) };
  return { plan, calls, ops: hostOperations(plan, system), busy: () => { busyRoot = true; }, old: () => { oldDaemon = true; }, lock: () => { locked = true; } };
}

test("host gate uses real selection/activation paths and explicit idle root activation; remote service list may be empty", async () => {
  const f = fixture();
  await f.ops.prepare(); await f.ops.gate();
  assert.ok(f.calls.some(call => call.args.includes("PI_STACK_HOST_PHASE=publication")));
  assert.ok(f.calls.some(call => call.args.includes("PI_STACK_HOST_PHASE=activation")));
  assert.ok(f.calls.some(call => call.args.includes("uninitialized")));
  assert.ok(f.calls.some(call => call.exe === "/usr/bin/python3" && call.args.includes("activate")));
  assert.equal(f.calls.some(call => call.exe === "/usr/bin/systemctl" && call.args[0] === "enable"), false);
  const receipt = await f.ops.verify(); assert.deepEqual(receipt.oldControllers, []); assert.equal(receipt.owners[0].coverage, "complete");
});

test("busy root does not become a fabricated successful host gate", async () => {
  const f = fixture(); f.busy(); await assert.rejects(f.ops.gate(), /active native work/);
});

test("namespace readability and census run as owning UID and pass JSON stdin, not root0600 temporary files", async () => {
  const f = fixture(); const census = await f.ops.census();
  assert.equal(census.entries.length, 3);
  const calls = f.calls.filter(call => call.args.includes("census"));
  assert.equal(calls.length, 2);
  const privateCall = calls.find(call => call.exe === "/usr/bin/nsenter");
  assert.deepEqual(privateCall.args.slice(0, 8), ["--target", "123", "--mount", "--", "/usr/sbin/runuser", "-u", "person", "--"]);
  assert.equal(JSON.parse(privateCall.input).owners[0].threadDatabases[0], "/private/threads.sqlite3");
  assert.deepEqual(JSON.parse(privateCall.input).owners[0].threadDatabaseDirectories, ["/private/root-sessions"]);
  assert.ok(census.entries.some(entry => entry.source === "/private/root-sessions/request-uuid/threads.sqlite3"));
});

test("old daemon health and locked namespaces are explicit unavailable custody, never empty census", async () => {
  const f = fixture(); f.old(); f.lock();
  const receipt = await f.ops.verify(); assert.deepEqual(receipt.oldControllers, ["pi-orchestrator@person.service"]);
  assert.deepEqual(receipt.owners[0].unavailableSources, ["/private/threads.sqlite3"]);
  await assert.rejects(f.ops.census(), /must be available/);
});

test("inactive personal-source omission requires no retained native process under either original or short socket path", () => {
  const root = mkdtempSync(join(tmpdir(), "inactive-person-"));
  const source = { namespaceUnit: "pi-remote@person.service", path: "/private/.pi-remote/threads.sqlite3", dataDir: "/private/.pi-remote", uid: 1000 };
  try {
    assert.deepEqual(inactivePersonalProof(root, source).nativeProcesses, []);
    mkdirSync(join(root, "123"));
    writeFileSync(join(root, "123/cmdline"), `node\0/release/dist/threads/runner-host.js\0${source.dataDir}/thread-runners/generation.sock\0`);
    assert.throws(() => inactivePersonalProof(root, source), /retains native processes 123/);
    const long = { ...source, dataDir: `/private/${"long".repeat(40)}` };
    writeFileSync(join(root, "123/cmdline"), "node\0/unrelated.js\0");
    const directory = inactivePersonalProof(root, long).socketDir;
    writeFileSync(join(root, "123/cmdline"), `node\0/release/dist/threads/runner-host.js\0${directory}/thread-runners/generation.sock\0`);
    assert.throws(() => inactivePersonalProof(root, long), /retains native processes 123/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("candidate driver uses honest candidate SHA before publication, not a fabricated future integration SHA", async () => {
  const commit = "a".repeat(40), calls = [], files = new Map();
  const template = { version: 1, barrierId: "test", operatorUser: "operator", stateRoot: "/state", authorityModule: "/srv/pi/pi-orchestrator/dist/agent-capacity-authority.js", authorityConfig: "/authority.json",
    hosts: [null, "peer"].map((sshAlias, index) => ({ id: `host-${index}`, sshAlias, releaseWrapper: "/home/operator/machine/pi-stack-release",
      checkout: "/home/operator/release/repository", preparedHostPlan: "/prepared.json", hostPlan: "/live-plan.json" })) };
  const result = await runCandidate(template, commit, async (command, options) => {
    calls.push({ command, options });
    if (options.receipt) return JSON.stringify({ version: 1, host: command.args.includes("/usr/bin/ssh") ? "host-1" : "host-0" });
    return "";
  }, (path, value) => files.set(path, value));
  assert.equal(result.candidateCommit, commit); assert.equal(result.phase, "opened");
  assert.equal(calls.filter(call => call.command.args.includes("PI_STACK_HOST_PHASE=publication")).length, 1);
  assert.ok(calls.some(call => call.command.args.includes("/usr/bin/ssh") && call.command.args.at(-1).includes("PI_STACK_HOST_PHASE=publication")));
  const plan = [...files.values()][0]; assert.equal(plan.releaseCommit, commit); assert.equal(plan.hosts.length, 2);
  assert.equal(calls.filter(call => call.command.args.includes("advance")).length, 5);
  assert.equal(candidateCommand(template.hosts[1], ["/path with spaces", "arg'quoted"]).args.at(-1), "'/path with spaces' 'arg'\\''quoted'");
});

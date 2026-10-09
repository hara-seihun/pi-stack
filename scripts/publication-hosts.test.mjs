import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test, { describe } from "node:test";
import { hostWaitKind, rollForwardHosts } from "../deploy/publication-hosts.mjs";
import { progressBudgetExhausted } from "../deploy/publication-control.mjs";
import { publicationConfig } from "./publication-fixture.mjs";

const hostIds = ["gmktec", "converge"];
const publication = process.env.PI_PUBLICATION_TEST_COMMAND ?? new URL("../deploy/publication", import.meta.url).pathname;
const id = "PUB-0123456789abcdef01234567";

for (const waitingHost of hostIds) {
  for (const kind of ["live-meeting", "native-source", "native-history", "host-lock"]) {
    test(`${kind} on ${waitingHost} does not hold its peer; restart retries only the pending host`, () => {
      const request = {};
      const calls = [];
      const durable = [];
      const targets = hostIds.map(id => ({ id }));
      const first = rollForwardHosts(request, targets, {
        deliver(target) {
          calls.push(target.id);
          return target.id === waitingHost
            ? { status: "waiting", waiting: { kind, host: target.id }, nextAttemptAt: "2026-10-07T12:00:00Z" }
            : { status: "passed", integrationSha: "old", android: { revision: "old", web: { revision: "old" } } };
        },
        save: value => durable.push(structuredClone(value)),
      });
      assert.deepEqual(first, { status: "waiting", hosts: [waitingHost] });
      assert.deepEqual(calls, hostIds);
      assert.equal(durable.length, 2);
      const ready = hostIds.find(host => host !== waitingHost);
      const successful = structuredClone(request.hosts[ready]);
      const restarted = structuredClone(durable.at(-1));
      calls.length = 0;
      const second = rollForwardHosts(restarted, targets, {
        deliver(target, previous) {
          calls.push(target.id);
          assert.deepEqual(previous, request.hosts[waitingHost]);
          return { status: "passed", integrationSha: "old", android: { revision: "old", web: { revision: "old" } } };
        },
        save: value => durable.push(structuredClone(value)),
      });
      assert.deepEqual(second, { status: "passed" });
      assert.deepEqual(calls, [waitingHost]);
      assert.deepEqual(restarted.hosts[ready], successful);
    });
  }
}

for (const failure of ["throw", "returned"]) test(`${failure} failure on the first host still delivers and saves the second`, () => {
  const request = {};
  const saved = [];
  const outcome = rollForwardHosts(request, hostIds.map(id => ({ id })), {
    deliver(target) {
      if (target.id === "gmktec") {
        if (failure === "throw") throw new Error("host activation failed");
        return { status: "failed", failure: { message: "host activation failed" } };
      }
      assert.equal(saved[0].hosts.gmktec.status, "failed", "failure is durable before the next host starts");
      return { status: "passed", integrationSha: "ready" };
    },
    save: value => saved.push(structuredClone(value)),
  });
  assert.deepEqual(outcome, { status: "failed", hosts: ["gmktec"] });
  assert.equal(saved.at(-1).hosts.converge.status, "passed");
});

// Host commands are fixture boundaries, while the owner, Git ancestry, proof hashing,
// filesystem receipts and reservation scripts execute unchanged in subprocesses.
const hostCommand = String.raw`
import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, appendFileSync, mkdirSync, cpSync } from "node:fs";
import { basename, join } from "node:path";
const root = process.env.FIXTURE_ROOT;
const host = process.env.FIXTURE_HOST || "gmktec";
const worldPath = join(root, "world.json");
const world = () => JSON.parse(readFileSync(worldPath, "utf8"));
const save = value => writeFileSync(worldPath, JSON.stringify(value));
const event = (action, extra = {}) => appendFileSync(join(root, "events.jsonl"), JSON.stringify({ host, action, ...extra }) + "\n");
const json = value => process.stdout.write(JSON.stringify(value));
const exec = (command, args, options = {}) => {
  const result = spawnSync(command, args, { encoding: "utf8", timeout: 3000, stdio: ["pipe", "inherit", "inherit"], ...options });
  process.exit(result.status ?? 1);
};
const name = basename(process.argv[1]);
let args = process.argv.slice(2);
if (name === "ssh") {
  while (args[0] === "-o") args.splice(0, 2);
  args.shift();
  exec(args.shift(), args, { input: readFileSync(0, "utf8"), env: { ...process.env, FIXTURE_HOST: "converge", PI_STACK_HOST_LOCK_PATH: join(root, "converge.lock") } });
} else if (name === "git") {
  const position = args.indexOf("fetch");
  if (position !== -1) args[args.indexOf("origin", position)] = join(root, "origin.git");
  exec("/usr/bin/git", args);
} else if (name === "bash") {
  if (args[0] !== "-s") throw new Error("Unexpected fixture bash invocation " + JSON.stringify(args));
  const script = readFileSync(0, "utf8");
  args = args.slice(1);
  if (args[0] === "--") args.shift();
  if (script.includes('operation=$1') && script.includes('pi_stack_acquire_host_lock')) {
    event(args[0]);
    exec("/bin/bash", ["-s", "--", ...args], { input: script });
  } else if (script.includes('native-history-boundary-fixture')) {
    const mode = args[3];
    assert.ok(["--probe", "--restore"].includes(mode), "publication must never advance the native boundary before wrapper preparation");
    event("native-history-" + mode, { revision: args[2], checkout: args[1] });
    if (mode === "--probe" && world().hosts[host].mode === "native-history") {
      process.stderr.write("native history boundary waiting: fixture old generation is busy\n");
      process.exit(75);
    }
    if (mode === "--probe" && ["history-probe-error", "history-unmarked-busy"].includes(world().hosts[host].mode)) {
      process.stderr.write("fixture native history source custody mismatch\n");
      process.exit(world().hosts[host].mode === "history-unmarked-busy" ? 75 : 66);
    }
    if (mode === "--restore" && world().hosts[host].mode === "history-forward-only") {
      process.stderr.write("native history boundary error: Native history is already preserved/migrated; prior capture source restoration is not allowed. Resume the candidate.\n");
      process.exit(1);
    }
    if (mode === "--restore" && world().hosts[host].mode === "history-probe-error") {
      process.stderr.write("fixture migration crossed schema boundary; old source restoration refused\n");
      process.exit(65);
    }
  } else if (script.includes('releasePrerequisites')) {
    event("native-probe");
    if (["native-probe-error", "native-unmarked-busy"].includes(world().hosts[host].mode)) {
      process.stderr.write("fixture native source status unavailable\n");
      process.exit(world().hosts[host].mode === "native-unmarked-busy" ? 75 : 66);
    }
    exec("/bin/bash", ["-s", "--", ...args], { input: script });
  } else if (script.includes('checkoutCommit:') && script.includes('runtimes:$runtimes')) {
    event("census");
    const state = world().hosts[host];
    json({ host, selectedCommit: state.selected, checkoutCommit: state.selected, runtimes: [], fleet: { activeRuns: [] } });
  } else if (script.includes('supervisors:$people') && script.includes('voiceCommit:')) {
    event("proof", { revision: args[0] });
    if (world().hosts[host].selected !== args[0]) throw new Error("proof selected source mismatch");
    json({ host, integrationSha: args[0], remoteCommit: args[0], orchestratorCommit: args[0], voiceCommit: args[0] });
  } else if (script.includes('root=/var/lib/pi-remote/app-updates/current')) {
    event("matched-app-web-proof");
    const android = world().hosts[host].android;
    json({ revision: android, web: { revision: android } });
  } else if (script.includes('meetingCensus') && script.includes('rooms')) {
    event("meeting-probe");
    if (world().hosts[host].mode === "live-meeting") process.stdout.write("fixture-room:1\n");
  } else {
    throw new Error("Unknown host script boundary: " + script.slice(0, 150));
  }
} else if (name === "bun") {
  const [tool, operation, path] = args;
  if (operation === "bundle") {
    writeFileSync(path, "checked installer\n");
  } else if (operation === "install") {
    event("install-app-web");
    const state = world();
    state.hosts[host].android = JSON.parse(readFileSync(join(path, "manifest.json"), "utf8")).revision;
    save(state);
  } else if (operation === "verify") {
    const revision = JSON.parse(readFileSync(path, "utf8")).revision;
    json({ revision, web: { revision } });
  } else throw new Error("Unknown Android operation: " + operation);
} else if (name === "rsync") {
  const source = args.at(-2);
  const destination = args.at(-1).split(":").slice(1).join(":");
  mkdirSync(destination, { recursive: true });
  cpSync(source, destination, { recursive: true });
} else if (name === "sudo") {
  if (args[0] === "-n") args.shift();
  exec(args.shift(), args, { input: readFileSync(0, "utf8") });
} else if (name === "release") {
  const state = world();
  const mode = state.hosts[host].mode;
  const request = JSON.parse(readFileSync(join(root, "requests", "PUB-0123456789abcdef01234567.json"), "utf8"));
  const custody = request.nativeHistory.hosts[host];
  assert.deepEqual(custody, { state: "restore-required", integrationSha: args[0] }, "wrapper starts only after durable native custody");
  assert.equal(request.android.release.revision, args[0], "checked app/web artifact is prepared before wrapper preparation");
  event("deploy", { revision: args[0], custody });
  if (mode === "failed") { process.stderr.write("fixture activation failed\n"); process.exit(42); }
  if (mode === "native-source") {
    process.stderr.write("native source prerequisite fixture requires " + "f".repeat(40) + " before Pi Stack " + args[0] + "; selected " + "e".repeat(40) + "\n");
    process.exit(75);
  }
  if (mode === "host-lock") { process.stderr.write("another Pi stack deployment owns /fixture/deploy.lock\n"); process.exit(75); }
  event("prepare", { revision: args[0], serving: state.hosts[host].selected });
  event("host-native-history-advance", { revision: args[0], custody });
  if (mode === "native-history") {
    const noise = state.hosts[host].noisyStatus;
    if (noise === "interleaved") writeFileSync(1, '{"priorRestoration":"' + "x".repeat(65536));
    process.stderr.write("native history boundary waiting: fixture old generation is busy\n");
    if (noise === "interleaved") writeFileSync(1, "x".repeat(200000) + '"}\n');
    if (noise === "trailing") writeFileSync(1, JSON.stringify({ priorRestoration: "x".repeat(200000) }) + "\n");
    process.exit(75);
  }
  if (mode === "executor-replacement") {
    state.hosts[host].selected = args[0];
    state.hosts[host].rootReplacementPending = true;
    save(state);
    process.stderr.write("executor replacement waiting: fixture Root executor handoff pending\n");
    process.exit(75);
  }
  if (state.hosts[host].rootReplacementPending) {
    event("root-executor-replaced", { revision: args[0] });
    state.hosts[host].rootReplacementPending = false;
  }
  state.hosts[host].selected = args[0];
  save(state);
} else throw new Error("Unknown fixture command " + name);
`;

function fixture(t, waitingHost, mode) {
  const root = mkdtempSync(join(tmpdir(), "publication-hosts-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const dir of ["bin", "repository", "requests"]) mkdirSync(join(root, dir));
  const repository = join(root, "repository");
  const git = (...args) => {
    const result = spawnSync("git", ["-C", repository, ...args], { encoding: "utf8", timeout: 3000 });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  git("init", "-q", "-b", "main");
  git("config", "user.name", "Fixture");
  git("config", "user.email", "fixture@example.test");
  git("config", "commit.gpgsign", "false");
  git("config", "core.hooksPath", "/dev/null");
  mkdirSync(join(repository, "deploy"));
  writeFileSync(join(repository, "deploy/android-update"), "fixture artifact capability\n");
  writeFileSync(join(repository, "deploy/native-history-boundary"), "# native-history-boundary-fixture\n");
  writeFileSync(join(repository, "deploy/native-history-bridge.mjs"), "export const MAINTENANCE_INTAKE = 'always-open-v1';\n");
  git("add", ".");
  git("commit", "-qm", "selected baseline");
  const baseline = git("rev-parse", "HEAD");
  git("commit", "--allow-empty", "-qm", "requested integration");
  const revision = git("rev-parse", "HEAD");
  git("commit", "--allow-empty", "-qm", "newer ready host delivery");
  const newer = git("rev-parse", "HEAD");
  const origin = join(root, "origin.git");
  const clone = spawnSync("git", ["clone", "--bare", "--quiet", repository, origin], { encoding: "utf8", timeout: 3000 });
  assert.equal(clone.status, 0, clone.stderr);
  git("remote", "add", "origin", "https://github.com/hara-seihun/pi-stack.git");
  git("update-ref", "refs/pi-stack-publication/owner-source", newer);
  git("checkout", "-q", "--detach", revision);
  const configPath = publicationConfig(root, repository);
  const config = JSON.parse(readFileSync(configPath, "utf8"));
  for (const target of config.targets) target.releaseCommand = join(root, "bin/release");
  writeFileSync(configPath, JSON.stringify(config));
  writeFileSync(join(root, "host.json"), JSON.stringify({ version: 1, fleetUser: "fixture" }));
  for (const command of ["bash", "ssh", "sudo", "bun", "rsync", "release", "git"]) {
    writeFileSync(join(root, "bin", command), `#!${process.execPath}\n${hostCommand}`, { mode: 0o700 });
  }
  const worldPath = join(root, "world.json");
  writeFileSync(worldPath, JSON.stringify({ hosts: Object.fromEntries(hostIds.map(host => [host,
    { mode: host === waitingHost ? mode : "ready", selected: baseline, android: baseline }])) }));
  const directory = join(root, "proofs", id, "android-artifact", revision);
  mkdirSync(directory, { recursive: true });
  const hash = value => createHash("sha256").update(value).digest("hex");
  const release = { revision, fileName: `${revision}.apk`, sha256: hash("apk") };
  writeFileSync(join(directory, release.fileName), "apk");
  writeFileSync(join(directory, `${revision}.web.zip`), "web");
  writeFileSync(join(directory, "manifest.json"), JSON.stringify(release));
  writeFileSync(join(directory, "web-manifest.json"), JSON.stringify({ fileName: `${revision}.web.zip`, sha256: hash("web") }));
  const requestPath = join(root, "requests", `${id}.json`);
  const request = { requestId: id, sourceSha: revision, sourceRef: "refs/heads/submitted", integrationSha: revision,
    integratedAt: new Date().toISOString(), checks: { status: "passed" }, status: "queued", attempt: 0, failures: [],
    android: { release, directory, manifest: join(directory, "manifest.json"), status: "prepared", hosts: {} } };
  writeFileSync(requestPath, JSON.stringify(request));
  const env = { ...process.env, PATH: `${root}/bin:${process.env.PATH}`, FIXTURE_ROOT: root,
    PI_STACK_PUBLICATION_STATE: root, PI_STACK_PUBLICATION_CONFIG: configPath, PI_STACK_HOST_FILE: join(root, "host.json"),
    PI_STACK_HOST_LOCK_PATH: join(root, "gmktec.lock"), PI_STACK_PUBLICATION_ALERT_INBOX: join(root, "inbox") };
  const run = async (operation = "processRequest") => {
    const args = ["recover-native-history", "_retry"].includes(operation) ? [publication, operation, id, ...(operation === "recover-native-history" ? ["gmktec"] : [])] : ["--input-type=module", "-e", `
      import { readFileSync } from "node:fs";
      import { ${operation} } from ${JSON.stringify(pathToFileURL(publication).href)};
      ${operation}(JSON.parse(readFileSync(${JSON.stringify(requestPath)}, "utf8")));
    `];
    const child = spawn(process.execPath, args, { env, timeout: 20000, stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stdout.resume();
    child.stderr.on("data", chunk => stderr += chunk);
    const status = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
    assert.equal(status, 0, stderr);
    return JSON.parse(readFileSync(requestPath, "utf8"));
  };
  const events = () => existsSync(join(root, "events.jsonl")) ? readFileSync(join(root, "events.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line)) : [];
  const world = () => JSON.parse(readFileSync(worldPath, "utf8"));
  const update = change => { const value = world(); change(value); writeFileSync(worldPath, JSON.stringify(value)); };
  return { root, run, events, world, update, revision, newer, baseline, git, requestPath, env };
}

test("native source validation is effect-free and rejects obsolete or closed-intake boundary source", t => {
  const f = fixture(t, "gmktec", "native-history");
  const validate = revision => {
    const script = `import {nativeHistoryBoundaryTarget} from ${JSON.stringify(pathToFileURL(publication).href)};
      try { console.log(JSON.stringify(nativeHistoryBoundaryTarget({integrationSha:${JSON.stringify(revision)}}, {id:'gmktec'}, 'validate'))); }
      catch (error) { console.log(JSON.stringify(error.probeFailure)); }`;
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], { env: f.env, encoding: "utf8", timeout: 3000 });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  };
  const request = readFileSync(f.requestPath, "utf8");
  const world = f.world();
  assert.deepEqual(validate(f.revision), { ok: true, status: 0, needed: true });
  const repository = join(f.root, "repository");
  writeFileSync(join(repository, "deploy/native-history-boundary"), "# repaired-native-history-boundary-fixture\n");
  f.git("add", ".");
  f.git("commit", "-qm", "retained owner boundary repair");
  const repaired = f.git("rev-parse", "HEAD");
  f.git("update-ref", "refs/pi-stack-publication/owner-source", repaired);
  const obsolete = validate(f.revision);
  assert.equal(obsolete.kind, "native-source");
  assert.equal(obsolete.mode, "validate");
  assert.equal(obsolete.sourceProof.code, "obsolete-native-maintenance-source");
  assert.deepEqual(obsolete.sourceProof.changed, ["deploy/native-history-boundary"]);
  writeFileSync(join(repository, "deploy/native-history-bridge.mjs"), "export const MAINTENANCE_INTAKE = 'closed';\n");
  f.git("add", ".");
  f.git("commit", "-qm", "closed intake candidate");
  const closed = f.git("rev-parse", "HEAD");
  f.git("update-ref", "refs/pi-stack-publication/owner-source", closed);
  assert.equal(validate(closed).intakeProof.code, "closed-intake-maintenance-forbidden");
  assert.deepEqual(f.events(), [], "validation cannot reserve, prepare, advance or restore host state");
  assert.deepEqual(f.world(), world);
  assert.equal(readFileSync(f.requestPath, "utf8"), request, "validation cannot acquire native custody itself");
});

test("another checked request cannot acquire native fences until each original host custody positively clears", async t => {
  const f = fixture(t, "gmktec", "ready");
  const ownerId = "PUB-ffffffffffffffffffffffff";
  const ownerPath = join(f.root, "requests", `${ownerId}.json`);
  const owner = { requestId: ownerId, sourceSha: f.baseline, integrationSha: f.baseline, status: "failed",
    nativeHistory: { hosts: {
      gmktec: { state: "repair-required", integrationSha: f.baseline },
      converge: { state: "restore-required", integrationSha: f.baseline },
    } } };
  const original = JSON.stringify(owner);
  writeFileSync(ownerPath, original);
  const waiting = await f.run();
  assert.equal(waiting.status, "queued", JSON.stringify(waiting.failure));
  for (const host of hostIds) {
    assert.equal(waiting.hosts[host].status, "waiting");
    assert.equal(waiting.hosts[host].waiting.kind, "native-history-custody");
    assert.equal(hostWaitKind(waiting.hosts[host].waiting), "waiting-for-native-history-custody");
    assert.deepEqual(waiting.hosts[host].waiting.owners, [{ requestId: ownerId, integrationSha: f.baseline,
      state: owner.nativeHistory.hosts[host].state, receipt: ownerPath }]);
  }
  assert.equal(waiting.reservations, undefined);
  assert.equal(waiting.nativeHistory, undefined);
  assert.deepEqual(f.events(), [], "custody gate precedes reservation, census, native advance, artifact installation and activation");
  assert.equal(readFileSync(ownerPath, "utf8"), original, "competing requests never invent restoration or alter original custody");
  const probed = await f.run("refreshHostWaits");
  assert.equal(probed.hosts.gmktec.ready, false);
  assert.equal(probed.hosts.converge.ready, false);
  assert.equal(probed.nextAttemptAt === undefined, false);
  assert.deepEqual(f.events(), [], "waiting probes read publication custody only, never another owner's native boundary");
  owner.nativeHistory.hosts.converge.state = "restored";
  writeFileSync(ownerPath, JSON.stringify(owner));
  const peerReady = await f.run("refreshHostWaits");
  assert.equal(peerReady.hosts.gmktec.ready, false);
  assert.equal(peerReady.hosts.converge.ready, true);
  const peerDelivered = await f.run();
  assert.equal(peerDelivered.status, "queued", JSON.stringify(peerDelivered.failure));
  assert.equal(peerDelivered.hosts.gmktec.waiting.owners[0].requestId, ownerId);
  assert.equal(peerDelivered.hosts.converge.status, "passed");
  assert.ok(f.events().every(event => event.host === "converge"), "restoration frees only that host, not its repair-held peer");
  const peerProof = structuredClone(peerDelivered.hosts.converge);
  owner.nativeHistory.hosts.gmktec.state = "released";
  writeFileSync(ownerPath, JSON.stringify(owner));
  const finalReady = await f.run("refreshHostWaits");
  assert.equal(finalReady.hosts.gmktec.ready, true);
  const boundary = f.events().length;
  const complete = await f.run();
  assert.equal(complete.status, "published", JSON.stringify(complete.failure));
  assert.deepEqual(complete.hosts.converge, peerProof);
  assert.ok(f.events().slice(boundary).every(event => event.host === "gmktec"));
});

test('one repair-held native boundary prevents automatic rollback of its still-owned peer', t => {
  const f = fixture(t, 'gmktec', 'native-history');
  const script = `import {recoveryNeeded,outstandingHostCustody} from ${JSON.stringify(pathToFileURL(publication).href)};
    const request={status:'failed',nativeHistory:{hosts:{gmktec:{state:'repair-required'},converge:{state:'restore-required'}}}};
    console.log(JSON.stringify({automatic:recoveryNeeded(request),custody:outstandingHostCustody(request)}));
    request.nativeHistory.hosts.gmktec.state='restored';
    console.log(JSON.stringify({automatic:recoveryNeeded(request),custody:outstandingHostCustody(request)}));`;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], { env: f.env, encoding: 'utf8', timeout: 3000 });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.stdout.trim().split('\n').map(line => JSON.parse(line)), [
    {automatic:false,custody:true}, {automatic:true,custody:true},
  ]);
});

test("preserved native history retains its original candidate for one evidenced repaired retry", async t => {
  const f = fixture(t, "gmktec", "history-forward-only");
  f.update(value => { value.hosts.converge.mode = "history-forward-only"; });
  const request = JSON.parse(readFileSync(f.requestPath, "utf8"));
  request.status = "failed";
  request.failure = { at: "2026-10-09T20:26:40Z", attempt: 1, reason: "misclassified-wait", message: "wrapper exited 75" };
  request.attempt = 1;
  request.nativeHistory = { hosts: Object.fromEntries(hostIds.map(host => [host, { state: "restore-required", integrationSha: f.revision }])) };
  writeFileSync(f.requestPath, JSON.stringify(request));
  const recovered = await f.run("recoverOutstandingCustody");
  for (const host of hostIds) {
    assert.equal(recovered.nativeHistory.hosts[host].state, "resume-required");
    assert.equal(recovered.nativeHistory.hosts[host].integrationSha, f.revision);
    assert.equal(recovered.nativeHistory.hosts[host].restoredAt, undefined);
  }
  assert.deepEqual(recovered.failure, request.failure);
  const script = `import {outstandingHostCustody,recoveryNeeded,nativeHistoryCustodyOwners} from ${JSON.stringify(pathToFileURL(publication).href)};
    const request=${JSON.stringify(recovered)};
    console.log(JSON.stringify({custody:outstandingHostCustody(request),automatic:recoveryNeeded(request),owners:nativeHistoryCustodyOwners({requestId:'PUB-ffffffffffffffffffffffff'},{id:'gmktec'})}));`;
  const proof = spawnSync(process.execPath, ["--input-type=module", "-e", script], { env: f.env, encoding: "utf8", timeout: 3000 });
  assert.equal(proof.status, 0, proof.stderr);
  const disposition = JSON.parse(proof.stdout);
  assert.equal(disposition.custody, true);
  assert.equal(disposition.automatic, false);
  assert.equal(disposition.owners[0].state, "resume-required");
  const repairDir = join(f.root, "repairs", id);
  mkdirSync(repairDir, { recursive: true });
  writeFileSync(join(repairDir, "receipt.json"), JSON.stringify({id:"causal-repair", failure:request.failure,
    outcome:{status:"infrastructure-fixed",evidence:join(f.root,"focused-proof.json")}}));
  writeFileSync(join(f.root, "bin", "systemctl"), "#!/bin/sh\nexit 0\n", {mode:0o700});
  const queued = await f.run("_retry");
  assert.equal(queued.status, "queued");
  assert.equal(queued.integrationSha, f.revision);
  assert.deepEqual(queued.nativeHistory, recovered.nativeHistory);
  assert.equal(queued.attemptLimit, 2);
  f.update(value => { for (const host of hostIds) value.hosts[host].mode = "ready"; });
  const published = await f.run();
  assert.equal(published.status, "published", JSON.stringify(published.failure));
  assert.equal(published.integrationSha, f.revision);
  for (const host of hostIds) assert.equal(published.nativeHistory.hosts[host].state, "released");
});

describe("publication owner host delivery", { concurrency: 8 }, () => {
for (const waitingHost of hostIds) for (const mode of ["live-meeting", "native-source", "native-history", "host-lock"]) {
  test(`owner releases both reservations while ${waitingHost} waits for ${mode}; old completion cannot downgrade a newer peer`, async t => {
    const f = fixture(t, waitingHost, mode);
    const readyHost = hostIds.find(host => host !== waitingHost);
    const first = await f.run();
    assert.equal(first.status, "queued", JSON.stringify(first.failure));
    assert.equal(first.hosts[waitingHost].status, "waiting");
    assert.equal(first.hosts[waitingHost].waiting.kind, mode);
    assert.equal(first.hosts[readyHost].status, "passed");
    assert.equal(first.hosts[readyHost].integrationSha, f.revision);
    assert.equal(first.hosts[readyHost].android.revision, f.revision);
    assert.equal(first.hosts[readyHost].android.web.revision, f.revision);
    if (mode === "native-history") {
      assert.equal(first.nativeHistory.hosts[waitingHost].state, "restore-required");
      assert.equal(f.world().hosts[waitingHost].android, f.baseline);
      assert.equal(f.world().hosts[waitingHost].selected, f.baseline, "old source serves throughout immutable preparation and busy boundary");
      const custody = { state: "restore-required", integrationSha: f.revision };
      assert.deepEqual(first.nativeHistory.hosts[waitingHost], custody);
      const hostEvents = f.events().filter(event => event.host === waitingHost);
      assert.deepEqual(hostEvents.filter(event => ["install-app-web", "deploy", "prepare", "host-native-history-advance"].includes(event.action)).map(event => event.action),
        ["deploy", "prepare", "host-native-history-advance"]);
      assert.deepEqual(hostEvents.find(event => event.action === "deploy").custody, custody);
      assert.deepEqual(hostEvents.find(event => event.action === "host-native-history-advance").custody, custody);
      assert.equal(hostEvents.find(event => event.action === "prepare").serving, f.baseline);
      assert.ok(!hostEvents.some(event => event.action === "native-history---restore"));
      assert.equal(hostWaitKind(first.hosts[waitingHost].waiting), "waiting-for-native-history");
      assert.equal(progressBudgetExhausted({ ...first, attempt: 1000, blockedSince: "2020-01-01T00:00:00Z" }), false);
      const beforeProbe = f.events().length;
      const probed = await f.run("refreshHostWaits");
      assert.equal(probed.hosts[waitingHost].ready, false);
      assert.deepEqual(probed.nativeHistory.hosts[waitingHost], first.nativeHistory.hosts[waitingHost], "busy probe retains the wrapper's exact custody");
      assert.deepEqual(f.events().slice(beforeProbe).map(event => [event.host, event.action]), [[waitingHost, "native-history---probe"]]);
      assert.equal(probed.hosts[waitingHost].waiting.probeFailingSince, undefined, "truthful busy is not probe failure");
    }
    for (const host of hostIds) {
      assert.equal(first.reservations[host].state, "released");
      assert.equal(existsSync(join(f.root, `${host}.lock.publication`)), false);
    }
    const savedProof = readFileSync(first.hosts[readyHost].proof, "utf8");
    const boundary = f.events().length;
    f.update(value => {
      value.hosts[waitingHost].mode = "ready";
      value.hosts[readyHost].selected = f.newer;
      value.hosts[readyHost].android = f.newer;
    });
    if (mode === "native-history") {
      const resumed = await f.run("refreshHostWaits");
      assert.equal(resumed.hosts[waitingHost].ready, true);
    }
    const completed = await f.run();
    assert.equal(completed.status, "published", JSON.stringify(completed.failure));
    assert.equal(completed.attempt, first.attempt, "resuming pending hosts is the same publication attempt");
    assert.deepEqual(completed.hosts[readyHost], first.hosts[readyHost]);
    assert.equal(readFileSync(completed.hosts[readyHost].proof, "utf8"), savedProof);
    assert.ok(f.events().slice(boundary).every(event => event.host === waitingHost), "no reserve, app/web install, census, deploy or proof reruns on the successful host");
    assert.equal(f.world().hosts[readyHost].selected, f.newer);
    assert.equal(f.world().hosts[readyHost].android, f.newer);
    assert.equal(f.world().hosts[waitingHost].selected, f.revision);
    for (const host of hostIds) assert.equal(existsSync(join(f.root, `${host}.lock.publication`)), false);
    assert.equal(JSON.parse(readFileSync(completed.finalProof.path, "utf8"))[readyHost].integrationSha, f.revision);
  });
}

for (const host of hostIds) for (const noise of ["trailing", "interleaved"]) test(`large ${noise} native history status on ${host} cannot turn pending custody into rollback`, async t => {
  const f = fixture(t, host, "native-history");
  f.update(value => { value.hosts[host].noisyStatus = noise; });
  const waiting = await f.run();
  assert.equal(waiting.status, "queued", JSON.stringify(waiting.failure));
  assert.equal(waiting.hosts[host].waiting.kind, "native-history");
  assert.equal(waiting.nativeHistory.hosts[host].state, "restore-required");
  assert.equal(waiting.hosts[hostIds.find(peer => peer !== host)].status, "passed");
  assert.equal(f.events().some(event => event.action === "native-history---restore"), false);
});

test("selected candidate with a pending Root replacement resumes its wrapper rather than passing census proof", async t => {
  const f = fixture(t, "gmktec", "executor-replacement");
  const waiting = await f.run();
  assert.equal(waiting.status, "queued", JSON.stringify(waiting.failure));
  assert.equal(waiting.hosts.gmktec.status, "waiting");
  assert.equal(waiting.hosts.gmktec.waiting.kind, "host-lock");
  assert.equal(waiting.hosts.converge.status, "passed");
  assert.equal(f.world().hosts.gmktec.selected, f.revision);
  assert.equal(f.world().hosts.gmktec.rootReplacementPending, true);
  assert.equal(waiting.executorHandoffs.gmktec.integrationSha, f.revision);
  assert.deepEqual(waiting.nativeHistory.hosts.gmktec, { state: "restore-required", integrationSha: f.revision });
  assert.equal(f.events().some(event => event.host === "gmktec" && event.action === "proof"), false);
  const peer = structuredClone(waiting.hosts.converge);
  const peerProof = readFileSync(peer.proof, "utf8");
  const boundary = f.events().length;
  const probed = await f.run("refreshHostWaits");
  assert.equal(probed.hosts.gmktec.ready, true);
  assert.deepEqual(probed.executorHandoffs, waiting.executorHandoffs);
  assert.deepEqual(probed.nativeHistory, waiting.nativeHistory);
  assert.equal(f.world().hosts.gmktec.rootReplacementPending, true);
  assert.equal(f.events().length, boundary, "host-lock readiness does not claim an executor was replaced");
  f.update(value => {
    value.hosts.gmktec.mode = "ready";
    value.hosts.converge.selected = f.newer;
    value.hosts.converge.android = f.newer;
  });
  const completed = await f.run();
  assert.equal(completed.status, "published", JSON.stringify(completed.failure));
  assert.equal(completed.attempt, waiting.attempt);
  assert.equal(completed.executorHandoffs.gmktec, undefined);
  assert.equal(completed.nativeHistory.hosts.gmktec.state, "released");
  assert.equal(f.world().hosts.gmktec.rootReplacementPending, false);
  const resumed = f.events().slice(boundary);
  assert.ok(resumed.every(event => event.host === "gmktec"), "successful peer never re-enters delivery");
  assert.deepEqual(resumed.filter(event => ["deploy", "prepare", "host-native-history-advance", "root-executor-replaced", "proof"].includes(event.action)).map(event => event.action),
    ["deploy", "prepare", "host-native-history-advance", "root-executor-replaced", "proof"]);
  assert.deepEqual(completed.hosts.converge, peer);
  assert.equal(readFileSync(peer.proof, "utf8"), peerProof);
  assert.equal(f.world().hosts.converge.selected, f.newer);
  for (const host of hostIds) assert.equal(existsSync(join(f.root, `${host}.lock.publication`)), false);
});

for (const mode of ["history-probe-error", "history-unmarked-busy"]) test(`${mode} fails once with causal repair, preserving maintenance and successful peer custody`, async t => {
  const f = fixture(t, "gmktec", "native-history");
  const waiting = await f.run();
  const completedPeer = structuredClone(waiting.hosts.converge);
  const proof = readFileSync(completedPeer.proof, "utf8");
  f.update(value => { value.hosts.gmktec.mode = mode; });
  const boundary = f.events().length;
  const failed = await f.run("refreshHostWaits");
  assert.equal(failed.status, "failed");
  assert.equal(failed.hosts.gmktec.status, "failed");
  assert.equal(failed.failure.reason, "readiness-probe-failed");
  assert.match(failed.failure.message, /source custody mismatch/);
  const causal = failed.hosts.gmktec.failure.waiting;
  assert.equal(causal.kind, "native-history");
  assert.match(causal.probe.error, /source custody mismatch/);
  assert.equal(causal.probe.failure.status, mode === "history-unmarked-busy" ? 75 : 66);
  assert.equal(causal.probe.failure.mode, "probe");
  assert.equal(causal.probe.failure.command[0], "bash");
  assert.equal(failed.failure.hosts.gmktec.waiting.probe.error, causal.probe.error);
  const repair = JSON.parse(readFileSync(join(f.root, "repairs", id, "receipt.json"), "utf8"));
  assert.equal(repair.status, "pending");
  assert.equal(repair.integrationSha, f.revision);
  assert.deepEqual(repair.failure, failed.failure);
  assert.equal(failed.nextAttemptAt, undefined);
  assert.equal(failed.nativeHistory.hosts.gmktec.state, "repair-required", "a failed probe cannot prove rollback safe");
  assert.deepEqual(failed.hosts.converge, completedPeer);
  assert.equal(readFileSync(completedPeer.proof, "utf8"), proof);
  assert.deepEqual(f.events().slice(boundary).map(event => [event.host, event.action]), [["gmktec", "native-history---probe"]]);
  if (mode === "history-probe-error") {
    await f.run("drain");
    await f.run("drain");
    assert.equal(f.events().filter(event => event.action === "native-history---restore").length, 0, "worker restart cannot restore unknown closure automatically");
    writeFileSync(repair.path, JSON.stringify({ ...repair, outcome: { status: "infrastructure-fixed", evidence: join(f.root, "proof.json") } }));
    await assert.rejects(f.run("_retry"), /custody remains repair-held/);
    writeFileSync(repair.path, JSON.stringify(repair));
    await assert.rejects(f.run("recover-native-history"), /restoration refused/);
    const retained = JSON.parse(readFileSync(f.requestPath, "utf8"));
    assert.equal(retained.status, "failed");
    assert.equal(retained.nativeHistory.hosts.gmktec.state, "repair-required");
    assert.match(retained.nativeHistoryRecoveries.at(-1).error, /restoration refused/);
    assert.deepEqual(retained.failure, failed.failure, "restoration failure cannot replace the causal publication error");
    assert.deepEqual(JSON.parse(readFileSync(repair.path, "utf8")), repair, "worker restarts cannot replace existing causal repair custody");
    assert.deepEqual(retained.failures, failed.failures);
    f.update(value => { value.hosts.gmktec.mode = "ready"; });
    const recovered = await f.run("recover-native-history");
    assert.equal(recovered.nativeHistory.hosts.gmktec.state, "restored");
    assert.equal(recovered.nativeHistoryRecoveries.at(-1).status, "restored");
    assert.deepEqual(recovered.nativeHistoryRecoveries.at(-1).hosts, ["gmktec"]);
    assert.deepEqual(recovered.failure, failed.failure);
    assert.deepEqual(JSON.parse(readFileSync(repair.path, "utf8")), repair);
  }
});

test("fatal history probe still permits a newly ready peer's delivery before causal failure", async t => {
  const f = fixture(t, "gmktec", "native-history");
  f.update(value => { value.hosts.converge.mode = "live-meeting"; });
  const waiting = await f.run();
  assert.equal(waiting.hosts.converge.status, "waiting");
  f.update(value => { value.hosts.gmktec.mode = "history-probe-error"; value.hosts.converge.mode = "ready"; });
  const refreshed = await f.run("refreshHostWaits");
  assert.equal(refreshed.status, "queued");
  assert.equal(refreshed.hosts.gmktec.status, "failed");
  assert.equal(refreshed.hosts.converge.ready, true);
  const boundary = f.events().length;
  const failed = await f.run();
  assert.equal(failed.status, "failed");
  assert.equal(failed.failure.reason, "readiness-probe-failed");
  assert.equal(failed.hosts.converge.status, "passed");
  assert.equal(failed.hosts.converge.integrationSha, f.revision);
  assert.equal(failed.nativeHistory.hosts.gmktec.state, "repair-required");
  assert.match(failed.failure.hosts.gmktec.waiting.probe.error, /source custody mismatch/);
  assert.equal(f.events().slice(boundary).some(event => event.host === "gmktec" && ["install-app-web", "deploy"].includes(event.action)), false);
});

for (const mode of ["native-probe-error", "native-unmarked-busy"]) test(`${mode} is a terminal source failure, not typed dependency waiting`, async t => {
  const f = fixture(t, "converge", "native-source");
  const waiting = await f.run();
  f.update(value => { value.hosts.converge.mode = mode; });
  const boundary = f.events().length;
  const failed = await f.run("refreshHostWaits");
  assert.equal(failed.status, "failed");
  assert.equal(failed.hosts.converge.failure.waiting.probe.failure.status, mode === "native-unmarked-busy" ? 75 : 66);
  assert.deepEqual(failed.hosts.gmktec, waiting.hosts.gmktec);
  assert.equal(f.events().slice(boundary).some(event => ["install-app-web", "deploy"].includes(event.action)), false);
});

test("cancellation of legitimate native history waiting restores pre-migration custody without repair", async t => {
  const f = fixture(t, "gmktec", "native-history");
  const waiting = await f.run();
  writeFileSync(join(f.root, "requests", `${id}.cancel`), "cancelled\n");
  const cancelled = await f.run();
  assert.equal(cancelled.status, "failed");
  assert.equal(cancelled.failure.reason, "cancelled");
  assert.equal(cancelled.nativeHistory.hosts.gmktec.state, "restored");
  assert.deepEqual(cancelled.hosts.converge, waiting.hosts.converge);
  assert.equal(existsSync(join(f.root, "repairs", id, "receipt.json")), false);
  assert.equal(f.events().filter(event => event.action === "native-history---restore").length, 1);
});

test("owner accepts a newer already-selected host without installing the older request's app/web", async t => {
  const f = fixture(t, "converge", "live-meeting");
  writeFileSync(join(f.root, "requests", "PUB-1123456789abcdef01234567.json"), JSON.stringify({
    requestId: "PUB-1123456789abcdef01234567", sourceSha: f.newer, integrationSha: f.newer,
    status: "queued", checks: { status: "passed" }, hosts: { gmktec: { status: "passed", integrationSha: f.newer } },
  }));
  f.update(value => {
    value.hosts.gmktec.selected = f.newer;
    value.hosts.gmktec.android = f.newer;
  });
  const request = await f.run();
  assert.equal(request.status, "queued", JSON.stringify(request.failure));
  assert.equal(request.hosts.gmktec.status, "passed");
  assert.equal(request.hosts.gmktec.superseded, true);
  assert.equal(request.hosts.gmktec.integrationSha, f.newer);
  assert.equal(request.hosts.gmktec.android.revision, f.newer);
  assert.equal(request.hosts.gmktec.android.web.revision, f.newer);
  assert.equal(f.events().some(event => event.host === "gmktec" && ["install-app-web", "deploy"].includes(event.action)), false);
  assert.equal(f.world().hosts.gmktec.selected, f.newer);
  assert.equal(f.world().hosts.gmktec.android, f.newer);
  assert.equal(existsSync(join(f.root, "gmktec.lock.publication")), false);
});

for (const divergentHost of hostIds) test(`divergent ancestry on ${divergentHost} stops only that host before artifacts or activation`, async t => {
  const f = fixture(t, divergentHost, "ready");
  const readyHost = hostIds.find(host => host !== divergentHost);
  f.git("checkout", "-q", "--detach", f.baseline);
  f.git("commit", "--allow-empty", "-qm", "divergent host source");
  const divergent = f.git("rev-parse", "HEAD");
  f.git("checkout", "-q", "--detach", f.revision);
  f.update(value => { value.hosts[divergentHost].selected = divergent; });
  const request = await f.run();
  assert.equal(request.status, "failed");
  assert.equal(request.hosts[divergentHost].status, "failed");
  assert.match(request.hosts[divergentHost].failure.message, /integration omits selected or checkout source/);
  const ancestry = JSON.parse(readFileSync(join(f.root, "proofs", id, `${divergentHost}-release-ancestry.json`), "utf8"));
  assert.equal(ancestry.ok, false);
  assert.deepEqual(ancestry.baselines.map(baseline => [baseline.kind, baseline.commit, baseline.included]),
    [["live", divergent, false], ["checkout", divergent, false]]);
  assert.equal(request.hosts[readyHost].status, "passed");
  assert.equal(request.hosts[readyHost].android.web.revision, f.revision);
  assert.equal(f.world().hosts[readyHost].selected, f.revision);
  assert.equal(f.world().hosts[divergentHost].selected, divergent);
  assert.ok(f.events().filter(event => event.host === divergentHost)
    .every(event => ["reserve", "census", "release"].includes(event.action)));
  for (const host of hostIds) {
    assert.equal(request.reservations[host].state, "released");
    assert.equal(existsSync(join(f.root, `${host}.lock.publication`)), false);
  }
});

test("owner failure on the first host still commits the second host's matched release and releases custody", async t => {
  const f = fixture(t, "gmktec", "failed");
  const request = await f.run();
  assert.equal(request.status, "failed");
  assert.match(request.failure.message, /gmktec.*release wrapper exited 42/);
  assert.equal(request.hosts.gmktec.status, "failed");
  assert.equal(request.hosts.converge.status, "passed");
  assert.equal(request.hosts.converge.android.web.revision, f.revision);
  assert.equal(f.world().hosts.converge.selected, f.revision);
  for (const host of hostIds) {
    assert.equal(request.reservations[host].state, "released");
    assert.equal(existsSync(join(f.root, `${host}.lock.publication`)), false);
  }
});
});

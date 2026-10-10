import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test, { describe } from "node:test";
import { hostWaitKind, mergeHostLanes } from "../deploy/publication-hosts.mjs";
import { progressBudgetExhausted } from "../deploy/publication-control.mjs";
import { publicationConfig } from "./publication-fixture.mjs";

const hostIds = ["gmktec", "converge"];
const publication = process.env.PI_PUBLICATION_TEST_COMMAND ?? new URL("../deploy/publication", import.meta.url).pathname;
const id = "PUB-0123456789abcdef01234567";

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
} else if (name === "systemctl") {
  appendFileSync(join(root, "units.jsonl"), JSON.stringify(args) + "\n");
  if (args.includes("show")) { process.stdout.write("inactive\n"); process.exit(0); }
  if (args.includes("start")) {
    const unit = args.find(value => value.startsWith("pi-stack-publication-host@"));
    if (unit) {
      const result = spawnSync(process.execPath, [process.env.FIXTURE_PUBLICATION, "host-run", unit.slice("pi-stack-publication-host@".length, -".service".length)], { encoding: 'utf8', timeout: 15000, env: process.env });
      if (result.status !== 0) appendFileSync(join(root, 'unit-errors'), result.stderr + '\n' + result.error + '\n');
      process.stderr.write(result.stderr);
      process.exit(result.status ?? 1);
    }
  }
} else if (name === "git") {
  const position = args.findIndex(value => value === "fetch" || value === "push");
  const remote = args.indexOf("origin", position);
  if (position !== -1 && remote !== -1) args[remote] = join(root, "origin.git");
  exec("/usr/bin/git", args);
} else if (name === "bash") {
  if (args[0] === "-c" && args[1].includes("npm run check")) {
    event("post-source-checks");
    process.exit(world().hosts[host].mode === "post-checks-failed" ? 42 : 0);
  }
  if (args[0] !== "-s") throw new Error("Unexpected fixture bash invocation " + JSON.stringify(args));
  const script = readFileSync(0, "utf8");
  args = args.slice(1);
  if (args[0] === "--") args.shift();
  if (script.includes('git -C "$1" fetch --quiet --no-tags origin "$2"')) {
    exec('/bin/bash', ['-s', '--', ...args], { input: script });
  } else if (script.includes('read -r commit < /srv/pi/pi-remote/.pi-stack-commit') || script.includes('read -r selected < /srv/pi/pi-remote/.pi-stack-commit')) {
    event('selected-source');
    process.stdout.write(world().hosts[host].selected);
  } else if (script.includes("'{remoteCommit:$remote,orchestratorCommit:$orchestrator}'")) {
    const state = world().hosts[host];
    event('proof', { revision: state.selected });
    json({ remoteCommit: state.selected, orchestratorCommit: state.orchestratorSelected ?? state.selected });
  } else if (script.includes('operation=$1') && script.includes('pi_stack_acquire_host_lock')) {
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
    event("qualification", { revision: args[0] });
    if (world().hosts[host].selected !== args[0]) throw new Error("proof selected source mismatch");
    json({ host, integrationSha: args[0], remoteCommit: args[0], orchestratorCommit: args[0], voiceCommit: args[0] });
  } else if (script.includes('"$control/deploy/runtime-doctors"')) {
    event('post-doctors');
    json({ status: 'passed' });
  } else if (script.includes('root=/var/lib/pi-remote/app-updates/current')) {
    event("matched-app-web-proof");
    const android = world().hosts[host].android;
    json({ revision: android, web: { revision: android } });
  } else if (script.includes('Phone census unavailable') && script.includes('activeCalls')) {
    event("telephone-probe");
    const mode = world().hosts[host].mode;
    if (mode === "phone-census-error") { process.stderr.write("Phone census unavailable\n"); process.exit(66); }
    if (mode === "phone-census-invalid") process.stdout.write('{"activeCalls":null}\n');
    else json({ activeCalls: mode === "live-telephone" ? 1 : 0 });
  } else if (script.includes('meetingCensus') && script.includes('rooms')) {
    event("meeting-probe");
    if (world().hosts[host].mode === "live-meeting") process.stdout.write("fixture-room:1\n");
  } else {
    throw new Error("Unknown host script boundary: " + script.slice(0, 150));
  }
} else if (name === "bun") {
  const [tool, operation, path] = args;
  if (operation === "plan") {
    json({ kind: "native" });
  } else if (operation === "bundle") {
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
} else if (name === "npm") {
  assert.deepEqual(args, ["run", "android:test", "--workspace=kenan"]);
  event("post-android-tests");
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
  const { mergeHostLanes } = await import(process.env.FIXTURE_LANES_MODULE);
  const request = mergeHostLanes(JSON.parse(readFileSync(join(root, "requests", "PUB-0123456789abcdef01234567.json"), "utf8")), join(root, "host-lanes"), [{id:host}]);
  const custody = request.nativeHistory.hosts[host];
  assert.deepEqual(custody, { state: "restore-required", integrationSha: args[0] }, "wrapper starts only after durable native custody");
  assert.equal(request.android.release.revision, args[0], "checked app/web artifact is prepared before wrapper preparation");
  event("deploy", { revision: args[0], custody });
  if (mode === "failed") { process.stderr.write("fixture activation failed\n"); process.exit(42); }
  if (mode === "live-meeting") { process.stderr.write("live meeting rooms on this host (fixture-room:1); deploying now would end them\n"); process.exit(75); }
  if (mode === "native-source") {
    process.stderr.write("native source prerequisite fixture requires " + "f".repeat(40) + " before Pi Stack " + args[0] + "; selected " + "e".repeat(40) + "\n");
    process.exit(75);
  }
  if (mode === "host-lock") { process.stderr.write("another Pi stack deployment owns /fixture/deploy.lock\n"); process.exit(75); }
  if (mode === "live-telephone") { process.stderr.write("Live telephone calls; defer deployment\n"); process.exit(75); }
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
  if (mode === "mismatched-markers") state.hosts[host].orchestratorSelected = state.hosts[host].selected;
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
  const candidateDeploy = new URL('../deploy/', pathToFileURL(publication));
  for (const name of readdirSync(candidateDeploy).filter(name => name.startsWith('publication') || ['action-journal.mjs', 'release-checkout', 'meeting-census', 'phone-census', 'native-prerequisites'].includes(name))) {
    copyFileSync(new URL(name, candidateDeploy), join(repository, 'deploy', name));
  }
  mkdirSync(join(repository, "deploy/systemd"));
  for (const name of readdirSync(new URL('systemd/', candidateDeploy)).filter(name => name.startsWith('pi-stack-publication'))) {
    copyFileSync(new URL(`systemd/${name}`, candidateDeploy), join(repository, 'deploy/systemd', name));
  }
  writeFileSync(join(repository, "deploy/android-update"), "fixture artifact capability\n");
  writeFileSync(join(repository, "deploy/native-history-boundary"), "# native-history-boundary-fixture\n");
  writeFileSync(join(repository, "deploy/native-history-bridge.mjs"), "export const MAINTENANCE_INTAKE = 'always-open-v1';\n");
  git("add", ".");
  git("commit", "-qm", "selected baseline");
  const baseline = git("rev-parse", "HEAD");
  git("commit", "--allow-empty", "-qm", "requested integration");
  const revision = git("rev-parse", "HEAD");
  git("update-ref", `refs/heads/pi-stack-publications/${id}`, revision);
  writeFileSync(join(root, 'owner-code.json'), JSON.stringify({ version: 1, sourceSha: revision }));
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
  for (const command of ["bash", "ssh", "sudo", "bun", "npm", "rsync", "release", "git", "systemctl"]) {
    writeFileSync(join(root, "bin", command), `#!${process.execPath}\n${hostCommand}`, { mode: 0o700 });
  }
  writeFileSync(join(root, 'bin', 'timeout'), '#!/bin/sh\nif [ "$3" = systemctl ] && [ "$5" = start ]; then shift; shift; exec /usr/bin/timeout --kill-after=2s 15s "$@"; fi\nexec /usr/bin/timeout "$@"\n', { mode: 0o700 });
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
  const request = { requestId: id, sourceSha: revision, sourceRef: `refs/heads/pi-stack-publications/${id}`, integrationSha: revision,
    sourceSelection: { status: "pinned", sourceSha: revision }, baseSha: revision,
    integratedAt: new Date().toISOString(), checks: { status: "deferred", phase: "post-serving", androidPlan: { kind: "native" } }, status: "queued", attempt: 0, failures: [],
    android: { release, directory, manifest: join(directory, "manifest.json"), status: "prepared", hosts: {} } };
  writeFileSync(requestPath, JSON.stringify(request));
  const env = { ...process.env, PATH: `${root}/bin:${process.env.PATH}`, FIXTURE_ROOT: root,
    PI_STACK_PUBLICATION_STATE: root, PI_STACK_PUBLICATION_CONFIG: configPath, PI_STACK_HOST_FILE: join(root, "host.json"),
    PI_STACK_HOST_LOCK_PATH: join(root, "gmktec.lock"), PI_STACK_PUBLICATION_ALERT_INBOX: join(root, "inbox"),
    FIXTURE_PUBLICATION: publication, FIXTURE_LANES_MODULE: new URL('../deploy/publication-hosts.mjs', import.meta.url).href };
  const readRequest = () => mergeHostLanes(JSON.parse(readFileSync(requestPath, 'utf8')), join(root, 'host-lanes'), hostIds.map(id => ({ id })));
  const run = async (operation = "processRequest") => {
    const args = operation === "post-gmktec" ? [publication, "_post-run", readRequest().hostDelivery.gmktec.inputPath]
      : ["recover-native-history", "_retry"].includes(operation) ? [publication, operation, id, ...(operation === "recover-native-history" ? ["gmktec"] : [])] : ["--input-type=module", "-e", `
      import { readFileSync } from "node:fs";
      import { ${operation} } from ${JSON.stringify(pathToFileURL(publication).href)};
      ${operation}(JSON.parse(readFileSync(${JSON.stringify(requestPath)}, "utf8")));
    `];
    const child = spawn(process.execPath, args, { env, timeout: 30000, stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stdout.resume();
    child.stderr.on("data", chunk => stderr += chunk);
    const status = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
    assert.equal(status, 0, stderr);
    return readRequest();
  };
  const events = () => existsSync(join(root, "events.jsonl")) ? readFileSync(join(root, "events.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line)) : [];
  const world = () => JSON.parse(readFileSync(worldPath, "utf8"));
  const update = change => { const value = world(); change(value); writeFileSync(worldPath, JSON.stringify(value)); };
  return { root, run, readRequest, events, world, update, revision, newer, baseline, git, requestPath, env };
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
  for (const host of hostIds) {
    const installs = f.events().filter(event => event.host === host && event.action === 'install-app-web');
    assert.equal(installs.length, 1, `${host} installs its checked client once, before activation`);
    assert.ok(f.events().some(event => event.host === host && event.action === 'proof'), `${host} records exact serving markers after activation`);
    assert.equal(f.events().some(event => event.host === host && event.action === 'matched-app-web-proof'), false, 'artifact qualification is post-serving work');
  }
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
test("fresh delivery pins the submitted SHA and serves both hosts before deferred qualification", async t => {
  const f = fixture(t, "gmktec", "ready");
  f.git("update-ref", "refs/pi-stack-publication/owner-source", f.revision);
  const initial = JSON.parse(readFileSync(f.requestPath, "utf8"));
  for (const key of ["sourceSelection", "integrationSha", "baseSha", "integratedAt", "checks"]) delete initial[key];
  writeFileSync(f.requestPath, JSON.stringify(initial));
  const served = await f.run();
  assert.equal(served.status, "published", JSON.stringify(served.failure));
  assert.equal(served.integrationSha, f.revision, "concurrent main must not create a synthetic integration");
  assert.equal(served.sourceSelection.sourceSha, f.revision);
  assert.equal(served.checks.status, "deferred");
  assert.equal(served.checks.phase, "post-serving");
  assert.equal(served.mainPublication.status, "not-advanced");
  for (const host of hostIds) {
    const proof = JSON.parse(readFileSync(served.hosts[host].proof, "utf8"));
    assert.equal(proof.remoteCommit, f.revision);
    assert.equal(proof.orchestratorCommit, f.revision);
    assert.equal(proof.acceptance.kind, "service-start");
    assert.equal(f.world().hosts[host].selected, f.revision);
  }
  assert.equal(f.events().some(event => ["census", "qualification", "post-source-checks", "post-android-tests", "matched-app-web-proof"].includes(event.action)), false);
  const units = readFileSync(join(f.root, "units.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
  for (const host of hostIds) assert.ok(units.some(args => args.includes("start") && args.includes("--no-block")
    && args.includes(`pi-stack-publication-post@${id}--${f.revision}--${host}.service`)), `${host} hands qualification to a separate post-serving unit`);
});

test("failed post-serving checks retain published source, peer proof and host custody", async t => {
  const f = fixture(t, "gmktec", "ready");
  const served = await f.run();
  assert.equal(served.status, "published", JSON.stringify(served.failure));
  const peer = structuredClone(served.hosts.converge);
  const proof = readFileSync(peer.proof, "utf8");
  const boundary = f.events().length;
  f.update(value => { value.hosts.gmktec.mode = "post-checks-failed"; });
  const diagnosed = await f.run("post-gmktec");
  assert.equal(diagnosed.status, "published");
  assert.deepEqual(diagnosed.hosts, served.hosts);
  assert.deepEqual(diagnosed.nativeHistory, served.nativeHistory);
  assert.deepEqual(diagnosed.reservations, served.reservations);
  assert.deepEqual(diagnosed.hosts.converge, peer);
  assert.equal(readFileSync(peer.proof, "utf8"), proof);
  const receipt = JSON.parse(readFileSync(join(f.root, "post-serving", id, f.revision, "gmktec.json"), "utf8"));
  assert.equal(receipt.status, "failed");
  assert.equal(receipt.results.checks.exitCode, 42);
  assert.equal(receipt.results.androidTests.status, "passed", JSON.stringify(receipt) + readFileSync(receipt.log, "utf8"));
  assert.equal(receipt.results.hostProof.status, "passed", JSON.stringify(receipt) + readFileSync(receipt.log, "utf8"));
  assert.equal(receipt.results.androidProof.status, "passed");
  assert.equal(existsSync(join(f.root, "inbox", `pi-stack-post-${id}-gmktec.md`)), true);
  const after = f.events().slice(boundary);
  assert.ok(after.some(event => event.action === "post-source-checks"));
  assert.ok(after.every(event => event.host === "gmktec"));
  assert.equal(after.some(event => ["reserve", "install-app-web", "deploy", "native-history---restore"].includes(event.action)), false);
  for (const host of hostIds) assert.equal(f.world().hosts[host].selected, f.revision);
  const length = f.events().length;
  await f.run("post-gmktec");
  assert.equal(f.events().length, length, "a terminal diagnostic receipt is not replayed");
});

for (const waitingHost of hostIds) for (const mode of ["live-meeting", "live-telephone", "native-source", "native-history", "host-lock"]) {
  test(`owner releases both reservations while ${waitingHost} waits for ${mode}; old completion cannot downgrade a newer peer`, async t => {
    const f = fixture(t, waitingHost, mode);
    const readyHost = hostIds.find(host => host !== waitingHost);
    const first = await f.run();
    assert.equal(first.status, "queued", JSON.stringify(first.failure));
    assert.equal(first.hosts[waitingHost].status, "waiting");
    assert.equal(first.hosts[waitingHost].waiting.kind, mode, JSON.stringify(first.hostDelivery) + '\n' + (existsSync(join(f.root, 'unit-errors')) ? readFileSync(join(f.root, 'unit-errors'), 'utf8') : ''));
    assert.equal(first.hosts[readyHost].status, "passed", JSON.stringify(first.hostDelivery));
    assert.equal(first.hosts[readyHost].integrationSha, f.revision);
    assert.equal(first.hosts[readyHost].android.revision, f.revision);
    assert.equal(first.hosts[readyHost].android.web.revision, f.revision);
    if (mode === "native-history") {
      assert.equal(first.nativeHistory.hosts[waitingHost].state, "restore-required");
      assert.equal(f.world().hosts[waitingHost].android, f.revision, 'checked matching client is offered before server activation');
      assert.equal(first.hosts[waitingHost].proof, undefined, 'published client is not full host delivery');
      assert.equal(first.android.hosts[waitingHost].revision, f.revision);
      assert.equal(f.world().hosts[waitingHost].selected, f.baseline, "old source serves throughout immutable preparation and busy boundary");
      const custody = { state: "restore-required", integrationSha: f.revision };
      assert.deepEqual(first.nativeHistory.hosts[waitingHost], custody);
      const hostEvents = f.events().filter(event => event.host === waitingHost);
      assert.deepEqual(hostEvents.filter(event => ["install-app-web", "deploy", "prepare", "host-native-history-advance"].includes(event.action)).map(event => event.action),
        ["install-app-web", "deploy", "prepare", "host-native-history-advance"]);
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
    if (mode === "live-telephone") {
      assert.equal(hostWaitKind(first.hosts[waitingHost].waiting), "waiting-for-live-telephone-calls");
      assert.equal(progressBudgetExhausted({ ...first, waiting: { kind: mode }, attempt: 1000, blockedSince: "2020-01-01T00:00:00Z" }), false);
      const boundary = f.events().length;
      const probed = await f.run("refreshHostWaits");
      assert.equal(probed.hosts[waitingHost].ready, false);
      assert.equal(probed.hosts[waitingHost].waiting.probe.activeCalls, 1);
      assert.deepEqual(f.events().slice(boundary).map(event => [event.host, event.action]), [[waitingHost, "telephone-probe"]]);
      assert.equal(probed.attempt, first.attempt);
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
    if (["native-history", "live-telephone"].includes(mode)) {
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

for (const mode of ["phone-census-error", "phone-census-invalid"]) test(`telephone ${mode} becomes an explicit readiness failure without another deployment`, async t => {
  const f = fixture(t, "gmktec", "live-telephone");
  const waiting = await f.run();
  assert.equal(waiting.hosts.gmktec.waiting.kind, "live-telephone");
  f.update(value => { value.hosts.gmktec.mode = mode; });
  const boundary = f.events().length;
  const failed = await f.run("refreshHostWaits");
  assert.equal(failed.status, "failed");
  assert.equal(failed.hosts.gmktec.failure.reason, "readiness-probe-failed");
  assert.match(failed.hosts.gmktec.failure.waiting.probe.error, /Phone census unavailable/);
  assert.equal(failed.hosts.converge.status, "passed");
  assert.equal(failed.attempt, waiting.attempt);
  assert.ok(f.events().slice(boundary).every(event => event.action !== "deploy" && event.action !== "prepare"));
});

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
  assert.equal(waiting.hosts.gmktec.waiting.kind, "executor-handoff");
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
  assert.equal(f.events().length, boundary, "executor readiness does not claim an executor was replaced");
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
  assert.equal(resumed.some(event => event.action === 'install-app-web'), false, 'an unfinished executor handoff reuses its already checked client installation');
  assert.ok(resumed.some(event => event.action === 'proof'), 'reused installation still requires an exact serving receipt');
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
    const retained = f.readRequest();
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
    writeFileSync(repair.path, JSON.stringify({ ...repair, outcome: { status: 'infrastructure-fixed', evidence: join(f.root, 'focused-proof.json') } }));
    const retry = await f.run('_retry');
    assert.equal(retry.status, 'queued');
    assert.equal(retry.integrationSha, f.revision);
    assert.deepEqual(retry.hosts.converge, completedPeer, 'evidenced retry does not erase a successful peer');
    const afterRecovery = f.events().length;
    const published = await f.run();
    assert.equal(published.status, 'published', JSON.stringify(published.failure));
    assert.deepEqual(published.hosts.converge, completedPeer);
    assert.equal(readFileSync(completedPeer.proof, 'utf8'), proof);
    assert.ok(f.events().slice(afterRecovery).every(event => event.host === 'gmktec'), 'only the repaired host may acquire new custody');
    assert.equal(published.hosts.gmktec.integrationSha, f.revision);
    assert.ok(published.nativeHistoryRecoveries.some(receipt => receipt.status === 'failed' && /restoration refused/.test(receipt.error)));
    assert.ok(published.nativeHistoryRecoveries.some(receipt => receipt.status === 'restored' && receipt.hosts.includes('gmktec')));
  }
});

test("fatal history probe preserves causal custody while a ready peer serves and only the failed lane queues retry", async t => {
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
  const retrying = await f.run();
  assert.equal(retrying.status, "queued");
  assert.equal(retrying.hosts.converge.status, "passed");
  assert.equal(retrying.hosts.converge.integrationSha, f.revision);
  assert.equal(retrying.nativeHistory.hosts.gmktec.state, "repair-required");
  assert.equal(retrying.hostDelivery.gmktec.state, "queued");
  assert.equal(retrying.hostDelivery.gmktec.retry.failedAttempt, 1);
  const retained = JSON.parse(readFileSync(retrying.hostDelivery.gmktec.inputPath, "utf8")).request.hosts.gmktec;
  assert.equal(retained.failure.reason, "readiness-probe-failed");
  assert.match(retained.failure.waiting.probe.error, /source custody mismatch/);
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

test("an uncompleted host selects this request's exact SHA rather than inheriting another request's newer source", async t => {
  const f = fixture(t, "converge", "live-meeting");
  writeFileSync(join(f.root, "requests", "PUB-1123456789abcdef01234567.json"), JSON.stringify({
    requestId: "PUB-1123456789abcdef01234567", sourceSha: f.newer, integrationSha: f.newer,
    status: "queued", sourceSelection: { status: "pinned", sourceSha: f.newer }, checks: { status: "deferred", phase: "post-serving" },
    hosts: { gmktec: { status: "passed", integrationSha: f.newer } },
  }));
  f.update(value => {
    value.hosts.gmktec.selected = f.newer;
    value.hosts.gmktec.android = f.newer;
  });
  const request = await f.run();
  assert.equal(request.status, "queued", JSON.stringify(request.failure));
  assert.equal(request.hosts.gmktec.status, "passed");
  assert.equal(request.hosts.gmktec.superseded, undefined);
  assert.equal(request.hosts.gmktec.integrationSha, f.revision);
  assert.equal(request.hosts.gmktec.android.revision, f.revision);
  assert.equal(request.hosts.gmktec.android.web.revision, f.revision);
  assert.equal(f.events().filter(event => event.host === "gmktec" && event.action === "deploy").length, 1);
  assert.equal(f.world().hosts.gmktec.selected, f.revision);
  assert.equal(f.world().hosts.gmktec.android, f.revision);
  assert.equal(existsSync(join(f.root, "gmktec.lock.publication")), false);
});

for (const divergentHost of hostIds) test(`divergent prior selection on ${divergentHost} does not replace the requested immutable source`, async t => {
  const f = fixture(t, divergentHost, "ready");
  const readyHost = hostIds.find(host => host !== divergentHost);
  f.git("checkout", "-q", "--detach", f.baseline);
  f.git("commit", "--allow-empty", "-qm", "divergent host source");
  const divergent = f.git("rev-parse", "HEAD");
  f.git("checkout", "-q", "--detach", f.revision);
  f.update(value => { value.hosts[divergentHost].selected = divergent; });
  const request = await f.run();
  assert.equal(request.status, "published", JSON.stringify(request.failure));
  assert.equal(request.integrationSha, f.revision);
  assert.equal(request.checks.status, "deferred");
  assert.equal(request.hosts[divergentHost].status, "passed");
  assert.equal(request.hosts[divergentHost].integrationSha, f.revision);
  assert.equal(existsSync(join(f.root, "proofs", id, `${divergentHost}-release-ancestry.json`)), false, "qualification is not a pre-serving gate");
  assert.equal(request.hosts[readyHost].status, "passed");
  assert.equal(request.hosts[readyHost].android.web.revision, f.revision);
  for (const host of hostIds) assert.equal(f.world().hosts[host].selected, f.revision);
  assert.equal(f.git("rev-parse", `refs/pi-stack-publication/selected/${divergent}`), divergent, "prior source remains retained");
  assert.equal(f.events().some(event => ["census", "qualification", "matched-app-web-proof"].includes(event.action)), false);
  for (const host of hostIds) {
    assert.equal(request.reservations[host].state, "released");
    assert.equal(existsSync(join(f.root, `${host}.lock.publication`)), false);
  }
});

test("a successful activation command with mismatched source markers cannot create a serving receipt", async t => {
  const f = fixture(t, "gmktec", "mismatched-markers");
  const request = await f.run();
  assert.equal(request.status, "queued");
  assert.equal(request.hosts.gmktec.status, "failed");
  assert.match(request.hosts.gmktec.failure.message, /Host command did not select submitted source/);
  assert.equal(request.hosts.gmktec.proof, undefined);
  assert.equal(existsSync(join(f.root, "proofs", id, "gmktec.json")), false);
  assert.equal(request.hosts.converge.status, "passed");
  assert.equal(request.hosts.converge.integrationSha, f.revision);
  for (const host of hostIds) assert.equal(request.reservations[host].state, "released");
});

test("a failed host schedules its bounded retry while its peer's exact serving receipt stays committed", async t => {
  const f = fixture(t, "gmktec", "failed");
  const request = await f.run();
  assert.equal(request.status, "queued");
  assert.equal(request.failure, undefined);
  assert.match(request.hosts.gmktec.failure.message, /gmktec.*release wrapper exited 42/);
  assert.equal(request.hosts.gmktec.status, "failed");
  assert.equal(request.hostDelivery.gmktec.attempt, 1);
  assert.deepEqual(request.waiting.hosts, ["gmktec"]);
  assert.equal(request.checks.status, "deferred");
  assert.equal(request.hosts.converge.status, "passed");
  assert.equal(request.hosts.converge.android.web.revision, f.revision);
  assert.equal(f.world().hosts.converge.selected, f.revision);
  for (const host of hostIds) {
    assert.equal(request.reservations[host].state, "released");
    assert.equal(existsSync(join(f.root, `${host}.lock.publication`)), false);
  }
});
});

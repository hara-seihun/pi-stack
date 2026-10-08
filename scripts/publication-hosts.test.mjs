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
const publication = new URL("../deploy/publication", import.meta.url).pathname;
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
  const result = spawnSync(command, args, { encoding: "utf8", timeout: 3000, ...options });
  process.stdout.write(result.stdout || "");
  process.stderr.write(result.stderr || "");
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
    const mode = args[3] || "advance";
    event("native-history-" + mode, { revision: args[2], checkout: args[1] });
    if (mode !== "--restore" && world().hosts[host].mode === "native-history") {
      process.stderr.write("native history boundary waiting: fixture old generation is busy\n");
      process.exit(75);
    }
    if (mode === "--probe" && world().hosts[host].mode === "history-probe-error") {
      process.stderr.write("fixture native history status unavailable\n");
      process.exit(66);
    }
  } else if (script.includes('releasePrerequisites')) {
    event("native-probe");
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
  event("deploy", { revision: args[0] });
  if (mode === "failed") { process.stderr.write("fixture activation failed\n"); process.exit(42); }
  if (mode === "native-source") {
    process.stderr.write("native source prerequisite fixture requires " + "f".repeat(40) + " before Pi Stack " + args[0] + "; selected " + "e".repeat(40) + "\n");
    process.exit(75);
  }
  if (mode === "host-lock") { process.stderr.write("another Pi stack deployment owns /fixture/deploy.lock\n"); process.exit(75); }
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
    const child = spawn(process.execPath, ["--input-type=module", "-e", `
      import { readFileSync } from "node:fs";
      import { ${operation} } from ${JSON.stringify(pathToFileURL(publication).href)};
      ${operation}(JSON.parse(readFileSync(${JSON.stringify(requestPath)}, "utf8")));
    `], { env, timeout: 20000, stdio: ["ignore", "pipe", "pipe"] });
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
  const events = () => readFileSync(join(root, "events.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
  const world = () => JSON.parse(readFileSync(worldPath, "utf8"));
  const update = change => { const value = world(); change(value); writeFileSync(worldPath, JSON.stringify(value)); };
  return { root, run, events, world, update, revision, newer, baseline, git, requestPath };
}

describe("publication owner host delivery", { concurrency: true }, () => {
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
      assert.ok(!f.events().some(event => event.host === waitingHost && ["install-app-web", "deploy", "native-history---restore"].includes(event.action)));
      assert.equal(hostWaitKind(first.hosts[waitingHost].waiting), "waiting-for-native-history");
      assert.equal(progressBudgetExhausted({ ...first, attempt: 1000, blockedSince: "2020-01-01T00:00:00Z" }), false);
      const beforeProbe = f.events().length;
      const probed = await f.run("refreshHostWaits");
      assert.equal(probed.hosts[waitingHost].ready, false);
      assert.equal(probed.nativeHistory.hosts[waitingHost].state, "restore-required");
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

test("native history probe errors never become readiness; terminal cancellation restores maintenance custody", async t => {
  const f = fixture(t, "gmktec", "native-history");
  const waiting = await f.run();
  const completedPeer = structuredClone(waiting.hosts.converge);
  f.update(value => { value.hosts.gmktec.mode = "history-probe-error"; });
  const probed = await f.run("refreshHostWaits");
  assert.equal(probed.hosts.gmktec.ready, false);
  assert.match(probed.hosts.gmktec.waiting.probe.error, /status unavailable/);
  assert.ok(probed.hosts.gmktec.waiting.probeFailingSince);
  assert.equal(f.world().hosts.gmktec.selected, f.baseline);
  assert.equal(f.world().hosts.gmktec.android, f.baseline);
  writeFileSync(join(f.root, "requests", `${id}.cancel`), "cancelled\n");
  const cancelled = await f.run();
  assert.equal(cancelled.status, "failed");
  assert.equal(cancelled.failure.reason, "cancelled");
  assert.equal(cancelled.nativeHistory.hosts.gmktec.state, "restored");
  assert.deepEqual(cancelled.hosts.converge, completedPeer);
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

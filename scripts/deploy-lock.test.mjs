import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const helper = join(root, "deploy", "lib");
const hostLock = join(mkdtempSync(join(tmpdir(), "pi-host-lock-")), "deploy.lock");
process.env.PI_STACK_HOST_LOCK_PATH = hostLock;
after(() => rmSync(dirname(hostLock), { recursive: true, force: true }));

function start(script, args) {
  return spawn("bash", ["-c", script, "deploy-lock-test", ...args], {
    stdio: ["ignore", "pipe", "pipe"],
  });
}

async function waitForFile(path) {
  const deadline = Date.now() + 2_000;
  while (!existsSync(path)) {
    assert.ok(Date.now() < deadline, `timed out waiting for ${path}`);
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
  }
}

function waitForExit(child) {
  return new Promise((resolveExit, reject) => {
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (code === 0) resolveExit();
      else reject(new Error(`child exited with ${signal ?? code}: ${stderr}`));
    });
  });
}

test("one host deployment installs its shared dependency tree once", () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-stack-dependencies-"));
  try {
    writeFileSync(join(directory, "package.json"), "{}\n");
    writeFileSync(join(directory, "package-lock.json"), "{}\n");
    const calls = join(directory, "npm-calls");
    const result = spawnSync("bash", ["-c", `
      set -euo pipefail
      source "$1"
      root=$2
      calls=$3
      npm() {
        printf 'called\\n' >> "$calls"
        mkdir -p "$root/node_modules"
        : > "$root/node_modules/.package-lock.json"
      }
      pi_stack_prepare_dependencies "$root"
      pi_stack_prepare_dependencies "$root"
    `, "deploy-dependencies-test", helper, directory, calls], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(readFileSync(calls, "utf8"), "called\n");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("dependency receipts do not depend on checkout location", () => {
  const first = mkdtempSync(join(tmpdir(), "pi-stack-dependency-key-a-"));
  const second = mkdtempSync(join(tmpdir(), "pi-stack-dependency-key-b-"));
  try {
    for (const directory of [first, second]) {
      writeFileSync(join(directory, "package.json"), "{}\n");
      writeFileSync(join(directory, "package-lock.json"), "{\"lockfileVersion\":3}\n");
    }
    const result = spawnSync("bash", ["-c", `
      source "$1"
      pi_stack_dependency_key "$2"
      pi_stack_dependency_key "$3"
    `, "deploy-dependencies-test", helper, first, second], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    const keys = result.stdout.trim().split("\n");
    assert.equal(keys.length, 2);
    assert.equal(keys[0], keys[1]);
  } finally {
    rmSync(first, { recursive: true, force: true });
    rmSync(second, { recursive: true, force: true });
  }
});

test("a changed installed lock invalidates the dependency receipt", () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-stack-dependencies-"));
  try {
    writeFileSync(join(directory, "package.json"), "{}\n");
    writeFileSync(join(directory, "package-lock.json"), "{}\n");
    const calls = join(directory, "npm-calls");
    const result = spawnSync("bash", ["-c", `
      set -euo pipefail
      source "$1"
      root=$2
      calls=$3
      npm() {
        printf 'called\\n' >> "$calls"
        mkdir -p "$root/node_modules"
        printf 'installed\\n' > "$root/node_modules/.package-lock.json"
      }
      pi_stack_prepare_dependencies "$root"
      printf 'changed\\n' > "$root/node_modules/.package-lock.json"
      pi_stack_prepare_dependencies "$root"
    `, "deploy-dependencies-test", helper, directory, calls], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(readFileSync(calls, "utf8"), "called\ncalled\n");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("every deployment process ends before the machine-wide ceiling", () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-stack-deadline-"));
  try {
    const script = join(directory, "deploy");
    const bin = join(directory, "bin");
    const trace = join(directory, "timeout.trace");
    mkdirSync(bin);
    writeFileSync(script, `#!/usr/bin/env bash\nset -euo pipefail\nsource ${JSON.stringify(helper)}\npi_stack_enforce_deploy_deadline "$0" "$@"\nexit 99\n`, { mode: 0o755 });
    writeFileSync(join(bin, "timeout"), "#!/bin/sh\nprintf '%s\\n' \"$*\" > \"$TRACE\"\nexit 124\n", { mode: 0o755 });
    const env = {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      TRACE: trace,
    };
    const timed = spawnSync(script, [], {
      encoding: "utf8",
      env: { ...env, PI_STACK_DEPLOY_TIMEOUT_SECONDS: "1" },
    });
    assert.equal(timed.status, 124, timed.stderr);
    assert.match(readFileSync(trace, "utf8"), /--signal=TERM --kill-after=2s 1s .*\/deploy/);

    const refused = spawnSync(script, [], {
      encoding: "utf8",
      env: { ...env, PI_STACK_DEPLOY_TIMEOUT_SECONDS: "51" },
    });
    assert.equal(refused.status, 64);
    assert.match(refused.stderr, /1 through 50/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("unbounded preparation owns the deadline for component children", () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-stack-prepare-deadline-"));
  try {
    const repository = join(directory, "repo");
    const deploy = join(repository, "deploy");
    const trace = join(directory, "trace");
    mkdirSync(deploy, { recursive: true });
    copyFileSync(join(root, "deploy", "prepare"), join(deploy, "prepare"));
    chmodSync(join(deploy, "prepare"), 0o755);
    writeFileSync(join(deploy, "lib"), `pi_stack_acquire_deploy_lock() { test -z "\${PI_STACK_DEPLOY_DEADLINE_ACTIVE:-}"; }\npi_stack_prepare_builds() { test "\${PI_STACK_DEPLOY_DEADLINE_ACTIVE:-}" = 1; printf 'builds\\n' >> "$TRACE"; }\n`);
    for (const component of ["runtime", "transcription"]) {
      writeFileSync(join(deploy, component), `#!/bin/sh\ntest "\${PI_STACK_DEPLOY_DEADLINE_ACTIVE:-}" = 1\nprintf '${component}\\n' >> "$TRACE"\n`, { mode: 0o755 });
    }
    assert.equal(spawnSync("git", ["init", "-q", repository]).status, 0);
    assert.equal(spawnSync("git", ["-C", repository, "add", "deploy"]).status, 0);
    assert.equal(spawnSync("git", ["-C", repository, "-c", "user.name=test", "-c", "user.email=test@example.test", "commit", "-qm", "fixture"]).status, 0);
    const result = spawnSync(join(deploy, "prepare"), [], { encoding: "utf8", env: { ...process.env, TRACE: trace } });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(readFileSync(trace, "utf8").trim().split("\n").sort(), ["builds", "runtime", "transcription"]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("release identity follows the reviewed source commit", () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-stack-release-identity-"));
  try {
    const repository = join(directory, "repo");
    const releases = join(directory, "releases");
    assert.equal(spawnSync("git", ["init", "-q", repository]).status, 0);
    writeFileSync(join(repository, "source"), "first\n");
    assert.equal(spawnSync("git", ["-C", repository, "add", "source"]).status, 0);
    assert.equal(spawnSync("git", ["-C", repository, "-c", "user.name=test", "-c", "user.email=test@example.test", "commit", "-qm", "first"]).status, 0);
    const firstCommit = spawnSync("git", ["-C", repository, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();
    const first = spawnSync("bash", ["-c", 'source "$1"; pi_stack_release_for_commit "$2" "$3"', "release-identity-test", helper, repository, releases], { encoding: "utf8" });
    assert.equal(first.status, 0, first.stderr);
    assert.equal(first.stdout.trim(), join(releases, firstCommit));

    writeFileSync(join(repository, "source"), "second\n");
    assert.equal(spawnSync("git", ["-C", repository, "add", "source"]).status, 0);
    assert.equal(spawnSync("git", ["-C", repository, "-c", "user.name=test", "-c", "user.email=test@example.test", "commit", "-qm", "second"]).status, 0);
    const secondCommit = spawnSync("git", ["-C", repository, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();
    const second = spawnSync("bash", ["-c", 'source "$1"; pi_stack_release_for_commit "$2" "$3"', "release-identity-test", helper, repository, releases], { encoding: "utf8" });
    assert.equal(second.status, 0, second.stderr);
    assert.equal(second.stdout.trim(), join(releases, secondCommit));
    assert.notEqual(first.stdout, second.stdout);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("component publication atomically replaces directories and symlinks", () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-stack-release-"));
  try {
    const repository = join(directory, "repo");
    assert.equal(spawnSync("git", ["init", "-q", repository]).status, 0);
    writeFileSync(join(repository, "source"), "source\n");
    assert.equal(spawnSync("git", ["-C", repository, "add", "source"]).status, 0);
    assert.equal(spawnSync("git", ["-C", repository, "-c", "user.name=test", "-c", "user.email=test@example.test", "commit", "-qm", "source"]).status, 0);
    const commit = spawnSync("git", ["-C", repository, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();
    const stage = join(directory, "stage");
    const destination = join(directory, "component");
    const releases = join(directory, "releases");
    const result = spawnSync("bash", ["-c", `
      set -euo pipefail
      source "$1"
      mkdir -p "$3" "$4"
      printf old > "$4/value"
      printf first > "$3/value"
      printf '%s\\n' "$5" > "$3/.pi-stack-commit"
      PI_STACK_DEPLOY_NO_SUDO=1 PI_STACK_RELEASES_ROOT="$6" pi_stack_publish_release "$2" "$3" "$4" component
      test -L "$4"
      test "$(cat "$4/value")" = first
      printf changed > "$3/value"
      PI_STACK_DEPLOY_NO_SUDO=1 PI_STACK_RELEASES_ROOT="$6" pi_stack_publish_release "$2" "$3" "$4" component
      test "$(cat "$4/value")" = first
      printf second > "$3/value"
      PI_STACK_DEPLOY_NO_SUDO=1 PI_STACK_RELEASES_ROOT="$6" pi_stack_publish_release "$2" "$3" "$4" component-next
      test -L "$4"
      test "$(cat "$4/value")" = second
      test -z "$(find "$6" -name '.activate.*' -print -quit)"
    `, "deploy-release-test", helper, repository, stage, destination, commit, releases], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

for (const enableGuest of [false, true]) test(`host deployment activates Pi Remote and reconciles daemons with guest ${enableGuest ? "enabled" : "disabled"}`, () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-stack-host-current-"));
  try {
    const repository = join(directory, "repo"), deploy = join(repository, "deploy"), remoteApp = join(repository, "apps", "remote"), bin = join(directory, "bin");
    mkdirSync(deploy, { recursive: true });mkdirSync(remoteApp, { recursive: true });mkdirSync(bin);
    copyFileSync(join(root, "deploy", "host"), join(deploy, "host"));chmodSync(join(deploy, "host"), 0o755);
    copyFileSync(join(root, "deploy", "release-checkout"), join(deploy, "release-checkout"));
    writeFileSync(join(deploy, "lib"), `${readFileSync(join(root, "deploy", "lib"), "utf8")}\npi_stack_prepare_builds() { return "\${BUILD_EXIT:-0}"; }\n`);
    const component=`#!/usr/bin/env bash\nset -euo pipefail\nname=$(basename "$0")\ncommit=$(git -C "$(cd "$(dirname "$0")/.." && pwd)" rev-parse HEAD)\ncase "$name" in transcription) exit 0;; runtime) destination=$PI_STACK_RUNTIME_DEST;; orchestrator) destination=$PI_STACK_ORCHESTRATOR_DEST;; tools) destination=$PI_STACK_TOOLS_DEST;; skills) destination=$PI_STACK_SKILLS_DEST;; settings) printf '%s\\n' "$1" >> "$SETTINGS_TRACE"; exit 0;;\n remote) destination=$PI_STACK_REMOTE_DEST; release="$(dirname "$destination")/.pi-stack-releases/remote/$commit"; mkdir -p "$release/dist" "$release/server/voice"; touch "$release/server/voice/service.ts"; printf '%s\\n' "$commit" > "$release/.pi-stack-commit"; ln -sfn "$release" "$destination.tmp"; mv -Tf "$destination.tmp" "$destination"; exit 0;; esac\nmkdir -p "$destination/dist"\nprintf '%s\\n' "$commit" > "$destination/.pi-stack-commit"\n`;
    for(const name of ["runtime","transcription","orchestrator","remote","tools","skills","settings"]){writeFileSync(join(deploy,name),component);chmodSync(join(deploy,name),0o755);}
    writeFileSync(join(deploy,"smoke"),"#!/bin/sh\nexit \"${SMOKE_EXIT:-0}\"\n");chmodSync(join(deploy,"smoke"),0o755);
    writeFileSync(join(deploy,"voice"),"#!/bin/sh\nprintf '%s\\n' \"$1\" >> \"$VOICE_TRACE\"\ncase $1 in --check) exit \"${VOICE_CHECK_EXIT:-0}\";; --activate) exit 0;; *) exit 64;; esac\n",{mode:0o755});
    mkdirSync(join(repository,"packages/runtime"),{recursive:true});
    writeFileSync(join(repository,"packages/runtime/browser-doctor.mjs"), "process.exit(Number(process.env.BROWSER_SMOKE_EXIT ?? 0));\n");
    // Activation hands the supervisor the selected release; its health then names that commit.
    writeFileSync(join(remoteApp,"activate"),"#!/bin/sh\nprintf '%s\\n' \"${PI_REMOTE_SERVICE:-}\" >> \"$ACTIVATE_TRACE\"\ncat \"$PI_STACK_REMOTE_DEST/.pi-stack-commit\" > \"$SUPERVISOR_COMMIT\"\n");chmodSync(join(remoteApp,"activate"),0o755);
    assert.equal(spawnSync("git",["init","-q",repository]).status,0);assert.equal(spawnSync("git",["-C",repository,"add","deploy","apps","packages"]).status,0);assert.equal(spawnSync("git",["-C",repository,"-c","user.name=test","-c","user.email=test@example.test","commit","-qm","fixture"]).status,0);
    const destinations=Object.fromEntries(["RUNTIME","ORCHESTRATOR","REMOTE","TOOLS","SKILLS"].map((name)=>[`PI_STACK_${name}_DEST`,join(directory,name.toLowerCase())]));
    const user=process.env.USER??spawnSync("id",["-un"],{encoding:"utf8"}).stdout.trim();
    const hostFile=join(directory,"host.json");writeFileSync(hostFile,JSON.stringify({version:1,fleetUser:user}));
    const personsDir = join(directory, "persons");
    mkdirSync(personsDir);
    for (const person of [
      { user: "alice", displayName: "Alice", port: 18798 },
      { user: "guest-person", displayName: "Guest", port: 18799 },
    ]) {
      writeFileSync(join(personsDir, `${person.user}.json`), JSON.stringify({ version: 1, ...person, environment: {} }));
    }
    // Model account switching at the process boundary, without requiring fixture users on the host.
    const personReadTrace = join(directory, "person-read.trace");
    const switchUser = `#!/bin/sh
set -eu
if [ "$1" = -n ]; then shift; fi
[ "$1" = -u ] || exit 64
user=$2
shift 2
if [ "$1" = -- ]; then shift; fi
case $user in alice|guest-person) ;; *) exit 64;; esac
printf '%s\\n' "$user" >> "$PERSON_READ_TRACE"
[ "$(stat -c %a "$PI_REMOTE_PERSONS_DIR/$user.json")" = 644 ] || exit 1
exec "$@"
`;
    for (const command of ["sudo", "runuser"]) {
      writeFileSync(join(bin, command), switchUser, { mode: 0o755 });
    }
    const activationTrace=join(directory,"activation.trace"),systemctlTrace=join(directory,"systemctl.trace"),settingsTrace=join(directory,"settings.trace"),supervisorCommit=join(directory,"supervisor.commit");
    writeFileSync(join(bin, "systemctl"), `#!/bin/sh
printf '%s\\n' "$*" >> "$SYSTEMCTL_TRACE"
case $1 in
  list-unit-files) exit 1;;
  list-units)
    printf '%s\\n' 'pi-model-broker.service loaded active running' 'pi-stack-model-broker@alice.service loaded active running' 'pi-remote@alice.service loaded active running' 'pi-orchestrator@alice.service loaded active running' 'pi-orchestrator@running-person.service loaded active running';;
  show)
    [ "\${DISCOVERY_EXIT:-0}" = 0 ] || exit "$DISCOVERY_EXIT"
    case $4 in
      pi-orchestrator@alice.service) echo "\${ALICE_UNIT_STATE:-enabled}";;
      pi-orchestrator@guest-person.service) echo "\${GUEST_UNIT_STATE:-${enableGuest ? "enabled-runtime" : "disabled"}}";;
      *) echo static;;
    esac;;
  restart)
    case $2 in pi-orchestrator@*) exit "\${DAEMON_RESTART_EXIT:-0}";; esac;;
  is-active|reset-failed) exit 0;;
  *) exit 64;;
esac
exit 0
`, { mode: 0o755 });
    // The front door names its unlocked people; each supervisor names the release it runs.
    writeFileSync(join(bin, "curl"), `#!/bin/sh
for arg; do
  case $arg in
    http://127.0.0.1:8788/v1/router-health)
      printf '{"people":[{"user":"alice","unlocked":true},{"user":"guest-person","unlocked":false}]}\\n'
      exit 0;;
    http://127.0.0.1:18798/v1/health)
      printf '%s\\n' "$arg" >> "$HEALTH_TRACE"
      printf '{"releaseCommit":"%s"}\\n' "$(cat "$SUPERVISOR_COMMIT" 2>/dev/null)"
      exit 0;;
  esac
done
printf 'Unexpected deployment HTTP request: %s\\n' "$*" >&2
exit 64
`, { mode: 0o755 });
    const env={...process.env,...destinations,PATH:`${bin}:${process.env.PATH}`,ACTIVATE_TRACE:activationTrace,VOICE_TRACE:join(directory,"voice.trace"),SUPERVISOR_COMMIT:supervisorCommit,SYSTEMCTL_TRACE:systemctlTrace,SETTINGS_TRACE:settingsTrace,HEALTH_TRACE:join(directory,"health.trace"),PI_REMOTE_PERSONS_DIR:personsDir,PI_REMOTE_ROUTER_PORT:"8788",PI_STACK_DEPLOY_NO_SUDO:"1",PI_STACK_ALLOW_DIRTY:"1",PI_STACK_SERVICES:"1"};
    env.PERSON_READ_TRACE = personReadTrace;
    for (const person of ["alice", "guest-person"]) {
      const config = join(personsDir, `${person}.json`);
      chmodSync(config, 0o600);
      const unreadable = spawnSync(join(deploy, "host"), [hostFile], { encoding: "utf8", env });
      assert.equal(unreadable.status, 1, unreadable.stderr);
      assert.ok(unreadable.stderr.includes(`${config} is not readable valid configuration for ${person}`));
      for (const destination of Object.values(destinations)) {
        assert.equal(existsSync(destination), false, "person preflight must precede component publication");
      }
      for (const trace of [systemctlTrace, settingsTrace, activationTrace, env.VOICE_TRACE]) {
        assert.equal(existsSync(trace), false, "person preflight must precede account and service changes");
      }
      chmodSync(config, 0o644);
    }
    const discoveryFailure = spawnSync(join(deploy,"host"),[hostFile],{encoding:"utf8",env:{...env,DISCOVERY_EXIT:"1"}});
    assert.equal(discoveryFailure.status, 1, discoveryFailure.stderr);
    assert.match(discoveryFailure.stderr, /could not discover Orchestrator daemon units/);
    assert.equal(existsSync(destinations.PI_STACK_RUNTIME_DEST), false, "failed discovery cannot publish components");
    rmSync(systemctlTrace);
    const buildFailure = spawnSync(join(deploy,"host"),[hostFile],{encoding:"utf8",env:{...env,BUILD_EXIT:"1"}});
    assert.equal(buildFailure.status, 1, buildFailure.stderr);
    assert.equal(existsSync(destinations.PI_STACK_REMOTE_DEST), false, "failed preparation cannot select Remote");
    assert.doesNotMatch(readFileSync(systemctlTrace, "utf8"), /^restart /m, "failed preparation cannot activate services");
    rmSync(env.VOICE_TRACE, { force: true });
    rmSync(personReadTrace);
    const first=spawnSync(join(deploy,"host"),[hostFile],{encoding:"utf8",env,cwd:directory});assert.equal(first.status,0,first.stderr);
    assert.doesNotMatch(first.stderr, /fatal: not a git repository/, "preflight resolves the source commit independently of caller cwd");
    assert.deepEqual(readFileSync(personReadTrace, "utf8").trim().split("\n"), ["alice", "guest-person"], "preflight reads both unlocked and locked people through their own accounts");
    const firstUnits=readFileSync(systemctlTrace,"utf8");
    const expectedDaemons = [user, "alice", "running-person", ...(enableGuest ? ["guest-person"] : [])]
      .map(person => `pi-orchestrator@${person}.service`).sort();
    const restartedDaemons = trace => trace.trim().split("\n")
      .filter(line => line.startsWith("restart "))
      .flatMap(line => line.split(" ").slice(1))
      .filter(unit => unit.startsWith("pi-orchestrator@"))
      .sort();
    assert.deepEqual(restartedDaemons(firstUnits), expectedDaemons,
      "restart fleet, running and enabled daemons once each; leave disabled inactive people stopped");
    assert.doesNotMatch(firstUnits, /list-unit-files/);
    assert.match(firstUnits,/^restart pi-remote-router\.service$/m);
    assert.match(firstUnits, /^restart pi-model-broker\.service pi-stack-model-broker@alice\.service$/m);
    assert.equal(readFileSync(env.VOICE_TRACE,"utf8"),"--check\n--activate\n");
    assert.equal(readFileSync(activationTrace,"utf8"),"pi-remote@alice.service\n");
    assert.deepEqual(readFileSync(settingsTrace,"utf8").trim().split("\n").sort(),[user,"alice","guest-person"].sort(),"settings reconcile every account, concurrently");
    assert.equal(readFileSync(env.HEALTH_TRACE, "utf8"), "http://127.0.0.1:18798/v1/health\n".repeat(2));
    rmSync(systemctlTrace,{force:true});
    const unchanged=spawnSync(join(deploy,"host"),[hostFile],{encoding:"utf8",env});assert.equal(unchanged.status,0,unchanged.stderr);
    assert.equal(readFileSync(activationTrace,"utf8"),"pi-remote@alice.service\n");
    const again = readFileSync(systemctlTrace, "utf8");
    assert.deepEqual(restartedDaemons(again), expectedDaemons, "unchanged releases still reconcile every daemon");
    assert.doesNotMatch(again, /restart pi-remote-router/);

    rmSync(systemctlTrace,{force:true});
    const disabled=spawnSync(join(deploy,"host"),[hostFile],{encoding:"utf8",env:{...env,GUEST_UNIT_STATE:"disabled",ALICE_UNIT_STATE:"disabled"}});
    assert.equal(disabled.status,0,disabled.stderr);
    assert.deepEqual(restartedDaemons(readFileSync(systemctlTrace,"utf8")),
      [user, "alice", "running-person"].map(person => `pi-orchestrator@${person}.service`).sort(),
      "disabled running daemons restart, but disabled inactive daemons stay stopped");

    rmSync(systemctlTrace,{force:true});
    const voiceFailure=spawnSync(join(deploy,"host"),[hostFile],{encoding:"utf8",env:{...env,VOICE_CHECK_EXIT:"1"}});
    assert.notEqual(voiceFailure.status,0);
    assert.equal(existsSync(systemctlTrace),false,"Voice preflight blocks service activation");
    // The browser doctor runs alongside activation against the already selected runtime; its failure fails the release.
    const browserFailure=spawnSync(join(deploy,"host"),[hostFile],{encoding:"utf8",env:{...env,BROWSER_SMOKE_EXIT:"1"}});
    assert.notEqual(browserFailure.status,0);
    assert.match(browserFailure.stderr,/browser doctor failed/);
    rmSync(systemctlTrace,{force:true});

    // A release the clients cannot use goes back to the previous Pi Remote.
    const before=readlinkSync(destinations.PI_STACK_REMOTE_DEST);
    writeFileSync(join(repository,"release"),"broken\n");assert.equal(spawnSync("git",["-C",repository,"add","release"]).status,0);assert.equal(spawnSync("git",["-C",repository,"-c","user.name=test","-c","user.email=test@example.test","commit","-qm","broken"]).status,0);
    for (const failure of [{ SMOKE_EXIT: "1" }, { DAEMON_RESTART_EXIT: "1" }]) {
      rmSync(activationTrace,{force:true});rmSync(env.VOICE_TRACE,{force:true});
      const broken=spawnSync(join(deploy,"host"),[hostFile],{encoding:"utf8",env:{...env,...failure}});assert.notEqual(broken.status,0);
      assert.match(broken.stderr,/returning Pi Remote to/);
      assert.equal(readlinkSync(destinations.PI_STACK_REMOTE_DEST),before);
      assert.equal(readFileSync(env.VOICE_TRACE,"utf8"),"--check\n--activate\n--activate\n");
      assert.equal(readFileSync(activationTrace,"utf8"),"pi-remote@alice.service\npi-remote@alice.service\n");
      assert.match(readFileSync(systemctlTrace,"utf8"),/reset-failed pi-remote@\*\.service/);
    }
  } finally { rmSync(directory,{recursive:true,force:true}); }
});

for (const separateCheckout of [false, true]) test(`deploys from ${separateCheckout ? "different checkouts" : "one checkout"} serialize before reading or changing source`, async () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-stack-deploy-lock-"));
  try {
    const repository = join(directory, "repo");
    const initialized = spawnSync("git", ["init", "-q", repository]);
    assert.equal(initialized.status, 0);

    const otherRepository = separateCheckout ? join(directory, "other-repo") : repository;
    if (separateCheckout) assert.equal(spawnSync("git", ["init", "-q", otherRepository]).status, 0);
    const firstReady = join(directory, "first-ready");
    const releaseFirst = join(directory, "release-first");
    const secondStarted = join(directory, "second-started");
    const secondAcquired = join(directory, "second-acquired");

    const first = start(`
      set -euo pipefail
      source "$1"
      pi_stack_acquire_deploy_lock "$2"
      : > "$3"
      while [[ ! -e $4 ]]; do sleep 0.01; done
    `, [helper, repository, firstReady, releaseFirst]);
    await waitForFile(firstReady);
    assert.equal(existsSync(join(repository, ".git", "pi-stack-deploy.lock")), true);

    const second = start(`
      set -euo pipefail
      : > "$3"
      source "$1"
      pi_stack_acquire_deploy_lock "$2"
      : > "$4"
    `, [helper, otherRepository, secondStarted, secondAcquired]);
    await waitForFile(secondStarted);
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
    assert.equal(existsSync(secondAcquired), false);

    writeFileSync(releaseFirst, "release\n");
    await Promise.all([waitForExit(first), waitForExit(second)]);
    assert.equal(existsSync(secondAcquired), true);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

import assert from "node:assert/strict";
import { spawn, spawnSync as spawnSyncProcess } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { copyDeploymentOwner } from "./deployment-fixture.mjs";

function spawnSync(command, args, options = {}) {
  return spawnSyncProcess(command, args, { timeout: 20_000, killSignal: "SIGKILL", ...options });
}

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
        printf '{}\\n' > "$root/node_modules/.package-lock.json"
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

test("concurrent dependency consumers serialize npm ci and share its completed receipt", async () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-stack-dependencies-concurrent-"));
  try {
    writeFileSync(join(directory, "package.json"), "{}\n");
    writeFileSync(join(directory, "package-lock.json"), "{}\n");
    const script = `set -euo pipefail
      source "$1"
      root=$2
      npm() {
        mkdir "$root/installing" || return 71
        printf 'called\\n' >> "$root/npm-calls"
        rm -rf "$root/node_modules"
        mkdir -p "$root/node_modules"
        sleep 0.15
        printf '{}\\n' > "$root/node_modules/.package-lock.json"
        rmdir "$root/installing"
      }
      pi_stack_prepare_dependencies "$root"
      test -n "$PI_STACK_DEPENDENCIES_READY"`;
    await Promise.all([waitForExit(start(script, [helper, directory])), waitForExit(start(script, [helper, directory]))]);
    assert.equal(readFileSync(join(directory, "npm-calls"), "utf8"), "called\n");
    assert.ok(existsSync(join(directory, "node_modules/.pi-stack-dependency-key")));
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("dependency install failure propagates even in a conditional and never stamps readiness", () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-stack-dependencies-failed-"));
  try {
    writeFileSync(join(directory, "package.json"), "{}\n");
    writeFileSync(join(directory, "package-lock.json"), "{}\n");
    const result = spawnSync("bash", ["-c", `set -euo pipefail
      source "$1"
      npm() { return 23; }
      if pi_stack_prepare_dependencies "$2"; then exit 99; else test "$?" = 23; fi
      test ! -e "$2/node_modules/.pi-stack-dependency-key"`, "failed-dependencies", helper, directory], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("a deleted nested dependency invalidates an otherwise matching receipt", () => {
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
        mkdir -p "$root/node_modules" "$root/apps/remote/node_modules/plugin"
        printf '{}' > "$root/apps/remote/node_modules/plugin/package.json"
        printf '{"packages":{"apps/remote/node_modules/plugin":{},"packages/removed-workspace":{},"node_modules/skipped-platform-package":{"optional":true}}}' > "$root/node_modules/.package-lock.json"
      }
      pi_stack_prepare_dependencies "$root"
      pi_stack_prepare_dependencies "$root"
      rm -r "$root/apps/remote/node_modules"
      pi_stack_prepare_dependencies "$root"
    `, "deploy-dependencies-test", helper, directory, calls], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(readFileSync(calls, "utf8"), "called\ncalled\n");
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
    copyDeploymentOwner(root, repository);
    writeFileSync(join(deploy, "native-history-boundary"), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    writeFileSync(join(remoteApp, "data-contract.json"), readFileSync(join(root, "apps/remote/data-contract.json")));
    writeFileSync(join(deploy, "lib"), `${readFileSync(join(root, "deploy", "lib"), "utf8")}\npi_stack_prepare_builds() { return "\${BUILD_EXIT:-0}"; }\n`);
    const component = `#!/usr/bin/env bash
set -euo pipefail
name=$(basename "$0")
root=$(cd "$(dirname "$0")/.." && pwd)
source "$root/deploy/lib"
commit=$(git -C "$root" rev-parse HEAD)
case $name in
  runtime) destination=$PI_STACK_RUNTIME_DEST;;
  orchestrator) destination=$PI_STACK_ORCHESTRATOR_DEST;;
  remote) destination=$PI_STACK_REMOTE_DEST;;
  tools) destination=$PI_STACK_TOOLS_DEST;;
  skills) mkdir -p "$PI_STACK_SKILLS_DEST"; printf '%s\\n' "$commit" > "$PI_STACK_SKILLS_DEST/.pi-stack-commit"; exit 0;;
  settings) printf '%s\\n' "$1" >> "$SETTINGS_TRACE"; exit 0;;
  *) exit 64;;
esac
release="$PI_STACK_RELEASES_ROOT/$name/$commit"
case \${1:-} in
  --links-only) pi_stack_require_release "$destination" "$commit"; exit $?;;
  --activate-prepared) [[ $name == runtime ]] || exit 64; pi_stack_select_release "$release" "$destination" "$commit"; exit $?;;
esac
printf '%s\\n' "$name" >> "$PREPARE_TRACE"
if [[ $name == runtime ]]; then
  [[ \${1:-} == --prepare ]] || exit 64
  (( \${RUNTIME_CHECK_EXIT:-0} == 0 )) || exit "$RUNTIME_CHECK_EXIT"
else
  [[ $PI_STACK_PREPARE_ONLY == 1 ]] || exit 64
  pi_stack_require_release "$PI_STACK_RUNTIME_DEST" "$commit"
  if [[ $name == orchestrator ]]; then (( \${ORCHESTRATOR_EXIT:-0} == 0 )) || exit "$ORCHESTRATOR_EXIT"; fi
fi
mkdir -p "$release/dist"
printf '%s\\n' "$commit" > "$release/.pi-stack-commit"
case $name in
  runtime)
    mkdir -p "$release/node_modules/.bin"
    cp "$root/packages/runtime/model-doctor.mjs" "$release/node_modules/.bin/pi-model-selection-doctor";;
  orchestrator) cp "$root/packages/runtime/agent-capacity.mjs" "$release/dist/agent-capacity.js";;
  remote)
    mkdir -p "$release/server/voice" "$release/server/phone"
    touch "$release/server/voice/service.ts" "$release/server/phone/service.ts"
    cp "$root/apps/remote/data-contract.json" "$release/data-contract.json";;
esac
if [[ $name != runtime ]]; then pi_stack_select_release "$release" "$destination" "$commit"; fi
`;
    for (const name of ["runtime", "orchestrator", "remote", "tools", "skills", "settings"]) {
      writeFileSync(join(deploy, name), component, { mode: 0o755 });
    }
    writeFileSync(join(deploy, "skills"), component.replace('name=$(basename "$0")', 'name=$(basename "$0")\nprintf "%s\\n" "$*" >> "$SKILLS_TRACE"'));
    writeFileSync(join(deploy,"smoke"),"#!/bin/sh\nif [ \"${REQUIRE_ACTIVATION_OVERLAP:-0}\" = 1 ]; then test -f \"$DAEMON_ACTIVATED\" || exit 92; fi\nexit \"${SMOKE_EXIT:-0}\"\n");chmodSync(join(deploy,"smoke"),0o755);
    for (const service of ["voice", "phone"]) {
      const key = service.toUpperCase();
      writeFileSync(join(deploy, service), `#!/bin/sh\nprintf '%s\\n' "$1" >> "$${key}_TRACE"\ncase $1 in --check) exit "\${${key}_CHECK_EXIT:-0}";; --activate) if [ -n "\${DOCTOR_ACTIVATION_STARTED:-}" ]; then touch "$DOCTOR_ACTIVATION_STARTED"; fi; exit 0;; *) exit 64;; esac\n`, { mode: 0o755 });
    }
    mkdirSync(join(repository,"packages/runtime"),{recursive:true});
    const doctorProof = (name, peer) => `
import { existsSync, writeFileSync } from 'node:fs';
if (process.env.REQUIRE_DOCTOR_OVERLAP === '1') {
  writeFileSync(process.env.${name}_DOCTOR_STARTED, 'started');
  const deadline = Date.now() + 1500;
  while (!existsSync(process.env.${peer}_DOCTOR_STARTED) || !existsSync(process.env.DOCTOR_ACTIVATION_STARTED)) {
    if (Date.now() >= deadline) { console.error('Runtime doctors must overlap each other and activation'); process.exit(94); }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}
if (process.env.DOCTOR_SETTLEMENT_DIR) {
  await new Promise(resolve => setTimeout(resolve, 150));
  writeFileSync(process.env.DOCTOR_SETTLEMENT_DIR + '/${name}.settled', 'settled');
}
process.exit(Number(process.env.${name}_SMOKE_EXIT ?? 0));
`;
    writeFileSync(join(repository,"packages/runtime/browser-doctor.mjs"), doctorProof("BROWSER", "MODEL"));
    // Activation hands the supervisor the selected release; its health then names that commit.
    writeFileSync(join(remoteApp,"activate"),"#!/bin/sh\nprintf '%s\\n' \"${PI_REMOTE_SERVICE:-}\" >> \"$ACTIVATE_TRACE\"\ncat \"$PI_STACK_REMOTE_DEST/.pi-stack-commit\" > \"$SUPERVISOR_COMMIT\"\n");chmodSync(join(remoteApp,"activate"),0o755);
    const destinations=Object.fromEntries(["RUNTIME","ORCHESTRATOR","REMOTE","TOOLS","SKILLS"].map((name)=>[`PI_STACK_${name}_DEST`,join(directory,name.toLowerCase())]));
    const doctorBin = join(destinations.PI_STACK_RUNTIME_DEST, "node_modules/.bin");
    writeFileSync(join(repository, "packages/runtime/model-doctor.mjs"), doctorProof("MODEL", "BROWSER"));
    writeFileSync(join(repository, "packages/runtime/agent-capacity.mjs"), `
export async function configuredAgentCapacityStatus() {
  return { ok: true, value: { authority: 'pi-stack-global-agents-v1', limit: 100,
    initialized: process.env.CAPACITY_UNINITIALIZED !== '1', active: 0, queued: 0 } };
}
`);
    assert.equal(spawnSync("git",["init","-q",repository]).status,0);assert.equal(spawnSync("git",["-C",repository,"add","deploy","apps","packages"]).status,0);assert.equal(spawnSync("git",["-C",repository,"-c","user.name=test","-c","user.email=test@example.test","commit","-qm","fixture"]).status,0);
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
    case $2 in pi-stack-phone.service|pi-stack-voice.service) echo loaded; exit 0;; esac
    case $4 in
      pi-orchestrator@alice.service) echo "\${ALICE_UNIT_STATE:-enabled}";;
      pi-orchestrator@guest-person.service) echo "\${GUEST_UNIT_STATE:-${enableGuest ? "enabled-runtime" : "disabled"}}";;
      *) echo static;;
    esac;;
  restart)
    case $2 in pi-orchestrator@*)
      if [ "\${REQUIRE_ACTIVATION_OVERLAP:-0}" = 1 ]; then
        for i in $(seq 1 100); do
          if [ -f "$ACTIVATE_TRACE" ]; then
            sleep 0.05
            touch "$DAEMON_ACTIVATED"
            exit "\${DAEMON_RESTART_EXIT:-0}"
          fi
          sleep 0.01
        done
        echo 'Remote handoff was serialized behind daemon restart' >&2
        exit 91
      fi
      exit "\${DAEMON_RESTART_EXIT:-0}";; esac;;
  is-active|reset-failed|stop) exit 0;;
  *) exit 64;;
esac
exit 0
`, { mode: 0o755 });
    // The front door names its unlocked people; each supervisor names the release it runs.
    writeFileSync(join(bin, "curl"), `#!/bin/sh
for arg; do
  case $arg in
    http://127.0.0.1:18798/v1/meet|http://127.0.0.1:18799/v1/meet)
      if [ "\${PI_STACK_HOST_PHASE:-}" = activation ] && [ "\${ACTIVATION_CENSUS_FAIL:-0}" != 0 ]; then
        echo 'fixture census timeout' >&2
        exit "$ACTIVATION_CENSUS_FAIL"
      fi
      printf '%s\\n' "$MEETING_ROOMS"
      exit 0;;
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
    env.PHONE_TRACE = join(directory, "phone.trace");
    env.SKILLS_TRACE = join(directory, "skills.trace");
    env.PREPARE_TRACE = join(directory, "prepare.trace");
    const preparedReceipt = () => join(directory, ".pi-stack-releases/.prepared", `${spawnSync("git", ["-C", repository, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim()}.json`);
    const resetPreparation = () => rmSync(preparedReceipt());
    env.DAEMON_ACTIVATED = join(directory, "daemon.activated");
    env.PERSON_READ_TRACE = personReadTrace;
    env.PI_STACK_ALLOW_LIVE_MEETING_RESTART = "0";
    env.MEETING_ROOMS = '{"rooms":[]}';
    for (const person of ["alice", "guest-person"]) {
      const config = join(personsDir, `${person}.json`);
      chmodSync(config, 0o600);
      const unreadable = spawnSync(join(deploy, "host"), [hostFile], { encoding: "utf8", env });
      assert.equal(unreadable.status, 1, unreadable.stderr);
      assert.ok(unreadable.stderr.includes(`${config} is not readable valid configuration for ${person}`));
      for (const destination of Object.values(destinations)) {
        assert.equal(existsSync(destination), false, "person preflight must precede component publication");
      }
      for (const trace of [systemctlTrace, settingsTrace, activationTrace, env.VOICE_TRACE, env.PHONE_TRACE]) {
        assert.equal(existsSync(trace), false, "person preflight must precede account and service changes");
      }
      chmodSync(config, 0o644);
    }
    const liveMeeting = spawnSync(join(deploy, "host"), [hostFile], { encoding: "utf8", env: { ...env, MEETING_ROOMS: '{"rooms":[{"id":"active-room"}]}' } });
    assert.equal(liveMeeting.status, 75, liveMeeting.stderr);
    assert.match(liveMeeting.stderr, /live meeting rooms on this host/);
    assert.equal(existsSync(systemctlTrace), false, "live rooms must defer deployment before any service changes");
    for (const destination of Object.values(destinations)) assert.equal(existsSync(destination), false);
    const discoveryFailure = spawnSync(join(deploy,"host"),[hostFile],{encoding:"utf8",env:{...env,DISCOVERY_EXIT:"1"}});
    assert.equal(discoveryFailure.status, 1, discoveryFailure.stderr);
    assert.match(discoveryFailure.stderr, /could not discover Orchestrator daemon units/);
    assert.equal(existsSync(destinations.PI_STACK_RUNTIME_DEST), false, "failed discovery cannot publish components");
    rmSync(systemctlTrace);
    const buildFailure = spawnSync(join(deploy,"host"),[hostFile],{encoding:"utf8",env:{...env,BUILD_EXIT:"1"}});
    assert.equal(buildFailure.status, 1, `${buildFailure.stdout}\n${buildFailure.stderr}`);
    assert.equal(existsSync(destinations.PI_STACK_REMOTE_DEST), false, "failed preparation cannot select Remote");
    assert.doesNotMatch(readFileSync(systemctlTrace, "utf8"), /^restart /m, "failed preparation cannot activate services");
    rmSync(env.VOICE_TRACE, { force: true });
    rmSync(env.PHONE_TRACE, { force: true });
    rmSync(personReadTrace);
    const first=spawnSync(join(deploy,"host"),[hostFile],{encoding:"utf8",env:{...env,REQUIRE_ACTIVATION_OVERLAP:"1",REQUIRE_DOCTOR_OVERLAP:"1",BROWSER_DOCTOR_STARTED:join(directory,"browser.started"),MODEL_DOCTOR_STARTED:join(directory,"model.started"),DOCTOR_ACTIVATION_STARTED:join(directory,"doctor.activation.started")},cwd:directory});assert.equal(first.status,0,`${first.stdout}\n${first.stderr}`);
    assert.equal(existsSync(env.DAEMON_ACTIVATED), true, "smoke joins the independent daemon activation job");
    const preparedOrder = readFileSync(env.PREPARE_TRACE, "utf8").trim().split("\n");
    assert.deepEqual(preparedOrder.slice(0, 2), ["runtime", "orchestrator"], "dependents stage against the prepared runtime");
    assert.deepEqual(preparedOrder.slice(2).sort(), ["remote", "tools"]);
    assert.equal(existsSync(preparedReceipt()), true, "activation requires a bound prepared-artifact receipt");
    assert.deepEqual(readFileSync(env.SKILLS_TRACE, "utf8").trim().split("\n").sort(),
      [user, "--links-only alice", "--links-only guest-person"].sort(),
      "publish the shared skills once, then only reconcile other accounts' links");
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
    assert.equal(readFileSync(env.PHONE_TRACE,"utf8"),"--check\n--activate\n");
    assert.equal(readFileSync(activationTrace,"utf8"),"pi-remote@alice.service\n");
    assert.deepEqual(readFileSync(settingsTrace,"utf8").trim().split("\n").sort(),[user,"alice","guest-person"].sort(),"settings reconcile every account, concurrently");
    assert.equal(readFileSync(env.HEALTH_TRACE, "utf8"), "http://127.0.0.1:18798/v1/health\n".repeat(2));
    rmSync(systemctlTrace,{force:true});
    const uninitialized = spawnSync(join(deploy, "host"), [hostFile], { encoding: "utf8", env: { ...env, CAPACITY_UNINITIALIZED: "1" }, cwd: directory });
    assert.equal(uninitialized.status, 75, uninitialized.stderr);
    assert.match(uninitialized.stderr, /Global agent capacity cutover incomplete/);
    assert.equal(readFileSync(activationTrace, "utf8"), "pi-remote@alice.service\n", "capacity readiness gates further activation");
    assert.doesNotMatch(uninitialized.stdout, /phase=(browser-doctor|model-doctor|activation) started/, "capacity readiness gates native doctors");
    assert.doesNotMatch(readFileSync(systemctlTrace, "utf8"), /^restart /m);
    rmSync(systemctlTrace);
    const doctorSettlement = join(directory, "doctor-settlement");
    mkdirSync(doctorSettlement);
    resetPreparation();
    const stagingFailure = spawnSync(join(deploy, "host"), [hostFile], { encoding: "utf8", env: { ...env, ORCHESTRATOR_EXIT: "23", DOCTOR_SETTLEMENT_DIR: doctorSettlement } });
    assert.equal(stagingFailure.status, 23, `${stagingFailure.stdout}\n${stagingFailure.stderr}`);
    assert.equal(existsSync(preparedReceipt()), false, "failed staging cannot record prepared success");
    for (const doctor of ["BROWSER", "MODEL"]) assert.equal(existsSync(join(doctorSettlement, `${doctor}.settled`)), false, "doctors require successful publication of the runtime");
    assert.doesNotMatch(readFileSync(systemctlTrace, "utf8"), /^restart /m, "staging failure cannot activate services");
    const beforeDeferral = readFileSync(activationTrace, "utf8");
    for (const doctorFailure of [false, true]) {
      rmSync(join(directory, '.pi-stack-doctors'), { recursive: true, force: true });
      for (const doctor of ["BROWSER", "MODEL"]) rmSync(join(doctorSettlement, `${doctor}.settled`), { force: true });
      const deferred = spawnSync(join(deploy, "host"), [hostFile], { encoding: "utf8", env: { ...env,
        ACTIVATION_CENSUS_FAIL: "28", DOCTOR_SETTLEMENT_DIR: doctorSettlement,
        BROWSER_SMOKE_EXIT: doctorFailure ? "1" : "0" } });
      assert.equal(deferred.status, doctorFailure ? 1 : 75, deferred.stderr);
      assert.match(deferred.stderr, /meeting census unavailable on this host/);
      assert.match(deferred.stdout, /release phase=activation completed status=75/);
      for (const doctor of ["BROWSER", "MODEL"]) assert.ok(existsSync(join(doctorSettlement, `${doctor}.settled`)), "deferral must join both proof jobs");
      assert.equal(readFileSync(activationTrace, "utf8"), beforeDeferral, "unknown meetings cannot activate or rollback Remote");
    }
    rmSync(join(directory, '.pi-stack-doctors'), { recursive: true, force: true });
    rmSync(join(directory, '.pi-stack-release-plan.json'), { force: true });
    const activationFailure = spawnSync(join(deploy, "host"), [hostFile], { encoding: "utf8", env: { ...env, DAEMON_RESTART_EXIT: "1", DOCTOR_SETTLEMENT_DIR: doctorSettlement } });
    assert.equal(activationFailure.status, 1, activationFailure.stderr);
    for (const doctor of ["BROWSER", "MODEL"]) assert.ok(existsSync(join(doctorSettlement, `${doctor}.settled`)), "failed activation must join both proof jobs before releasing custody");
    rmSync(systemctlTrace);
    const preparationBefore = readFileSync(env.PREPARE_TRACE, "utf8");
    const unchanged=spawnSync(join(deploy,"host"),[hostFile],{encoding:"utf8",env:{...env,BUILD_EXIT:"99",RUNTIME_CHECK_EXIT:"23",ORCHESTRATOR_EXIT:"23"}});assert.equal(unchanged.status,0,`${unchanged.stdout}\n${unchanged.stderr}`);
    assert.equal(readFileSync(env.PREPARE_TRACE, "utf8"), preparationBefore, "verified prepared artifacts are reused without rebuilding components");
    assert.equal(readFileSync(activationTrace,"utf8"),"pi-remote@alice.service\n");
    const again = readFileSync(systemctlTrace, "utf8");
    // The preceding deliberately failed activation owns an unfinished plan;
    // this retry completes its changed owners. Accepted identical plans then do no restarts.
    assert.deepEqual(restartedDaemons(again), expectedDaemons, "failed activation retains its changed-owner recovery plan");
    rmSync(systemctlTrace, { force: true });
    const acceptedRepeat = spawnSync(join(deploy, 'host'), [hostFile], { encoding: 'utf8', env });
    assert.equal(acceptedRepeat.status, 0, acceptedRepeat.stderr);
    assert.deepEqual(restartedDaemons(readFileSync(systemctlTrace, 'utf8')), [], 'accepted unchanged source does not restart daemons');
    assert.match(again, /restart pi-remote-router/, 'unfinished recovery plan still reconciles its router');
    assert.doesNotMatch(readFileSync(systemctlTrace, 'utf8'), /restart pi-remote-router/, 'accepted unchanged source leaves the router running');

    rmSync(systemctlTrace,{force:true});
    resetPreparation();
    const runtimeFailure = spawnSync(join(deploy, "host"), [hostFile], { encoding: "utf8", env: { ...env, RUNTIME_CHECK_EXIT: "23" } });
    assert.equal(runtimeFailure.status, 1, runtimeFailure.stderr);
    assert.match(runtimeFailure.stderr, /preparation runtime exited 23/);
    assert.equal(existsSync(preparedReceipt()), false, "failed runtime preparation cannot record prepared success");
    assert.doesNotMatch(readFileSync(systemctlTrace, "utf8"), /^restart /m, "failed prepared runtime proof vetoes service activation");
    rmSync(systemctlTrace,{force:true});
    rmSync(join(directory, '.pi-stack-release-plan.json'), { force: true });
    const disabled=spawnSync(join(deploy,"host"),[hostFile],{encoding:"utf8",env:{...env,GUEST_UNIT_STATE:"disabled",ALICE_UNIT_STATE:"disabled"}});
    assert.equal(disabled.status,0,disabled.stderr);
    assert.deepEqual(restartedDaemons(readFileSync(systemctlTrace,"utf8")),
      [user, "alice", "running-person"].map(person => `pi-orchestrator@${person}.service`).sort(),
      "disabled running daemons restart, but disabled inactive daemons stay stopped");

    rmSync(systemctlTrace,{force:true});
    for (const service of ["VOICE", "PHONE"]) {
      const preflightFailure = spawnSync(join(deploy, "host"), [hostFile], { encoding: "utf8", env: { ...env, [`${service}_CHECK_EXIT`]: "75" } });
      assert.equal(preflightFailure.status, 75, preflightFailure.stderr);
      assert.equal(existsSync(systemctlTrace), false, `${service} preflight blocks service activation`);
    }
    for (const failure of [{ BROWSER_SMOKE_EXIT: "1" }, { MODEL_SMOKE_EXIT: "1" }]) {
      rmSync(join(directory, '.pi-stack-doctors'), { recursive: true, force: true });
      const doctorFailure = spawnSync(join(deploy, "host"), [hostFile], { encoding: "utf8", env: { ...env, ...failure } });
      assert.notEqual(doctorFailure.status, 0);
      assert.match(doctorFailure.stderr, /runtime doctor failed/);
    }
    rmSync(systemctlTrace, { force: true });
    rmSync(join(doctorBin, "pi-model-selection-doctor"));
    const missingDoctor = spawnSync(join(deploy, "host"), [hostFile], { encoding: "utf8", env });
    assert.equal(missingDoctor.status, 66, `${missingDoctor.stdout}\n${missingDoctor.stderr}`);
    assert.match(missingDoctor.stdout, /prepared-artifact-changed/);
    assert.doesNotMatch(readFileSync(systemctlTrace, "utf8"), /^restart /m, "mutated prepared artifacts are rejected before activation");
    writeFileSync(join(doctorBin, "pi-model-selection-doctor"), doctorProof("MODEL", "BROWSER"));
    rmSync(systemctlTrace,{force:true});

    // A release the clients cannot use goes back to the previous Pi Remote.
    const before=readlinkSync(destinations.PI_STACK_REMOTE_DEST);
    writeFileSync(join(repository,"packages/runtime/release-fixture.mjs"),"broken\n");assert.equal(spawnSync("git",["-C",repository,"add","packages/runtime/release-fixture.mjs"]).status,0);assert.equal(spawnSync("git",["-C",repository,"-c","user.name=test","-c","user.email=test@example.test","commit","-qm","broken"]).status,0);
    for (const failure of [{ SMOKE_EXIT: "1" }, { DAEMON_RESTART_EXIT: "1" }, { BROWSER_SMOKE_EXIT: "1" }, { MODEL_SMOKE_EXIT: "1" }]) {
      rmSync(join(directory, '.pi-stack-doctors'), { recursive: true, force: true });
      rmSync(activationTrace,{force:true});rmSync(env.VOICE_TRACE,{force:true});rmSync(env.PHONE_TRACE,{force:true});
      const broken=spawnSync(join(deploy,"host"),[hostFile],{encoding:"utf8",env:{...env,...failure}});assert.notEqual(broken.status,0);
      assert.match(broken.stderr,/returning Pi Remote to/);
      assert.equal(readlinkSync(destinations.PI_STACK_REMOTE_DEST),before);
      assert.equal(readFileSync(env.VOICE_TRACE,"utf8"),"--check\n--activate\n--activate\n");
      assert.equal(readFileSync(env.PHONE_TRACE,"utf8"),"--check\n--activate\n--restore\n", "rollback restores the captured Phone configuration instead of installing the candidate again");
      assert.equal(readFileSync(activationTrace,"utf8"),"pi-remote@alice.service\npi-remote@alice.service\n");
      assert.match(readFileSync(systemctlTrace,"utf8"),/reset-failed pi-remote@\*\.service/);
    }
    rmSync(join(before, "server/phone/service.ts"));
    rmSync(systemctlTrace);
    rmSync(env.PHONE_TRACE);
    const prePhoneRollback = spawnSync(join(deploy, "host"), [hostFile], { encoding: "utf8", env: { ...env, SMOKE_EXIT: "1" } });
    assert.equal(prePhoneRollback.status, 1, prePhoneRollback.stderr);
    assert.equal(readlinkSync(destinations.PI_STACK_REMOTE_DEST), before);
    assert.equal(readFileSync(env.PHONE_TRACE, "utf8"), "--check\n--activate\n");
    assert.match(readFileSync(systemctlTrace, "utf8"), /^stop pi-stack-phone.service$/m);

    // Unknown or incompatible persistent schemas must retain forward selection,
    // not reactivate an older supervisor against migrated data.
    const contractPath = join(before, "data-contract.json");
    for (const previousContract of [null, { version: 1, schema: "incompatible-fixture-schema" }]) {
      if (previousContract === null) rmSync(contractPath);
      else writeFileSync(contractPath, JSON.stringify(previousContract));
      rmSync(destinations.PI_STACK_REMOTE_DEST);
      symlinkSync(before, destinations.PI_STACK_REMOTE_DEST);
      writeFileSync(supervisorCommit, readFileSync(join(before, ".pi-stack-commit")));
      rmSync(activationTrace, { force: true });
      const incompatible = spawnSync(join(deploy, "host"), [hostFile], { encoding: "utf8", env: { ...env, SMOKE_EXIT: "1" } });
      assert.equal(incompatible.status, 1, incompatible.stderr);
      assert.match(incompatible.stderr, /Remote rollback refused/);
      assert.doesNotMatch(incompatible.stderr, /returning Pi Remote to/);
      assert.notEqual(readlinkSync(destinations.PI_STACK_REMOTE_DEST), before, "failed candidate remains selected for forward repair");
      assert.equal(readFileSync(activationTrace, "utf8"), "pi-remote@alice.service\n", "incompatible old release never receives activation");
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

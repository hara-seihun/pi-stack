import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const helper = join(root, "deploy", "lib");

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

test("the host deployment restarts the daemon and activates a changed Pi Remote", () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-stack-host-current-"));
  try {
    const repository = join(directory, "repo"), deploy = join(repository, "deploy"), remoteApp = join(repository, "apps", "remote"), bin = join(directory, "bin");
    mkdirSync(deploy, { recursive: true });mkdirSync(remoteApp, { recursive: true });mkdirSync(bin);
    copyFileSync(join(root, "deploy", "host"), join(deploy, "host"));chmodSync(join(deploy, "host"), 0o755);
    writeFileSync(join(deploy, "lib"), `${readFileSync(join(root, "deploy", "lib"), "utf8")}\npi_stack_prepare_dependencies() { :; }\n`);
    const component=`#!/usr/bin/env bash\nset -euo pipefail\nname=$(basename "$0")\ncommit=$(git -C "$(cd "$(dirname "$0")/.." && pwd)" rev-parse HEAD)\ncase "$name" in runtime) destination=$PI_STACK_RUNTIME_DEST;; orchestrator) destination=$PI_STACK_ORCHESTRATOR_DEST;; tools) destination=$PI_STACK_TOOLS_DEST;; skills) destination=$PI_STACK_SKILLS_DEST;; settings) printf '%s\\n' "$1" >> "$SETTINGS_TRACE"; exit 0;;\n remote) destination=$PI_STACK_REMOTE_DEST; release="$(dirname "$destination")/.pi-stack-releases/remote/$commit"; mkdir -p "$release/dist"; printf '%s\\n' "$commit" > "$release/.pi-stack-commit"; ln -sfn "$release" "$destination.tmp"; mv -Tf "$destination.tmp" "$destination"; exit 0;; esac\nmkdir -p "$destination/dist"\nprintf '%s\\n' "$commit" > "$destination/.pi-stack-commit"\n`;
    for(const name of ["runtime","orchestrator","remote","tools","skills","settings"]){writeFileSync(join(deploy,name),component);chmodSync(join(deploy,name),0o755);}
    writeFileSync(join(deploy,"smoke"),"#!/bin/sh\nexit \"${SMOKE_EXIT:-0}\"\n");chmodSync(join(deploy,"smoke"),0o755);
    writeFileSync(join(remoteApp,"activate"),"#!/bin/sh\nprintf '%s\\n' \"${PI_REMOTE_SERVICE:-}\" >> \"$ACTIVATE_TRACE\"\n");chmodSync(join(remoteApp,"activate"),0o755);
    assert.equal(spawnSync("git",["init","-q",repository]).status,0);assert.equal(spawnSync("git",["-C",repository,"add","deploy","apps"]).status,0);assert.equal(spawnSync("git",["-C",repository,"-c","user.name=test","-c","user.email=test@example.test","commit","-qm","fixture"]).status,0);
    const destinations=Object.fromEntries(["RUNTIME","ORCHESTRATOR","REMOTE","TOOLS","SKILLS"].map((name)=>[`PI_STACK_${name}_DEST`,join(directory,name.toLowerCase())]));
    const user=process.env.USER??spawnSync("id",["-un"],{encoding:"utf8"}).stdout.trim();
    const hostFile=join(directory,"host.json");writeFileSync(hostFile,JSON.stringify({version:1,fleetUser:user}));
    const personsDir=join(directory,"persons");mkdirSync(personsDir);writeFileSync(join(personsDir,"guest.json"),JSON.stringify({version:1,user:"guest-person",displayName:"Guest",port:18799,environment:{}}));
    const activationTrace=join(directory,"activation.trace"),systemctlTrace=join(directory,"systemctl.trace"),settingsTrace=join(directory,"settings.trace");
    writeFileSync(join(bin,"systemctl"),"#!/bin/sh\nprintf '%s\\n' \"$*\" >> \"$SYSTEMCTL_TRACE\"\ncase $1 in list-units) echo 'pi-remote@alice.service loaded active running';; is-active) exit 0;; esac\nexit 0\n");chmodSync(join(bin,"systemctl"),0o755);
    const env={...process.env,...destinations,PATH:`${bin}:${process.env.PATH}`,ACTIVATE_TRACE:activationTrace,SYSTEMCTL_TRACE:systemctlTrace,SETTINGS_TRACE:settingsTrace,PI_REMOTE_PERSONS_DIR:personsDir,PI_STACK_DEPLOY_NO_SUDO:"1",PI_STACK_ALLOW_DIRTY:"1",PI_STACK_SERVICES:"1"};
    const first=spawnSync(join(deploy,"host"),[hostFile],{encoding:"utf8",env});assert.equal(first.status,0,first.stderr);
    const firstUnits=readFileSync(systemctlTrace,"utf8");
    assert.match(firstUnits,new RegExp(`try-restart pi-orchestrator@${user}\\.service`));assert.match(firstUnits,/try-restart pi-remote-router\.service/);
    assert.equal(readFileSync(activationTrace,"utf8"),"pi-remote@alice.service\n");
    assert.equal(readFileSync(settingsTrace,"utf8"),`${user}\nguest-person\n`);
    rmSync(systemctlTrace,{force:true});
    const unchanged=spawnSync(join(deploy,"host"),[hostFile],{encoding:"utf8",env});assert.equal(unchanged.status,0,unchanged.stderr);
    assert.equal(readFileSync(activationTrace,"utf8"),"pi-remote@alice.service\n");
    const again=readFileSync(systemctlTrace,"utf8");assert.match(again,/try-restart pi-orchestrator@/);assert.doesNotMatch(again,/try-restart pi-remote-router/);

    // A release the clients cannot use goes back to the previous Pi Remote.
    const before=readlinkSync(destinations.PI_STACK_REMOTE_DEST);
    writeFileSync(join(repository,"release"),"broken\n");assert.equal(spawnSync("git",["-C",repository,"add","release"]).status,0);assert.equal(spawnSync("git",["-C",repository,"-c","user.name=test","-c","user.email=test@example.test","commit","-qm","broken"]).status,0);
    rmSync(activationTrace,{force:true});
    const broken=spawnSync(join(deploy,"host"),[hostFile],{encoding:"utf8",env:{...env,SMOKE_EXIT:"1"}});assert.notEqual(broken.status,0);
    assert.match(broken.stderr,/returning Pi Remote to/);
    assert.equal(readlinkSync(destinations.PI_STACK_REMOTE_DEST),before);
    assert.equal(readFileSync(activationTrace,"utf8"),"pi-remote@alice.service\npi-remote@alice.service\n");
  } finally { rmSync(directory,{recursive:true,force:true}); }
});

test("deploys from one checkout serialize before reading or changing source", async () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-stack-deploy-lock-"));
  try {
    const repository = join(directory, "repo");
    const initialized = spawnSync("git", ["init", "-q", repository]);
    assert.equal(initialized.status, 0);

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
    `, [helper, repository, secondStarted, secondAcquired]);
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

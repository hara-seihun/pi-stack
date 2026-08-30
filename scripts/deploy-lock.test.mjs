import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

test("a candidate orchestrator validates the installed task manifest before publication", () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-stack-manifest-preflight-"));
  try {
    const loader = join(directory, "task-manifest.mjs");
    const manifest = join(directory, "tasks.json");
    writeFileSync(loader, `
import { readFileSync } from "node:fs";
export function loadTaskManifest(path) {
  const document = JSON.parse(readFileSync(path, "utf8"));
  if (document.retiredField) throw new Error("unknown task manifest field retiredField");
}
`);
    writeFileSync(manifest, '{"retiredField":true}\n');
    const invalid = spawnSync("bash", ["-c", 'source "$1"; pi_stack_validate_task_manifest "$2" "$3"', "manifest-preflight-test", helper, loader, manifest], { encoding: "utf8" });
    assert.notEqual(invalid.status, 0);
    assert.match(invalid.stderr, /unknown task manifest field retiredField/);

    writeFileSync(manifest, '{}\n');
    const valid = spawnSync("bash", ["-c", 'source "$1"; pi_stack_validate_task_manifest "$2" "$3"', "manifest-preflight-test", helper, loader, manifest], { encoding: "utf8" });
    assert.equal(valid.status, 0, valid.stderr);
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

test("a changed host release rolls orchestrator workers and activates Pi Remote", () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-stack-host-roll-"));
  try {
    const repository = join(directory, "repo");
    const deploy = join(repository, "deploy");
    const remoteApp = join(repository, "apps", "remote");
    const orchestratorSource = join(repository, "packages", "orchestrator", "src");
    const supervisorSource = join(orchestratorSource, "host", "supervisor.ts");
    const ledgerSource = join(orchestratorSource, "ledger", "ledger.ts");
    const bin = join(directory, "bin");
    mkdirSync(deploy, { recursive: true });
    mkdirSync(remoteApp, { recursive: true });
    mkdirSync(dirname(supervisorSource), { recursive: true });
    mkdirSync(dirname(ledgerSource), { recursive: true });
    writeFileSync(supervisorSource, "same\n");
    writeFileSync(ledgerSource, "same\n");
    mkdirSync(bin);
    copyFileSync(join(root, "deploy", "host"), join(deploy, "host"));
    chmodSync(join(deploy, "host"), 0o755);
    writeFileSync(join(deploy, "lib"), `
pi_stack_enter_deployment() { :; }
pi_stack_prepare_dependencies() { :; }
pi_stack_as_root() { "$@"; }
`);
    const component = `#!/usr/bin/env bash
set -euo pipefail
name=$(basename "$0")
case "$name" in
  runtime) destination=$PI_STACK_RUNTIME_ROOT ;;
  orchestrator) destination=$PI_STACK_ORCHESTRATOR_DEST ;;
  remote) destination=$PI_STACK_REMOTE_DEST ;;
  tools) destination=$PI_STACK_TOOLS_DEST ;;
  skills) destination=$PI_STACK_SKILLS_DEST ;;
  settings) exit 0 ;;
esac
mkdir -p "$destination/dist"
if [[ $name == orchestrator ]]; then
  source_root=$(cd "$(dirname "$0")/../packages/orchestrator/src" && pwd)
  mkdir -p "$destination/src/host" "$destination/src/ledger"
  cp "$source_root/host/supervisor.ts" "$destination/src/host/supervisor.ts"
  cp "$source_root/ledger/ledger.ts" "$destination/src/ledger/ledger.ts"
fi
git -C "$(cd "$(dirname "$0")/.." && pwd)" rev-parse HEAD > "$destination/.pi-stack-commit"
`;
    for (const name of ["runtime", "orchestrator", "remote", "tools", "skills", "settings"]) {
      writeFileSync(join(deploy, name), component);
      chmodSync(join(deploy, name), 0o755);
    }
    writeFileSync(join(remoteApp, "activate"), "#!/bin/sh\nprintf '%s\\n' \"${PI_REMOTE_SERVICE:-}\" >> \"$ACTIVATE_TRACE\"\n");
    chmodSync(join(remoteApp, "activate"), 0o755);
    assert.equal(spawnSync("git", ["init", "-q", repository]).status, 0);
    assert.equal(spawnSync("git", ["-C", repository, "add", "deploy", "apps", "packages"]).status, 0);
    assert.equal(spawnSync("git", ["-C", repository, "-c", "user.name=test", "-c", "user.email=test@example.test", "commit", "-qm", "fixture"]).status, 0);

    const destinations = Object.fromEntries(["RUNTIME", "ORCHESTRATOR", "REMOTE", "TOOLS", "SKILLS"].map((name) =>
      [`PI_STACK_${name}_DEST`, join(directory, name.toLowerCase())]));
    destinations.PI_STACK_RUNTIME_ROOT = destinations.PI_STACK_RUNTIME_DEST;
    delete destinations.PI_STACK_RUNTIME_DEST;
    mkdirSync(destinations.PI_STACK_ORCHESTRATOR_DEST, { recursive: true });
    writeFileSync(join(destinations.PI_STACK_ORCHESTRATOR_DEST, ".pi-stack-commit"), "previous\n");
    const ledger = join(directory, "ledger.sqlite3");
    writeFileSync(ledger, "ledger");
    const trace = join(directory, "node.trace");
    const activationTrace = join(directory, "activation.trace");
    const systemctlTrace = join(directory, "systemctl.trace");
    writeFileSync(join(bin, "node"), `#!/bin/sh\nprintf '%s\\n' "$*" >> "$TRACE"\n`);
    chmodSync(join(bin, "node"), 0o755);
    writeFileSync(join(bin, "systemctl"), "#!/bin/sh\nprintf '%s\\n' \"$*\" >> \"$SYSTEMCTL_TRACE\"\ncase $1 in --user|is-active|stop|restart|start) exit 0;; *) exit 1;; esac\n");
    chmodSync(join(bin, "systemctl"), 0o755);
    const env = {
      ...process.env,
      ...destinations,
      PI_ORCHESTRATOR_LEDGER: ledger,
      PI_ORCHESTRATOR_TASK_MANIFEST: "",
      PATH: `${bin}:${process.env.PATH}`,
      TRACE: trace,
      ACTIVATE_TRACE: activationTrace,
      SYSTEMCTL_TRACE: systemctlTrace,
    };
    // The previous artifact carries no contract sources, so the change is
    // unknowable and must be treated as a contract change: restart, not drain.
    const first = spawnSync(join(deploy, "host"), ["converge"], { encoding: "utf8", env });
    assert.equal(first.status, 0, first.stderr);
    assert.equal(existsSync(trace), false);
    assert.match(readFileSync(systemctlTrace, "utf8"), /--user stop pi-orchestrator\.service\nstop pi-orchestrator-runner\.service\nstart pi-orchestrator-runner\.service\n--user start pi-orchestrator\.service/);
    assert.match(readFileSync(systemctlTrace, "utf8"), /restart pi-orchestrator-voice\.service/);
    assert.equal(readFileSync(activationTrace, "utf8"), "pi-remote.service\n");

    rmSync(trace, { force: true });
    const unchanged = spawnSync(join(deploy, "host"), ["converge"], { encoding: "utf8", env });
    assert.equal(unchanged.status, 0, unchanged.stderr);
    assert.equal(existsSync(trace), false);
    assert.equal(readFileSync(activationTrace, "utf8"), "pi-remote.service\n");

    writeFileSync(join(repository, "release"), "ordinary update\n");
    assert.equal(spawnSync("git", ["-C", repository, "add", "release"]).status, 0);
    assert.equal(spawnSync("git", ["-C", repository, "-c", "user.name=test", "-c", "user.email=test@example.test", "commit", "-qm", "ordinary update"]).status, 0);
    rmSync(systemctlTrace, { force: true });
    const ordinary = spawnSync(join(deploy, "host"), ["converge"], { encoding: "utf8", env });
    assert.equal(ordinary.status, 0, ordinary.stderr);
    assert.match(readFileSync(trace, "utf8"), /orchestrator\/dist\/cli\.js drain-runners/);
    assert.doesNotMatch(readFileSync(systemctlTrace, "utf8"), /stop pi-orchestrator-runner\.service/);

    rmSync(trace, { force: true });
    writeFileSync(supervisorSource, "changed\n");
    assert.equal(spawnSync("git", ["-C", repository, "add", supervisorSource]).status, 0);
    assert.equal(spawnSync("git", ["-C", repository, "-c", "user.name=test", "-c", "user.email=test@example.test", "commit", "-qm", "supervisor update"]).status, 0);
    rmSync(systemctlTrace, { force: true });
    const supervisorChanged = spawnSync(join(deploy, "host"), ["converge"], {
      encoding: "utf8",
      env,
    });
    assert.equal(supervisorChanged.status, 0, supervisorChanged.stderr);
    assert.equal(existsSync(trace), false);
    assert.match(readFileSync(systemctlTrace, "utf8"), /--user stop pi-orchestrator\.service\nstop pi-orchestrator-runner\.service\nstart pi-orchestrator-runner\.service\n--user start pi-orchestrator\.service/);

    writeFileSync(ledgerSource, "changed\n");
    assert.equal(spawnSync("git", ["-C", repository, "add", ledgerSource]).status, 0);
    assert.equal(spawnSync("git", ["-C", repository, "-c", "user.name=test", "-c", "user.email=test@example.test", "commit", "-qm", "ledger update"]).status, 0);
    rmSync(systemctlTrace, { force: true });
    const ledgerChanged = spawnSync(join(deploy, "host"), ["converge"], {
      encoding: "utf8",
      env,
    });
    assert.equal(ledgerChanged.status, 0, ledgerChanged.stderr);
    assert.equal(existsSync(trace), false);
    assert.match(readFileSync(systemctlTrace, "utf8"), /--user stop pi-orchestrator\.service\nstop pi-orchestrator-runner\.service\nstart pi-orchestrator-runner\.service\n--user start pi-orchestrator\.service/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
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

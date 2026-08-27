import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

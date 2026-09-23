import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

const helper = resolve("deploy/release-checkout");
const lib = resolve("deploy/lib");
const selectScript = 'set -euo pipefail; source "$1"; pi_stack_select_release_checkout "$2" "$3" "$4" "$5" "$6"; printf "%s\\n" "$commit"';
function git(repo, ...args) {
  const result = spawnSync("git", ["-C", repo, ...args], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "pi-release-checkout-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const repo = join(dir, "source");
  mkdirSync(repo);
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.name", "test");
  git(repo, "config", "user.email", "test@example.test");
  mkdirSync(join(repo, "deploy"));
  copyFileSync(lib, join(repo, "deploy/lib"));
  copyFileSync(helper, join(repo, "deploy/release-checkout"));
  writeFileSync(join(repo, "source"), "first\n");
  git(repo, "add", ".");
  git(repo, "commit", "-qm", "first");
  const first = git(repo, "rev-parse", "HEAD");
  writeFileSync(join(repo, "source"), "second\n");
  git(repo, "commit", "-qam", "second");
  const second = git(repo, "rev-parse", "HEAD");
  const state = join(dir, "release");
  const marker = join(dir, "live-commit");
  const args = (sha, rollback = "0") => ["-c", selectScript, "release-test", helper, state, repo, sha, marker, rollback];
  const hostLock = join(dir, "host.lock");
  const env = { ...process.env, PI_STACK_HOST_LOCK_PATH: hostLock };
  const select = (sha, rollback) => spawnSync("bash", args(sha, rollback), { encoding: "utf8", timeout: 5000, env });
  return { dir, repo, state, marker, first, second, args, select, env, hostLock };
}

test("release selects committed source without changing a dirty writer or its refs", (t) => {
  const f = fixture(t);
  writeFileSync(join(f.repo, "source"), "staged work\n");
  git(f.repo, "add", "source");
  writeFileSync(join(f.repo, "source"), "unstaged work\n");
  writeFileSync(join(f.repo, "untracked"), "retained work\n");
  const status = git(f.repo, "status", "--porcelain");
  const index = readFileSync(join(f.repo, ".git/index"));
  const result = f.select(f.first);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), f.first);
  assert.equal(readFileSync(join(f.state, "repository/source"), "utf8"), "first\n");
  assert.equal(git(f.repo, "rev-parse", "HEAD"), f.second);
  assert.equal(git(f.repo, "status", "--porcelain"), status);
  assert.deepEqual(readFileSync(join(f.repo, ".git/index")), index);
  assert.equal(readFileSync(join(f.repo, "source"), "utf8"), "unstaged work\n");
  assert.equal(readFileSync(join(f.repo, "untracked"), "utf8"), "retained work\n");
  assert.equal(f.select(f.second).status, 0);
  assert.equal(f.select(f.first).status, 65);
  assert.equal(f.select(f.first, "1").status, 0);
});

test("first selection respects the live marker and preserves a dirty release checkout", (t) => {
  const f = fixture(t);
  writeFileSync(f.marker, `${f.second}\n`);
  assert.equal(f.select(f.first).status, 65);
  assert.equal(f.select(f.second).status, 0);
  writeFileSync(join(f.state, "repository/source"), "unexpected edit\n");
  const result = f.select(f.second);
  assert.equal(result.status, 65);
  assert.match(result.stderr, /release-owned checkout has uncommitted changes/);
  assert.equal(readFileSync(join(f.state, "repository/source"), "utf8"), "unexpected edit\n");
});

test("selection recovers interrupted initialization and refuses an incorrect origin", (t) => {
  const f = fixture(t);
  mkdirSync(join(f.state, "repository"), { recursive: true });
  git(join(f.state, "repository"), "init", "-q");
  assert.equal(f.select(f.first).status, 0);
  git(join(f.state, "repository"), "remote", "set-url", "origin", "/not-the-source");
  const result = f.select(f.second);
  assert.equal(result.status, 65);
  assert.match(result.stderr, /origin differs/);
});

test("the wrapper retains the checkout lock until its proof finishes", async (t) => {
  const f = fixture(t);
  const child = spawn("bash", ["-c", `${selectScript}; read -r release_lock`, ...f.args(f.first).slice(2)], {
    stdio: ["pipe", "pipe", "pipe"], env: f.env,
  });
  t.after(() => child.kill());
  const finished = new Promise((resolveExit, reject) => {
    child.on("error", reject);
    child.on("exit", (code) => code === 0 ? resolveExit() : reject(new Error(`wrapper exited ${code}`)));
  });
  await new Promise((ready, reject) => {
    child.stdout.once("data", ready);
    child.once("error", reject);
    child.once("exit", () => reject(new Error("wrapper exited before selecting source")));
  });
  assert.equal(spawnSync("flock", ["-n", f.hostLock, "true"]).status, 1);
  const lock = join(f.state, "repository/.git/pi-stack-deploy.lock");
  assert.equal(spawnSync("flock", ["-n", lock, "true"]).status, 1);
  assert.equal(spawnSync("flock", ["-n", join(f.state, "release.lock"), "true"]).status, 1);
  child.stdin.end("done\n");
  await finished;
  assert.equal(spawnSync("flock", ["-n", lock, "true"]).status, 0);
});

import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

const entry = new URL("./main", import.meta.url).pathname;

function run(args, env, cwd) {
  return execFileSync(entry, args, {
    cwd,
    env: { ...process.env, ...env },
    encoding: "utf8",
    timeout: 30_000,
  }).trim();
}

function git(cwd, ...args) {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
}

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "agent-workspace-"));
  const source = path.join(root, "source");
  const remote = path.join(root, "remote.git");
  const workspaces = path.join(root, "workspaces");
  const state = path.join(root, "state", "registry.sqlite3");
  mkdirSync(source);
  git(source, "init", "-b", "main");
  git(source, "config", "user.name", "Test");
  git(source, "config", "user.email", "test@example.invalid");
  writeFileSync(path.join(source, ".gitignore"), "ignored-output/\n");
  writeFileSync(path.join(source, "file.txt"), "source\n");
  git(source, "add", ".");
  git(source, "commit", "-m", "source");
  execFileSync("git", ["clone", "--bare", source, remote]);
  git(source, "remote", "add", "origin", remote);
  git(source, "push", "-u", "origin", "main");
  return {
    root,
    source,
    remote,
    workspaces,
    env: { PI_WORKSPACE_STATE: state },
    close() { rmSync(root, { recursive: true, force: true }); },
  };
}

test("creates and releases a clean review checkout", () => {
  const f = fixture();
  try {
    const created = JSON.parse(run([
      "create", "--root", f.workspaces, "--name", "review-one", "--repo", f.remote,
      "--mode", "review", "--min-free-gib", "0", "--json",
    ], f.env));
    assert.equal(created.mode, "review");
    assert.equal(existsSync(created.path), true);
    const released = JSON.parse(run(["release", "--id", created.id, "--json"], f.env));
    assert.equal(released.action, "released");
    assert.equal(existsSync(created.path), false);
  } finally {
    f.close();
  }
});

test("releases and can recreate a linked worktree name", () => {
  const f = fixture();
  try {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const created = JSON.parse(run([
        "create", "--root", f.workspaces, "--name", "linked", "--repo", f.remote,
        "--strategy", "worktree", "--mode", "writer", "--min-free-gib", "0", "--json",
      ], f.env));
      assert.equal(created.checkoutType, "worktree");
      const released = JSON.parse(run(["release", "--id", created.id, "--json"], f.env));
      assert.equal(released.action, "released");
    }
  } finally {
    f.close();
  }
});

test("keeps local commits but strips declared caches", () => {
  const f = fixture();
  try {
    const created = JSON.parse(run([
      "create", "--root", f.workspaces, "--name", "writer-one", "--repo", f.remote,
      "--mode", "writer", "--min-free-gib", "0", "--json",
    ], f.env));
    git(created.path, "config", "user.name", "Test");
    git(created.path, "config", "user.email", "test@example.invalid");
    writeFileSync(path.join(created.path, "file.txt"), "changed\n");
    git(created.path, "add", "file.txt");
    git(created.path, "commit", "-m", "local work");
    mkdirSync(path.join(created.path, "node_modules", "package"), { recursive: true });
    writeFileSync(path.join(created.path, "node_modules", "package", "index.js"), "generated\n");
    const result = JSON.parse(run(["release", "--id", created.id, "--json"], f.env));
    assert.equal(result.inspection.classification, "repair-required");
    assert.match(result.inspection.reason, /commits absent from remote refs/);
    assert.equal(existsSync(created.path), true);
    assert.equal(existsSync(path.join(created.path, "node_modules")), false);
    assert.equal(readFileSync(path.join(created.path, "file.txt"), "utf8"), "changed\n");
  } finally {
    f.close();
  }
});

test("releases a writer after its branch is pushed", () => {
  const f = fixture();
  try {
    const created = JSON.parse(run([
      "create", "--root", f.workspaces, "--name", "writer-pushed", "--repo", f.remote,
      "--mode", "writer", "--min-free-gib", "0", "--json",
    ], f.env));
    git(created.path, "config", "user.name", "Test");
    git(created.path, "config", "user.email", "test@example.invalid");
    writeFileSync(path.join(created.path, "file.txt"), "published\n");
    git(created.path, "add", "file.txt");
    git(created.path, "commit", "-m", "published work");
    git(created.path, "push", "-u", "origin", "HEAD");
    const result = JSON.parse(run(["release", "--id", created.id, "--json"], f.env));
    assert.equal(result.action, "released");
    assert.equal(existsSync(created.path), false);
  } finally {
    f.close();
  }
});

test("unknown ignored output requires repair", () => {
  const f = fixture();
  try {
    const created = JSON.parse(run([
      "create", "--root", f.workspaces, "--name", "ignored", "--repo", f.remote,
      "--mode", "review", "--min-free-gib", "0", "--json",
    ], f.env));
    mkdirSync(path.join(created.path, "ignored-output"));
    writeFileSync(path.join(created.path, "ignored-output", "proof.txt"), "keep me\n");
    const result = JSON.parse(run(["release", "--id", created.id, "--json"], f.env));
    assert.equal(result.inspection.classification, "repair-required");
    assert.match(result.inspection.reason, /unclassified ignored output/);
    assert.equal(existsSync(created.path), true);
  } finally {
    f.close();
  }
});

test("expired live references require an explicit reap", async () => {
  const f = fixture();
  let sleeper;
  try {
    const created = JSON.parse(run([
      "create", "--root", f.workspaces, "--name", "referenced", "--repo", f.remote,
      "--mode", "review", "--lease-seconds", "0", "--min-free-gib", "0", "--json",
    ], f.env));
    sleeper = spawn("sleep", ["60"], { cwd: created.path, stdio: "ignore" });
    await new Promise((resolve) => setTimeout(resolve, 100));
    const held = JSON.parse(run(["release", "--id", created.id, "--json"], f.env));
    assert.equal(held.inspection.classification, "referenced");
    assert.equal(existsSync(created.path), true);
    const reaped = JSON.parse(run(["release", "--id", created.id, "--reap-expired", "--json"], f.env));
    assert.equal(reaped.action, "released");
    assert.equal(existsSync(created.path), false);
    await new Promise((resolve) => sleeper.once("exit", resolve));
  } finally {
    sleeper?.kill("SIGKILL");
    f.close();
  }
});

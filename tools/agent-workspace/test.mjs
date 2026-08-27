import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { workspaceTesting } from "./workspace.mjs";

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

test("offers help through the installed command and each subcommand", () => {
  const root = mkdtempSync(path.join(tmpdir(), "agent-workspace-link-"));
  try {
    const linked = path.join(root, "agent-workspace");
    symlinkSync(entry, linked);
    for (const args of [["--help"], ["create", "--help"]]) {
      const output = execFileSync(linked, args, { encoding: "utf8" });
      assert.match(output, /agent-workspace create/);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("migrates a registry created before workspace groups", () => {
  const root = mkdtempSync(path.join(tmpdir(), "agent-workspace-migration-"));
  const state = path.join(root, "registry.sqlite3");
  try {
    const database = new DatabaseSync(state);
    database.exec(`CREATE TABLE workspace (
      id TEXT PRIMARY KEY, path TEXT NOT NULL UNIQUE, root TEXT NOT NULL,
      kind TEXT NOT NULL, mode TEXT NOT NULL, owner TEXT NOT NULL,
      repository TEXT, source_commit TEXT, checkout_type TEXT NOT NULL,
      cache_paths TEXT NOT NULL, created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL, lease_expires_at INTEGER NOT NULL,
      state TEXT NOT NULL, detail TEXT NOT NULL
    )`);
    database.close();
    const status = run(["status", "--json"], { PI_WORKSPACE_STATE: state });
    assert.deepEqual(JSON.parse(status), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("ignores containers removed during the Docker ownership snapshot", () => {
  const snapshot = workspaceTesting.dockerSnapshot((_executable, args) => {
    if (args[0] === "ps") return { status: 0, stdout: "vanished\nlive", stderr: "" };
    if (args[1] === "vanished") return { status: 1, stdout: "", stderr: "Error: No such object: vanished" };
    return { status: 0, stdout: JSON.stringify([{ Id: "live" }]), stderr: "" };
  });
  assert.deepEqual(snapshot, { containers: [{ Id: "live" }], available: true });
});

test("classifies active systemd workspace references", () => {
  const workspace = "/srv/workspaces/agent-one";
  const units = workspaceTesting.parseSystemdUnits(`Id=worker.service\nActiveState=active\nExecStart={ path=/usr/bin/node ; argv[]=/usr/bin/node ${workspace}/server.js ; }\nWorkingDirectory=${workspace}\n\nId=finished.service\nActiveState=inactive\nExecStart={ path=/bin/true ; argv[]=/bin/true ; }\nWorkingDirectory=${workspace}\n`, "user");
  const result = workspaceTesting.systemdReferences(workspace, { units, available: true });
  assert.deepEqual(result.references.map(({ id, manager }) => ({ id, manager })), [
    { id: "worker.service", manager: "user" },
  ]);
});

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

test("a linked worktree ignores branches owned by its peers", () => {
  const f = fixture();
  try {
    const first = JSON.parse(run([
      "create", "--root", f.workspaces, "--name", "first", "--repo", f.remote,
      "--strategy", "worktree", "--mode", "writer", "--min-free-gib", "0", "--json",
    ], f.env));
    const second = JSON.parse(run([
      "create", "--root", f.workspaces, "--name", "second", "--repo", f.remote,
      "--strategy", "worktree", "--mode", "writer", "--min-free-gib", "0", "--json",
    ], f.env));
    for (const workspace of [first, second]) {
      git(workspace.path, "config", "user.name", "Test");
      git(workspace.path, "config", "user.email", "test@example.invalid");
      writeFileSync(path.join(workspace.path, "file.txt"), `${path.basename(workspace.path)}\n`);
      git(workspace.path, "add", "file.txt");
      git(workspace.path, "commit", "-m", path.basename(workspace.path));
    }
    git(first.path, "remote", "add", "publish", f.remote);
    git(first.path, "push", "-u", "publish", "HEAD");

    const released = JSON.parse(run(["release", "--id", first.id, "--json"], f.env));
    assert.equal(released.action, "released");
    assert.equal(existsSync(first.path), false);
    assert.equal(existsSync(second.path), true);

    const retained = JSON.parse(run(["release", "--id", second.id, "--json"], f.env));
    assert.equal(retained.inspection.classification, "repair-required");
    git(second.path, "push", "-u", "publish", "HEAD");
    const secondRelease = JSON.parse(run(["release", "--id", second.id, "--json"], f.env));
    assert.equal(secondRelease.action, "released");
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
    mkdirSync(path.join(created.path, "packages", "api", "node_modules", "package"), { recursive: true });
    writeFileSync(path.join(created.path, "packages", "api", "node_modules", "package", "index.js"), "generated\n");
    const result = JSON.parse(run(["release", "--id", created.id, "--json"], f.env));
    assert.equal(result.inspection.classification, "repair-required");
    assert.match(result.inspection.reason, /commits absent from remote refs/);
    assert.equal(existsSync(created.path), true);
    assert.equal(existsSync(path.join(created.path, "node_modules")), false);
    assert.equal(existsSync(path.join(created.path, "packages", "api", "node_modules")), false);
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

test("keeps a unique detached HEAD even when local branches are remote", () => {
  const f = fixture();
  try {
    const created = JSON.parse(run([
      "create", "--root", f.workspaces, "--name", "detached-work", "--repo", f.remote,
      "--mode", "review", "--min-free-gib", "0", "--json",
    ], f.env));
    git(created.path, "config", "user.name", "Test");
    git(created.path, "config", "user.email", "test@example.invalid");
    writeFileSync(path.join(created.path, "file.txt"), "detached work\n");
    git(created.path, "add", "file.txt");
    git(created.path, "commit", "-m", "detached work");

    const held = JSON.parse(run(["release", "--id", created.id, "--json"], f.env));
    assert.equal(held.inspection.classification, "repair-required");
    assert.match(held.inspection.reason, /HEAD:1/);
    assert.equal(existsSync(created.path), true);
  } finally {
    f.close();
  }
});

test("keeps every repository in a group until all are recoverable", () => {
  const f = fixture();
  try {
    const secondRoot = path.join(f.root, "second-workspaces");
    const first = JSON.parse(run([
      "create", "--root", f.workspaces, "--name", "backend", "--repo", f.remote,
      "--mode", "writer", "--group", "link-change-1", "--min-free-gib", "0", "--json",
    ], f.env));
    const second = JSON.parse(run([
      "create", "--root", secondRoot, "--name", "frontend", "--repo", f.remote,
      "--mode", "review", "--group", "link-change-1", "--min-free-gib", "0", "--json",
    ], f.env));
    git(first.path, "config", "user.name", "Test");
    git(first.path, "config", "user.email", "test@example.invalid");
    writeFileSync(path.join(first.path, "file.txt"), "grouped work\n");
    git(first.path, "add", "file.txt");
    git(first.path, "commit", "-m", "grouped work");

    const held = JSON.parse(run(["release", "--id", second.id, "--json"], f.env));
    assert.equal(Array.isArray(held), true);
    assert.equal(held.some((result) => result.inspection.classification === "repair-required"), true);
    assert.equal(existsSync(first.path), true);
    assert.equal(existsSync(second.path), true);

    git(first.path, "push", "-u", "origin", "HEAD");
    const released = JSON.parse(run(["release", "--id", first.id, "--json"], f.env));
    assert.equal(released.every((result) => result.action === "released-group"), true);
    assert.equal(existsSync(first.path), false);
    assert.equal(existsSync(second.path), false);
  } finally {
    f.close();
  }
});

test("keeps an object source until registered alternate borrowers are released", () => {
  const f = fixture();
  try {
    mkdirSync(f.workspaces, { recursive: true });
    const source = path.join(f.workspaces, "object-source");
    const borrower = path.join(f.workspaces, "borrower");
    execFileSync("git", ["clone", f.remote, source]);
    execFileSync("git", ["clone", "--reference", source, f.remote, borrower]);
    const records = JSON.parse(run([
      "adopt", "--root", f.workspaces, "--lease-seconds", "0", "--json",
    ], f.env));
    const sourceRecord = records.find((record) => record.path === source);
    const borrowerRecord = records.find((record) => record.path === borrower);

    const held = JSON.parse(run(["release", "--id", sourceRecord.id, "--json"], f.env));
    assert.equal(held.inspection.classification, "referenced");
    assert.match(held.inspection.reason, /borrow this checkout's objects/);
    assert.equal(existsSync(source), true);

    const borrowerRelease = JSON.parse(run(["release", "--id", borrowerRecord.id, "--json"], f.env));
    assert.equal(borrowerRelease.action, "released");
    const sourceRelease = JSON.parse(run(["release", "--id", sourceRecord.id, "--json"], f.env));
    assert.equal(sourceRelease.action, "released");
  } finally {
    f.close();
  }
});

test("adopts nested repositories as one workspace group", () => {
  const f = fixture();
  try {
    const container = path.join(f.workspaces, "link-change");
    mkdirSync(container, { recursive: true });
    const backend = path.join(container, "backend");
    const frontend = path.join(container, "frontend");
    execFileSync("git", ["clone", f.remote, backend]);
    execFileSync("git", ["clone", f.remote, frontend]);
    writeFileSync(path.join(backend, "file.txt"), "uncommitted work\n");

    const held = JSON.parse(run([
      "adopt", "--root", f.workspaces, "--nested-groups", "--execute", "--json",
    ], f.env));
    assert.equal(held.length, 2);
    assert.equal(new Set(held.map((result) => result.record.groupId)).size, 1);
    assert.equal(held.some((result) => result.inspection.classification === "repair-required"), true);
    assert.equal(existsSync(backend), true);
    assert.equal(existsSync(frontend), true);

    git(backend, "checkout", "--", "file.txt");
    const released = JSON.parse(run([
      "reconcile", "--root", f.workspaces, "--execute", "--json",
    ], f.env));
    assert.equal(released.every((result) => result.action === "released-group"), true);
    assert.equal(existsSync(container), false);
  } finally {
    f.close();
  }
});

test("empty ignored directories do not masquerade as unique work", () => {
  const f = fixture();
  try {
    const created = JSON.parse(run([
      "create", "--root", f.workspaces, "--name", "empty-ignored", "--repo", f.remote,
      "--mode", "review", "--min-free-gib", "0", "--json",
    ], f.env));
    mkdirSync(path.join(created.path, "ignored-output"));
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

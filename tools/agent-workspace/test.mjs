import assert from "node:assert/strict";
import { execFile, execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createServer } from "node:net";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test as nodeTest } from "node:test";
import { workspaceTesting } from "./workspace.mjs";

const [shardIndex = 0, shardCount = 1] = (process.env.AGENT_WORKSPACE_TEST_SHARD ?? "0/1")
  .split("/").map(Number);
if (!Number.isSafeInteger(shardIndex) || !Number.isSafeInteger(shardCount)
  || shardIndex < 0 || shardCount < 1 || shardIndex >= shardCount) {
  throw new Error("AGENT_WORKSPACE_TEST_SHARD must be a zero-based INDEX/COUNT");
}
let testIndex = 0;
const test = (name, body) => nodeTest(name, { skip: testIndex++ % shardCount !== shardIndex }, body);
const entry = new URL("./main", import.meta.url).pathname;

function run(args, env, cwd) {
  return execFileSync(entry, args, {
    cwd,
    env: { ...process.env, ...env },
    encoding: "utf8",
    timeout: 30_000,
  }).trim();
}

function runAsync(args, env, cwd) {
  return new Promise((resolve, reject) => {
    execFile(entry, args, {
      cwd,
      env: { ...process.env, ...env },
      encoding: "utf8",
      timeout: 30_000,
    }, (error, stdout) => error ? reject(error) : resolve(stdout.trim()));
  });
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
    env: {
      PI_WORKSPACE_STATE: state,
      PI_WORKSPACE_TEST_EXTERNAL_SAFETY: "empty",
    },
    close() { rmSync(root, { recursive: true, force: true }); },
  };
}

function interruptCreation(f, stage) {
  const bin = path.join(f.root, "bin");
  mkdirSync(bin);
  const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
  const marker = path.join(f.root, "interrupted");
  const wrapper = path.join(bin, "git");
  writeFileSync(wrapper, `#!${process.execPath}
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const args = process.argv.slice(2);
const result = spawnSync(${JSON.stringify(realGit)}, args, {stdio:'inherit'});
if (result.status === 0 && args.includes(${JSON.stringify(stage)}) && !fs.existsSync(${JSON.stringify(marker)})) {
  fs.writeFileSync(${JSON.stringify(marker)}, 'interrupted');
  process.kill(process.ppid, 'SIGKILL');
}
process.exit(result.status ?? 1);
`);
  chmodSync(wrapper, 0o755);
  return { ...f.env, PATH: `${bin}:${process.env.PATH}` };
}

for (const stage of ["clone", "checkout"]) test(`creation resumes after interruption following ${stage}`, () => {
  const f = fixture();
  try {
    const args = ["create", "--root", f.workspaces, "--name", "resumable", "--repo", f.source,
      "--owner", "original-owner", "--min-free-gib", "0", "--json"];
    assert.throws(() => run(args, interruptCreation(f, stage)));
    const [pending] = JSON.parse(run(["status", "--json"], f.env));
    assert.equal(pending.state, "creating");
    assert.equal(pending.owner, "original-owner");
    const [inspection] = JSON.parse(run(["reconcile", "--execute", "--reap-expired", "--json"], f.env));
    assert.equal(inspection.action, "none");
    assert.equal(existsSync(pending.path), true);
    assert.throws(() => run([...args, "--group", "another-owner"], f.env), /different creation request/);
    writeFileSync(path.join(f.source, "later.txt"), "later source\n");
    git(f.source, "add", "later.txt");
    git(f.source, "commit", "-m", "advance source after interruption");
    const resumed = JSON.parse(run(args, f.env));
    assert.equal(resumed.id, pending.id);
    assert.equal(resumed.sourceCommit, pending.sourceCommit);
    assert.equal(resumed.state, "active");
    assert.equal(readFileSync(path.join(resumed.path, "file.txt"), "utf8"), "source\n");
    assert.deepEqual(JSON.parse(run(args, f.env)), resumed);
  } finally { f.close(); }
});

test("source preparation interruption leaves no destination reservation", () => {
  const f = fixture();
  try {
    const args = ["create", "--root", f.workspaces, "--name", "preparing", "--repo", f.source,
      "--min-free-gib", "0", "--json"];
    assert.throws(() => run(args, interruptCreation(f, "config")));
    assert.deepEqual(JSON.parse(run(["status", "--json"], f.env)), []);
    assert.equal(existsSync(path.join(f.workspaces, "preparing")), false);
    assert.equal(JSON.parse(run(args, f.env)).state, "active");
  } finally { f.close(); }
});

test("invalid sources never reserve a destination and corrected sources resolve to commits", () => {
  const f = fixture();
  try {
    const commit = git(f.source, "rev-parse", "HEAD");
    const blob = git(f.source, "rev-parse", "HEAD:file.txt");
    git(f.source, "tag", "not-a-commit", blob);
    for (const repository of [f.source, `file://${f.remote}`]) {
      const args = ["create", "--root", f.workspaces, "--name", "validated", "--repo", repository,
        "--min-free-gib", "0", "--json"];
      for (const ref of ["no-such-ref", "012345678", ...(repository === f.source ? ["not-a-commit"] : [])]) {
        assert.throws(() => run([...args, "--ref", ref], f.env));
        assert.equal(JSON.parse(run(["status", "--json"], f.env)).some(row => row.state === "creating"), false);
        assert.equal(existsSync(path.join(f.workspaces, "validated")), false);
      }
      const created = JSON.parse(run([...args, "--ref", commit.slice(0, 9)], f.env));
      assert.equal(created.sourceCommit, commit);
      assert.equal(git(created.path, "rev-parse", "HEAD"), commit);
      run(["release", "--id", created.id, "--json"], f.env);
    }
  } finally { f.close(); }
});

test("explicit cancellation retires an absent creation without changing grouped peers", () => {
  const f = fixture();
  try {
    const args = ["create", "--root", f.workspaces, "--repo", f.source,
      "--group", "paired", "--min-free-gib", "0", "--json"];
    const pending = JSON.parse(run([...args, "--name", "failed"], f.env));
    const peer = JSON.parse(run([...args, "--name", "peer"], f.env));
    const database = new DatabaseSync(f.env.PI_WORKSPACE_STATE);
    database.prepare("UPDATE workspace SET state='creating', source_commit=NULL, lease_expires_at=0 WHERE id=?").run(pending.id);
    database.close();
    rmSync(pending.path, { recursive: true });
    symlinkSync(path.join(f.root, "absent-target"), pending.path);
    assert.throws(() => run(["cancel-creation", "--id", pending.id], f.env), /pending checkout exists/);
    rmSync(pending.path);
    const cancelled = JSON.parse(run(["cancel-creation", "--id", pending.id, "--json"], f.env));
    assert.equal(cancelled.state, "released");
    assert.equal(cancelled.sourceCommit, null);
    const [unchanged] = JSON.parse(run(["status", "--path", peer.path, "--json"], f.env));
    assert.deepEqual(unchanged, peer);
    const recovered = JSON.parse(run([...args, "--name", "failed", "--ref", peer.sourceCommit], f.env));
    assert.notEqual(recovered.id, pending.id);
    assert.equal(recovered.state, "active");
    assert.throws(() => run(["cancel-creation", "--id", recovered.id], f.env), /cannot cancel creation from state active/);
  } finally { f.close(); }
});

test("pending creation preserves edits and ignored output instead of deleting a failed checkout", () => {
  const f = fixture();
  try {
    const args = ["create", "--root", f.workspaces, "--name", "preserved", "--repo", f.source,
      "--min-free-gib", "0", "--json"];
    assert.throws(() => run(args, interruptCreation(f, "checkout")));
    const destination = path.join(f.workspaces, "preserved");
    writeFileSync(path.join(destination, "file.txt"), "unique source\n");
    mkdirSync(path.join(destination, "ignored-output"));
    writeFileSync(path.join(destination, "ignored-output", "proof"), "retain\n");
    assert.throws(() => run(args, f.env), /pending checkout contains changes/);
    assert.throws(() => run(["cancel-creation", "--path", destination], f.env), /pending checkout exists/);
    const retained = JSON.parse(run(["release", "--path", destination, "--json"], f.env));
    assert.equal(retained.action, "none");
    assert.equal(readFileSync(path.join(destination, "file.txt"), "utf8"), "unique source\n");
    assert.equal(readFileSync(path.join(destination, "ignored-output", "proof"), "utf8"), "retain\n");
  } finally { f.close(); }
});

test("local reference creation does not copy unreachable source objects", () => {
  const f = fixture();
  try {
    const object = execFileSync("git", ["-C", f.source, "hash-object", "-w", "--stdin"], {
      input: "unreferenced cache object\n", encoding: "utf8",
    }).trim();
    const created = JSON.parse(run(["create", "--root", f.workspaces, "--name", "negotiated",
      "--repo", f.source, "--min-free-gib", "0", "--json"], f.env));
    assert.equal(existsSync(path.join(created.path, ".git", "objects", object.slice(0, 2), object.slice(2))), false);
    assert.equal(readFileSync(path.join(created.path, "file.txt"), "utf8"), "source\n");
  } finally { f.close(); }
});

test("bounded reconciliation reports deferred custody and resumes after a released cursor", () => {
  const f = fixture();
  try {
    const records = ["a-clean", "b-dirty", "c-unpushed", "d-leased"].map((name) => JSON.parse(run([
      "create", "--root", f.workspaces, "--repo", f.remote, "--name", name,
      "--lease-seconds", name === "d-leased" ? "3600" : "0", "--min-free-gib", "0", "--json",
    ], f.env)));
    writeFileSync(path.join(records[1].path, "file.txt"), "retain my changes\n");
    git(records[2].path, "config", "user.name", "Test");
    git(records[2].path, "config", "user.email", "test@example.invalid");
    writeFileSync(path.join(records[2].path, "file.txt"), "unique commit\n");
    git(records[2].path, "commit", "-am", "unique");
    const args = ["reconcile", "--root", f.workspaces, "--max-groups", "1", "--json"];
    const preview = JSON.parse(run(args, f.env));
    assert.equal(preview[0].inspection.classification, "reclaimable");
    assert.deepEqual(preview.slice(1).map((r) => r.inspection.classification), ["deferred", "deferred", "deferred"]);
    assert.equal(preview[1].continuationAfter, records[0].id);
    assert.ok(records.every((r) => existsSync(r.path)));
    const first = JSON.parse(run([...args, "--execute"], f.env));
    assert.equal(first[0].action, "released");
    assert.equal(existsSync(records[0].path), false);
    const arrivals = ["0-new", "a-late"].map((name) => JSON.parse(run([
      "create", "--root", f.workspaces, "--repo", f.remote, "--name", name,
      "--lease-seconds", "3600", "--min-free-gib", "0", "--json",
    ], f.env)));
    const inserted = JSON.parse(run([...args, "--execute"], f.env));
    assert.equal(inserted[0].record.id, arrivals[1].id);
    assert.equal(inserted.find((r) => r.record.id === arrivals[0].id).inspection.classification, "deferred");
    const second = JSON.parse(run([...args, "--execute"], f.env));
    assert.equal(second[0].record.id, records[1].id);
    assert.equal(second[0].inspection.classification, "repair-required");
    const third = JSON.parse(run([...args, "--execute"], f.env));
    assert.equal(third[0].record.id, records[2].id);
    assert.match(third[0].inspection.reason, /commits absent from remote/);
    const fourth = JSON.parse(run([...args, "--execute"], f.env));
    assert.equal(fourth[0].record.id, records[3].id);
    assert.equal(fourth[0].inspection.classification, "active");
    assert.ok(records.slice(1).every((r) => existsSync(r.path)));
    const wrapped = JSON.parse(run([...args, "--execute"], f.env));
    assert.equal(wrapped[0].record.id, arrivals[0].id);
    assert.equal(wrapped[0].inspection.classification, "active");
    const resumed = JSON.parse(run([...args, "--after", records[1].id], f.env));
    assert.equal(resumed[0].record.id, records[2].id);
  } finally { f.close(); }
});

test("bounded reconciliation preserves caches across a runtime-referenced group", () => {
  const f = fixture();
  try {
    const records = ["group-a", "group-b"].map((name) => JSON.parse(run([
      "create", "--root", f.workspaces, "--repo", f.remote, "--name", name, "--group", "runtime",
      "--lease-seconds", "0", "--min-free-gib", "0", "--json",
    ], f.env)));
    for (const record of records) {
      mkdirSync(path.join(record.path, "node_modules"));
      writeFileSync(path.join(record.path, "node_modules", "runtime-data"), "in use\n");
    }
    const database = new DatabaseSync(f.env.PI_WORKSPACE_STATE);
    try {
      const results = workspaceTesting.groupReconciliation(database, records, {
        execute: true, reapExpired: false, ignoreLease: false, statePath: f.env.PI_WORKSPACE_STATE,
        safety: {
          processes: [{ pid: 12345, command: "runtime", cwd: records[0].path, executable: null, commandLine: [] }],
          docker: { containers: [], available: false }, systemd: { units: [], available: false }, gitAlternates: [],
        },
      });
      assert.equal(results[0].inspection.classification, "referenced");
      assert.ok(results.every((r) => r.action === "none"));
      assert.ok(records.every((r) => existsSync(path.join(r.path, "node_modules", "runtime-data"))));
    } finally { database.close(); }
  } finally { f.close(); }
});

test("a queued thread on one group member keeps both workspaces and their caches", () => {
  const f = fixture();
  try {
    const records = ["one", "two"].map((name) => JSON.parse(run([
      "create", "--root", f.workspaces, "--repo", f.remote, "--name", name, "--group", "paired",
      "--lease-seconds", "0", "--min-free-gib", "0", "--json",
    ], f.env)));
    const application = path.join(f.root, "applications", "sample");
    mkdirSync(application, { recursive: true });
    const databasePath = path.join(application, "threads.sqlite3");
    const db = new DatabaseSync(databasePath);
    db.exec(`CREATE TABLE thread(id TEXT, cwd TEXT, state TEXT);
      CREATE TABLE thread_work(thread_id TEXT, status TEXT);
      CREATE TABLE thread_execution(thread_id TEXT, ended_at INTEGER);`);
    db.prepare("INSERT INTO thread VALUES(?,?,?)").run("worker", records[0].path, "idle");
    db.prepare("INSERT INTO thread_work VALUES(?,?)").run("worker", "queued");
    const previousLedger = process.env.PI_ORCHESTRATOR_LEDGER;
    process.env.PI_ORCHESTRATOR_LEDGER = path.join(f.root, "ledger.sqlite3");
    try {
      assert.ok(workspaceTesting.ownerThreadDatabases().includes(databasePath));
      assert.deepEqual(workspaceTesting.threadSnapshot(workspaceTesting.ownerThreadDatabases())
        .filter((thread) => thread.cwd === records[0].path).map((thread) => thread.id), ["worker"]);
    } finally {
      if (previousLedger === undefined) delete process.env.PI_ORCHESTRATOR_LEDGER;
      else process.env.PI_ORCHESTRATOR_LEDGER = previousLedger;
    }
    for (const record of records) {
      mkdirSync(path.join(record.path, "node_modules"));
      writeFileSync(path.join(record.path, "node_modules", "needed"), "in use");
    }
    const result = JSON.parse(run(["release", "--path", records[1].path, "--json"], {
      ...f.env, PI_ORCHESTRATOR_LEDGER: path.join(f.root, "ledger.sqlite3"),
      PI_THREAD_DATABASE: databasePath,
    }));
    assert.equal(result.find(({ record }) => record.id === records[0].id).inspection.classification, "referenced");
    assert.ok(records.every((record) => existsSync(path.join(record.path, "node_modules", "needed"))));
    db.close();
  } finally { f.close(); }
});

test("bounded reconciliation stops a stalled read without declaring unchecked paths clean", () => {
  const f = fixture();
  try {
    const record = JSON.parse(run(["create", "--root", f.workspaces, "--repo", f.remote,
      "--name", "slow", "--lease-seconds", "0", "--min-free-gib", "0", "--json"], f.env));
    const bin = path.join(f.root, "bin");
    mkdirSync(bin);
    const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
    writeFileSync(path.join(bin, "git"), `#!/usr/bin/env node\nif (process.argv.includes('status')) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10000); } else { const r=require('node:child_process').spawnSync(${JSON.stringify(realGit)}, process.argv.slice(2), {stdio:'inherit'}); process.exit(r.status??1); }\n`, { mode: 0o755 });
    const started = Date.now();
    const result = JSON.parse(run(["reconcile", "--root", f.workspaces, "--budget-ms", "600", "--json"], {
      ...f.env, PATH: `${bin}:${process.env.PATH}`,
    }));
    assert.ok(Date.now() - started < 2500);
    assert.equal(result[0].inspection.classification, "blocked");
    assert.equal(result[0].action, "none");
    assert.ok(existsSync(record.path));
    assert.equal(readFileSync(path.join(record.path, "file.txt"), "utf8"), "source\n");
  } finally { f.close(); }
});

test("capacity follows available storage unless a caller imposes a count limit", () => {
  const f = fixture();
  try {
    for (let index = 0; index < 40; index += 1) {
      mkdirSync(path.join(f.workspaces, `retained-${index}`), { recursive: true });
    }
    const args = ["create", "--root", f.workspaces, "--repo", f.remote, "--json"];
    const record = JSON.parse(run([...args, "--name", "admitted", "--min-free-gib", "0"], f.env));
    assert.equal(record.path, path.join(f.workspaces, "admitted"));
    assert.throws(() => run([...args, "--name", "blocked", "--max-count", "41"], f.env),
      /limit is 41/);
    assert.throws(() => run([...args, "--name", "disk-blocked", "--min-free-gib", "1000000000"], f.env),
      /GiB is required/);
  } finally {
    f.close();
  }
});

test("allocates from a reclaimed caller directory without changing valid relative paths", () => {
  const f = fixture();
  try {
    git(f.source, "remote", "set-url", "origin", "../remote.git");
    const fromRemovedDirectory = (name, repository) => {
      const gone = path.join(f.root, `caller-${name}`);
      mkdirSync(gone);
      return execFileSync("bash", ["-c", 'rmdir -- "$1"; shift; exec "$@"', "removed-cwd",
        gone, entry, "create", "--root", f.workspaces, "--name", name,
        "--repo", repository, "--min-free-gib", "0", "--json"], {
        cwd: gone,
        env: { ...process.env, ...f.env },
        encoding: "utf8",
        timeout: 30_000,
      });
    };
    const relative = JSON.parse(run(["create", "--root", "workspaces", "--name", "relative",
      "--repo", "source", "--min-free-gib", "0", "--json"], f.env, f.root));
    assert.equal(relative.sourceCommit, git(f.source, "rev-parse", "HEAD"));
    for (const [name, repository, origin] of [
      ["local", f.source, f.remote],
      ["remote", `file://${f.remote}`, `file://${f.remote}`],
    ]) {
      const record = JSON.parse(fromRemovedDirectory(name, repository));
      assert.equal(record.sourceCommit, relative.sourceCommit);
      assert.equal(git(record.path, "remote", "get-url", "origin"), origin);
    }
    assert.throws(() => fromRemovedDirectory("unresolved", "source"),
      /current directory was removed; --repo must be an absolute path or a Git URL/);
  } finally {
    f.close();
  }
});

test("offers help through the installed command and each subcommand", () => {
  const root = mkdtempSync(path.join(tmpdir(), "agent-workspace-link-"));
  try {
    const linked = path.join(root, "agent-workspace");
    symlinkSync(entry, linked);
    for (const args of [["--help"], ["create", "--help"]]) {
      const output = execFileSync(linked, args, { encoding: "utf8" });
      assert.match(output, /agent-workspace create/);
      assert.match(output, /--cache PATH/);
      assert.match(output, /not origin\/main/);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a reader that closes the output pipe does not crash the command", async () => {
  const f = fixture();
  try {
    run(["status", "--json"], f.env);
    const database = new DatabaseSync(f.env.PI_WORKSPACE_STATE);
    const insert = database.prepare(`INSERT INTO workspace
      (id,path,root,kind,mode,owner,repository,source_commit,checkout_type,
       cache_paths,created_at,updated_at,lease_expires_at,state,detail,group_id)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,NULL)`);
    for (let index = 0; index < 512; index += 1) {
      insert.run(
        `workspace-${index}`, path.join(f.workspaces, `workspace-${index}`), f.workspaces,
        "agent", "writer", `owner-${index}`, f.remote, "a".repeat(40), "clone",
        JSON.stringify(["node_modules"]), index, index, 0, "released", "durable remote branch",
      );
    }
    database.close();

    const child = spawn(entry, ["status", "--json"], {
      env: { ...process.env, ...f.env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.stdout.once("data", () => child.stdout.destroy());
    const code = await new Promise((resolve) => child.once("close", resolve));
    assert.equal(code, 0, stderr);
  } finally {
    f.close();
  }
});

test("released records whose trees are gone leave the registry after a month", () => {
  const root = mkdtempSync(path.join(tmpdir(), "agent-workspace-prune-"));
  const state = path.join(root, "registry.sqlite3");
  try {
    run(["status", "--json"], { PI_WORKSPACE_STATE: state });
    const database = new DatabaseSync(state);
    const insert = database.prepare(`INSERT INTO workspace (id, path, root, kind, mode, owner, checkout_type, cache_paths,
      created_at, updated_at, lease_expires_at, state, detail) VALUES (?, ?, ?, 'test', 'writer', 'test', 'clone', '[]', ?, ?, 0, ?, '')`);
    const now = Date.now();
    const old = now - 40 * 24 * 60 * 60_000;
    insert.run("gone-old", path.join(root, "gone-old"), root, old, old, "released");
    insert.run("gone-new", path.join(root, "gone-new"), root, now, now, "released");
    insert.run("present-old", root, root, old, old, "released");
    insert.run("active-old", path.join(root, "active-old"), root, old, old, "active");
    assert.equal(workspaceTesting.pruneReleased(database, now), 1);
    assert.deepEqual(database.prepare("SELECT id FROM workspace ORDER BY id").all().map((row) => row.id), ["active-old", "gone-new", "present-old"]);
    database.close();
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

test("initialized registry reads do not acquire the SQLite writer lock", () => {
  const f = fixture();
  let database;
  try {
    const created = JSON.parse(run(["create", "--root", f.workspaces, "--name", "writer-held",
      "--repo", f.remote, "--min-free-gib", "0", "--json"], f.env));
    database = new DatabaseSync(f.env.PI_WORKSPACE_STATE);
    database.exec("BEGIN IMMEDIATE");
    database.prepare("UPDATE workspace SET detail='uncommitted writer' WHERE id=?").run(created.id);
    const output = execFileSync(entry, ["status", "--json"], {
      env: { ...process.env, ...f.env }, encoding: "utf8", timeout: 1500,
    });
    const [observed] = JSON.parse(output);
    assert.equal(observed.id, created.id);
    assert.equal(observed.detail, "creation completed");
    database.exec("ROLLBACK");
    database.close();
    database = undefined;
  } finally {
    database?.close();
    f.close();
  }
});

test("forty cold registry clients initialize one WAL schema without contention failures", async () => {
  const f = fixture();
  try {
    const results = await Promise.all(Array.from({ length: 40 }, () => runAsync(["status", "--json"], f.env)));
    for (const result of results) assert.deepEqual(JSON.parse(result), []);
    const database = new DatabaseSync(f.env.PI_WORKSPACE_STATE);
    assert.equal(database.prepare("PRAGMA journal_mode").get().journal_mode, "wal");
    assert.equal(database.prepare("PRAGMA user_version").get().user_version, 1);
    assert.ok(database.prepare("PRAGMA table_info(workspace)").all().some(column => column.name === "creation_request"));
    database.close();
  } finally { f.close(); }
});

test("forty concurrent create and heartbeat clients share registry writes", async () => {
  const f = fixture();
  try {
    const commit = git(f.source, "rev-parse", "HEAD");
    const records = await Promise.all(Array.from({ length: 40 }, async (_, index) => JSON.parse(await runAsync([
      "create", "--root", f.workspaces, "--name", `concurrent-${index}`, "--repo", f.remote,
      "--ref", commit, "--min-free-gib", "0", "--json",
    ], f.env))));
    assert.equal(new Set(records.map(record => record.id)).size, 40);
    const renewed = await Promise.all(records.map(async record => JSON.parse(await runAsync([
      "heartbeat", "--path", record.path, "--json",
    ], f.env))));
    for (const record of renewed) {
      assert.equal(record.state, "active");
      assert.equal(record.sourceCommit, commit);
    }
    assert.equal(JSON.parse(run(["status", "--json"], f.env)).length, 40);
  } finally { f.close(); }
});

test("Docker authority excludes only an ungranted foreign Unix socket", () => {
  const denied = (code = "EACCES") => { throw Object.assign(new Error(code), { code }); };
  const foreign = { uid: 1006, inspect: () => ({ uid: 0, isSocket: () => true }), writable: () => denied() };
  assert.deepEqual(workspaceTesting.dockerEndpointScope("unix:///run/docker.sock", foreign),
    { inspect: false, reason: "foreign-owned-socket-without-connect-grant" });
  assert.deepEqual(workspaceTesting.dockerEndpointScope("unix:///run/docker.sock", { ...foreign, writable: () => {} }),
    { inspect: true });
  for (const options of [
    { ...foreign, uid: 0 },
    { ...foreign, inspect: () => ({ uid: 1006, isSocket: () => true }) },
    { ...foreign, inspect: () => denied() },
    { ...foreign, writable: () => denied("EIO") },
    { ...foreign, inspect: () => ({ uid: 0, isSocket: () => false }) },
  ]) assert.ok(workspaceTesting.dockerEndpointScope("unix:///run/docker.sock", options).error);
  assert.deepEqual(workspaceTesting.dockerEndpointScope("ssh://docker-host", foreign), { inspect: true });
});

test("Docker authority is resolved before daemon access without swallowing daemon failures", () => {
  const calls = [];
  const execute = (_executable, args) => {
    calls.push(args);
    if (args[0] === "context") return { status: 0, stdout: JSON.stringify("unix:///run/docker.sock"), stderr: "" };
    return { status: 1, stdout: "", stderr: "permission denied during docker ps" };
  };
  const scope = () => ({ inspect: false, reason: "foreign-owned-socket-without-connect-grant" });
  assert.deepEqual(workspaceTesting.dockerSnapshot(execute, { env: {}, endpointScope: scope }),
    { containers: [], available: false, reason: "foreign-owned-socket-without-connect-grant" });
  assert.equal(calls.length, 1);
  const failed = workspaceTesting.dockerSnapshot(execute, { env: {}, endpointScope: () => ({ inspect: true }) });
  assert.equal(failed.available, true);
  assert.match(failed.error, /permission denied during docker ps/);
  assert.equal(calls.at(-1)[0], "ps");
  const malformed = workspaceTesting.dockerSnapshot(() => ({ status: 0, stdout: "not JSON" }), { env: {} });
  assert.match(malformed.error, /invalid endpoint/);
});

test("Docker authority honors explicit context before host and inspects authorized containers", () => {
  for (const [env, expected] of [
    [{}, "unix:///run/user/1006/docker.sock"],
    [{ DOCKER_HOST: "tcp://127.0.0.1:2375" }, "tcp://127.0.0.1:2375"],
    [{ DOCKER_CONTEXT: "rootless", DOCKER_HOST: "tcp://127.0.0.1:2375" }, "unix:///run/user/1006/docker.sock"],
  ]) {
    const calls = [];
    const snapshot = workspaceTesting.dockerSnapshot((_executable, args) => {
      calls.push(args);
      if (args[0] === "context") return { status: 0, stdout: JSON.stringify("unix:///run/user/1006/docker.sock") };
      if (args[0] === "ps") return { status: 0, stdout: "live" };
      return { status: 0, stdout: JSON.stringify([{ Id: "live" }]) };
    }, { env, endpointScope: (endpoint) => { assert.equal(endpoint, expected); return { inspect: true }; } });
    assert.deepEqual(snapshot, { containers: [{ Id: "live" }], available: true });
    assert.equal(calls[0].includes("rootless"), Boolean(env.DOCKER_CONTEXT));
  }
});

test("ignores containers removed during the Docker ownership snapshot", () => {
  const snapshot = workspaceTesting.dockerSnapshot((_executable, args) => {
    if (args[0] === "context") return { status: 0, stdout: JSON.stringify("tcp://docker-host:2375"), stderr: "" };
    if (args[0] === "ps") return { status: 0, stdout: "vanished\nlive", stderr: "" };
    if (args[1] === "vanished") return { status: 1, stdout: "", stderr: "Error: No such object: vanished" };
    return { status: 0, stdout: JSON.stringify([{ Id: "live" }]), stderr: "" };
  }, { env: {} });
  assert.deepEqual(snapshot, { containers: [{ Id: "live" }], available: true });
});

test("classifies active systemd workspace references", () => {
  const workspace = "/srv/workspaces/agent-one";
  const units = workspaceTesting.parseSystemdUnits(`Id=worker.service\nActiveState=active\nExecStart={ path=/usr/bin/node ; argv[]=/usr/bin/node ${workspace}/server.js ; }\nWorkingDirectory=${workspace}\n\nId=finished.service\nActiveState=inactive\nExecStart={ path=/bin/true ; argv[]=/bin/true ; }\nWorkingDirectory=${workspace}\n`, "user");
  const result = workspaceTesting.systemdReferences(workspace, { units, available: true });
  assert.deepEqual(result.references.map(({ id, manager }) => ({ id, manager })), [
    { id: "worker.service", manager: "user" },
  ]);
  const unavailable = workspaceTesting.systemdManagerSnapshot("user", () => ({
    status: 1,
    stdout: "",
    stderr: "Failed to connect to user scope bus via local transport: $DBUS_SESSION_BUS_ADDRESS and $XDG_RUNTIME_DIR not defined",
  }));
  assert.deepEqual(unavailable, { units: [], available: false });
});

test("a released checkout stays until its owner's pending or running thread settles", () => {
  const f = fixture();
  try {
    const created = JSON.parse(run(["create", "--root", f.workspaces, "--name", "resubmitted",
      "--repo", f.remote, "--min-free-gib", "0", "--json"], f.env));
    const threadDatabase = path.join(f.root, "threads.sqlite3");
    const db = new DatabaseSync(threadDatabase);
    db.exec(`CREATE TABLE thread(id TEXT PRIMARY KEY, cwd TEXT NOT NULL, state TEXT NOT NULL);
      CREATE TABLE thread_work(thread_id TEXT NOT NULL, status TEXT NOT NULL);
      CREATE TABLE thread_execution(thread_id TEXT NOT NULL, ended_at INTEGER);`);
    const insert = db.prepare("INSERT INTO thread(id,cwd,state) VALUES(?,?,?)");
    insert.run("historical", created.path, "idle");
    insert.run("other-path", `${created.path}-sibling`, "running");
    assert.deepEqual(workspaceTesting.threadSnapshot([threadDatabase]).map((row) => row.id), ["other-path"]);
    const env = { ...f.env, PI_ORCHESTRATOR_LEDGER: path.join(f.root, "ledger.sqlite3"),
      PI_THREAD_DATABASE: threadDatabase };
    insert.run("resubmitted-worker", created.path, "idle");
    db.prepare("INSERT INTO thread_work(thread_id,status) VALUES(?,?)").run("resubmitted-worker", "queued");
    const held = JSON.parse(run(["release", "--id", created.id, "--json"], env));
    assert.equal(held.inspection.classification, "referenced");
    assert.match(held.inspection.reason, /resubmitted-worker/);
    assert.equal(existsSync(created.path), true);
    db.prepare("UPDATE thread_work SET status='done'").run();
    db.prepare("UPDATE thread SET state='running' WHERE id='resubmitted-worker'").run();
    const executing = JSON.parse(run(["reconcile", "--path", created.path, "--execute", "--json"], env))[0];
    assert.equal(executing.inspection.classification, "referenced");
    db.prepare("UPDATE thread SET state='idle' WHERE id='resubmitted-worker'").run();
    db.prepare("INSERT INTO thread_execution(thread_id,ended_at) VALUES(?,NULL)").run("resubmitted-worker");
    assert.equal(JSON.parse(run(["release", "--id", created.id, "--json"], env)).inspection.classification, "referenced");
    db.prepare("UPDATE thread_execution SET ended_at=1").run();
    writeFileSync(path.join(f.root, "invalid-threads.sqlite3"), "not sqlite");
    assert.throws(() => run(["release", "--id", created.id, "--json"], {
      ...env, PI_THREAD_DATABASE: path.join(f.root, "invalid-threads.sqlite3"),
    }), /file is not a database/);
    assert.equal(existsSync(created.path), true);
    assert.equal(JSON.parse(run(["release", "--id", created.id, "--json"], env)).action, "released");
    assert.equal(existsSync(created.path), false);
    db.close();
  } finally { f.close(); }
});

test("creates and releases a clean review checkout", () => {
  const f = fixture();
  try {
    const created = JSON.parse(run([
      "create", "--root", f.workspaces, "--name", "review-one", "--repo", f.remote,
      "--mode", "review", "--cache", "ignored-output", "--min-free-gib", "0", "--json",
    ], f.env));
    assert.equal(created.mode, "review");
    assert.deepEqual(created.cachePaths, [
      "node_modules",
      "**/node_modules",
      "dist",
      "**/dist",
      ".nx",
      ".react-router",
      "**/.react-router",
      ".converge-cache",
      "build",
      "**/build",
      "**/__pycache__",
      "**/.pytest_cache",
      "**/.mypy_cache",
      "**/.ruff_cache",
      ".lake",
      "**/.lake",
      "target",
      "**/target",
      "ignored-output",
    ]);
    assert.equal(existsSync(created.path), true);
    assert.equal(git(created.path, "config", "--bool", "core.commitGraph"), "false");
    assert.equal(git(created.path, "config", "--bool", "gc.writeCommitGraph"), "false");
    assert.equal(git(created.path, "config", "--bool", "fetch.writeCommitGraph"), "false");
    assert.equal(git(created.path, "config", "--int", "gc.auto"), "0");
    assert.equal(git(created.path, "config", "--bool", "maintenance.auto"), "false");
    mkdirSync(path.join(created.path, "ignored-output"));
    writeFileSync(path.join(created.path, "ignored-output", "generated.txt"), "generated\n");
    const released = JSON.parse(run(["release", "--id", created.id, "--json"], f.env));
    assert.equal(released.action, "released");
    assert.equal(existsSync(created.path), false);

    const plain = JSON.parse(run([
      "create", "--root", f.workspaces, "--name", "review-plain", "--repo", f.remote,
      "--mode", "review", "--min-free-gib", "0", "--json",
    ], f.env));
    const output = run(["release", "--id", plain.id], f.env);
    assert.equal(output, `${plain.id}\treclaimable\t${plain.path}\treleased\tcheckout remains at its durable source commit`);
  } finally {
    f.close();
  }
});

test("repairs reference-clone maintenance during an active lease without pruning work", () => {
  const f = fixture();
  try {
    const created = JSON.parse(run(["create", "--root", f.workspaces, "--name", "publication",
      "--repo", f.remote, "--min-free-gib", "0", "--json"], f.env));
    git(created.path, "config", "user.name", "Test");
    git(created.path, "config", "user.email", "test@example.invalid");
    git(created.path, "commit", "--allow-empty", "-m", "Unpublished work");
    const head = git(created.path, "rev-parse", "HEAD");
    writeFileSync(path.join(created.path, "file.txt"), "unfinished work\n");
    const objects = git(created.path, "count-objects", "-v");
    for (const [key, value] of [["gc.writeCommitGraph", "true"], ["fetch.writeCommitGraph", "true"],
      ["gc.auto", "1"], ["maintenance.auto", "true"]]) git(created.path, "config", key, value);
    const log = path.join(created.path, ".git", "gc.log");
    const warning = "warning: attempting to write a commit-graph, but 'core.commitGraph' is disabled\n"
      + "warning: There are too many unreachable loose objects; run 'git prune' to remove them.\n";
    writeFileSync(log, warning);
    const planned = JSON.parse(run(["maintain", "--path", created.path, "--json"], f.env))[0];
    assert.equal(planned.gcLog, "would-remove-diagnosed-warning");
    assert.equal(readFileSync(log, "utf8"), warning);
    assert.equal(git(created.path, "config", "gc.auto"), "1");
    const [result] = JSON.parse(run(["reconcile", "--path", created.path, "--execute", "--json"], f.env));
    assert.equal(result.inspection.classification, "active");
    assert.equal(result.gitMaintenance.gcLog, "removed-diagnosed-warning");
    assert.equal(existsSync(log), false);
    assert.equal(git(created.path, "rev-parse", "HEAD"), head);
    assert.equal(git(created.path, "count-objects", "-v"), objects);
    assert.equal(readFileSync(path.join(created.path, "file.txt"), "utf8"), "unfinished work\n");
    git(created.path, "commit", "--allow-empty", "-m", "Normal publication commit");
    assert.equal(existsSync(log), false);
    const [settled] = JSON.parse(run(["maintain", "--path", created.path, "--execute", "--json"], f.env));
    assert.deepEqual(settled.settings, []);
    writeFileSync(log, "fatal: object database is damaged\n");
    assert.throws(() => workspaceTesting.maintainReferenceClone(created.path, true), /unrecognized Git maintenance failure retained/);
    assert.equal(readFileSync(log, "utf8"), "fatal: object database is damaged\n");
    assert.equal(workspaceTesting.maintainReferenceClone(f.source, true), null);
  } finally {
    f.close();
  }
});

test("defaults to the repository's current HEAD", () => {
  const f = fixture();
  try {
    git(f.source, "checkout", "--detach");
    writeFileSync(path.join(f.source, "file.txt"), "detached source\n");
    git(f.source, "add", "file.txt");
    git(f.source, "commit", "-m", "detached source");
    const detachedHead = git(f.source, "rev-parse", "HEAD");

    const created = JSON.parse(run([
      "create", "--root", f.workspaces, "--name", "detached-source", "--repo", f.source,
      "--strategy", "worktree", "--mode", "writer", "--min-free-gib", "0", "--json",
    ], f.env));
    assert.equal(created.sourceCommit, detachedHead);
    assert.equal(git(created.path, "rev-parse", "HEAD"), detachedHead);
    assert.equal(git(created.path, "remote", "get-url", "origin"), f.remote);
    assert.equal(git(created.path, "remote", "get-url", "--push", "origin"), f.remote);
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

test("a registered linked worktree prevents release of its parent clone", () => {
  const f = fixture();
  try {
    const parent = JSON.parse(run([
      "create", "--root", f.workspaces, "--name", "parent", "--repo", f.remote,
      "--mode", "writer", "--min-free-gib", "0", "--json",
    ], f.env));
    const childPath = path.join(f.workspaces, "child");
    git(parent.path, "worktree", "add", "-b", "child", childPath, "HEAD");
    const child = JSON.parse(run(["register", "--path", childPath, "--json"], f.env));
    writeFileSync(path.join(childPath, "unique.txt"), "unfinished child work\n");

    const database = new DatabaseSync(f.env.PI_WORKSPACE_STATE);
    database.prepare("UPDATE workspace SET lease_expires_at=0 WHERE id=?").run(parent.id);
    database.close();
    const planned = JSON.parse(run(["reconcile", "--root", f.workspaces, "--json"], f.env));
    const parentPlan = planned.find(({ record }) => record.id === parent.id);
    assert.equal(parentPlan.inspection.classification, "referenced");
    assert.equal(parentPlan.inspection.gitDependents[0].recordId, child.id);
    const executed = JSON.parse(run(["reconcile", "--root", f.workspaces, "--execute", "--reap-expired", "--json"], f.env));
    assert.equal(executed.find(({ record }) => record.id === parent.id).action, "none");
    assert.equal(existsSync(parent.path), true);
    const held = JSON.parse(run(["release", "--id", parent.id, "--json"], f.env));
    assert.equal(held.inspection.classification, "referenced");
    assert.equal(held.action, "none");
    assert.equal(held.inspection.gitDependents[0].recordId, child.id);
    assert.equal(git(childPath, "rev-parse", "HEAD"), parent.sourceCommit);
    assert.equal(readFileSync(path.join(childPath, "unique.txt"), "utf8"), "unfinished child work\n");
    assert.equal(existsSync(parent.path), true);

    const childRelease = JSON.parse(run(["release", "--id", child.id, "--json"], f.env));
    assert.equal(childRelease.inspection.classification, "repair-required");
    rmSync(path.join(childPath, "unique.txt"));
    assert.equal(JSON.parse(run(["release", "--id", child.id, "--json"], f.env)).action, "released");
    assert.equal(JSON.parse(run(["release", "--id", parent.id, "--json"], f.env)).action, "released");
  } finally { f.close(); }
});

test("a linked worktree ignores branches owned by its peers", () => {
  const f = fixture();
  try {
    const first = JSON.parse(run([
      "create", "--root", f.workspaces, "--name", "first", "--repo", f.remote,
      "--strategy", "worktree", "--mode", "writer", "--min-free-gib", "0", "--json",
    ], f.env));
    git(first.path, "config", "user.name", "Test");
    git(first.path, "config", "user.email", "test@example.invalid");
    writeFileSync(path.join(first.path, "file.txt"), "first\n");
    git(first.path, "add", "file.txt");
    git(first.path, "commit", "-m", "first");
    const firstHead = git(first.path, "rev-parse", "HEAD");

    const second = JSON.parse(run([
      "create", "--root", f.workspaces, "--name", "second", "--repo", f.remote,
      "--strategy", "worktree", "--mode", "writer", "--min-free-gib", "0", "--json",
    ], f.env));
    assert.equal(git(first.path, "rev-parse", "HEAD"), firstHead);
    assert.equal(git(first.path, "rev-list", "--count", `${first.sourceCommit}..HEAD`), "1");

    git(second.path, "config", "user.name", "Test");
    git(second.path, "config", "user.email", "test@example.invalid");
    writeFileSync(path.join(second.path, "file.txt"), "second\n");
    git(second.path, "add", "file.txt");
    git(second.path, "commit", "-m", "second");
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

test("cache discovery walks each directory once across recursive declarations", () => {
  const root = mkdtempSync(path.join(tmpdir(), "workspace-cache-walk-"));
  try {
    for (let index = 0; index < 200; index += 1) mkdirSync(path.join(root, `source-${index}`, "nested"), { recursive: true });
    mkdirSync(path.join(root, "source-0", "build"));
    mkdirSync(path.join(root, ".git", "build"), { recursive: true });
    symlinkSync(path.join(root, "source-0"), path.join(root, "linked"));
    const reads = new Map();
    const targets = [...workspaceTesting.cacheTargets(root,
      ["**/build", "**/dist", "**/target", "**/node_modules", "**/__pycache__"],
      (directory, options) => {
        reads.set(directory, (reads.get(directory) ?? 0) + 1);
        return readdirSync(directory, options);
      })];
    assert.deepEqual(targets, [path.join(root, "source-0", "build")]);
    assert.equal(reads.size, 402);
    assert.equal(Math.max(...reads.values()), 1);
    assert.equal(reads.has(path.join(root, ".git")), false);
    assert.equal(reads.has(path.join(root, "linked")), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("cache discovery skips removed trees and descends into retained cache names", () => {
  const root = mkdtempSync(path.join(tmpdir(), "workspace-cache-consumer-"));
  try {
    const removed = path.join(root, "node_modules");
    const retained = path.join(root, "source", "build");
    const nested = path.join(retained, "__pycache__");
    mkdirSync(path.join(removed, "huge", "build"), { recursive: true });
    mkdirSync(nested, { recursive: true });
    const reads = [];
    const targets = [];
    for (const target of workspaceTesting.cacheTargets(root,
      ["node_modules", "**/build", "**/__pycache__"], (directory, options) => {
        reads.push(directory);
        return readdirSync(directory, options);
      })) {
      targets.push(target);
      if (target === removed || target === nested) rmSync(target, { recursive: true });
    }
    assert.deepEqual(targets, [removed, retained, nested]);
    assert.equal(reads.some(directory => directory.startsWith(removed)), false);
    assert.equal(reads.includes(nested), false);
    assert.equal(existsSync(retained), true);
  } finally { rmSync(root, { recursive: true, force: true }); }
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
    mkdirSync(path.join(created.path, "apps", "web", "dist"), { recursive: true });
    writeFileSync(path.join(created.path, "apps", "web", "dist", "app.js"), "generated\n");
    mkdirSync(path.join(created.path, "apps", "web", ".react-router", "types"), { recursive: true });
    writeFileSync(path.join(created.path, "apps", "web", ".react-router", "types", "routes.ts"), "generated\n");
    mkdirSync(path.join(created.path, "tools", "__pycache__"), { recursive: true });
    writeFileSync(path.join(created.path, "tools", "__pycache__", "harness.pyc"), "generated\n");
    mkdirSync(path.join(created.path, "build", "CMakeFiles"), { recursive: true });
    writeFileSync(path.join(created.path, "build", "CMakeFiles", "link.txt"), "generated\n");
    mkdirSync(path.join(created.path, ".lake", "build"), { recursive: true });
    writeFileSync(path.join(created.path, ".lake", "build", "Module.olean"), "generated\n");
    const result = JSON.parse(run(["release", "--id", created.id, "--json"], f.env));
    assert.equal(result.inspection.classification, "repair-required");
    assert.match(result.inspection.reason, /commits absent from remote refs/);
    assert.equal(existsSync(created.path), true);
    assert.equal(existsSync(path.join(created.path, "node_modules")), false);
    assert.equal(existsSync(path.join(created.path, "packages", "api", "node_modules")), false);
    assert.equal(existsSync(path.join(created.path, "apps", "web", "dist")), false);
    assert.equal(existsSync(path.join(created.path, "apps", "web", ".react-router")), false);
    assert.equal(existsSync(path.join(created.path, "tools", "__pycache__")), false);
    assert.equal(existsSync(path.join(created.path, "build")), false);
    assert.equal(existsSync(path.join(created.path, ".lake")), false);
    assert.equal(readFileSync(path.join(created.path, "file.txt"), "utf8"), "changed\n");
  } finally {
    f.close();
  }
});

test("a tracked .agent-workspace-caches manifest classifies repository-generated output", () => {
  const f = fixture();
  try {
    const created = JSON.parse(run([
      "create", "--root", f.workspaces, "--name", "writer-manifest", "--repo", f.remote,
      "--mode", "writer", "--min-free-gib", "0", "--json",
    ], f.env));
    git(created.path, "config", "user.name", "Test");
    git(created.path, "config", "user.email", "test@example.invalid");
    writeFileSync(path.join(created.path, ".gitignore"), "*.generated.ts\ngenerated/\n");
    writeFileSync(path.join(created.path, ".agent-workspace-caches"), [
      "# repository-owned generated output",
      "src/api/client.generated.ts",
      "**/generated",
      "**/schema.generated.ts",
      "../escape # rejected, not fatal",
      "",
    ].join("\n"));
    git(created.path, "add", ".gitignore", ".agent-workspace-caches");
    git(created.path, "commit", "-m", "declare generated output");
    git(created.path, "push", "origin", "HEAD");
    mkdirSync(path.join(created.path, "src", "api"), { recursive: true });
    writeFileSync(path.join(created.path, "src", "api", "client.generated.ts"), "generated\n");
    mkdirSync(path.join(created.path, "packages", "design", "generated"), { recursive: true });
    writeFileSync(path.join(created.path, "packages", "design", "generated", "index.ts"), "generated\n");
    // A **/name entry must also match generated files, not only directories.
    mkdirSync(path.join(created.path, "packages", "api", "src"), { recursive: true });
    writeFileSync(path.join(created.path, "packages", "api", "src", "schema.generated.ts"), "generated\n");
    const result = JSON.parse(run(["release", "--id", created.id, "--json"], f.env));
    assert.equal(result.inspection.classification, "reclaimable", result.inspection.reason);
    assert.equal(existsSync(created.path), false);
  } finally {
    f.close();
  }
});

test("an untracked .agent-workspace-caches manifest does not classify anything", () => {
  const f = fixture();
  try {
    const created = JSON.parse(run([
      "create", "--root", f.workspaces, "--name", "writer-untracked-manifest", "--repo", f.remote,
      "--mode", "writer", "--min-free-gib", "0", "--json",
    ], f.env));
    git(created.path, "config", "user.name", "Test");
    git(created.path, "config", "user.email", "test@example.invalid");
    writeFileSync(path.join(created.path, ".gitignore"), "*.generated.ts\n.agent-workspace-caches\n");
    git(created.path, "add", ".gitignore");
    git(created.path, "commit", "-m", "ignore generated output");
    git(created.path, "push", "origin", "HEAD");
    writeFileSync(path.join(created.path, ".agent-workspace-caches"), "src/api/client.generated.ts\n");
    mkdirSync(path.join(created.path, "src", "api"), { recursive: true });
    writeFileSync(path.join(created.path, "src", "api", "client.generated.ts"), "generated\n");
    const result = JSON.parse(run(["release", "--id", created.id, "--json"], f.env));
    assert.equal(result.inspection.classification, "repair-required");
    assert.match(result.inspection.reason, /unclassified ignored output/);
  } finally {
    f.close();
  }
});

test("leaves a tracked directory alone when its name matches a cache path", () => {
  const f = fixture();
  try {
    const created = JSON.parse(run([
      "create", "--root", f.workspaces, "--name", "writer-tracked-build", "--repo", f.remote,
      "--mode", "writer", "--min-free-gib", "0", "--json",
    ], f.env));
    git(created.path, "config", "user.name", "Test");
    git(created.path, "config", "user.email", "test@example.invalid");
    mkdirSync(path.join(created.path, "build"), { recursive: true });
    writeFileSync(path.join(created.path, "build", "release.sh"), "echo build\n");
    git(created.path, "add", "build/release.sh");
    git(created.path, "commit", "-m", "tracked build directory");
    mkdirSync(path.join(created.path, "__pycache__"), { recursive: true });
    writeFileSync(path.join(created.path, "__pycache__", "tool.pyc"), "generated\n");
    const result = JSON.parse(run(["release", "--id", created.id, "--json"], f.env));
    assert.equal(result.inspection.classification, "repair-required");
    assert.equal(existsSync(path.join(created.path, "__pycache__")), false);
    assert.equal(readFileSync(path.join(created.path, "build", "release.sh"), "utf8"), "echo build\n");
  } finally {
    f.close();
  }
});

test("preserves tracked cache names inside nested submodules while removing generated caches", () => {
  const f = fixture();
  try {
    const created = JSON.parse(run([
      "create", "--root", f.workspaces, "--name", "submodules", "--repo", f.remote,
      "--mode", "writer", "--min-free-gib", "0", "--json",
    ], f.env));
    const child = path.join(created.path, "dependency");
    const grandchild = path.join(child, "dependency");
    git(created.path, "-c", "protocol.file.allow=always", "submodule", "add", f.remote, "dependency");
    git(child, "-c", "protocol.file.allow=always", "submodule", "add", f.remote, "dependency");
    for (const repository of [grandchild, child, created.path]) {
      git(repository, "config", "user.name", "Test");
      git(repository, "config", "user.email", "test@example.invalid");
      mkdirSync(path.join(repository, "build"));
      writeFileSync(path.join(repository, "build", "release.sh"), "echo source\n");
      git(repository, "add", ".");
      git(repository, "commit", "-m", "track build source and dependencies");
      mkdirSync(path.join(repository, "__pycache__"));
      writeFileSync(path.join(repository, "__pycache__", "generated.pyc"), "generated\n");
    }
    const result = JSON.parse(run(["release", "--id", created.id, "--json"], f.env));
    assert.equal(result.inspection.classification, "repair-required");
    for (const repository of [created.path, child, grandchild]) {
      assert.equal(readFileSync(path.join(repository, "build", "release.sh"), "utf8"), "echo source\n");
      assert.equal(existsSync(path.join(repository, "__pycache__")), false);
      assert.equal(git(repository, "status", "--porcelain"), "");
    }
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

test("existing registration adopts one requested group and rejects a conflicting replacement", () => {
  const f = fixture();
  try {
    mkdirSync(f.workspaces, { recursive: true });
    const workspace = path.join(f.workspaces, "existing");
    execFileSync("git", ["clone", f.remote, workspace]);
    const first = JSON.parse(run(["register", "--path", workspace, "--lease-seconds", "0", "--json"], f.env));
    assert.equal(first.groupId, null);

    const grouped = JSON.parse(run([
      "register", "--path", workspace, "--group", "task-one", "--cache", "generated-one", "--lease-seconds", "0", "--json",
    ], f.env));
    assert.equal(grouped.id, first.id);
    assert.equal(grouped.groupId, "task-one");
    assert.equal(grouped.cachePaths.includes("generated-one"), true);

    assert.throws(() => run([
      "register", "--path", workspace, "--group", "task-two", "--lease-seconds", "0", "--json",
    ], f.env), /already belongs to group task-one; requested task-two/);
    const retained = JSON.parse(run(["status", "--path", workspace, "--json"], f.env))[0];
    assert.equal(retained.groupId, "task-one");

    const replaced = JSON.parse(run([
      "register", "--path", workspace, "--group", "task-one", "--cache", "generated-two", "--replace-cache", "--lease-seconds", "0", "--json",
    ], f.env));
    assert.equal(replaced.cachePaths.includes("generated-one"), false);
    assert.equal(replaced.cachePaths.includes("generated-two"), true);
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

test("adopts new and existing sibling repositories as one workspace group", () => {
  const f = fixture();
  try {
    const container = path.join(f.workspaces, "link-change");
    mkdirSync(container, { recursive: true });
    const backend = path.join(container, "backend");
    const frontend = path.join(container, "frontend");
    execFileSync("git", ["clone", f.remote, backend]);
    execFileSync("git", ["clone", f.remote, frontend]);
    const existing = JSON.parse(run(["register", "--path", frontend, "--lease-seconds", "0", "--json"], f.env));
    assert.equal(existing.groupId, null);
    writeFileSync(path.join(backend, "file.txt"), "uncommitted work\n");

    const held = JSON.parse(run([
      "adopt", "--root", f.workspaces, "--nested-groups", "--execute", "--json",
    ], f.env));
    assert.equal(held.length, 2);
    assert.equal(new Set(held.map((result) => result.record.groupId)).size, 1);
    assert.equal(held.find((result) => result.record.path === frontend).record.id, existing.id);
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

test("conditional cache ownership follows each repository's tracked source", () => {
  const f = fixture();
  try {
    const container = path.join(f.workspaces, "link-change");
    mkdirSync(container, { recursive: true });
    const backend = path.join(container, "backend");
    const frontend = path.join(container, "frontend");
    for (const repository of [backend, frontend]) {
      execFileSync("git", ["clone", f.remote, repository]);
      git(repository, "config", "user.name", "Test");
      git(repository, "config", "user.email", "test@example.invalid");
      writeFileSync(path.join(repository, ".gitignore"), "generated.json\n");
    }
    writeFileSync(path.join(backend, "generator.js"), "writeGeneratedOutput();\n");
    git(backend, "add", ".gitignore", "generator.js");
    git(backend, "commit", "-m", "own generated output");
    git(frontend, "add", ".gitignore");
    git(frontend, "commit", "-m", "ignore foreign output");

    const records = JSON.parse(run([
      "adopt", "--root", f.workspaces, "--nested-groups", "--cache-owned", "generated.json=generator.js", "--replace-cache", "--json",
    ], f.env));
    assert.equal(records.find((record) => record.path === backend).cachePaths.includes("generated.json"), true);
    assert.equal(records.find((record) => record.path === frontend).cachePaths.includes("generated.json"), false);
  } finally {
    f.close();
  }
});

test("adopts an independent repository nested inside a checkout without classifying it as cache", () => {
  const f = fixture();
  try {
    mkdirSync(f.workspaces, { recursive: true });
    const parent = path.join(f.workspaces, "agent-parent");
    execFileSync("git", ["clone", f.remote, parent]);
    writeFileSync(path.join(parent, ".gitignore"), ".link-ui-review/\n");
    git(parent, "add", ".gitignore");
    git(parent, "commit", "-m", "ignore nested review checkout");
    git(parent, "push", "origin", "HEAD:main");
    const nested = path.join(parent, ".link-ui-review");
    execFileSync("git", ["clone", f.remote, nested]);
    const existing = JSON.parse(run(["register", "--path", parent, "--lease-seconds", "0", "--json"], f.env));
    assert.equal(existing.groupId, null);

    writeFileSync(path.join(nested, "file.txt"), "nested unique work\n");
    const held = JSON.parse(run([
      "adopt", "--root", f.workspaces, "--nested-groups", "--lease-seconds", "21600", "--execute", "--json",
    ], f.env));
    assert.equal(held.length, 2);
    assert.equal(new Set(held.map((result) => result.record.groupId)).size, 1);
    assert.equal(held.find((result) => result.record.path === parent).record.id, existing.id);
    assert.equal(held.find((result) => result.record.path === nested).record.leaseExpiresAt <= Date.now(), true);
    assert.equal(held.find((result) => result.record.path === nested).inspection.classification, "repair-required");
    assert.equal(existsSync(parent), true);
    assert.equal(existsSync(nested), true);

    git(nested, "checkout", "--", "file.txt");
    const released = JSON.parse(run([
      "reconcile", "--root", f.workspaces, "--execute", "--json",
    ], f.env));
    assert.equal(released.every((result) => result.action === "released-group"), true, JSON.stringify(released));
    assert.equal(existsSync(parent), false);
    assert.equal(existsSync(nested), false);
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
    const exited = new Promise((resolve) => sleeper.once("exit", resolve));
    const liveSafety = { ...f.env, PI_WORKSPACE_TEST_EXTERNAL_SAFETY: "host" };
    const held = JSON.parse(await runAsync(["release", "--id", created.id, "--json"], liveSafety));
    assert.equal(held.inspection.classification, "referenced");
    assert.equal(existsSync(created.path), true);
    const reaped = JSON.parse(await runAsync(["release", "--id", created.id, "--reap-expired", "--json"], liveSafety));
    assert.equal(reaped.action, "released");
    assert.equal(existsSync(created.path), false);
    await exited;
  } finally {
    sleeper?.kill("SIGKILL");
    f.close();
  }
});

test("status answers what became of a checkout whose directory is gone", () => {
  const f = fixture();
  try {
    run(["status", "--json"], f.env);
    const database = new DatabaseSync(f.env.PI_WORKSPACE_STATE);
    database.prepare(`INSERT INTO workspace
      (id,path,root,kind,mode,owner,repository,source_commit,checkout_type,
       cache_paths,created_at,updated_at,lease_expires_at,state,detail,group_id)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,NULL)`).run(
      "gone-1", path.join(f.workspaces, "p3-ob50-review-someone"), f.workspaces,
      "agent", "writer", "p3-ob50-review-someone", f.remote, "a".repeat(40), "clone",
      JSON.stringify([]), 1, 1, 0, "released", "every local branch commit exists on a remote ref",
    );
    database.close();

    const byPath = run(["status", "--path", "ob50"], f.env);
    assert.match(byPath, /state released: every local branch commit exists on a remote ref/);
    assert.match(byPath, /present-on-disk false/);

    const byOwner = run(["list", "--owner", "ob50"], f.env);
    assert.match(byOwner, /p3-ob50-review-someone/);

    const missing = run(["status", "--path", "never-registered-anywhere"], f.env);
    assert.match(missing, /no registered workspace matches that filter/);
  } finally {
    f.close();
  }
});

test("status filters in SQL before decoding unrelated records and preserves literal matching", () => {
  const f = fixture();
  try {
    mkdirSync(f.workspaces);
    run(["status", "--json"], f.env);
    const database = new DatabaseSync(f.env.PI_WORKSPACE_STATE);
    const insert = database.prepare(`INSERT INTO workspace
      (id,path,root,kind,mode,owner,checkout_type,cache_paths,created_at,updated_at,lease_expires_at,state,detail)
      VALUES (?,?,?,'agent','writer',?,'clone',?,1,1,0,'released','retained history')`);
    const rows = [
      ["one", path.join(f.workspaces, "Case_%'雪"), f.workspaces, "Owner_%'雪", "[]"],
      ["two", path.join(f.workspaces, "case-other"), f.workspaces, "other", "[]"],
      ["three", path.join(f.root, "other-pool", "Case_%'雪"), path.join(f.root, "other-pool"), "other", "[]"],
      ["unrelated", path.join(f.root, "unrelated"), path.join(f.root, "other-pool"), "unrelated", "not JSON"],
    ];
    for (const row of rows) insert.run(...row);
    database.close();
    const ids = (args, cwd) => JSON.parse(run(["status", ...args, "--json"], f.env, cwd)).map(row => row.id);
    assert.deepEqual(ids(["--path", "_%'雪"]), ["three", "one"]);
    assert.deepEqual(ids(["--root", f.workspaces, "--path", "_%'雪"]), ["one"]);
    assert.deepEqual(ids(["--owner", "Owner_%'"]), ["one"]);
    assert.deepEqual(ids(["--owner", "owner"]), []);
    assert.deepEqual(ids(["--path", "Case", "--owner", "other"]), ["three"]);
    assert.deepEqual(ids(["--path", "./Case_%'雪"], f.workspaces), ["one"]);
    assert.match(run(["status", "--root", f.workspaces, "--path", "Case"], f.env), /filtered from 2/);
    assert.match(run(["list", "--path", "missing"], f.env), /4 record\(s\) are known/);
    assert.throws(() => run(["status", "--path", "unrelated", "--json"], f.env), /JSON/);
  } finally { f.close(); }
});

test("status, list and dry-run reconciliation leave disposal to executing lifecycle commands", () => {
  const f = fixture();
  try {
    run(["status", "--json"], f.env);
    const garbage = path.join(path.dirname(f.env.PI_WORKSPACE_STATE), "gc", "pending");
    mkdirSync(garbage, { recursive: true });
    const retained = path.join(garbage, "payload");
    writeFileSync(retained, "pending lifecycle cleanup");
    const guard = path.join(f.root, "spawn-guard.mjs");
    writeFileSync(guard, `import cp from "node:child_process";\nimport { syncBuiltinESMExports } from "node:module";\ncp.spawn = () => { throw new Error("disposal subprocess attempted"); };\nsyncBuiltinESMExports();\n`);
    const env = { ...f.env, NODE_OPTIONS: `--import=${guard}` };
    for (const args of [
      ["status", "--path", "missing"],
      ["list", "--path", "missing"],
      ["reconcile"],
      ["reconcile", "--execute=false"],
    ]) {
      assert.deepEqual(JSON.parse(run([...args, "--json"], env)), []);
      assert.equal(readFileSync(retained, "utf8"), "pending lifecycle cleanup");
    }
    assert.throws(() => run(["reconcile", "--execute", "--json"], env), /disposal subprocess attempted/);
  } finally { f.close(); }
});

test("a surviving Git child retains its checkout fence after creator termination", async () => {
  const f = fixture();
  let connection;
  let accept;
  let completed;
  const gate = new Promise(resolve => { accept = resolve; });
  const done = new Promise(resolve => { completed = resolve; });
  const server = createServer(socket => {
    connection = socket;
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", chunk => {
      buffer += chunk;
      let end;
      while ((end = buffer.indexOf("\n")) >= 0) {
        const event = JSON.parse(buffer.slice(0, end));
        buffer = buffer.slice(end + 1);
        if (event.pid) accept(event.pid);
        else completed(event.code);
      }
    });
  });
  try {
    const bin = path.join(f.root, "bin");
    mkdirSync(bin);
    const socketPath = path.join(f.root, "child.sock");
    const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
    writeFileSync(path.join(bin, "git"), `#!${process.execPath}
const { spawnSync } = require('node:child_process');
const args = process.argv.slice(2);
if (args[0] !== 'clone') process.exit(spawnSync(${JSON.stringify(realGit)}, args, {stdio:'inherit'}).status ?? 1);
const socket = require('node:net').createConnection(${JSON.stringify(socketPath)});
socket.on('connect', () => socket.write(JSON.stringify({pid:process.ppid})+'\\n'));
socket.once('data', () => {
  const code = spawnSync(${JSON.stringify(realGit)}, args, {stdio:'ignore'}).status;
  socket.end(JSON.stringify({code})+'\\n');
});
`, { mode: 0o755 });
    await new Promise(resolve => server.listen(socketPath, resolve));
    const args = ["create", "--root", f.workspaces, "--name", "surviving-child", "--repo", f.source,
      "--min-free-gib", "0", "--json"];
    const first = runAsync(args, { ...f.env, PATH: `${bin}:${process.env.PATH}` }).catch(error => error);
    const pid = await Promise.race([gate, first.then(() => { throw Error("creation exited before child gate"); })]);
    process.kill(pid, "SIGKILL");
    assert.ok(await first instanceof Error);
    const key = createHash("sha256").update(`checkout:${path.join(f.workspaces, "surviving-child")}`).digest("hex");
    const lock = path.join(path.dirname(f.env.PI_WORKSPACE_STATE), "locks", key);
    assert.throws(() => execFileSync("flock", ["--nonblock", lock, "true"]), error => error.status === 1);
    connection.write("continue");
    assert.equal(await done, 0);
    const resumed = JSON.parse(await runAsync(args, f.env));
    assert.equal(resumed.state, "active");
    assert.equal(readFileSync(path.join(resumed.path, "file.txt"), "utf8"), "source\n");
  } finally {
    connection?.destroy();
    await new Promise(resolve => server.close(resolve));
    f.close();
  }
});

test("parallel immutable creations leave unrelated custody usable and fence duplicate destinations", async () => {
  const f = fixture();
  const sockets = [];
  const children = [];
  const server = createServer(socket => sockets.push(socket));
  try {
    const commit = git(f.source, "rev-parse", "HEAD");
    const create = ["create", "--root", f.workspaces, "--repo", f.remote,
      "--ref", commit, "--min-free-gib", "0", "--json"];
    const retained = JSON.parse(run([...create, "--name", "retained"], f.env));
    const released = JSON.parse(run([...create, "--name", "released"], f.env));
    const bin = path.join(f.root, "bin");
    mkdirSync(bin);
    const socketPath = path.join(f.root, "create.sock");
    const gitPath = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
    const log = path.join(f.root, "git.jsonl");
    writeFileSync(path.join(bin, "git"), `#!${process.execPath}
const { appendFileSync } = require("node:fs");
const { spawn } = require("node:child_process");
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + "\\n");
const run = () => { const child = spawn(${JSON.stringify(gitPath)}, args, {stdio:"inherit"}); child.on("exit", code => process.exit(code ?? 1)); };
if (args[0] === "clone") { const socket = require("node:net").createConnection(${JSON.stringify(socketPath)}); socket.on("end", run); socket.on("error", error => {console.error(error);process.exit(1);}); socket.resume(); } else run();
`, { mode: 0o755 });
    await new Promise(resolve => server.listen(socketPath, resolve));
    const env = { ...f.env, PATH: `${bin}:${process.env.PATH}` };
    const ready = new Promise(resolve => {
      server.on("connection", () => { if (sockets.length === 8) resolve(); });
    });
    for (let index = 0; index < 8; index += 1) children.push(runAsync([...create, "--name", `parallel-${index}`], env));
    await Promise.race([ready, Promise.all(children).then(() => { throw Error("creations escaped the clone gate"); })]);
    const renewed = JSON.parse(await runAsync(["heartbeat", "--path", retained.path, "--json"], f.env));
    assert.equal(renewed.state, "active");
    assert.equal(JSON.parse(await runAsync(["release", "--path", released.path, "--json"], f.env)).action, "released");
    const duplicate = runAsync([...create, "--name", "parallel-0"], env);
    for (const socket of sockets) socket.end();
    const records = (await Promise.all(children)).map(value => JSON.parse(value));
    assert.equal(JSON.parse(await duplicate).id, records[0].id);
    await assert.rejects(runAsync([...create, "--name", "parallel-0", "--owner", "different-request"], env),
      /different creation request/);
    assert.equal(new Set(records.map(record => record.id)).size, 8);
    for (const record of records) assert.equal(git(record.path, "rev-parse", "HEAD"), commit);
    const commands = readFileSync(log, "utf8").trim().split("\n").map(line => JSON.parse(line));
    assert.equal(commands.some(args => args.includes("fetch")), false);
  } finally {
    for (const socket of sockets) socket.end();
    await Promise.allSettled(children);
    await new Promise(resolve => server.close(resolve));
    f.close();
  }
});

test("an unrecognised command prints the usage that names the real ones", () => {
  const f = fixture();
  try {
    let stdout = "";
    let code = 0;
    try {
      stdout = execFileSync(entry, ["list-workspaces"], {
        env: { ...process.env, ...f.env }, encoding: "utf8", timeout: 30_000,
      });
    } catch (error) {
      code = error.status;
      stdout = error.stdout ?? "";
    }
    assert.equal(code, 2);
    assert.match(stdout, /agent-workspace status/);
    assert.match(stdout, /alias for status/);
  } finally {
    f.close();
  }
});

import assert from "node:assert/strict";
import { execFile, execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statfsSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createServer } from "node:net";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test as nodeTest } from "node:test";
import { main, workspaceTesting } from "./workspace.mjs";

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
    const [pending] = JSON.parse(run(["status", "--json"], f.env)).records;
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

test("origin fetch mapping is installed before an interrupted clone checkout", () => {
  const f = fixture();
  try {
    const args = ["create", "--root", f.workspaces, "--name", "tracking", "--repo", f.remote,
      "--min-free-gib", "0", "--json"];
    assert.throws(() => run(args, interruptCreation(f, "clone")));
    const destination = path.join(f.workspaces, "tracking");
    assert.equal(git(destination, "config", "--local", "--get-all", "remote.origin.fetch"),
      "+refs/heads/*:refs/remotes/origin/*");
    assert.throws(() => git(destination, "rev-parse", "--verify", "origin/main"));
    const record = JSON.parse(run(args, f.env));
    git(destination, "fetch", "origin", "main");
    assert.equal(git(destination, "rev-parse", "origin/main"), record.sourceCommit);
    git(destination, "rebase", "origin/main");
    assert.equal(git(destination, "status", "--porcelain"), "");
  } finally { f.close(); }
});

for (const mapping of [null, "", "+refs/heads/main:refs/remotes/origin/main"]) {
  for (const operation of ["resume", "finalize"]) test(`${operation} repairs missing origin tracking and preserves explicit mapping (${mapping})`, () => {
    const f = fixture();
    try {
      const args = ["create", "--root", f.workspaces, "--name", "tracking", "--repo", f.remote,
        "--min-free-gib", "0", "--json"];
      assert.throws(() => run(args, interruptCreation(f, "checkout")));
      const destination = path.join(f.workspaces, "tracking");
      git(destination, "config", "--unset-all", "remote.origin.fetch");
      if (mapping !== null) git(destination, "config", "--add", "remote.origin.fetch", mapping);
      const head = git(destination, "rev-parse", "HEAD");
      const branch = git(destination, "branch", "--show-current");
      const urls = git(destination, "remote", "-v");
      const record = JSON.parse(run(operation === "resume" ? args :
        ["finalize-creation", "--path", destination, "--json"], f.env));
      assert.equal(record.state, "active");
      assert.equal(git(destination, "rev-parse", "HEAD"), head);
      assert.equal(git(destination, "branch", "--show-current"), branch);
      if (operation === "finalize") assert.equal(git(destination, "remote", "-v"), urls);
      assert.equal(git(destination, "config", "--local", "--get-all", "remote.origin.fetch"),
        mapping || "+refs/heads/*:refs/remotes/origin/*");
      assert.throws(() => git(destination, "rev-parse", "--verify", "origin/main"));
      git(destination, "fetch", "origin", "main");
      git(destination, "rebase", "origin/main");
      assert.equal(git(destination, "rev-parse", "origin/main"), record.sourceCommit);
    } finally { f.close(); }
  });
}

test("bounded creation expiry retains a partial checkout and retries with a larger budget", () => {
  const f = fixture();
  try {
    const bin = path.join(f.root, "bin");
    mkdirSync(bin);
    const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
    const wrapper = path.join(bin, "git");
    writeFileSync(wrapper, `#!${process.execPath}
const {spawnSync} = require('node:child_process');
const fs = require('node:fs');
const args = process.argv.slice(2);
const result = spawnSync(${JSON.stringify(realGit)}, args, {stdio:'inherit'});
if (result.status === 0 && args.includes('checkout')) {
  const dest = args[args.indexOf('-C') + 1];
  fs.unlinkSync(require('node:path').join(dest, '.git', 'index'));
  fs.unlinkSync(require('node:path').join(dest, 'file.txt'));
  setInterval(() => {}, 1000);
} else process.exit(result.status ?? 1);
`);
    chmodSync(wrapper, 0o755);
    const env = { ...f.env, PATH: `${bin}:${process.env.PATH}` };
    const args = ["create", "--root", f.workspaces, "--name", "bounded", "--repo", f.remote,
      "--min-free-gib", "0", "--json"];
    const started = Date.now();
    assert.throws(() => run([...args, "--creation-timeout-seconds", "5"], env), /creation.*(budget|timed out)/);
    assert.ok(Date.now() - started < 10_000);
    const [pending] = JSON.parse(run(["status", "--json"], f.env)).records;
    assert.equal(pending.state, "creating");
    assert.equal(existsSync(pending.path), true);
    assert.equal(git(pending.path, "config", "--get", "remote.origin.fetch"),
      "+refs/heads/*:refs/remotes/origin/*");
    assert.equal(existsSync(path.join(pending.path, "file.txt")), false);
    const resumed = JSON.parse(run([...args, "--creation-timeout-seconds", "30"], f.env));
    assert.equal(resumed.id, pending.id);
    assert.equal(resumed.sourceCommit, pending.sourceCommit);
    assert.equal(resumed.state, "active");
    assert.equal(readFileSync(path.join(resumed.path, "file.txt"), "utf8"), "source\n");
    assert.equal(git(resumed.path, "status", "--porcelain"), "");
  } finally { f.close(); }
});

for (const budget of ["0", "901", "NaN", "Infinity"]) test(`creation rejects unbounded or invalid timeout ${budget}`, () => {
  const f = fixture();
  try {
    assert.throws(() => run(["create", "--root", f.workspaces, "--name", "invalid", "--repo", f.remote,
      "--creation-timeout-seconds", budget, "--min-free-gib", "0"], f.env), /creation-timeout-seconds/);
    assert.equal(existsSync(path.join(f.workspaces, "invalid")), false);
  } finally { f.close(); }
});

for (const mode of ["writer", "review"]) {
  for (const stage of ["complete", "clone", "checkout"]) {
    test(`local ${mode} creation isolates the requested revision with ${stage} materialization`, () => {
      const f = fixture();
      try {
        const reserved = git(f.source, "rev-parse", "main");
        const unrelated = [];
        for (const name of ["unpublished-one", "unpublished-two"]) {
          git(f.source, "checkout", "-b", name, "main");
          writeFileSync(path.join(f.source, `${name}.txt`), `${name}\n`);
          git(f.source, "add", ".");
          git(f.source, "commit", "-m", name);
          unrelated.push(git(f.source, "rev-parse", "HEAD"));
        }
        git(f.source, "checkout", "--detach");
        git(f.source, "commit", "--allow-empty", "-m", "unpublished detached HEAD");
        unrelated.push(git(f.source, "rev-parse", "HEAD"));
        const sourceRefs = git(f.source, "show-ref");
        const args = ["create", "--root", f.workspaces, "--name", "isolated", "--repo", f.source,
          "--ref", "main", "--mode", mode, "--min-free-gib", "0", "--json"];
        let pending;
        if (stage !== "complete") {
          assert.throws(() => run(args, interruptCreation(f, stage)));
          [pending] = JSON.parse(run(["status", "--json"], f.env)).records;
          assert.equal(pending.sourceCommit, reserved);
          assert.equal(git(pending.path, "rev-parse", "HEAD"), reserved);
          assert.deepEqual([...new Set(git(pending.path, "for-each-ref", "--format=%(objectname)").split("\n"))], [reserved]);
          git(f.source, "checkout", "main");
          git(f.source, "commit", "--allow-empty", "-m", "advance requested ref after reservation");
        }
        const created = JSON.parse(run(args, f.env));
        assert.equal(created.state, "active");
        assert.equal(created.sourceCommit, reserved);
        if (pending) assert.equal(created.id, pending.id);
        assert.equal(git(created.path, "rev-parse", "HEAD"), reserved);
        assert.equal(git(created.path, "branch", "--show-current"), mode === "writer" ? "agent/isolated" : "");
        assert.deepEqual([...new Set(git(created.path, "for-each-ref", "--format=%(objectname)").split("\n"))], [reserved]);
        assert.equal(git(created.path, "for-each-ref", "--format=%(refname)", "refs/heads"),
          mode === "writer" ? "refs/heads/agent/isolated" : "");
        assert.equal(git(created.path, "remote"), "origin");
        assert.equal(git(created.path, "status", "--porcelain"), "");
        assert.equal(git(created.path, "remote", "get-url", "origin"), f.remote);
        assert.equal(git(created.path, "config", "--get", "remote.origin.fetch"), "+refs/heads/*:refs/remotes/origin/*");
        for (const commit of unrelated) assert.equal(git(f.source, "rev-parse", `${commit}^{commit}`), commit);
        if (stage === "complete") assert.equal(git(f.source, "show-ref"), sourceRefs);
        git(created.path, "fetch", "origin");
        assert.equal(git(created.path, "rev-parse", "origin/main"), reserved);
      } finally { f.close(); }
    });
  }
}

for (const operation of ["resume-clone", "resume-checkout", "finalize"]) {
  for (const differentOrigin of [false, true]) {
    test(`${operation} ${differentOrigin ? "refuses a different stored origin" : "accepts the stored SSH origin"} under a global HTTPS rewrite`, () => {
      const f = fixture();
      try {
        const repository = "git@github.com:workspace-fixture/repository.git";
        const https = "https://github.com/workspace-fixture/repository.git";
        const globalConfig = path.join(f.root, "gitconfig");
        const env = { ...f.env, GIT_CONFIG_GLOBAL: globalConfig, GIT_CONFIG_NOSYSTEM: "1" };
        execFileSync("git", ["config", "--file", globalConfig, `url.file://${f.remote}.insteadOf`, repository]);
        const args = ["create", "--root", f.workspaces, "--name", "rewritten", "--repo", repository,
          "--ref", git(f.source, "rev-parse", "HEAD"), "--min-free-gib", "0", "--json"];
        assert.throws(() => run(args, { ...interruptCreation(f, operation === "resume-clone" ? "clone" : "checkout"), ...env }));
        const [pending] = JSON.parse(run(["status", "--json"], env)).records;
        writeFileSync(globalConfig, `[url "${https}"]\n\tinsteadOf = ${repository}\n`);
        const destination = pending.path;
        if (differentOrigin) git(destination, "remote", "set-url", "origin", "git@github.com:workspace-fixture/different.git");
        const stored = git(destination, "config", "--local", "--get", "remote.origin.url");
        if (!differentOrigin) {
          assert.equal(stored, repository);
          assert.equal(execFileSync("git", ["-C", destination, "remote", "get-url", "origin"], {
            env: { ...process.env, ...env }, encoding: "utf8",
          }).trim(), https);
        }
        const head = git(destination, "rev-parse", "HEAD");
        const status = git(destination, "status", "--porcelain");
        const retry = operation === "finalize" ? ["finalize-creation", "--id", pending.id, "--json"] : args;
        if (differentOrigin) {
          assert.throws(() => run(retry, env), /origin differs from the creation request/u);
          assert.equal(git(destination, "rev-parse", "HEAD"), head);
          assert.equal(git(destination, "status", "--porcelain"), status);
          assert.equal(git(destination, "config", "--local", "--get", "remote.origin.url"), stored);
          assert.equal(JSON.parse(run(["status", "--json"], env)).records[0].state, "creating");
        } else {
          const resumed = JSON.parse(run(retry, env));
          assert.equal(resumed.id, pending.id);
          assert.equal(resumed.state, "active");
          assert.equal(git(destination, "rev-parse", "HEAD"), pending.sourceCommit);
          assert.equal(git(destination, "status", "--porcelain"), "");
          assert.equal(git(destination, "config", "--local", "--get", "remote.origin.url"), repository);
        }
      } finally { f.close(); }
    });
  }
}

function interruptedCheckout(f, name = "partial", mode = "writer") {
  writeFileSync(path.join(f.source, "missing.txt"), "not yet materialized\n");
  git(f.source, "add", ".");
  git(f.source, "commit", "-m", "reserved tree");
  const reserved = git(f.source, "rev-parse", "HEAD");
  writeFileSync(path.join(f.source, "later.txt"), "main advanced\n");
  git(f.source, "add", ".");
  git(f.source, "commit", "-m", "main ahead of reserved source");
  git(f.source, "push", "origin", "main");
  const args = ["create", "--root", f.workspaces, "--name", name, "--repo", f.source,
    "--ref", reserved, "--mode", mode, "--min-free-gib", "0", "--json"];
  assert.throws(() => run(args, interruptCreation(f, "clone")));
  const destination = path.join(f.workspaces, name);
  // Model a checkout left by the former all-refs clone, before single-revision isolation.
  const mainHead = git(f.source, "rev-parse", "main");
  git(destination, "fetch", "--no-tags", "origin", "refs/heads/main:refs/remotes/origin/main");
  git(destination, "update-ref", "refs/heads/main", mainHead);
  git(destination, "symbolic-ref", "HEAD", "refs/heads/main");
  // Git has written some reserved files but has not committed its index or HEAD update.
  git(destination, "read-tree", "--empty");
  writeFileSync(path.join(destination, "file.txt"), "source\n");
  writeFileSync(path.join(destination, ".gitignore"), "ignored-output/\n");
  return { args, destination, reserved };
}

for (const [mode, indexState] of [["writer", "empty"], ["review", "absent"], ["writer", "reserved"]]) test(`creation resumes a partially materialized reserved checkout in ${mode} mode with ${indexState} index`, () => {
  const f = fixture();
  try {
    const { args, destination, reserved } = interruptedCheckout(f, "partial", mode);
    const [pending] = JSON.parse(run(["status", "--json"], f.env)).records;
    const mainHead = git(destination, "rev-parse", "HEAD");
    assert.notEqual(mainHead, reserved);
    assert.match(git(destination, "status", "--porcelain"), /D .*file.txt/u);
    assert.match(git(destination, "status", "--porcelain"), /\?\? file.txt/u);
    if (indexState === "absent") rmSync(path.join(destination, ".git", "index"));
    if (indexState === "reserved") git(destination, "read-tree", reserved);
    mkdirSync(path.join(destination, "ignored-output"));
    writeFileSync(path.join(destination, "ignored-output", "proof"), "preserved\n");
    const resumed = JSON.parse(run(args, f.env));
    assert.equal(resumed.id, pending.id);
    assert.equal(resumed.state, "active");
    assert.equal(git(destination, "rev-parse", "HEAD"), reserved);
    assert.equal(git(destination, "status", "--porcelain"), "");
    assert.equal(readFileSync(path.join(destination, "ignored-output", "proof"), "utf8"), "preserved\n");
    assert.equal(readFileSync(path.join(destination, ".gitignore"), "utf8"), "ignored-output/\n");
    assert.equal(git(destination, "rev-parse", "main"), mainHead);
    if (mode === "writer") assert.equal(git(destination, "branch", "--show-current"), "agent/partial");
    else assert.equal(git(destination, "branch", "--show-current"), "");
  } finally { f.close(); }
});

for (const change of ["edit", "untracked", "staged", "local-commit", "ignored-collision", "symlink"]) {
  test(`interrupted checkout recovery preserves genuine ${change} work`, () => {
    const f = fixture();
    try {
      const { args, destination } = interruptedCheckout(f);
      if (change === "edit") writeFileSync(path.join(destination, "file.txt"), "unique edit\n");
      if (change === "untracked") writeFileSync(path.join(destination, "notes.txt"), "unique notes\n");
      if (change === "staged") {
        writeFileSync(path.join(destination, "file.txt"), "unique staged edit\n");
        git(destination, "add", "file.txt");
      }
      if (change === "local-commit") {
        git(destination, "config", "user.name", "Test");
        git(destination, "config", "user.email", "test@example.invalid");
        git(destination, "add", "file.txt");
        git(destination, "commit", "-m", "unique local work");
      }
      if (change === "ignored-collision") {
        writeFileSync(path.join(destination, ".git", "info", "exclude"), ".gitignore\n");
        writeFileSync(path.join(destination, ".gitignore"), "unique ignored collision\n");
      }
      if (change === "symlink") {
        rmSync(path.join(destination, "file.txt"));
        symlinkSync(path.join(f.source, "file.txt"), path.join(destination, "file.txt"));
      }
      const head = git(destination, "rev-parse", "HEAD");
      const status = git(destination, "status", "--porcelain");
      const index = git(destination, "ls-files", "--stage");
      assert.throws(() => run(args, f.env), /pending checkout cannot resume/u);
      assert.equal(git(destination, "rev-parse", "HEAD"), head);
      assert.equal(git(destination, "status", "--porcelain"), status);
      assert.equal(git(destination, "ls-files", "--stage"), index);
      assert.equal(JSON.parse(run(["status", "--json"], f.env)).records[0].state, "creating");
    } finally { f.close(); }
  });
}

test("source preparation interruption leaves no destination reservation", () => {
  const f = fixture();
  try {
    const args = ["create", "--root", f.workspaces, "--name", "preparing", "--repo", f.source,
      "--min-free-gib", "0", "--json"];
    assert.throws(() => run(args, interruptCreation(f, "config")));
    assert.deepEqual(JSON.parse(run(["status", "--json"], f.env)).records, []);
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
        assert.equal(JSON.parse(run(["status", "--json"], f.env)).records.some(row => row.state === "creating"), false);
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
    const beforePeer = JSON.parse(run(["status", "--path", peer.path, "--json"], f.env)).records[0];
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
    const [unchanged] = JSON.parse(run(["status", "--path", peer.path, "--json"], f.env)).records;
    assert.deepEqual(unchanged, beforePeer);
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

for (const mode of ["writer", "review"]) test(`completed interrupted ${mode} checkout preserves later file deletions`, () => {
  const f = fixture();
  try {
    const args = ["create", "--root", f.workspaces, "--name", "deleted", "--repo", f.source,
      "--mode", mode, "--min-free-gib", "0", "--json"];
    assert.throws(() => run(args, interruptCreation(f, "checkout")));
    const destination = path.join(f.workspaces, "deleted");
    rmSync(path.join(destination, "file.txt"));
    const status = git(destination, "status", "--porcelain");
    assert.throws(() => run(args, f.env), /pending checkout contains changes/);
    assert.equal(existsSync(path.join(destination, "file.txt")), false);
    assert.equal(git(destination, "status", "--porcelain"), status);
    assert.equal(JSON.parse(run(["status", "--json"], f.env)).records[0].state, "creating");
  } finally { f.close(); }
});

test("interrupted creation resumes with ignored output without removing it", () => {
  const f = fixture();
  try {
    const args = ["create", "--root", f.workspaces, "--name", "ignored", "--repo", f.source,
      "--min-free-gib", "0", "--json"];
    assert.throws(() => run(args, interruptCreation(f, "checkout")));
    const destination = path.join(f.workspaces, "ignored");
    mkdirSync(path.join(destination, "ignored-output"));
    const output = path.join(destination, "ignored-output", "proof");
    writeFileSync(output, "retain ignored work\n");
    assert.equal(git(destination, "status", "--porcelain"), "");
    assert.equal(JSON.parse(run(args, f.env)).state, "active");
    assert.equal(readFileSync(output, "utf8"), "retain ignored work\n");
    const release = JSON.parse(run(["release", "--path", destination, "--json"], f.env));
    assert.match(release.inspection.reason, /unclassified ignored output/);
    assert.equal(existsSync(output), true);
  } finally { f.close(); }
});

test("finalize-creation adopts an interrupted clean descendant without losing work or peers", () => {
  const f = fixture();
  try {
    const args = ["create", "--root", f.workspaces, "--repo", f.source, "--min-free-gib", "0", "--json"];
    const peer = JSON.parse(run([...args, "--name", "peer"], f.env));
    const peerBefore = JSON.parse(run(["status", "--path", peer.path, "--json"], f.env));
    assert.throws(() => run([...args, "--name", "descendant"], interruptCreation(f, "checkout")));
    const destination = path.join(f.workspaces, "descendant");
    const database = new DatabaseSync(f.env.PI_WORKSPACE_STATE);
    const before = database.prepare("SELECT * FROM workspace WHERE path=?").get(destination);
    database.close();
    const finalize = ["finalize-creation", "--id", before.id, "--json"];
    git(destination, "config", "user.name", "Test");
    git(destination, "config", "user.email", "test@example.invalid");
    git(destination, "branch", "-m", "renamed-after-interruption");
    writeFileSync(path.join(destination, "file.txt"), "descendant work\n");
    assert.throws(() => run(finalize, f.env), /pending checkout contains changes/);
    git(destination, "commit", "-am", "work after interruption");
    const head = git(destination, "rev-parse", "HEAD");
    mkdirSync(path.join(destination, "ignored-output"));
    const ignored = path.join(destination, "ignored-output", "proof");
    writeFileSync(ignored, "ignored evidence\n");
    git(destination, "remote", "set-url", "origin", path.join(f.root, "unrelated.git"));
    assert.throws(() => run(finalize, f.env), /origin differs/);
    git(destination, "remote", "set-url", "origin", f.source);
    git(destination, "checkout", "--orphan", "unrelated");
    git(destination, "commit", "-am", "unrelated root");
    assert.throws(() => run(finalize, f.env), /not descended/);
    git(destination, "checkout", "renamed-after-interruption");
    git(destination, "branch", "-D", "unrelated");
    // The original disposable source can already be gone when a task finishes.
    rmSync(f.source, { recursive: true });
    const finalized = JSON.parse(run(finalize, f.env));
    assert.equal(finalized.id, before.id);
    assert.equal(finalized.owner, before.owner);
    assert.equal(finalized.sourceCommit, before.source_commit);
    assert.equal(finalized.state, "active");
    assert.deepEqual(JSON.parse(run(finalize, f.env)), finalized);
    assert.equal(git(destination, "rev-parse", "HEAD"), head);
    assert.equal(git(destination, "branch", "--show-current"), "renamed-after-interruption");
    assert.equal(readFileSync(ignored, "utf8"), "ignored evidence\n");
    const afterDb = new DatabaseSync(f.env.PI_WORKSPACE_STATE);
    assert.equal(afterDb.prepare("SELECT creation_request FROM workspace WHERE id=?").get(before.id).creation_request, before.creation_request);
    afterDb.close();
    assert.deepEqual(JSON.parse(run(["status", "--path", peer.path, "--json"], f.env)), peerBefore);
    // Normal release still refuses unclassified ignored files and unpushed commits.
    assert.notEqual(JSON.parse(run(["release", "--id", before.id, "--json"], f.env)).action, "released");
    rmSync(path.join(destination, "ignored-output"), { recursive: true });
    assert.notEqual(JSON.parse(run(["release", "--id", before.id, "--json"], f.env)).action, "released");
    assert.equal(existsSync(destination), true);
    git(destination, "remote", "add", "publish", f.remote);
    git(destination, "push", "publish", "HEAD:refs/heads/descendant");
    assert.equal(JSON.parse(run(["release", "--id", before.id, "--json"], f.env)).action, "released");
    assert.equal(git(f.remote, "rev-parse", "refs/heads/descendant"), head);
    assert.equal(existsSync(peer.path), true);
  } finally { f.close(); }
});

test("finalize-creation validates the interrupted linked worktree mode and mirror", () => {
  const f = fixture();
  try {
    const args = ["create", "--root", f.workspaces, "--name", "linked", "--repo", f.source,
      "--strategy", "worktree", "--min-free-gib", "0", "--json"];
    assert.throws(() => run(args, interruptCreation(f, "worktree")));
    const destination = path.join(f.workspaces, "linked");
    const finalize = ["finalize-creation", "--path", destination, "--json"];
    git(destination, "checkout", "--detach");
    assert.throws(() => run(finalize, f.env), /branch mode differs/);
    git(destination, "checkout", "agent/linked");
    const record = JSON.parse(run(finalize, f.env));
    assert.equal(record.checkoutType, "worktree");
    assert.equal(record.state, "active");
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

test("source capacity separates real headroom and known footprint from unknown full work", () => {
  const GiB = 1024 ** 3;
  const plan = { constructionBytes: 640 * 1024 ** 2, growthBytes: 256 * 1024 ** 2, headroomBytes: 20 * GiB };
  assert.equal(workspaceTesting.capacityRequirement(plan, []) < 24.74 * GiB, true);
  assert.equal(workspaceTesting.capacityRequirement(plan, [4 * GiB]) > 24.74 * GiB, true);
  assert.equal(workspaceTesting.capacityRequirement({ constructionBytes: 30 * GiB, growthBytes: 0, headroomBytes: 0 }, []) > 24.74 * GiB, true);
  assert.throws(() => workspaceTesting.capacityRequirement({ ...plan, growthBytes: undefined }, []), /invalid capacity ledger/);
  assert.throws(() => workspaceTesting.capacityRequirement(plan, [-1]), /invalid capacity ledger/);
});

test("filesystem headroom is shared across completed workspaces while pending construction and declared growth stay additive", () => {
  const f = fixture();
  const GiB = 1024 ** 3;
  try {
    const records = ["one", "two", "three"].map(name => JSON.parse(run([
      "create", "--root", name === "three" ? path.join(f.root, "other-pool") : f.workspaces,
      "--name", name, "--repo", f.remote, "--min-free-gib", "0", "--json",
    ], f.env)));
    const db = new DatabaseSync(f.env.PI_WORKSPACE_STATE);
    const device = String(statSync(f.workspaces).dev);
    const plan = { intent: "unestimated", estimate: "unknown", constructionBytes: 30 * GiB, growthBytes: 0, headroomBytes: 0 };
    for (const record of records) db.prepare("UPDATE workspace_capacity SET plan_json=? WHERE workspace_id=?").run(JSON.stringify(plan), record.id);
    let reservations = workspaceTesting.capacityReservations(db, device);
    assert.deepEqual(reservations, { priced: [], headroomBytes: 30 * GiB, unpricedDormant: 0 });
    assert.equal(workspaceTesting.capacityRequirement(plan, reservations.priced, reservations.headroomBytes), 30 * GiB);
    db.prepare("UPDATE workspace SET state='creating' WHERE id=?").run(records[0].id);
    reservations = workspaceTesting.capacityReservations(db, device);
    assert.deepEqual(reservations, { priced: [30 * GiB], headroomBytes: 30 * GiB, unpricedDormant: 0 });
    assert.equal(workspaceTesting.capacityRequirement(plan, reservations.priced, reservations.headroomBytes), 60 * GiB);
    db.prepare("UPDATE workspace SET state='released' WHERE id=?").run(records[0].id);
    const budgeted = { intent: "budgeted", estimate: "whole-tree-upper-bound", constructionBytes: 5 * GiB, growthBytes: 2 * GiB, headroomBytes: 40 * GiB };
    db.prepare("UPDATE workspace_capacity SET plan_json=? WHERE workspace_id=?").run(JSON.stringify(budgeted), records[1].id);
    db.prepare("UPDATE workspace SET state='repair-required', lease_expires_at=0 WHERE id=?").run(records[1].id);
    reservations = workspaceTesting.capacityReservations(db, device);
    assert.deepEqual(reservations, { priced: [2 * GiB], headroomBytes: 40 * GiB, unpricedDormant: 0 });
    assert.equal(workspaceTesting.capacityRequirement(plan, reservations.priced, reservations.headroomBytes), 42 * GiB);
    db.prepare("UPDATE workspace SET state='released'").run();
    assert.deepEqual(workspaceTesting.capacityReservations(db, device), { priced: [], headroomBytes: 0, unpricedDormant: 0 });
    db.close();
  } finally { f.close(); }
});

test("budgeted source creation shares existing objects and records immutable whole-tree pricing", () => {
  const f = fixture();
  try {
    writeFileSync(path.join(f.source, "excluded.bin"), Buffer.alloc(3 * 1024 ** 2));
    git(f.source, "add", "excluded.bin");
    git(f.source, "commit", "-m", "large excluded source");
    git(f.source, "push", "origin", "main");
    const selectedSource = git(f.source, "rev-parse", "HEAD");
    writeFileSync(path.join(f.source, "unique-source.txt"), "unpublished source work\n");
    git(f.source, "add", "unique-source.txt");
    git(f.source, "commit", "-m", "unpublished source work");
    const sourceHead = git(f.source, "rev-parse", "HEAD");
    const args = ["create", "--root", f.workspaces, "--name", "priced", "--repo", f.source, "--ref", selectedSource,
      "--intent", "source-only", "--headroom-gib", "1", "--growth-mib", "8", "--sparse-pattern", "*.txt", "--json"];
    const created = JSON.parse(run(args, f.env));
    assert.equal(created.capacity.intent, "source-only");
    assert.equal(created.capacity.estimate, "whole-tree-upper-bound");
    assert.equal(created.capacity.sourceCommit, created.sourceCommit);
    assert.equal(created.capacity.constructionBytes > 6 * 1024 ** 2, true);
    assert.equal(created.capacity.growthBytes, 8 * 1024 ** 2);
    assert.equal(existsSync(path.join(created.path, "excluded.bin")), false);
    assert.equal(readFileSync(path.join(created.path, "file.txt"), "utf8"), "source\n");
    assert.equal(existsSync(path.join(created.path, ".git", "objects", "info", "alternates")), true);
    const alternate = readFileSync(path.join(created.path, ".git", "objects", "info", "alternates"), "utf8").trim();
    assert.equal(alternate.startsWith(path.join(f.root, "state", "mirrors")), true);
    assert.equal(existsSync(path.join(alternate, "info", "alternates")), false);
    assert.equal(created.capacity.sourceImportBytes > 0, true);
    assert.equal(git(created.path, "for-each-ref", "--format=%(refname)", "refs/remotes"), "");
    assert.equal(git(created.path, "rev-list", "--all", "--not", selectedSource), "");
    assert.equal(git(f.source, "rev-parse", "HEAD"), sourceHead);
    assert.deepEqual(JSON.parse(run(args, f.env)).capacity, created.capacity);
    const shared = JSON.parse(run(args.map(arg => arg === "priced" ? "priced-peer" : arg), f.env));
    assert.equal(shared.capacity.sourceImportBytes, 0);
    assert.equal(readFileSync(path.join(shared.path, ".git", "objects", "info", "alternates"), "utf8").trim(), alternate);
    run(["release", "--id", shared.id], f.env);
    assert.throws(() => run(args.map(arg => arg === "8" ? "9" : arg), f.env), /different creation request/);
    const db = new DatabaseSync(f.env.PI_WORKSPACE_STATE);
    const device = String(statSync(f.workspaces).dev);
    const fullPlan = { intent: "unestimated", estimate: "unknown", constructionBytes: 30 * 1024 ** 3, growthBytes: 0, headroomBytes: 0 };
    db.prepare("UPDATE workspace_capacity SET plan_json=? WHERE workspace_id=?").run(JSON.stringify(fullPlan), created.id);
    assert.deepEqual(workspaceTesting.capacityReservations(db, device), { priced: [], headroomBytes: 30 * 1024 ** 3, unpricedDormant: 0 });
    db.prepare("UPDATE workspace_capacity SET plan_json=? WHERE workspace_id=?").run(JSON.stringify(created.capacity), created.id);
    assert.deepEqual(workspaceTesting.capacityReservations(db, device), { priced: [8 * 1024 ** 2], headroomBytes: 1024 ** 3, unpricedDormant: 0 });
    db.prepare("UPDATE workspace SET lease_expires_at=0 WHERE id=?").run(created.id);
    assert.deepEqual(workspaceTesting.capacityReservations(db, device), { priced: [8 * 1024 ** 2], headroomBytes: 1024 ** 3, unpricedDormant: 0 });
    db.prepare("UPDATE workspace SET state='creating', lease_expires_at=0 WHERE id=?").run(created.id);
    assert.deepEqual(workspaceTesting.capacityReservations(db, device), { priced: [created.capacity.growthBytes + created.capacity.constructionBytes], headroomBytes: 1024 ** 3, unpricedDormant: 0 });
    db.prepare("DELETE FROM workspace_capacity WHERE workspace_id=?").run(created.id);
    assert.deepEqual(workspaceTesting.capacityReservations(db, device), { priced: [], headroomBytes: 0, unpricedDormant: 1 });
    assert.deepEqual(workspaceTesting.capacityReservations(db, device, created.path), { priced: [], headroomBytes: 0, unpricedDormant: 0 });
    // An old dormant reservation is priced again under the filesystem fence before resuming.
    const resumed = JSON.parse(run(args, f.env));
    assert.equal(resumed.id, created.id);
    assert.equal(resumed.capacity.sourceCommit, created.sourceCommit);
    assert.deepEqual(workspaceTesting.capacityReservations(db, device), { priced: [8 * 1024 ** 2], headroomBytes: 1024 ** 3, unpricedDormant: 0 });
    db.prepare("UPDATE workspace SET state='creating' WHERE id=?").run(created.id);
    rmSync(created.path, { recursive: true });
    run(["cancel-creation", "--id", created.id], f.env);
    assert.deepEqual(workspaceTesting.capacityReservations(db, device), { priced: [], headroomBytes: 0, unpricedDormant: 0 });
    db.close();
  } finally { f.close(); }
});

for (const custody of ["creation", "registration", "maintenance"]) test(`${custody} preserves fetched branch objects across transitive source repack and release`, () => {
  const f = fixture();
  try {
    const base = git(f.source, "rev-parse", "HEAD");
    git(f.source, "checkout", "-b", "feature");
    writeFileSync(path.join(f.source, "feature.txt"), "fetched feature\n");
    git(f.source, "add", ".");
    git(f.source, "commit", "-m", "feature");
    const feature = git(f.source, "rev-parse", "HEAD");
    git(f.source, "push", "origin", "feature");
    git(f.source, "checkout", "main");
    mkdirSync(f.workspaces, { recursive: true });
    const intermediate = path.join(f.workspaces, "intermediate");
    execFileSync("git", ["clone", "--reference", f.source, "--single-branch", "--branch", "main", f.remote, intermediate]);
    const borrower = path.join(f.workspaces, "child");
    if (custody === "creation") {
      run(["create", "--root", f.workspaces, "--name", "child", "--repo", intermediate,
        "--intent", "source-only", "--headroom-gib", "1", "--growth-mib", "8", "--json"], f.env);
    } else {
      execFileSync("git", ["clone", "--shared", "--single-branch", "--branch", "main", intermediate, borrower]);
      git(borrower, "remote", "set-url", "origin", f.remote);
      if (custody === "maintenance") {
        run(["register", "--path", borrower], f.env);
        // Model a pre-repair registered checkout's mutable transitive alternate.
        writeFileSync(path.join(borrower, ".git", "objects", "info", "alternates"), `${intermediate}/.git/objects\n`);
      }
    }
    git(borrower, "fetch", "origin", "feature");
    git(borrower, "checkout", "-B", "feature", "FETCH_HEAD");
    if (custody === "registration") run(["register", "--path", borrower], f.env);
    if (custody === "maintenance") {
      const alternateFile = path.join(borrower, ".git", "objects", "info", "alternates");
      const previous = readFileSync(alternateFile, "utf8");
      const [plan] = JSON.parse(run(["maintain", "--path", borrower, "--json"], f.env));
      assert.equal(plan.objectCustody, "would-import-durable-mirror");
      assert.equal(readFileSync(alternateFile, "utf8"), previous);
      const [applied] = JSON.parse(run(["maintain", "--path", borrower, "--execute", "--json"], f.env));
      assert.equal(applied.objectCustody, "imported-durable-mirror");
      const mirror = path.dirname(readFileSync(alternateFile, "utf8").trim());
      git(mirror, "repack", "-a", "-d");
      git(mirror, "prune", "--expire=now");
    }
    git(intermediate, "repack", "-a", "-d");
    rmSync(path.join(intermediate, ".git", "objects", "info", "alternates"));
    assert.equal(git(borrower, "rev-parse", "HEAD"), feature);
    assert.equal(git(borrower, "show", "HEAD:feature.txt"), "fetched feature");
    const sourceRecord = JSON.parse(run(["register", "--path", intermediate, "--json"], f.env));
    assert.equal(JSON.parse(run(["release", "--id", sourceRecord.id, "--json"], f.env)).action, "released");
    assert.equal(existsSync(intermediate), false);
    assert.equal(git(borrower, "show", `${base}:file.txt`), "source");
    assert.equal(git(borrower, "show", "HEAD:feature.txt"), "fetched feature");
    git(borrower, "fetch", "origin", "feature");
    git(borrower, "fsck", "--connectivity-only", "--no-dangling");
  } finally { f.close(); }
});

test("failed mutable-custody import retains the alternate and imported refs", () => {
  const f = fixture();
  try {
    const borrower = path.join(f.workspaces, "missing-object");
    mkdirSync(f.workspaces);
    execFileSync("git", ["clone", "--shared", f.source, borrower]);
    run(["register", "--path", borrower], f.env);
    const alternates = path.join(borrower, ".git", "objects", "info", "alternates");
    const original = `${f.source}/.git/objects\n`;
    writeFileSync(alternates, original);
    git(f.source, "commit", "--allow-empty", "-m", "later borrowed object");
    const object = git(f.source, "rev-parse", "HEAD");
    git(borrower, "update-ref", "refs/heads/imported", object);
    rmSync(path.join(f.source, ".git", "objects", object.slice(0, 2), object.slice(2)));
    assert.throws(() => run(["maintain", "--path", borrower, "--execute", "--json"], f.env));
    assert.equal(readFileSync(alternates, "utf8"), original);
    assert.equal(git(borrower, "rev-parse", "refs/heads/imported"), object);
    assert.equal(readFileSync(path.join(borrower, "file.txt"), "utf8"), "source\n");
  } finally { f.close(); }
});

test("budgeted shared-source creation resumes an interrupted initialization with the same reservation", () => {
  const f = fixture();
  try {
    const args = ["create", "--root", f.workspaces, "--name", "partial-shared", "--repo", f.source,
      "--intent", "source-only", "--headroom-gib", "1", "--growth-mib", "8", "--json"];
    assert.throws(() => run(args, interruptCreation(f, "update-ref")));
    const pending = JSON.parse(run(["status", "--json"], f.env)).records[0];
    assert.equal(pending.state, "creating");
    const resumed = JSON.parse(run(args, f.env));
    assert.equal(resumed.id, pending.id);
    assert.equal(resumed.state, "active");
    assert.equal(resumed.sourceCommit, pending.sourceCommit);
    assert.equal(git(resumed.path, "for-each-ref", "--format=%(refname)", "refs/remotes"), "");
    assert.equal(readFileSync(path.join(resumed.path, "file.txt"), "utf8"), "source\n");
  } finally { f.close(); }
});

test("budgeted admission rejects unknown source imports, filters and unspecified budgets before reservation", () => {
  const f = fixture();
  try {
    const base = ["create", "--root", f.workspaces, "--name", "unknown", "--repo", f.source, "--json"];
    const budget = ["--intent", "budgeted", "--headroom-gib", "1", "--growth-mib", "2048"];
    for (const args of [[...base, "--intent", "source-only"], [...base, "--headroom-gib", "1"],
      [...base, ...budget, "--min-free-gib", "0"], [...base, ...budget, "--strategy", "worktree"],
      [...base, ...budget.map(arg => arg === "1" ? "0" : arg)]]) assert.throws(() => run(args, f.env));
    assert.throws(() => run([...base.map(arg => arg === f.source ? `file://${f.remote}` : arg), ...budget], f.env), /estimate unknown/);
    git(f.source, "config", "filter.fake.smudge", "cat");
    assert.throws(() => run([...base, ...budget], f.env), /estimate unknown.*filters/);
    git(f.source, "config", "--unset", "filter.fake.smudge");
    writeFileSync(path.join(f.source, ".gitattributes"), "*.txt working-tree-encoding=UTF-16\n");
    git(f.source, "add", ".gitattributes");
    git(f.source, "commit", "-m", "unknown encoding transform");
    assert.throws(() => run([...base, ...budget], f.env), /estimate unknown.*attribute/);
    assert.deepEqual(JSON.parse(run(["status", "--json"], f.env)).records, []);
    assert.equal(existsSync(path.join(f.workspaces, "unknown")), false);
  } finally { f.close(); }
});

test("an active legacy creator refuses unknown capacity while a dormant one must reprice before resume", async () => {
  const f = fixture();
  let child;
  try {
    const base = ["create", "--root", f.workspaces, "--repo", f.source, "--min-free-gib", "0", "--json"];
    const created = JSON.parse(run([...base, "--name", "legacy"], f.env));
    const db = new DatabaseSync(f.env.PI_WORKSPACE_STATE);
    db.prepare("UPDATE workspace SET state='creating' WHERE id=?").run(created.id);
    db.prepare("DELETE FROM workspace_capacity WHERE workspace_id=?").run(created.id);
    const device = String(statSync(f.workspaces).dev);
    const lock = path.join(f.root, "state", "locks", createHash("sha256").update(`checkout:${created.path}`).digest("hex"));
    child = spawn("flock", ["--exclusive", lock, process.execPath, "-e", "process.stdout.write('ready');process.stdin.resume()"], { stdio: ["pipe", "pipe", "pipe"] });
    await new Promise((resolve, reject) => { child.stdout.once("data", resolve); child.once("error", reject); });
    assert.throws(() => workspaceTesting.capacityReservations(db, device), /estimate unknown.*active legacy/);
    assert.throws(() => run([...base, "--name", "other"], f.env), /estimate unknown.*active legacy/);
    const closed = new Promise(resolve => child.once("close", resolve));
    child.stdin.end();
    await closed;
    child = undefined;
    assert.deepEqual(workspaceTesting.capacityReservations(db, device), { priced: [], unpricedDormant: 1 });
    assert.equal(JSON.parse(run([...base, "--name", "other"], f.env)).capacity.admission.unpricedDormant, 1);
    assert.throws(() => run([...base.map(arg => arg === "0" ? "1000000" : arg), "--name", "legacy"], f.env), /GiB is required/);
    assert.equal(db.prepare("SELECT count(*) AS count FROM workspace_capacity WHERE workspace_id=?").get(created.id).count, 0);
    assert.equal(JSON.parse(run([...base, "--name", "legacy"], f.env)).state, "active");
    assert.equal(db.prepare("SELECT count(*) AS count FROM workspace_capacity WHERE workspace_id=?").get(created.id).count, 1);
    db.close();
  } finally { child?.kill(); f.close(); }
});

test("concurrent budgeted admissions across roots cannot spend the same filesystem capacity twice", async () => {
  const f = fixture();
  try {
    const stats = statfsSync(f.root);
    const growthMiB = Math.floor(stats.bavail * stats.bsize / 1024 ** 2 * 0.6);
    const commands = ["first", "second"].map(name => ["create", "--root", path.join(f.root, name), "--name", "priced",
      "--repo", f.source, "--intent", "budgeted", "--headroom-gib", "1", "--growth-mib", String(growthMiB), "--json"]);
    const results = await Promise.allSettled(commands.map(args => runAsync(args, f.env)));
    assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
    assert.equal(results.filter(result => result.status === "rejected").length, 1);
    const failure = results.find(result => result.status === "rejected");
    assert.match(failure.reason.message, /GiB is required/);
    const winner = JSON.parse(results.find(result => result.status === "fulfilled").value);
    run(["release", "--id", winner.id], f.env);
    assert.equal(JSON.parse(run(commands[results[0].status === "rejected" ? 0 : 1], f.env)).state, "active");
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
    assert.throws(() => run([...args, "--name", "disk-blocked", "--min-free-gib", "1000000"], f.env),
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
    database.prepare("INSERT INTO workspace_capacity VALUES('gone-old','device','{}')").run();
    assert.equal(workspaceTesting.pruneReleased(database, now), 1);
    assert.equal(database.prepare("SELECT count(*) AS count FROM workspace_capacity").get().count, 0);
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
    assert.deepEqual(JSON.parse(status).records, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("initialized registry reads do not acquire the SQLite writer lock", (t) => {
  const f = fixture();
  let database;
  try {
    const created = JSON.parse(run(["create", "--root", f.workspaces, "--name", "writer-held",
      "--repo", f.remote, "--min-free-gib", "0", "--json"], f.env));
    database = new DatabaseSync(f.env.PI_WORKSPACE_STATE);
    database.exec("BEGIN IMMEDIATE");
    database.prepare("UPDATE workspace SET detail='uncommitted writer' WHERE id=?").run(created.id);
    // A second connection must succeed while the writer stays held. Process
    // startup speed is unrelated to whether the read acquires a writer lock.
    let output = "";
    const write = t.mock.method(process.stdout, "write", chunk => { output += chunk; return true; });
    try { main(["status", "--json"], f.env.PI_WORKSPACE_STATE); }
    finally { write.mock.restore(); }
    const [observed] = JSON.parse(output).records;
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
    for (const result of results) assert.deepEqual(JSON.parse(result).records, []);
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
    assert.equal(JSON.parse(run(["status", "--json"], f.env)).records.length, 40);
  } finally { f.close(); }
});

test("concurrent local HEAD creates never refresh upstream and use immutable mirror custody", async () => {
  const f = fixture();
  try {
    const bin = path.join(f.root, "bin");
    mkdirSync(bin);
    const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
    const wrapper = path.join(bin, "git");
    writeFileSync(wrapper, `#!${process.execPath}
const { spawnSync } = require('node:child_process');
const args = process.argv.slice(2);
if (args.includes('fetch') && args.at(-1) === 'origin') {
  console.error('local allocation attempted serialized upstream refresh'); process.exit(99);
}
const result = spawnSync(${JSON.stringify(realGit)}, args, {stdio:'inherit'});
process.exit(result.status ?? 1);
`);
    chmodSync(wrapper, 0o755);
    const env = { ...f.env, PATH: `${bin}:${process.env.PATH}` };
    const create = ["create", "--root", f.workspaces, "--repo", f.source, "--min-free-gib", "0", "--json"];
    const commit = git(f.source, "rev-parse", "HEAD");
    const records = await Promise.all(Array.from({ length: 24 }, async (_, index) =>
      JSON.parse(await runAsync([...create, "--name", `local-${index}`], env))));
    assert.equal(new Set(records.map(record => record.id)).size, 24);
    for (const record of records) {
      assert.equal(record.state, "active");
      assert.equal(record.sourceCommit, commit);
      assert.equal(git(record.path, "rev-parse", "HEAD"), commit);
    }
    const remoteRecords = await Promise.all(Array.from({ length: 24 }, async (_, index) =>
      JSON.parse(await runAsync(["create", "--root", f.workspaces, "--repo", `file://${f.remote}`,
        "--name", `remote-${index}`, "--min-free-gib", "0", "--json"], env))));
    for (const record of remoteRecords) {
      assert.equal(record.state, "active");
      assert.equal(record.sourceCommit, commit);
    }
    git(f.source, "tag", "-a", "annotated-source", "-m", "tag source");
    git(f.source, "push", "origin", "annotated-source");
    const tagged = JSON.parse(run(["create", "--root", f.workspaces, "--repo", `file://${f.remote}`,
      "--ref", "annotated-source", "--name", "tagged", "--min-free-gib", "0", "--json"], env));
    assert.equal(tagged.sourceCommit, commit);
    const database = new DatabaseSync(f.env.PI_WORKSPACE_STATE);
    const plan = database.prepare("EXPLAIN QUERY PLAN SELECT path FROM workspace WHERE root=? AND state='creating'").all(f.workspaces);
    assert.ok(plan.some(row => row.detail.includes("workspace_pending")));
    database.close();
    writeFileSync(path.join(f.source, "next.txt"), "unpushed next HEAD\n");
    git(f.source, "add", ".");
    git(f.source, "commit", "-m", "new local source");
    const next = JSON.parse(run([...create, "--name", "next-head"], env));
    assert.equal(next.sourceCommit, git(f.source, "rev-parse", "HEAD"));
    assert.notEqual(next.sourceCommit, commit);
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

test("systemd discovery keeps multiline command descriptions out of unit operands", () => {
  const workspace = "/srv/workspaces/agent-one";
  const description = `python3 -c '\nroot='${workspace}'\n\nprint(root)\n'`;
  const unitIds = ["worker.service", "session-12.scope", "worker@escaped\\x2dname.service"];
  for (const manager of ["user", "system"]) {
    const calls = [];
    const snapshot = workspaceTesting.systemdManagerSnapshot(manager, (_executable, args) => {
      calls.push(args);
      if (args.includes("list-units")) return {
        status: 0, stderr: "",
        stdout: JSON.stringify(unitIds.map((unit) => ({ unit, description }))),
      };
      assert.deepEqual(args.slice(args.indexOf("--") + 1), unitIds);
      return {
        status: 0, stderr: "",
        stdout: `ExecStart={ path=/usr/bin/python3 ; argv[]=/usr/bin/python3 -c root='${workspace}/data'\\nprint(root) ; }\nWorkingDirectory=/srv\nId=worker.service\nActiveState=active\n\nId=session-12.scope\nActiveState=active\nWorkingDirectory=${workspace}\nExecStart=\n`,
      };
    });
    assert.equal(calls.length, 2);
    assert.equal(calls[0].includes("--output=json"), true);
    assert.equal(calls[0].includes("--user"), manager === "user");
    assert.equal(snapshot.error, undefined);
    const references = workspaceTesting.systemdReferences(workspace, snapshot).references;
    assert.deepEqual(references.map(({ id }) => id), ["worker.service", "session-12.scope"]);
    assert.equal(workspaceTesting.systemdReferences(`${workspace}-unrelated`, snapshot).references.length, 0);
  }
});

test("systemd malformed discovery refuses safety instead of omitting units", () => {
  for (const stdout of ["worker.service loaded active running python3\nroot=42", "{}", "null", "[null]",
    '[{"description":"no unit"}]', '[{"unit":"root=42"}]', '[{"unit":"worker.timer"}]',
    '[{"unit":"worker.service\\nroot=42"}]', '[{"unit":"worker.service"},{"unit":"worker.service"}]']) {
    let calls = 0;
    const snapshot = workspaceTesting.systemdManagerSnapshot("user", () => {
      calls += 1;
      return { status: 0, stderr: "", stdout };
    });
    assert.equal(calls, 1);
    assert.match(snapshot.error, /^systemctl list-units returned /u);
    assert.deepEqual(workspaceTesting.systemdReferences("/srv/workspaces/agent-one", snapshot), {
      references: [], available: true, error: snapshot.error,
    });
  }
  assert.deepEqual(workspaceTesting.systemdManagerSnapshot("system", () => ({
    status: 0, stderr: "", stdout: "[]",
  })), { units: [], available: true });
  for (const phase of ["list-units", "show"]) {
    const snapshot = workspaceTesting.systemdManagerSnapshot("system", (_executable, args) => args.includes(phase)
      ? { status: 1, stderr: "permission denied", stdout: "" }
      : { status: 0, stderr: "", stdout: '[{"unit":"worker.service"}]' });
    assert.equal(snapshot.error, "permission denied");
  }
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
    git(parent.path, "fetch", "origin");
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

for (const grouped of [false, true]) for (const committed of [false, true])
  test(`preserve-runtime skips optional caches for ${committed ? "unpushed" : "dirty"} ${grouped ? "groups" : "individuals"}`, () => {
    const f = fixture();
    try {
      const records = Array.from({ length: grouped ? 2 : 1 }, (_, index) => JSON.parse(run([
        "create", "--root", f.workspaces, "--name", `retained-${index}`, "--repo", f.remote,
        "--mode", "writer", "--lease-seconds", "0", "--min-free-gib", "0",
        ...(grouped ? ["--group", "source-retention"] : []), "--json",
      ], f.env)));
      const workspace = records[0].path;
      writeFileSync(path.join(workspace, "file.txt"), "retained source\n");
      if (committed) {
        git(workspace, "config", "user.name", "Test");
        git(workspace, "config", "user.email", "test@example.invalid");
        git(workspace, "add", "file.txt");
        git(workspace, "commit", "-m", "unpushed source");
      }
      for (const record of records) {
        writeFileSync(path.join(record.path, ".git", "info", "exclude"), "node_modules/\n");
        mkdirSync(path.join(record.path, "node_modules"));
        writeFileSync(path.join(record.path, "node_modules", "kept.js"), "retained cache\n");
      }
      const results = JSON.parse(run(["reconcile", "--root", f.workspaces, "--after", "start",
        "--execute", "--reap-expired", "--preserve-runtime", "--json"], f.env));
      assert.equal(results.length, records.length);
      assert.ok(results.every(result => result.action === "none"));
      assert.match(results.find(result => result.record.path === workspace).inspection.reason,
        committed ? /commits absent from remote refs/ : /working tree has changes/);
      assert.equal(readFileSync(path.join(workspace, "file.txt"), "utf8"), "retained source\n");
      for (const record of records) {
        assert.equal(readFileSync(path.join(record.path, "node_modules", "kept.js"), "utf8"), "retained cache\n");
      }
    } finally { f.close(); }
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

test("clone release excludes durable source ancestry but protects every unpublished new branch", () => {
  const f = fixture();
  try {
    git(f.source, "commit", "--allow-empty", "-m", "local-only source base");
    const sourceCommit = git(f.source, "rev-parse", "HEAD");
    const created = JSON.parse(run([
      "create", "--root", f.workspaces, "--name", "durable-base", "--repo", f.source,
      "--strategy", "clone", "--mode", "writer", "--min-free-gib", "0", "--json",
    ], f.env));
    assert.equal(created.sourceCommit, sourceCommit);
    assert.equal(git(created.path, "remote"), "origin");
    rmSync(f.source, { recursive: true });
    git(created.path, "fetch", "origin");
    assert.equal(git(created.path, "branch", "-r", "--contains", sourceCommit), "");
    git(created.path, "config", "user.name", "Test");
    git(created.path, "config", "user.email", "test@example.invalid");
    git(created.path, "branch", "source-base", sourceCommit);
    writeFileSync(path.join(created.path, "file.txt"), "new writer work\n");
    git(created.path, "commit", "-am", "new writer work");
    const release = () => JSON.parse(run(["release", "--id", created.id, "--json"], f.env));
    const unpushed = release();
    assert.equal(unpushed.inspection.classification, "repair-required");
    assert.match(unpushed.inspection.reason, /refs\/heads\/agent\/durable-base:1/);
    assert.match(unpushed.inspection.reason, /HEAD:1/);
    assert.equal(existsSync(created.path), true);

    // Returning HEAD to the reserved source must not hide a unique sibling branch.
    git(created.path, "checkout", "source-base");
    const sibling = release();
    assert.equal(sibling.inspection.classification, "repair-required");
    assert.match(sibling.inspection.reason, /refs\/heads\/agent\/durable-base:1/);
    assert.equal(existsSync(created.path), true);

    git(created.path, "checkout", "agent/durable-base");
    git(created.path, "rebase", "--onto", "origin/main", sourceCommit);
    assert.equal(release().inspection.classification, "repair-required");
    git(created.path, "push", "origin", "HEAD:refs/heads/published");
    assert.equal(git(created.path, "branch", "-r", "--contains", sourceCommit), "");
    assert.equal(git(created.path, "rev-parse", "source-base"), sourceCommit);
    const published = release();
    assert.equal(published.action, "released");
    assert.match(published.inspection.reason, /remote ref or in durable source ancestry/);
    assert.equal(existsSync(created.path), false);
  } finally { f.close(); }
});

test("keeps a unique detached HEAD even when local branches are remote", () => {
  const f = fixture();
  try {
    const created = JSON.parse(run([
      "create", "--root", f.workspaces, "--name", "detached-work", "--repo", f.remote,
      "--mode", "review", "--min-free-gib", "0", "--json",
    ], f.env));
    git(created.path, "fetch", "origin");
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

test("registration refuses explicit metadata mismatches without changing the retained row", () => {
  const f = fixture();
  try {
    const record = JSON.parse(run(["create", "--root", f.workspaces, "--name", "metadata", "--repo", f.remote,
      "--owner", "original", "--min-free-gib", "0", "--json"], f.env));
    const database = new DatabaseSync(f.env.PI_WORKSPACE_STATE);
    const before = database.prepare("SELECT * FROM workspace WHERE id=?").get(record.id);
    for (const flags of [["--owner", "borrower"], ["--source-commit", "a".repeat(40)], ["--mode", "review"]]) {
      assert.throws(() => run(["register", "--path", record.path, "--cache", "extra", ...flags, "--json"], f.env), error => {
        assert.equal(error.status, 2);
        assert.equal(JSON.parse(error.stdout).error.code, "registration-metadata-mismatch");
        return true;
      });
      assert.deepEqual(database.prepare("SELECT * FROM workspace WHERE id=?").get(record.id), before);
    }
    const same = JSON.parse(run(["register", "--path", record.path, "--owner", record.owner,
      "--source-commit", record.sourceCommit, "--json"], f.env));
    assert.equal(same.owner, record.owner);
    assert.equal(same.leaseExpiresAt, record.leaseExpiresAt);
    database.close();
  } finally { f.close(); }
});

test("reassignment journals responsibility but never grants new deletion custody or changes reservations", () => {
  const f = fixture();
  try {
    const [record, peer] = ["handoff", "peer"].map(name => JSON.parse(run(["create", "--root", f.workspaces,
      "--name", name, "--repo", f.source, "--owner", "author", "--group", "paired", "--intent", "source-only",
      "--headroom-gib", "1", "--growth-mib", "1", "--json"], f.env)));
    git(record.path, "config", "user.name", "Test");
    git(record.path, "config", "user.email", "test@example.invalid");
    writeFileSync(path.join(record.path, "file.txt"), "unpublished author work\n");
    git(record.path, "commit", "-am", "unpublished author work");
    const head = git(record.path, "rev-parse", "HEAD");
    writeFileSync(path.join(record.path, "file.txt"), "borrower edits already in progress\n");
    mkdirSync(path.join(record.path, "ignored-output"));
    writeFileSync(path.join(record.path, "ignored-output", "proof"), "keep\n");
    const database = new DatabaseSync(f.env.PI_WORKSPACE_STATE);
    const before = database.prepare("SELECT * FROM workspace WHERE id=?").get(record.id);
    const capacityBefore = database.prepare("SELECT * FROM workspace_capacity ORDER BY workspace_id").all();
    const peerBefore = database.prepare("SELECT * FROM workspace WHERE id=?").get(peer.id);
    const handoff = ["reassign", "--id", record.id, "--path", record.path, "--from-owner", "author",
      "--from-source-commit", record.sourceCommit, "--from-state", "active", "--owner", "borrower",
      "--source-commit", head, "--authorization", "author ended and both parties approved in receipt 123", "--json"];
    const assigned = JSON.parse(run(handoff, f.env));
    assert.equal(assigned.ok, true);
    assert.equal(assigned.record.owner, "borrower");
    assert.equal(assigned.record.sourceCommit, head);
    assert.equal(assigned.record.durableSourceCommit, record.sourceCommit);
    const after = database.prepare("SELECT * FROM workspace WHERE id=?").get(record.id);
    assert.deepEqual({ ...after, owner: before.owner, updated_at: before.updated_at }, { ...before });
    assert.deepEqual(database.prepare("SELECT * FROM workspace_capacity ORDER BY workspace_id").all(), capacityBefore);
    assert.deepEqual(database.prepare("SELECT * FROM workspace WHERE id=?").get(peer.id), peerBefore);
    const event = database.prepare("SELECT * FROM workspace_reassignment WHERE workspace_id=?").get(record.id);
    assert.equal(event.old_owner, "author");
    assert.equal(event.old_source_commit, record.sourceCommit);
    assert.equal(event.new_owner, "borrower");
    assert.equal(event.new_source_commit, head);
    assert.equal(event.authorization, assigned.transfer.authorization);
    assert.equal(readFileSync(path.join(record.path, "file.txt"), "utf8"), "borrower edits already in progress\n");
    assert.equal(readFileSync(path.join(record.path, "ignored-output", "proof"), "utf8"), "keep\n");
    assert.equal(git(record.path, "rev-parse", "HEAD"), head);
    const status = JSON.parse(run(["status", "--path", record.path, "--json"], f.env)).records[0];
    assert.equal(status.sourceCommit, head);
    assert.equal(status.durableSourceCommit, record.sourceCommit);
    assert.throws(() => run(handoff, f.env), error => JSON.parse(error.stdout).error.code === "owner-mismatch");
    assert.throws(() => run(["register", "--path", record.path, "--source-commit", record.sourceCommit, "--json"], f.env));
    const registered = JSON.parse(run(["register", "--path", record.path, "--owner", "borrower", "--source-commit", head, "--json"], f.env));
    assert.equal(registered.sourceCommit, head);
    const second = JSON.parse(run(["reassign", "--id", record.id, "--path", record.path, "--from-owner", "borrower",
      "--from-source-commit", head, "--from-state", "active", "--owner", "successor", "--source-commit", head,
      "--authorization", "second explicit handoff", "--json"], f.env));
    assert.equal(second.record.durableSourceCommit, record.sourceCommit);
    assert.equal(database.prepare("SELECT count(*) AS n FROM workspace_reassignment").get().n, 2);
    git(record.path, "restore", "file.txt");
    rmSync(path.join(record.path, "ignored-output"), { recursive: true });
    const retained = JSON.parse(run(["release", "--id", record.id, "--json"], f.env));
    assert.equal(retained.find(item => item.record.id === record.id).inspection.classification, "repair-required");
    assert.equal(existsSync(record.path), true);
    database.close();
  } finally { f.close(); }
});

test("reassignment refuses unknown and mismatched writer state without mutation", () => {
  const f = fixture();
  try {
    const record = JSON.parse(run(["create", "--root", f.workspaces, "--name", "refused", "--repo", f.remote,
      "--owner", "author", "--min-free-gib", "0", "--json"], f.env));
    const args = ["reassign", "--id", record.id, "--path", record.path, "--from-owner", "author",
      "--from-source-commit", record.sourceCommit, "--from-state", "active", "--owner", "borrower",
      "--source-commit", record.sourceCommit, "--authorization", "explicit consent receipt", "--json"];
    const database = new DatabaseSync(f.env.PI_WORKSPACE_STATE);
    const check = (change, code) => {
      const before = database.prepare("SELECT * FROM workspace WHERE id=?").get(record.id);
      assert.throws(() => run(change, f.env), error => {
        assert.equal(error.status, 2);
        assert.equal(JSON.parse(error.stdout).error.code, code);
        return true;
      });
      assert.deepEqual(database.prepare("SELECT * FROM workspace WHERE id=?").get(record.id), before);
      assert.equal(database.prepare("SELECT count(*) AS n FROM workspace_reassignment").get().n, 0);
    };
    const flag = (name, value) => { const copy = [...args]; copy[copy.indexOf(name) + 1] = value; return copy; };
    check(flag("--id", "unknown"), "workspace-not-registered");
    check(flag("--path", path.join(f.root, "different")), "path-mismatch");
    check(flag("--from-owner", "other"), "owner-mismatch");
    check(flag("--from-source-commit", "a".repeat(40)), "source-mismatch");
    check(flag("--from-state", "referenced"), "state-mismatch");
    check(flag("--source-commit", "a".repeat(40)), "head-mismatch");
    for (const state of ["creating", "released", "reclaiming", "unknown"]) {
      database.prepare("UPDATE workspace SET state=? WHERE id=?").run(state, record.id);
      check(args, "state-not-reassignable");
    }
    database.prepare("UPDATE workspace SET state='active', mode='review' WHERE id=?").run(record.id);
    check(args, "mode-not-writer");
    database.prepare("UPDATE workspace SET mode='writer' WHERE id=?").run(record.id);
    git(record.path, "checkout", "--detach");
    check(args, "writer-branch-unknown");
    git(record.path, "checkout", "agent/refused");
    git(record.path, "remote", "set-url", "origin", "https://example.invalid/replaced.git");
    check(args, "repository-mismatch");
    git(record.path, "remote", "set-url", "origin", f.remote);
    rmSync(record.path, { recursive: true });
    check(args, "checkout-inspection-failed");
    database.close();
  } finally { f.close(); }
});

test("concurrent reassignment has one winner and preserves unset durable source", async () => {
  const f = fixture();
  try {
    const workspace = path.join(f.root, "registered");
    execFileSync("git", ["clone", f.remote, workspace]);
    const record = JSON.parse(run(["register", "--path", workspace, "--owner", "author", "--json"], f.env));
    const args = ["reassign", "--id", record.id, "--path", workspace, "--from-owner", "author",
      "--from-source-commit", "unset", "--from-state", "active", "--source-commit", git(workspace, "rev-parse", "HEAD"),
      "--authorization", "both parties approved", "--json"];
    const results = await Promise.allSettled(["one", "two"].map(owner => runAsync([...args, "--owner", owner], f.env)));
    assert.equal(results.filter(item => item.status === "fulfilled").length, 1);
    const assigned = JSON.parse(results.find(item => item.status === "fulfilled").value);
    assert.equal(assigned.record.durableSourceCommit, null);
    assert.equal(assigned.transfer.oldSourceCommit, null);
    const rejected = results.find(item => item.status === "rejected").reason;
    assert.match(rejected.message, /owner-mismatch/);
    assert.throws(() => run(args, f.env), error => JSON.parse(error.stdout).error.code === "invalid-request");
    const database = new DatabaseSync(f.env.PI_WORKSPACE_STATE);
    assert.equal(database.prepare("SELECT count(*) AS n FROM workspace_reassignment").get().n, 1);
    assert.equal(database.prepare("SELECT source_commit FROM workspace WHERE id=?").get(record.id).source_commit, null);
    database.close();
  } finally { f.close(); }
});

test("same-path registration refreshes a linked worktree replaced by a shared clone without granting source custody", () => {
  const f = fixture();
  try {
    mkdirSync(f.workspaces, { recursive: true });
    const workspace = path.join(f.workspaces, "replaced");
    const sourceCommit = git(f.source, "rev-parse", "HEAD");
    git(f.source, "worktree", "add", "--detach", workspace, sourceCommit);
    const first = JSON.parse(run(["register", "--path", workspace, "--owner", "original-owner",
      "--source-commit", sourceCommit, "--group", "original-group", "--cache", "generated-one", "--json"], f.env));
    assert.equal(first.checkoutType, "worktree");
    git(f.source, "worktree", "remove", workspace);
    execFileSync("git", ["clone", "--shared", f.source, workspace]);
    git(workspace, "remote", "set-url", "origin", f.remote);
    git(workspace, "config", "user.name", "Test");
    git(workspace, "config", "user.email", "test@example.invalid");
    writeFileSync(path.join(workspace, "file.txt"), "new clone unique work\n");
    git(workspace, "add", "file.txt");
    git(workspace, "commit", "-m", "new clone unique work");
    const head = git(workspace, "rev-parse", "HEAD");
    assert.equal(existsSync(path.join(workspace, ".git", "objects", "info", "alternates")), true);
    const refreshed = JSON.parse(run(["register", "--path", workspace, "--cache", "generated-two", "--json"], f.env));
    assert.equal(refreshed.checkoutType, "clone");
    for (const key of ["id", "owner", "sourceCommit", "groupId", "leaseExpiresAt", "createdAt", "state", "detail"]) {
      assert.equal(refreshed[key], first[key], key);
    }
    assert.equal(refreshed.cachePaths.includes("generated-one"), true);
    assert.equal(refreshed.cachePaths.includes("generated-two"), true);
    assert.equal(git(workspace, "rev-parse", "HEAD"), head);
    const held = JSON.parse(run(["release", "--id", first.id, "--json"], f.env));
    assert.equal(held.inspection.classification, "repair-required");
    assert.equal(existsSync(workspace), true);
    assert.equal(git(workspace, "rev-parse", "HEAD"), head);
  } finally { f.close(); }
});

test("same-path registration refreshes a clone replaced by a worktree and keeps parent branches out of its custody", () => {
  const f = fixture();
  try {
    mkdirSync(f.workspaces, { recursive: true });
    const workspace = path.join(f.workspaces, "replaced");
    const sourceCommit = git(f.source, "rev-parse", "HEAD");
    execFileSync("git", ["clone", f.remote, workspace]);
    const first = JSON.parse(run(["register", "--path", workspace, "--source-commit", sourceCommit, "--json"], f.env));
    assert.equal(first.checkoutType, "clone");
    rmSync(workspace, { recursive: true });
    writeFileSync(path.join(f.source, "file.txt"), "unique parent branch\n");
    git(f.source, "add", "file.txt");
    git(f.source, "commit", "-m", "unique parent branch");
    const parentHead = git(f.source, "rev-parse", "HEAD");
    git(f.source, "worktree", "add", "--detach", workspace, sourceCommit);
    const refreshed = JSON.parse(run(["register", "--path", workspace, "--json"], f.env));
    assert.equal(refreshed.id, first.id);
    assert.equal(refreshed.checkoutType, "worktree");
    assert.equal(refreshed.sourceCommit, sourceCommit);
    assert.equal(git(workspace, "rev-parse", "HEAD"), sourceCommit);
    const released = JSON.parse(run(["release", "--id", first.id, "--json"], f.env));
    assert.equal(released.action, "released");
    assert.equal(existsSync(workspace), false);
    assert.equal(git(f.source, "rev-parse", "HEAD"), parentHead);
  } finally { f.close(); }
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
    const retained = JSON.parse(run(["status", "--path", workspace, "--json"], f.env)).records[0];
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

test("adoption imports mutable object borrowers before releasing their source", () => {
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
    assert.equal(held.action, "released");
    assert.equal(existsSync(source), false);
    assert.equal(git(borrower, "show", "HEAD:file.txt"), "source");

    const borrowerRelease = JSON.parse(run(["release", "--id", borrowerRecord.id, "--json"], f.env));
    assert.equal(borrowerRelease.action, "released");
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

for (const grouped of [false, true]) test(`expired live references require an explicit reap; preserve-runtime retains ${grouped ? "groups" : "individuals"}`, async () => {
  const f = fixture();
  let sleeper;
  try {
    const created = JSON.parse(run([
      "create", "--root", f.workspaces, "--name", "referenced", "--repo", f.remote,
      "--mode", "review", "--lease-seconds", "0", "--min-free-gib", "0", "--json",
      ...(grouped ? ["--group", "live-group"] : []),
    ], f.env));
    if (grouped) run([
      "create", "--root", f.workspaces, "--name", "group-peer", "--repo", f.remote,
      "--group", "live-group", "--lease-seconds", "0", "--min-free-gib", "0", "--json",
    ], f.env);
    sleeper = spawn("sleep", ["60"], { cwd: created.path, stdio: "ignore" });
    await new Promise((resolve) => setTimeout(resolve, 100));
    const exited = new Promise((resolve) => sleeper.once("exit", resolve));
    const liveSafety = { ...f.env, PI_WORKSPACE_TEST_EXTERNAL_SAFETY: "host" };
    const held = JSON.parse(await runAsync(["release", "--id", created.id, "--json"], liveSafety));
    assert.equal((grouped ? held.find(result => result.record.id === created.id) : held).inspection.classification, "referenced");
    assert.equal(existsSync(created.path), true);
    const preserved = JSON.parse(await runAsync(["reconcile", "--root", f.workspaces, "--after", "start", "--execute", "--reap-expired", "--preserve-runtime", "--json"], liveSafety));
    assert.equal(preserved.find(result => result.record.id === created.id).inspection.classification, "referenced");
    assert.equal(preserved.every(result => result.action === "none"), true);
    assert.equal(sleeper.exitCode, null);
    assert.equal(existsSync(created.path), true);
    const released = JSON.parse(await runAsync(["release", "--id", created.id, "--reap-expired", "--preserve-runtime", "--json"], liveSafety));
    assert.equal((grouped ? released.find(result => result.record.id === created.id) : released).inspection.classification, "referenced");
    assert.equal(sleeper.exitCode, null);
    const reaped = JSON.parse(await runAsync(["release", "--id", created.id, "--reap-expired", "--json"], liveSafety));
    assert.equal((grouped ? reaped[0] : reaped).action, grouped ? "released-group" : "released");
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
    const ids = (args, cwd) => JSON.parse(run(["status", ...args, "--json"], f.env, cwd)).records.map(row => row.id);
    assert.deepEqual(ids(["--path", "_%'雪"]), ["three", "one"]);
    assert.deepEqual(ids(["--root", f.workspaces, "--path", "_%'雪"]), ["one"]);
    assert.deepEqual(ids(["--owner", "Owner_%'"]), ["one"]);
    assert.deepEqual(ids(["--owner", "owner"]), []);
    assert.deepEqual(ids(["--path", "Case", "--owner", "other"]), ["three"]);
    assert.deepEqual(ids(["--path", "./Case_%'雪"], f.workspaces), ["one"]);
    assert.match(run(["status", "--root", f.workspaces, "--path", "Case"], f.env), /filtered from 2/);
    assert.match(run(["list", "--path", "missing"], f.env), /4 record\(s\) are known/);
    assert.equal(JSON.parse(run(["status", "--path", "unrelated", "--json"], f.env)).records.length, 1);
  } finally { f.close(); }
});

test("status pages retained history without decoding or serializing oversized lifecycle payloads", () => {
  const f = fixture();
  try {
    run(["status", "--json"], f.env);
    const database = new DatabaseSync(f.env.PI_WORKSPACE_STATE);
    const insert = database.prepare(`INSERT INTO workspace
      (id,path,root,kind,mode,owner,checkout_type,cache_paths,created_at,updated_at,lease_expires_at,state,detail)
      VALUES (?,?,?,'agent','writer','paged-owner','clone',?,1,1,0,'released','retained history')`);
    const payload = JSON.stringify(["generated/" + "x".repeat(65536)]);
    database.exec("BEGIN");
    for (let index = 0; index < 205; index++) insert.run(String(index).padStart(3, "0"), path.join(f.workspaces, String(index).padStart(3, "0")), f.workspaces, payload);
    database.exec("COMMIT");
    const before = database.prepare("SELECT count(*) AS count, sum(length(cache_paths)) AS bytes FROM workspace").get();
    let after = "start";
    const ids = [];
    do {
      const output = run(["list", "--owner", "paged-owner", "--after", after, "--json"], f.env);
      assert.ok(output.length < 100000);
      const page = JSON.parse(output);
      assert.equal(page.matched, 205);
      assert.ok(page.records.length <= 100);
      assert.ok(page.records.every(record => record.cachePaths === undefined && record.cacheDeclarationBytes === payload.length));
      ids.push(...page.records.map(record => record.id));
      after = page.nextAfter;
    } while (after !== null);
    assert.equal(ids.length, 205);
    assert.equal(new Set(ids).size, 205);
    assert.deepEqual(database.prepare("SELECT count(*) AS count, sum(length(cache_paths)) AS bytes FROM workspace").get(), before);
    assert.equal(JSON.parse(run(["status", "--limit", "1", "--path", "000", "--json"], f.env)).records.length, 1);
    assert.throws(() => run(["status", "--limit", "501", "--json"], f.env), /--limit/);
    assert.throws(() => run(["status", "--after", "invalid", "--json"], f.env), /cursor/);
    database.close();
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
      ["reconcile", "--root", f.workspaces, "--execute", "--reap-expired", "--preserve-runtime"],
    ]) {
      const result = JSON.parse(run([...args, "--json"], env));
      assert.deepEqual(args[0] === "reconcile" ? result : result.records, []);
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

for (const mode of ['writer', 'review']) test(`sparse ${mode} creation selects Markdown and requirements without tracked archives`, () => {
  const f = fixture();
  try {
    mkdirSync(path.join(f.source, 'programme'));
    writeFileSync(path.join(f.source, 'programme', 'search.md'), '# search\n');
    writeFileSync(path.join(f.source, 'requirements.txt'), 'numpy\n');
    writeFileSync(path.join(f.source, 'native-custody.tgz'), Buffer.alloc(2 * 1024 * 1024, 37));
    git(f.source, 'add', '.');
    git(f.source, 'commit', '-m', 'sparse selection fixture');
    const args = ['create', '--root', f.workspaces, '--name', 'sparse', '--repo', f.source,
      '--mode', mode, '--sparse-pattern', '*.md', '--sparse-pattern', 'requirements*.txt',
      '--min-free-gib', '0', '--json'];
    const record = JSON.parse(run(args, f.env));
    assert.equal(record.state, 'active');
    assert.equal(readFileSync(path.join(record.path, 'programme', 'search.md'), 'utf8'), '# search\n');
    assert.equal(readFileSync(path.join(record.path, 'requirements.txt'), 'utf8'), 'numpy\n');
    assert.equal(existsSync(path.join(record.path, 'native-custody.tgz')), false);
    assert.equal(existsSync(path.join(record.path, 'file.txt')), false);
    assert.equal(git(record.path, 'status', '--porcelain'), '');
    assert.match(git(record.path, 'ls-files', '-t'), /S native-custody.tgz/);
    assert.equal(git(record.path, 'branch', '--show-current'), mode === 'writer' ? 'agent/sparse' : '');
    assert.equal(JSON.parse(run(args, f.env)).id, record.id);
    assert.throws(() => run([...args, '--sparse-pattern', '*.tgz'], f.env), /different creation request/);
  } finally { f.close(); }
});

test('interrupted sparse creation resumes its reservation and supports clean finalization', () => {
  const f = fixture();
  try {
    writeFileSync(path.join(f.source, 'programme.md'), '# search\n');
    git(f.source, 'add', '.');
    git(f.source, 'commit', '-m', 'markdown');
    const args = ['create', '--root', f.workspaces, '--name', 'sparse-resume', '--repo', f.source,
      '--sparse-pattern', '*.md', '--min-free-gib', '0', '--json'];
    assert.throws(() => run(args, interruptCreation(f, 'checkout')));
    const [pending] = JSON.parse(run(['status', '--json'], f.env)).records;
    assert.equal(pending.state, 'creating');
    const policy = path.join(pending.path, '.git', 'info', 'sparse-checkout');
    writeFileSync(policy, '*.txt\n');
    assert.throws(() => run(args, f.env), /pending sparse selection differs/);
    assert.equal(readFileSync(policy, 'utf8'), '*.txt\n');
    writeFileSync(policy, '*.md\n');
    const record = JSON.parse(run(['finalize-creation', '--id', pending.id, '--json'], f.env));
    assert.equal(record.state, 'active');
    assert.equal(record.id, pending.id);
    assert.equal(existsSync(path.join(record.path, 'file.txt')), false);
    assert.equal(readFileSync(path.join(record.path, 'programme.md'), 'utf8'), '# search\n');
  } finally { f.close(); }
});

for (const pattern of ['', 'true', 'x\ny', 'x\ry']) test(`invalid sparse pattern ${JSON.stringify(pattern)} leaves no reservation`, () => {
  const f = fixture();
  try {
    assert.throws(() => run(['create', '--root', f.workspaces, '--name', 'invalid', '--repo', f.source,
      '--sparse-pattern', pattern, '--min-free-gib', '0'], f.env), /sparse-pattern/);
    assert.deepEqual(JSON.parse(run(['status', '--json'], f.env)).records, []);
  } finally { f.close(); }
});

test('sparse creation rejects linked worktrees without changing mirror configuration', () => {
  const f = fixture();
  try {
    assert.throws(() => run(['create', '--root', f.workspaces, '--name', 'invalid', '--repo', f.source,
      '--strategy', 'worktree', '--sparse-pattern', '*.md', '--min-free-gib', '0'], f.env), /requires --strategy clone/);
    assert.deepEqual(JSON.parse(run(['status', '--json'], f.env)).records, []);
  } finally { f.close(); }
});

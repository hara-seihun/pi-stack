import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const commit = (component, n) => `${component.length.toString(16)}${n.toString(16).padStart(2, "0")}`.padEnd(40, "a");
const tree = (n) => n.toString(16).padStart(2, "0").padEnd(64, "d");

// Ten releases per component, published an hour apart, the second newest
// selected. Runtime release n links dependency tree floor(n / 3).
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "pi-stack-retain-"));
  const repo = join(directory, "repo"), srv = join(directory, "srv");
  const releases = join(srv, ".pi-stack-releases"), dependencies = join(srv, "dependencies");
  mkdirSync(join(repo, "deploy"), { recursive: true });
  for (const name of ["lib", "release-checkout", "retain"]) copyFileSync(join(root, "deploy", name), join(repo, "deploy", name));
  for (const args of [["init", "-q"], ["add", "."], ["-c", "user.name=test", "-c", "user.email=test@example.test", "commit", "-qm", "fixture"]]) {
    assert.equal(spawnSync("git", ["-C", repo, ...args]).status, 0);
  }
  const now = Date.now() / 1000;
  for (let t = 0; t < 4; t++) {
    mkdirSync(join(dependencies, tree(t), "node_modules"), { recursive: true });
    utimesSync(join(dependencies, tree(t)), now - 86400, now - 86400);
  }
  for (const component of ["runtime", "remote", "orchestrator"]) {
    for (let n = 0; n < 10; n++) {
      const release = join(releases, component, commit(component, n));
      mkdirSync(release, { recursive: true });
      writeFileSync(join(release, ".pi-stack-commit"), `${commit(component, n)}\n`);
      if (component === "runtime") symlinkSync(join(dependencies, tree(Math.floor(n / 3)), "node_modules"), join(release, "node_modules"));
      const at = now - 86400 + n * 3600;
      utimesSync(join(release, ".pi-stack-commit"), at, at);
    }
  }
  for (const [link, component] of [["runtime", "runtime"], ["pi-remote", "remote"], ["pi-orchestrator", "orchestrator"]]) {
    symlinkSync(join(releases, component, commit(component, 8)), join(srv, link));
  }
  const ledger = join(directory, "ledger.sqlite3");
  const created = spawnSync("python3", ["-c", `import sqlite3,sys
db=sqlite3.connect(sys.argv[1])
db.execute("CREATE TABLE run (id TEXT, state TEXT, release_path TEXT)")
db.execute("INSERT INTO run VALUES ('a','running',?)", (sys.argv[2],))
db.execute("INSERT INTO run VALUES ('b','done',?)", (sys.argv[3],))
db.commit()`, ledger, join(releases, "orchestrator", commit("orchestrator", 1)), join(releases, "orchestrator", commit("orchestrator", 2))]);
  assert.equal(created.status, 0, String(created.stderr));
  const env = {
    ...process.env, PI_STACK_HOST_LOCK_HELD: "0", PI_STACK_HOST_LOCK_PATH: join(directory, "host.lock"), PI_STACK_DEPLOY_LOCK_HELD: "0",
    PI_STACK_DEPLOY_NO_SUDO: "1", PI_STACK_RUNTIME_DEST: join(srv, "runtime"), PI_STACK_DEPENDENCIES_ROOT: dependencies,
    PI_STACK_RETAIN_GRACE_SECONDS: "0", PI_STACK_RETAIN_LEDGERS: ledger, PI_STACK_RELEASE_KEEP: "2",
  };
  const run = (args = [], extra = {}) => spawnSync(join(repo, "deploy", "retain"), args, { env: { ...env, ...extra }, encoding: "utf8", timeout: 20000 });
  const left = (component) => readdirSync(join(releases, component)).sort();
  return { directory, releases, dependencies, ledger, run, left, close: () => rmSync(directory, { recursive: true, force: true }) };
}

test("retention keeps the selected release, the newest others, and every release still in use", async () => {
  const f = fixture();
  // A long-running process whose working directory is an old Remote release.
  const holder = spawn("sleep", ["30"], { cwd: join(f.releases, "remote", commit("remote", 0)), stdio: "ignore" });
  try {
    await new Promise((settle) => setTimeout(settle, 200));
    const dry = f.run(["--dry-run"]);
    assert.equal(dry.status, 0, dry.stderr);
    assert.equal(f.left("runtime").length, 10, "a dry run removes nothing");

    const result = f.run();
    assert.equal(result.status, 0, result.stderr);
    // Selected (8) plus the two newest others (9, 7).
    assert.deepEqual(f.left("runtime"), [7, 8, 9].map((n) => commit("runtime", n)).sort());
    // Remote release 0 stays while its process runs.
    assert.deepEqual(f.left("remote"), [0, 7, 8, 9].map((n) => commit("remote", n)).sort());
    // An unfinished run's release stays; a finished run's does not.
    assert.deepEqual(f.left("orchestrator"), [1, 7, 8, 9].map((n) => commit("orchestrator", n)).sort());
    // Runtime releases 7-9 link trees 2 and 3; trees 0 and 1 go.
    assert.deepEqual(readdirSync(f.dependencies).sort(), [tree(2), tree(3)]);
    for (const component of ["runtime", "remote", "orchestrator"]) {
      assert.ok(!readdirSync(join(f.releases, component)).some((name) => name.startsWith(".")), "no retired entry is left behind");
    }
  } finally {
    holder.kill();
    f.close();
  }
});

function retiredLedger(f, states) {
  const result = spawnSync('python3', ['-c', `import sqlite3,sys,json
with sqlite3.connect(sys.argv[1]) as db:
    db.execute("DROP TABLE run")
    db.execute("CREATE TABLE run (id INTEGER PRIMARY KEY, state TEXT)")
    db.executemany("INSERT INTO run(state) VALUES (?)", [(s,) for s in json.loads(sys.argv[2])])
    db.execute("CREATE TABLE historical_usage (cost INTEGER)")
    db.execute("INSERT INTO historical_usage VALUES (49)")`, f.ledger, JSON.stringify(states)], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
}

for (const states of [[], ['done']]) test(`retention accepts old-schema ledgers without active work: ${JSON.stringify(states)}`, () => {
  const f = fixture();
  try {
    retiredLedger(f, states);
    const result = f.run();
    assert.equal(result.status, 0, result.stderr);
    assert.equal(f.left('runtime').length, 3);
    const history = spawnSync('python3', ['-c', 'import sqlite3,sys; print(sqlite3.connect(sys.argv[1]).execute("SELECT cost FROM historical_usage").fetchone()[0])', f.ledger], { encoding: 'utf8' });
    assert.equal(history.stdout.trim(), '49');
  } finally { f.close(); }
});

for (const state of ['queued', 'starting', 'running']) test(`retention refuses unresolved old-schema ${state} runs before removing anything`, () => {
  const f = fixture();
  try {
    retiredLedger(f, [state]);
    const result = f.run();
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /unfinished runs have no release_path.*nothing removed/);
    assert.equal(f.left('runtime').length, 10);
    assert.equal(f.left('remote').length, 10);
    assert.equal(f.left('orchestrator').length, 10);
    assert.equal(readdirSync(f.dependencies).length, 4);
  } finally { f.close(); }
});

test("retention refuses to judge releases through an unreadable ledger and leaves another root's dependencies alone", () => {
  const f = fixture();
  try {
    const unreadable = join(f.directory, "broken.sqlite3");
    writeFileSync(unreadable, "not a database");
    const refused = f.run([], { PI_STACK_RETAIN_LEDGERS: unreadable });
    assert.notEqual(refused.status, 0);
    assert.match(refused.stderr, /nothing removed/);
    assert.equal(f.left("runtime").length, 10);

    const elsewhere = join(f.directory, "other-dependencies");
    mkdirSync(join(elsewhere, tree(9)), { recursive: true });
    const redirected = f.run([], { PI_STACK_DEPENDENCIES_ROOT: elsewhere });
    assert.equal(redirected.status, 0, redirected.stderr);
    assert.ok(existsSync(join(elsewhere, tree(9))));
    assert.equal(readdirSync(f.dependencies).length, 4, "the fixture's own trees are not this run's to prune");
    assert.equal(f.left("runtime").length, 3);
  } finally {
    f.close();
  }
});

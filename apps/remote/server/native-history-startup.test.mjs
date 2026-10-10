import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { createServer } from "node:net";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile, rm, lstat, symlink, copyFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { nativeHistoryStartup, startupConfiguration } from "./native-history-startup.mjs";
import { remoteRequiredFiles } from "../../../deploy/remote-resources.mjs";

async function fixture(t, state = "old") {
  const root = await mkdtemp(join(tmpdir(), "history-unlock-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const configPath = join(root, "person.json"), procRoot = join(root, "proc"), native = join(root, "session.jsonl");
  await mkdir(join(procRoot, "net"), { recursive: true });
  await writeFile(join(procRoot, "net/unix"), "Num RefCount Protocol Flags Type St Inode Path\n");
  await writeFile(configPath, JSON.stringify({ version: 1, environment: { PI_REMOTE_DATA: root } }));
  const options = { configPath, environment: {}, procRoot, migratorPath: fileURLToPath(new URL("../../../scripts/migrate-native-history.mjs", import.meta.url)) };
  if (state !== "fresh") {
    const supervisor = new DatabaseSync(join(root, "supervisor.sqlite3"));
    if (state === "old") supervisor.exec("CREATE TABLE session_contexts(session_id TEXT,body TEXT); INSERT INTO session_contexts VALUES('s','captured source')");
    else supervisor.exec("CREATE TABLE metadata(key TEXT PRIMARY KEY,value TEXT); INSERT INTO metadata VALUES('native_history_contract','native-history-v1')");
    supervisor.close();
    const threads = new DatabaseSync(join(root, "threads.sqlite3"));
    threads.exec("CREATE TABLE thread(id TEXT PRIMARY KEY,session_file TEXT,metadata TEXT)");
    threads.prepare("INSERT INTO thread VALUES('s',?,NULL)").run(native);
    threads.close();
    await writeFile(native, '{"type":"session","id":"s","version":3}\n');
  }
  const run = (overrides = {}) => nativeHistoryStartup({ ...options, ...overrides });
  return { root, native, run, options };
}
function sourceRetained(root) {
  const db = new DatabaseSync(join(root, "supervisor.sqlite3"), { readOnly: true });
  try { return db.prepare("SELECT body FROM session_contexts WHERE session_id='s'").get().body === "captured source"; }
  finally { db.close(); }
}
async function writer(f, pid = 123) {
  const directory = join(f.options.procRoot, String(pid));
  await mkdir(directory);
  await writeFile(join(directory, "cmdline"), `node\0/release/runner-host.js\0${f.root}/thread-runners/0123456789abcdef.sock\0`);
  await writeFile(join(directory, "environ"), "");
}

async function control(t, root, status) {
  await mkdir(join(root, "thread-runners"), { recursive: true });
  const path = join(root, "thread-runners/0123456789abcdef.sock");
  const server = createServer(socket => {
    socket.on("error", () => {});
    socket.on("data", data => {
      assert.equal(JSON.parse(String(data)).type, "status");
      socket.end(JSON.stringify(status) + "\n");
    });
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(path, resolve); });
  t.after(() => new Promise(resolve => server.close(resolve)));
}

test("first unlock migrates after positive owner census, preserves captures, and repeated startup does no migration", async t => {
  const f = await fixture(t);
  const first = await f.run();
  assert.equal(first.ok, true, JSON.stringify(first));
  assert.equal(first.value.state, "migrated");
  assert.equal(first.value.readiness, "local-census");
  const snapshot = new DatabaseSync(join(f.root, "native-history-retirement/supervisor.sqlite"), { readOnly: true });
  assert.equal(snapshot.prepare("SELECT body FROM session_contexts").get().body, "captured source");
  snapshot.close();
  const receipt = await readFile(join(f.root, "native-history-retirement/snapshot.json"));
  const second = await f.run();
  assert.deepEqual(second, { ok: true, value: { state: "migrated" } });
  assert.deepEqual(await readFile(join(f.root, "native-history-retirement/snapshot.json")), receipt);
  const fresh = await fixture(t, "fresh");
  assert.deepEqual(await fresh.run(), { ok: true, value: { state: "fresh-owner" } });
  await assert.rejects(lstat(join(fresh.root, "native-history-retirement")), { code: "ENOENT" });
});

test("old writer or unacknowledged retained output refuses with exit75 without modifying source", async t => {
  const f = await fixture(t);
  await writer(f);
  assert.deepEqual((await f.run()).error.code, "writers-active");
  assert.equal((await f.run()).error.exitCode, 75);
  assert.equal(sourceRetained(f.root), true);
  await rm(join(f.options.procRoot, "123"), { recursive: true });
  await mkdir(join(f.root, "thread-sockets"));
  await writeFile(join(f.root, "thread-sockets/0123456789abcdef.0123456789abcdef.sock.events"), '{"type":"output","sequence":1}\n');
  await writeFile(join(f.root, "native-history-readiness.json"), JSON.stringify({ version: 1, contract: "native-history-v1", uid: process.getuid(), dataDir: f.root,
    state: "ready", writersStopped: true, retainedOutput: "acknowledged" }));
  const output = await f.run();
  assert.equal(output.error.code, "retained-output");
  assert.equal(output.error.exitCode, 75);
  assert.equal(sourceRetained(f.root), true);
  await assert.rejects(lstat(join(f.root, "native-history-retirement")), { code: "ENOENT" });
});

test("a migrated schema still refuses an old retained runner, while native protocol keeps normal handoff custody", async t => {
  const old = await fixture(t, "migrated");
  await control(t, old.root, { ok: true, pid: 123 });
  assert.equal((await old.run()).error.code, "writers-active");
  const current = await fixture(t, "migrated");
  await control(t, current.root, { ok: true, pid: 123, historySource: "native-jsonl-v1" });
  await writer(current);
  await mkdir(join(current.root, "thread-sockets"));
  await writeFile(join(current.root, "thread-sockets/0123456789abcdef.0123456789abcdef.sock.events"), "native output awaiting its new controller\n");
  assert.deepEqual(await current.run(), { ok: true, value: { state: "migrated" } });
});

test("missing or corrupt mapped native source delegates preservation and explicit errors to the migrator", async t => {
  for (const missing of [true, false]) {
    const f = await fixture(t);
    if (missing) await rm(f.native);
    else await writeFile(f.native, "{broken-json\n");
    const result = await f.run();
    assert.equal(result.error.code, missing ? "migration-missing-native" : "migration-invalid-jsonl");
    assert.equal(sourceRetained(f.root), true);
    assert.equal((await lstat(join(f.root, "native-history-retirement/supervisor.sqlite"))).isFile(), true);
  }
});

test("only an old producer refusal with exact deployed legacy source can select the bootstrap", async t => {
  const f = await fixture(t);
  const releaseRoot = join(f.root, "candidate"), manifestRoot = join(f.root, "manifests");
  const candidate = "a".repeat(40), legacySource = "b".repeat(40);
  const legacyRemote = join(f.root, "legacy-remote"), legacyOrchestrator = join(f.root, "legacy-orchestrator");
  for (const directory of [releaseRoot, join(manifestRoot, candidate), join(legacyRemote, "server"), join(legacyRemote, "node_modules"), join(legacyOrchestrator, "src")]) {
    await mkdir(directory, { recursive: true, mode: 0o755 });
    await chmod(directory, 0o755);
  }
  await writeFile(join(releaseRoot, ".pi-stack-commit"), candidate);
  for (const root of [legacyRemote, legacyOrchestrator]) await writeFile(join(root, ".pi-stack-commit"), legacySource);
  await writeFile(join(legacyRemote, "server/main.ts"), "export {};\n");
  await writeFile(join(legacyOrchestrator, "src/api.ts"), "export {};\n");
  await symlink(legacyOrchestrator, join(legacyRemote, "node_modules/pi-orchestrator"));
  const bridgeModule = join(f.root, "bridge.mjs");
  await writeFile(bridgeModule, "export {};\n");
  const migrator = join(f.root, "migrator.mjs");
  await copyFile(f.options.migratorPath, migrator);
  const manifest = { version: 1, candidate, legacySource, legacyRemote, legacyOrchestrator, bridgeModule, migrator, node: process.execPath };
  const manifestPath = join(manifestRoot, candidate, "legacy.json");
  await writeFile(manifestPath, JSON.stringify(manifest));
  for (const path of [manifestPath, bridgeModule, migrator, join(legacyRemote, "server/main.ts"), join(legacyOrchestrator, "src/api.ts")]) await chmod(path, 0o644);
  await writer(f);
  const required = await f.run({ releaseRoot, manifestRoot });
  assert.equal(required.error.code, "legacy-required", JSON.stringify(required));
  assert.equal(required.error.exitCode, 76);
  assert.equal(required.error.bootstrap.oldApi, join(legacyRemote, "node_modules/pi-orchestrator/src/api.ts"));
  assert.equal(sourceRetained(f.root), true);
  await writeFile(manifestPath, JSON.stringify({ ...manifest, candidate: "c".repeat(40) }));
  const unbound = await f.run({ releaseRoot, manifestRoot });
  assert.equal(unbound.error.code, "writers-active");
  assert.equal(unbound.error.exitCode, 75);
  await writeFile(manifestPath, JSON.stringify(manifest));
  await rm(join(f.options.procRoot, "123"), { recursive: true });
  await rm(f.native);
  assert.equal((await f.run({ releaseRoot, manifestRoot })).error.code, "migration-missing-native");
});

test("readiness binding and owner/path configuration failures are explicit", async t => {
  const f = await fixture(t);
  await writeFile(join(f.root, "native-history-readiness.json"), JSON.stringify({ version: 1, contract: "native-history-v1", uid: process.getuid(), dataDir: "/different",
    state: "ready", writersStopped: true, retainedOutput: "acknowledged" }));
  assert.equal((await f.run()).error.code, "readiness-receipt");
  assert.equal(sourceRetained(f.root), true);
  for (const value of ["", "relative", 7, "/", `${f.root}/../path`]) {
    assert.equal(startupConfiguration(f.options.configPath, { PI_REMOTE_DATA: value }, process.getuid()).error.code, "configuration");
  }
  const link = join(f.root, "alias");
  await symlink(f.root, link);
  assert.equal(startupConfiguration(f.options.configPath, { PI_REMOTE_DATA: link }, process.getuid()).error.code, "source-ownership");
  assert.equal((await f.run({ uid: process.getuid() + 1 })).error.code, "source-ownership");
});

test("migration time budget yields retryable exit75 and leaves old source intact", async t => {
  const f = await fixture(t);
  const result = await f.run({ migrationTimeoutMs: 1 });
  assert.equal(result.error.code, "migration-timeout");
  assert.equal(result.error.exitCode, 75);
  assert.equal(sourceRetained(f.root), true);
});

test("the namespace launcher migrates before its supervisor command and does not count itself as an old writer", async t => {
  const f = await fixture(t);
  const release = join(f.root, "release");
  for (const directory of ["server", "scripts"]) await mkdir(join(release, directory), { recursive: true });
  for (const name of ["pi-remote-launch", "pi-remote-supervise", "native-history-startup.mjs", "native-history-startup-legacy.mjs"]) {
    await copyFile(fileURLToPath(new URL(name, import.meta.url)), join(release, "server", name));
    await chmod(join(release, "server", name), 0o700);
  }
  await copyFile(f.options.migratorPath, join(release, "scripts/migrate-native-history.mjs"));
  const launched = spawnSync("bash", [join(release, "server/pi-remote-launch"), "/usr/bin/printf", "%s\\n", "/release/server/main.ts"], {
    env: { ...process.env, PI_REMOTE_CONFIG: f.options.configPath, PI_REMOTE_DATA: f.root }, encoding: "utf8", timeout: 5_000,
  });
  assert.equal(launched.status, 0, launched.stderr + launched.stdout);
  const [receipt, command] = launched.stdout.trim().split("\n");
  assert.equal(JSON.parse(receipt).value.state, "migrated");
  assert.equal(command, "/release/server/main.ts");
});

test("the launcher runs the gate and migrator when invoked through a release pointer symlink", async t => {
  // Production runs /srv/pi/pi-remote/server/pi-remote-launch, where /srv/pi/pi-remote
  // points at the sealed release directory. Every entry module must still run.
  const f = await fixture(t);
  const release = join(f.root, "releases", "candidate");
  for (const directory of ["server", "scripts"]) await mkdir(join(release, directory), { recursive: true });
  for (const name of ["pi-remote-launch", "pi-remote-supervise", "native-history-startup.mjs", "native-history-startup-legacy.mjs"]) {
    await copyFile(fileURLToPath(new URL(name, import.meta.url)), join(release, "server", name));
    await chmod(join(release, "server", name), 0o700);
  }
  await copyFile(f.options.migratorPath, join(release, "scripts/migrate-native-history.mjs"));
  const pointer = join(f.root, "pi-remote");
  await symlink(release, pointer);
  const launched = spawnSync("bash", [join(pointer, "server/pi-remote-launch"), "/usr/bin/printf", "%s\\n", "/release/server/main.ts"], {
    env: { ...process.env, PI_REMOTE_CONFIG: f.options.configPath, PI_REMOTE_DATA: f.root }, encoding: "utf8", timeout: 5_000,
  });
  assert.equal(launched.status, 0, launched.stderr + launched.stdout);
  const [receipt, command] = launched.stdout.trim().split("\n");
  assert.equal(JSON.parse(receipt).value.state, "migrated");
  assert.equal(command, "/release/server/main.ts");

  const direct = spawnSync(process.execPath, [join(pointer, "scripts/migrate-native-history.mjs")], { encoding: "utf8", timeout: 5_000 });
  assert.equal(direct.status, 1, "a symlinked migrator invocation must run and report its argument error");
  assert.equal(JSON.parse(direct.stdout.trim()).ok, false);
});

test("Remote's release contains the owner-local gate, migrator and operating instructions", () => {
  for (const path of ["server/native-history-startup.mjs", "server/native-history-startup-legacy.mjs", "scripts/migrate-native-history.mjs", "docs/native-history-migration.md"]) {
    assert.ok(remoteRequiredFiles.includes(path), `Missing required release asset: ${path}`);
  }
});

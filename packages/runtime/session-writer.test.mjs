import { test } from "node:test";
import { AsyncLocalStorage } from "node:async_hooks";
import assert from "node:assert/strict";
import { chownSync, copyFileSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { acquireSessionWriter, requireSessionWriter, sessionWriterConfiguration, withSessionWriterConfiguration, withSessionWriterScope, writeSessionBytes } from "./session-writer.mjs";
import { patchAgentSessionWriterDisposal, patchSessionDurability, patchSessionFactoryWriter, patchSessionRuntimeWriter } from "./patch-session-durability.mjs";

const base = dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent")));
const helper = new URL("./session-writer.mjs", import.meta.url).href;
function directory(t) {
  const dir = mkdtempSync(join(tmpdir(), "pi-writer-"));
  t.after(() => rmSync(dir, { force: true, recursive: true }));
  return dir;
}
async function fixture(t) {
  const dir = directory(t);
  let source = patchSessionDurability(readFileSync(join(base, "core/session-manager.js"), "utf8"));
  for (const specifier of ["../config.js", "../utils/paths.js", "./messages.js"]) {
    source = source.replaceAll(`"${specifier}"`, JSON.stringify(pathToFileURL(resolve(base, "core", specifier)).href));
  }
  const candidate = join(dir, "session-manager.mjs");
  writeFileSync(candidate, source);
  copyFileSync(new URL("./session-writer.mjs", import.meta.url), join(dir, "session-writer.mjs"));
  symlinkSync(resolve("node_modules"), join(dir, "node_modules"));
  const { SessionManager } = await import(pathToFileURL(candidate).href);
  return { SessionManager, dir, candidate, config: { directory: dir, scope: "test-source" } };
}
const user = { role: "user", content: "synthetic user", timestamp: 1 };
const assistant = { role: "assistant", content: [{ type: "text", text: "synthetic response" }], timestamp: 2 };

test("canonical core environment binds writer configuration before manager construction without process-global leakage", async t => {
  const key = Symbol.for("pi-stack.session-environment"), previous = globalThis[key];
  const environment = new AsyncLocalStorage(); globalThis[key] = environment;
  t.after(() => { if (previous === undefined) delete globalThis[key]; else globalThis[key] = previous; });
  const outside = sessionWriterConfiguration();
  const { SessionManager } = await fixture(t);
  const scopes = await Promise.all(["remote:first", "remote:second"].map(scope => environment.run({
    PI_SESSION_WRITER_DIRECTORY: directory(t), PI_SESSION_WRITER_SCOPE: scope,
  }, async () => {
    await Promise.resolve();
    const config = sessionWriterConfiguration();
    const owner = requireSessionWriter(acquireSessionWriter({ ...config, identity: "same-native-id" }));
    requireSessionWriter(owner.release());
    const manager = SessionManager.create(config.directory, config.directory, { id: "same-native-id" });
    manager.appendMessage(user); manager.appendMessage(assistant); manager.dispose();
    return config.scope;
  })));
  assert.deepEqual(scopes, ["remote:first", "remote:second"]);
  assert.deepEqual(sessionWriterConfiguration(), outside);
  environment.run({}, () => {
    assert.equal(acquireSessionWriter({ ...sessionWriterConfiguration(), identity: "known" }).error.code, "SESSION_WRITER_CONFIGURATION");
    withSessionWriterConfiguration({ directory: directory(t), scope: "explicit" }, () => assert.equal(sessionWriterConfiguration().scope, "explicit"));
  });
});

test("explicit physical custody and same-process exclusive ownership", t => {
  assert.equal(acquireSessionWriter({}).error.code, "SESSION_WRITER_CONFIGURATION");
  const config = { directory: directory(t), scope: "remote:test", identity: "session:test" };
  const first = requireSessionWriter(acquireSessionWriter(config));
  assert.equal(acquireSessionWriter(config).error.code, "SESSION_WRITER_BUSY");
  requireSessionWriter(first.release());
  assert.equal(first.assertOwned().error.code, "SESSION_WRITER_RELEASED");
  const second = requireSessionWriter(acquireSessionWriter(config));
  requireSessionWriter(second.release());
});

test("root-created session locks remain usable by their registered directory owner", { skip: process.getuid?.() !== 0 }, t => {
  const dir = directory(t); chownSync(dir, 65534, 65534);
  const owner = requireSessionWriter(acquireSessionWriter({ directory: dir, scope: "registered", identity: "native" }));
  const lock = join(dir, readdirSync(dir)[0]);
  assert.equal(statSync(lock).uid, 65534);
  const probe = () => spawnSync("/usr/bin/setpriv", ["--reuid=65534", "--regid=65534", "--clear-groups", "/usr/bin/flock", "--nonblock", "--conflict-exit-code", "73", lock, "/usr/bin/true"]).status;
  assert.equal(probe(), 73);
  requireSessionWriter(owner.release());
  assert.equal(probe(), 0);
});

test("independent processes share custody and kernel releases crashed owners", { timeout: 3_000 }, async t => {
  const config = { directory: directory(t), scope: "source", identity: "canonical" };
  const child = spawn(process.execPath, ["--input-type=module", "-e", `import { acquireSessionWriter } from ${JSON.stringify(helper)}; const owner = acquireSessionWriter(${JSON.stringify(config)}); if (!owner.ok) process.exit(2); process.stdout.write('owned'); process.stdin.resume();`], { stdio: ["pipe", "pipe", "pipe"] });
  t.after(() => child.kill("SIGKILL"));
  await once(child.stdout, "data");
  assert.equal(acquireSessionWriter(config).error.code, "SESSION_WRITER_BUSY");
  const exited = once(child, "exit");
  child.kill("SIGKILL");
  await exited;
  const owner = requireSessionWriter(acquireSessionWriter(config));
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", `import { acquireSessionWriter } from ${JSON.stringify(helper)}; const r = acquireSessionWriter(${JSON.stringify(config)}); console.log(r.ok ? 'owned' : r.error.code);`], { encoding: "utf8", timeout: 3_000 });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), "SESSION_WRITER_BUSY");
  requireSessionWriter(owner.release());
});

test("complete UTF8 records survive partial writes and EINTR; zero progress fails", () => {
  const chunks = [];
  let interrupt = true, syncs = 0;
  writeSessionBytes(0, '{"text":"α😀"}\n', {
    write(_fd, bytes, offset, length) {
      if (interrupt) { interrupt = false; throw Object.assign(new Error("interrupted"), { code: "EINTR" }); }
      const count = Math.min(3, length);
      chunks.push(Buffer.from(bytes.subarray(offset, offset + count)));
      return count;
    }, sync() { syncs++; },
  });
  assert.equal(Buffer.concat(chunks).toString("utf8"), '{"text":"α😀"}\n');
  assert.equal(syncs, 1);
  assert.throws(() => writeSessionBytes(0, "x", { write: () => 0, sync: () => assert.fail() }), { code: "SESSION_WRITER_SHORT_WRITE" });
});

test("manager lifetime excludes aliases, preserves raw prefixes, and disposes explicitly", async t => {
  const { SessionManager, dir, config } = await fixture(t);
  const manager = withSessionWriterConfiguration(config, () => SessionManager.create(dir, dir, { id: "canonical" }));
  t.after(() => manager.dispose());
  manager.appendMessage(user);
  manager.appendMessage(assistant);
  const file = manager.getSessionFile();
  const original = readFileSync(file);
  const alias = join(dir, "different-fuse-view.jsonl");
  copyFileSync(file, alias);
  assert.throws(() => withSessionWriterConfiguration(config, () => SessionManager.open(alias)), { code: "SESSION_WRITER_BUSY" });
  assert.deepEqual(readFileSync(file), original);
  manager.dispose();
  assert.throws(() => manager.appendMessage(user), { code: "SESSION_WRITER_RELEASED" });
  const resumed = withSessionWriterConfiguration(config, () => SessionManager.open(alias));
  t.after(() => resumed.dispose());
  resumed.appendMessage(user);
  assert.deepEqual(readFileSync(alias).subarray(0, original.length), original);
  assert.equal(resumed.getEntries().length, 3);
});

test("missing scope and unflushed competing manager cannot mutate files", async t => {
  const { SessionManager, dir, config } = await fixture(t);
  assert.throws(() => withSessionWriterConfiguration({ directory: dir }, () => SessionManager.create(dir, dir)), { code: "SESSION_WRITER_CONFIGURATION" });
  const first = withSessionWriterConfiguration(config, () => SessionManager.create(dir, dir, { id: "pending" }));
  t.after(() => first.dispose());
  first.appendMessage(user);
  assert.throws(() => withSessionWriterConfiguration(config, () => SessionManager.create(dir, dir, { id: "pending" })), { code: "SESSION_WRITER_BUSY" });
  first.dispose();
  const second = withSessionWriterConfiguration(config, () => SessionManager.create(dir, dir, { id: "pending" }));
  second.dispose();
});

test("strict resume rejects closed malformed lines, partial tails and missing tree parents without rewrite", async t => {
  const { SessionManager, dir, config } = await fixture(t);
  const header = { type: "session", version: 3, id: "invalid", cwd: dir, timestamp: new Date().toISOString() };
  const entry = { type: "message", id: "child", parentId: null, message: user };
  const variants = [
    [JSON.stringify(header) + '\n{"lost":\n' + JSON.stringify(entry) + '\n', "SESSION_WRITER_FRAGMENT"],
    [JSON.stringify(header) + '\n{"partial":', "SESSION_WRITER_FRAGMENT"],
    [[header, { ...entry, parentId: "missing" }].map(JSON.stringify).join('\n') + '\n', "SESSION_WRITER_GRAPH"],
  ];
  const file = join(dir, "invalid.jsonl");
  for (const [raw, code] of variants) {
    writeFileSync(file, raw);
    assert.throws(() => withSessionWriterConfiguration(config, () => SessionManager.open(file)), { code });
    assert.equal(readFileSync(file, "utf8"), raw);
  }
  writeFileSync(file, [header, entry].map(JSON.stringify).join('\n') + '\n');
  const owner = withSessionWriterConfiguration(config, () => SessionManager.open(file));
  owner.dispose();
});

test("an append-boundary failure preserves bytes and poisons the held writer", async t => {
  const { SessionManager, dir, config } = await fixture(t);
  const manager = withSessionWriterConfiguration(config, () => SessionManager.create(dir, dir));
  t.after(() => manager.dispose());
  manager.appendMessage(user); manager.appendMessage(assistant);
  const file = manager.getSessionFile();
  const count = manager.getEntries().length;
  writeFileSync(file, '{"fragment":', { flag: "a" });
  const damaged = readFileSync(file);
  assert.throws(() => manager.appendMessage(user), { code: "SESSION_WRITER_FRAGMENT" });
  assert.equal(manager.getEntries().length, count);
  assert.deepEqual(readFileSync(file), damaged);
  assert.throws(() => manager.appendMessage(user), { code: "SESSION_WRITER_POISONED" });
  assert.throws(() => withSessionWriterConfiguration(config, () => SessionManager.open(file)), { code: "SESSION_WRITER_BUSY" });
});

test("branch managers own only their new history; original remains exclusively owned", async t => {
  const { SessionManager, dir, config } = await fixture(t);
  const first = withSessionWriterConfiguration(config, () => SessionManager.create(dir, dir));
  t.after(() => first.dispose());
  const leaf = first.appendMessage(user);
  first.appendMessage(assistant);
  const raw = readFileSync(first.getSessionFile());
  const branch = SessionManager.branchFrom(first, leaf);
  t.after(() => branch.dispose());
  branch.appendMessage(assistant);
  assert.notEqual(branch.getSessionFile(), first.getSessionFile());
  assert.deepEqual(readFileSync(first.getSessionFile()), raw);
  assert.throws(() => withSessionWriterConfiguration(config, () => SessionManager.open(first.getSessionFile())), { code: "SESSION_WRITER_BUSY" });
  assert.equal(branch.getHeader().parentSession, first.getSessionFile());
});

test("SDK disposal and runtime replacement patches are idempotent and syntactically valid", t => {
  const dir = directory(t);
  for (const [name, patch] of [["agent-session", patchAgentSessionWriterDisposal], ["agent-session-runtime", patchSessionRuntimeWriter], ["sdk", patchSessionFactoryWriter]]) {
    const source = patch(readFileSync(join(base, `core/${name}.js`), "utf8"));
    assert.equal(patch(source), source);
    const file = join(dir, `${name}.mjs`);
    writeFileSync(file, source);
    const result = spawnSync(process.execPath, ["--check", file], { encoding: "utf8", timeout: 3_000 });
    assert.equal(result.status, 0, result.stderr);
  }
});


test("failed construction scopes release candidates and imports transfer exact-byte custody", async t => {
  const { SessionManager, dir, config } = await fixture(t);
  await assert.rejects(withSessionWriterConfiguration(config, () => withSessionWriterScope(async () => {
    SessionManager.create(dir, dir, { id: "failed-candidate" });
    throw new Error("failed factory");
  }, () => false)), /failed factory/);
  const recovered = withSessionWriterConfiguration(config, () => SessionManager.create(dir, dir, { id: "failed-candidate" }));
  recovered.dispose();
  const original = withSessionWriterConfiguration(config, () => SessionManager.create(dir, dir, { id: "imported" }));
  original.appendMessage(user);
  original.appendMessage(assistant);
  const source = original.getSessionFile(), raw = readFileSync(source);
  const destination = join(dir, "imported-view.jsonl");
  assert.throws(() => withSessionWriterConfiguration(config, () => SessionManager.importFile(source, destination, dir)), { code: "SESSION_WRITER_BUSY" });
  original.dispose();
  const imported = withSessionWriterConfiguration(config, () => SessionManager.importFile(source, destination, dir));
  t.after(() => imported.dispose());
  assert.equal(imported.getSessionFile(), destination);
  assert.deepEqual(readFileSync(destination), raw);
  assert.throws(() => withSessionWriterConfiguration(config, () => SessionManager.open(source)), { code: "SESSION_WRITER_BUSY" });
});

test("native runtime replacement retains injected config and releases failed candidates", async t => {
  const { SessionManager, dir, candidate, config } = await fixture(t);
  let source = patchSessionRuntimeWriter(readFileSync(join(base, "core/agent-session-runtime.js"), "utf8"));
  source = source.replaceAll('"./session-manager.js"', JSON.stringify(pathToFileURL(candidate).href));
  for (const specifier of ["../utils/paths.js", "./extensions/runner.js", "./session-cwd.js", "./agent-session-services.js"]) {
    source = source.replaceAll(JSON.stringify(specifier), JSON.stringify(pathToFileURL(resolve(base, "core", specifier)).href));
  }
  const path = join(dir, "runtime.mjs");
  writeFileSync(path, source);
  const { AgentSessionRuntime } = await import(pathToFileURL(path).href);
  const fake = manager => ({ sessionManager: manager, get sessionFile() { return manager.getSessionFile(); },
    extensionRunner: { hasHandlers: () => false }, abort: async () => {}, dispose: () => manager.dispose() });
  const initial = withSessionWriterConfiguration(config, () => SessionManager.create(dir, dir));
  initial.appendMessage(user); initial.appendMessage(assistant);
  const services = { cwd: dir, agentDir: dir };
  let failFactory = false, candidateFile;
  const runtime = new AgentSessionRuntime(fake(initial), services, async options => {
    candidateFile = options.sessionManager.getSessionFile();
    if (failFactory) throw new Error("candidate rejected");
    return { session: fake(options.sessionManager), services, diagnostics: [] };
  });
  await runtime.switchSession(initial.getSessionFile());
  assert.notEqual(runtime.session.sessionManager, initial);
  assert.throws(() => initial.appendMessage(user), { code: "SESSION_WRITER_RELEASED" });
  await runtime.newSession();
  runtime.session.sessionManager.appendMessage(user); runtime.session.sessionManager.appendMessage(assistant);
  const leaf = runtime.session.sessionManager.getLeafId();
  await runtime.fork(leaf, { position: "at" });
  failFactory = true;
  await assert.rejects(runtime.newSession(), /candidate rejected/);
  const next = withSessionWriterConfiguration(config, () => SessionManager.open(candidateFile));
  next.dispose();
});

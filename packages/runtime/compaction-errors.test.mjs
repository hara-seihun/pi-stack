import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, mkdtempSync, mkdirSync, copyFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { patchCompactionErrors, patchContextErrors, patchCompactionErrorCopies } from "./patch-compaction-errors.mjs";

const base = dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent")));
const chunks = join(base, "bundle/chunks");
const paths = [join(base, "core/agent-session.js"), ...readdirSync(chunks).filter(name => name.endsWith(".js")).map(name => join(chunks, name)).filter(path => readFileSync(path, "utf8").includes("async _runAutoCompaction("))];
assert.equal(paths.length, 2);
for (const path of paths) test(`native failures reach Pi lifecycle and stop continuation in ${path.includes("chunks") ? "bundled CLI" : "SDK"}`, async () => {
  const source = patchCompactionErrors(readFileSync(path, "utf8"));
  assert.equal(patchCompactionErrors(source), source);
  const start = source.indexOf("async _runAutoCompaction(");
  const end = source.indexOf("setAutoCompactionEnabled(", start);
  const prepare = () => ({});
  const method = new Function("prepareCompaction", "prepareCompaction2", `return class { ${source.slice(start, end)} };`)(prepare, prepare).prototype._runAutoCompaction;
  const events = [], failures = [], assistantFailures = [];
  let aborted = 0;
  const session = {
    model: {}, settingsManager: { getCompactionSettings: () => ({}) },
    _getSummarizationRequestAuth: async () => ({}), sessionManager: { getBranch: () => [] },
    _emit: event => events.push(event), _emitSessionCompactFailed: async event => failures.push(event),
    _extensionRunner: { hasHandlers: () => true, emit: async () => ({ cancel: true, error: "native idle-timeout" }) },
    agent: { abort() { aborted++; }, async processEvents() {}, async runWithLifecycle(executor) { try { await executor(); } catch (error) { assistantFailures.push({ error, cancelled: false }); } } }, _resolveIdleWaitIfIdle() {},
  };
  assert.equal(await method.call(session, "threshold", false), false);
  assert.equal(aborted, 0, "provider failures must not cancel the agent");
  assert.match(assistantFailures[0].error.message, /native idle-timeout/);
  assert.equal(assistantFailures[0].cancelled, false);
  assert.equal(events.at(-1).aborted, false);
  assert.match(events.at(-1).errorMessage, /native idle-timeout/);
  assert.equal(failures[0].fromExtension, true);
  assert.equal(session._autoCompactionAbortController, undefined);
  await assert.rejects(method.call(session, "threshold", false, true), /native idle-timeout/);
  assert.equal(session._autoCompactionAbortController, undefined);
  assert.equal(aborted, 0);
  session._extensionRunner.emit = async () => ({ cancel: true });
  assert.equal(await method.call(session, "threshold", false, true), false);
  assert.equal(events.at(-1).aborted, true, "operator cancellation stays cancellation");
});

const runnerPaths = [join(base, "core/extensions/runner.js"), ...readdirSync(chunks).filter(name => name.endsWith(".js")).map(name => join(chunks, name)).filter(path => readFileSync(path, "utf8").includes("async emitContext(messages)"))];
assert.equal(runnerPaths.length, 2);
test("deployment patches both consumers and declares context rejection without mutating installed dependencies", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-compaction-patch-"));
  const target = join(root, "@earendil-works/pi-coding-agent/dist");
  try {
    for (const path of new Set([...paths, ...runnerPaths, join(base, "core/extensions/types.d.ts")])) {
      const destination = join(target, relative(base, path));
      mkdirSync(dirname(destination), { recursive: true });
      copyFileSync(path, destination);
    }
    patchCompactionErrorCopies(root);
    patchCompactionErrorCopies(root);
    for (const path of paths) assert.match(readFileSync(join(target, relative(base, path)), "utf8"), /Pi Stack compaction failure propagation/);
    for (const path of runnerPaths) assert.match(readFileSync(join(target, relative(base, path)), "utf8"), /Pi Stack context rejection result/);
    assert.match(readFileSync(join(target, "core/extensions/types.d.ts"), "utf8"), /interface ContextEventResult \{\n    error\?: string;/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
for (const path of runnerPaths) test(`context rejection stops the request without swallowing its cause in ${path.includes("chunks") ? "bundled CLI" : "SDK"}`, async () => {
  const source = patchContextErrors(readFileSync(path, "utf8"));
  assert.equal(patchContextErrors(source), source);
  const start = source.indexOf("async emitContext(messages) {");
  const end = source.indexOf("async emitBeforeProviderRequest(", start);
  const method = new Function(`return class { ${source.slice(start, end)} };`)().prototype.emitContext;
  let reached = 0;
  const errors = [];
  const runner = { createContext: () => ({}), emitError: e => errors.push(e), extensions: [{ handlers: new Map([["context", [() => ({ error: "Native compaction failed: fetch failed" }), () => { reached++; }]]]) }] };
  await assert.rejects(method.call(runner, []), /Context rejected: Native compaction failed: fetch failed/);
  assert.equal(reached, 0);
  assert.deepEqual(errors, []);
});

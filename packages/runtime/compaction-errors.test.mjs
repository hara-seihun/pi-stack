import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { patchCompactionErrors } from "./patch-compaction-errors.mjs";

const base = dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent")));
const chunks = join(base, "bundle/chunks");
const paths = [join(base, "core/agent-session.js"), ...readdirSync(chunks).filter(name => name.endsWith(".js")).map(name => join(chunks, name)).filter(path => readFileSync(path, "utf8").includes("async _runAutoCompaction("))];
assert.equal(paths.length, 2);
for (const path of paths) test(`native failures reach Pi lifecycle and stop continuation in ${path.includes("chunks") ? "bundled CLI" : "SDK"}`, async () => {
  const source = patchCompactionErrors(readFileSync(path, "utf8"));
  assert.equal(patchCompactionErrors(source), source);
  const start = source.indexOf("async _runAutoCompaction(");
  const end = source.indexOf("setAutoCompactionEnabled(", start);
  const method = new Function("prepareCompaction", `return class { ${source.slice(start, end)} };`)(() => ({})).prototype._runAutoCompaction;
  const events = [], failures = [];
  let aborted = 0;
  const session = {
    model: {}, settingsManager: { getCompactionSettings: () => ({}) },
    _getSummarizationRequestAuth: async () => ({}), sessionManager: { getBranch: () => [] },
    _emit: event => events.push(event), _emitSessionCompactFailed: async event => failures.push(event),
    _extensionRunner: { hasHandlers: () => true, emit: async () => ({ cancel: true, error: "native idle-timeout" }) },
    agent: { abort() { aborted++; } }, _resolveIdleWaitIfIdle() {},
  };
  assert.equal(await method.call(session, "threshold", false), false);
  assert.equal(aborted, 1);
  assert.equal(events.at(-1).aborted, false);
  assert.match(events.at(-1).errorMessage, /native idle-timeout/);
  assert.equal(failures[0].fromExtension, true);
  assert.equal(session._autoCompactionAbortController, undefined);
});

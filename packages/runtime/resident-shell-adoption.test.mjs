import assert from "node:assert/strict";
import { test } from "node:test";
import { adoptResidentLocalShells, residentShellProtocol as protocol, shellFunctionHash as hash } from "./resident-shell-adoption.mjs";

function candidate(shellName, resolveShellConfig) {
  return { exec: async (...args) => ({ shellName, config: resolveShellConfig(), args }) };
}
function plan(entries, factory = candidate) { return { protocol, entries, factory, factorySha256: hash(factory) }; }
function entry(id, operations) { return { kind: "local-shell", id, operations, shellName: "bash", resolveShellConfig: () => ({ shell: "/original/bash", args: ["--original"] }), expectedExecSha256: hash(operations.exec) }; }

test("all-before-any refusal leaves every retained operation untouched", () => {
  const a = { exec: async () => "a" }, b = { exec: async () => "b" };
  const originalA = a.exec, originalB = b.exec;
  const first = entry("a", a), second = entry("b", b);
  second.expectedExecSha256 = "0".repeat(64);
  assert.equal(adoptResidentLocalShells(plan([first, second])).error.code, "predecessor-conflict");
  assert.equal(a.exec, originalA); assert.equal(b.exec, originalB);
  assert.equal(adoptResidentLocalShells(plan([first, first])).error.code, "invalid-target");
  assert.equal(a.exec, originalA);
});

test("preserves original shell binding, wrapper, context and active execution owner", async () => {
  let finish, cancelled = false;
  const local = { exec: async (_command, _cwd, options) => new Promise(resolve => {
    finish = resolve; options.signal.addEventListener("abort", () => { cancelled = true; resolve("old-owner-aborted"); }, { once: true });
  }) };
  const session = { history: [], operations: local };
  const history = session.history, oldExec = local.exec;
  const wrapper = (...args) => session.operations.exec(...args);
  const controller = new AbortController();
  const active = wrapper("old", "/original/cwd", { signal: controller.signal });
  const binding = entry("resident", local);
  const resolver = binding.resolveShellConfig;
  const result = adoptResidentLocalShells(plan([binding]));
  assert.equal(result.ok, true);
  assert.equal(session.operations, local); assert.equal(session.history, history);
  assert.notEqual(local.exec, oldExec);
  controller.abort();
  assert.equal(await active, "old-owner-aborted"); assert.equal(cancelled, true);
  const next = await wrapper("new", "/original/cwd", { env: { ORIGINAL: "env" } });
  assert.deepEqual(next.config, resolver()); assert.equal(next.args[1], "/original/cwd");
  assert.equal(next.args[2].env.ORIGINAL, "env");
  assert.equal(typeof finish, "function");
});

test("rejects unset identity, proxies, frozen exec and unknown worker route", () => {
  const local = { exec: async () => {} }, e = entry("resident", local);
  assert.equal(adoptResidentLocalShells({ ...plan([e]), factorySha256: "0".repeat(64) }).error.code, "candidate-mismatch");
  assert.equal(adoptResidentLocalShells(plan([{ ...e, resolveShellConfig: undefined }])).error.code, "invalid-plan");
  assert.equal(adoptResidentLocalShells(plan([{ ...e, operations: new Proxy(local, {}) }])).error.code, "invalid-target");
  assert.equal(adoptResidentLocalShells(plan([{ ...e, kind: "bash-worker" }])).error.code, "invalid-plan");
  Object.freeze(local);
  assert.equal(adoptResidentLocalShells(plan([e])).error.code, "predecessor-conflict");
});

test("a candidate that changes the predecessor during preflight cannot overwrite it", () => {
  const local = { exec: async () => "original" }, e = entry("resident", local);
  const concurrent = async () => "concurrent";
  const changing = () => { local.exec = concurrent; return { exec: async () => "candidate" }; };
  assert.equal(adoptResidentLocalShells(plan([e], changing)).error.code, "predecessor-conflict");
  assert.equal(local.exec, concurrent);
});

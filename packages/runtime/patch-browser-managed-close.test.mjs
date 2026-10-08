import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { patchBrowserManagedClose, managedCloseTarget } from "./patch-browser-managed-close.mjs";

const upstream = new URL("./fixtures/browser-managed-daemon-policy-0.6.6.js", import.meta.url);
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "browser-managed-close-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(dirname(join(root, managedCloseTarget)), { recursive: true });
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "pi-agent-browser-native", version: "0.6.6" }));
  cpSync(upstream, join(root, managedCloseTarget));
  return root;
}

function restoreState() {
  const keys = new Map([["managed", "saved-key"], ["other", "other-key"]]);
  const disabled = new Set(["managed", "other"]);
  return {
    keys, disabled,
    getDaemonRestoreKey: name => keys.get(name),
    hasDaemonRestoreKey: name => keys.has(name),
    forgetDaemonRestoreKey: name => keys.delete(name),
    recordDaemonRestoreKey: (name, _namespace, key) => keys.set(name, key),
    isDisabled: name => disabled.has(name),
    clear: name => { keys.delete(name); disabled.delete(name); },
  };
}

// Run the authentic pinned compiled module with controllable process/lock boundaries.
function load(root, options = {}) {
  const calls = [];
  let released = 0;
  const pruned = [];
  const removed = [];
  const waits = [];
  let now = 0;
  let infoAttempt = 0;
  const lock = { release: async () => { released++; } };
  const deps = {
    rm: async path => { removed.push(path); },
    performance: { now: () => now },
    delay: async (ms, _value, { signal }) => {
      waits.push(ms);
      now += ms;
      options.onDelay?.();
      if (signal?.aborted) throw signal.reason;
    },
    acquireManagedSessionPolicyLock: async () => options.noLock ? undefined : lock,
    pruneOwnedManagedSessionRestoreSnapshots: args => pruned.push(args),
    resolveExplicitAutosaveInterval: value => value,
    isManagedSessionRestoreKey: value => typeof value === "string",
    isRecord: value => value !== null && typeof value === "object" && !Array.isArray(value),
    getAgentBrowserProcessEnvironment: () => ({}),
    runAgentBrowserProcess: async args => {
      calls.push(args);
      if (args.args.includes("info")) {
        options.onInfo?.();
        if (options.infoResults) {
          const result = options.infoResults[Math.min(infoAttempt++, options.infoResults.length - 1)];
          return { aborted: false, exitCode: 0, stderr: "", ...result };
        }
        if (options.unknownInfo) return { aborted: false, exitCode: 1, stdout: "", stderr: "busy" };
        throw new Error("session info cannot be dispatched during close");
      }
      return {
        aborted: false, exitCode: 0, stderr: "", timeoutMs: 500,
        stdout: JSON.stringify({ success: true, data: { closed: true } }),
        ...options.processResult,
      };
    },
    parseAgentBrowserEnvelope: async ({ stdout }) => {
      try { return { envelope: JSON.parse(stdout) }; }
      catch { return { parseError: "invalid JSON" }; }
    },
    getAgentBrowserErrorText: args => {
      if (args.aborted) return "aborted";
      if (args.spawnError) return args.spawnError.message;
      if (args.parseError) return args.parseError;
      if (args.envelope?.success === false) return args.envelope.error ?? "failed";
      if (args.exitCode !== 0) return "failed exit";
      return undefined;
    },
    redactInvocationArgs: args => args,
  };
  const source = readFileSync(join(root, managedCloseTarget), "utf8")
    .replace(/^import .*;\n/gm, "")
    .replace(/^export /gm, "");
  const api = new Function(...Object.keys(deps), `${source}\nreturn { acquireOwnedManagedSessionDaemonPolicy, closeManagedSession, inspectManagedSessionDaemon };`)(...Object.values(deps));
  return { api, calls, lock, pruned, removed, waits, now: () => now, released: () => released };
}

function prepared(t, options) {
  const root = fixture(t);
  patchBrowserManagedClose(root);
  return load(root, options);
}

test("patch is pinned, reproducible and idempotent", t => {
  const root = fixture(t);
  const original = readFileSync(join(root, managedCloseTarget), "utf8");
  patchBrowserManagedClose(root);
  const patched = readFileSync(join(root, managedCloseTarget), "utf8");
  assert.notEqual(patched, original);
  patchBrowserManagedClose(root);
  assert.equal(readFileSync(join(root, managedCloseTarget), "utf8"), patched);
  cpSync(new URL("./fixtures/browser-managed-daemon-policy-close-934de44.js", import.meta.url), join(root, managedCloseTarget));
  patchBrowserManagedClose(root);
  assert.equal(readFileSync(join(root, managedCloseTarget), "utf8"), patched);
  writeFileSync(join(root, managedCloseTarget), original + "\n");
  assert.throws(() => patchBrowserManagedClose(root), /differs from pinned/);
  assert.equal(readFileSync(join(root, managedCloseTarget), "utf8"), original + "\n");
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "pi-agent-browser-native", version: "0.9.3" }));
  assert.throws(() => patchBrowserManagedClose(root), /Unsupported native browser/);
});

test("explicit close acquires policy ownership without daemon info", async t => {
  const h = prepared(t);
  const state = restoreState();
  const result = await h.api.acquireOwnedManagedSessionDaemonPolicy({
    context: { cwd: "/fixture", sessionName: "managed", restoreState: state }, mode: "close",
  });
  assert.equal(result.lock, h.lock);
  assert.equal(result.error, undefined);
  assert.equal(h.calls.length, 0);
  assert.equal(state.keys.get("managed"), "saved-key");
  await result.lock.release();
  assert.equal(h.released(), 1);
});

test("reuse still refuses an unverifiable daemon", async t => {
  const h = prepared(t, { unknownInfo: true });
  const result = await h.api.acquireOwnedManagedSessionDaemonPolicy({
    context: { cwd: "/fixture", sessionName: "managed", restoreState: restoreState() }, mode: "reuse",
  });
  assert.match(result.error, /could not verify.*restore policy/);
  assert.equal(h.calls.length, 1);
  assert.ok(h.calls[0].args.includes("info"));
  await result.lock.release();
});

test("replacement/shutdown close dispatches native close only and retains attached-browser mode", async t => {
  const h = prepared(t);
  const state = restoreState();
  const error = await h.api.closeManagedSession({
    cwd: "/fixture", sessionName: "managed", namespace: "work", restoreState: state,
    timeoutMs: 500, preserveAttachedBrowserSession: true,
  });
  assert.equal(error, undefined);
  assert.equal(h.calls.length, 1);
  assert.deepEqual(h.calls[0].args, ["--namespace", "work", "--session", "managed", "close"]);
  assert.equal(h.calls[0].preserveAttachedBrowserSession, true);
  assert.equal(state.keys.has("managed"), false);
  assert.equal(state.disabled.has("managed"), false);
  assert.equal(state.keys.get("other"), "other-key");
  assert.equal(state.disabled.has("other"), true);
  assert.equal(h.released(), 1);
  assert.equal(h.pruned.length, 1);
});

for (const [name, processResult] of [
  ["native failure with exit zero", { stdout: '{"success":false,"error":"CDP disconnected"}' }],
  ["explicit closed false", { stdout: '{"success":true,"data":{"closed":false}}' }],
  ["confirmation pending", { stdout: '{"success":true,"data":{"confirmation_required":true,"confirmation_id":"pending-close"}}' }],
  ["malformed output", { stdout: "not JSON" }],
  ["aborted operation", { aborted: true }],
  ["nonzero exit", { exitCode: 1 }],
]) {
  test(`cleanup retains ownership after ${name}`, async t => {
    const h = prepared(t, { processResult });
    const state = restoreState();
    const error = await h.api.closeManagedSession({ cwd: "/fixture", sessionName: "managed", restoreState: state, timeoutMs: 500 });
    assert.ok(error);
    assert.equal(state.keys.get("managed"), "saved-key");
    assert.equal(state.disabled.has("managed"), true);
    assert.equal(h.pruned.length, 0);
    assert.equal(h.released(), 1);
  });
}

test("caller-owned lock survives close; unavailable coordination never runs cleanup", async t => {
  const h = prepared(t);
  assert.equal(await h.api.closeManagedSession({ cwd: "/fixture", sessionName: "managed", restoreState: restoreState(), timeoutMs: 500, policyLock: h.lock }), undefined);
  assert.equal(h.released(), 0);
  const unavailable = prepared(t, { noLock: true });
  assert.match(await unavailable.api.closeManagedSession({ cwd: "/fixture", sessionName: "managed", restoreState: restoreState(), timeoutMs: 500 }), /coordination is unavailable/);
  assert.equal(unavailable.calls.length, 0);
});

const nativeBusy = { exitCode: 1, stdout: JSON.stringify({ success: false, code: "daemon_busy", error: "Operation owns daemon state" }) };
const matchingPolicy = { stdout: JSON.stringify({ success: true, data: { active: true, runtime: { restoreKey: "saved-key" } } }) };
function policyRequest(state = restoreState(), signal) {
  return {
    context: { cwd: "/fixture", sessionName: "managed", restoreState: state, restoreDecision: "enabled", expectedDaemonRestoreKey: "saved-key" },
    mode: "reuse", signal,
  };
}

test("typed busy retries metadata only, cleans spill before retry, and accepts fresh matching policy", async t => {
  for (const exitCode of [0, 1]) {
    const state = restoreState();
    const h = prepared(t, {
      infoResults: [{ ...nativeBusy, exitCode, stdoutSpillPath: "/fixture/busy-spill" }, matchingPolicy],
      onDelay: () => assert.deepEqual(h.removed, ["/fixture/busy-spill"]),
    });
    const result = await h.api.acquireOwnedManagedSessionDaemonPolicy(policyRequest(state));
    assert.equal(result.error, undefined);
    assert.equal(result.daemonStatus, "active");
    assert.equal(result.lock, h.lock);
    assert.equal(h.calls.length, 2);
    assert.ok(h.calls.every(call => call.args.at(-1) === "info"));
    assert.equal(h.calls[1].timeoutMs, 950);
    assert.deepEqual(h.removed, ["/fixture/busy-spill"]);
    assert.deepEqual(h.waits, [50]);
    await result.lock.release();
    assert.equal(h.released(), 1);
  }
});

test("persistent native busy exhausts a local deadline and refuses without abandoning either owner", async t => {
  const state = restoreState();
  const h = prepared(t, { infoResults: [{ ...nativeBusy, stdoutSpillPath: "/fixture/busy-spill" }] });
  const result = await h.api.acquireOwnedManagedSessionDaemonPolicy(policyRequest(state));
  assert.equal(result.daemonStatus, "busy");
  assert.match(result.error, /daemon is busy.*still owns.*bounded retry.*no command was dispatched/i);
  assert.equal(result.lock, h.lock);
  assert.equal(h.released(), 0);
  assert.equal(h.now(), 1_000);
  assert.equal(h.calls.length, 20);
  assert.ok(h.calls.every(call => call.args.at(-1) === "info"));
  assert.equal(h.removed.length, h.calls.length);
  assert.equal(state.keys.get("managed"), "saved-key");
  assert.equal(state.disabled.has("managed"), true);
  assert.equal(h.pruned.length, 0);
  await result.lock.release();
  assert.equal(h.released(), 1);
});

for (const [name, result] of [
  ["matching key on nonzero exit", { ...matchingPolicy, exitCode: 1 }],
  ["matching key in failed envelope", { stdout: JSON.stringify({ success: false, data: { active: true, runtime: { restoreKey: "saved-key" } } }) }],
  ["untyped runtime-null busy", { stdout: JSON.stringify({ success: true, data: { active: true, runtime: null, runtimeError: "daemon_busy" } }) }],
  ["busy text without native code", { stdout: JSON.stringify({ success: false, error: "daemon_busy" }) }],
  ["success with misleading busy code", { stdout: JSON.stringify({ success: true, code: "daemon_busy", data: null }) }],
  ["wrong typed error", { stdout: JSON.stringify({ success: false, code: "tab_gone" }) }],
  ["malformed output", { stdout: "daemon_busy" }],
  ["timed out busy", { ...nativeBusy, timedOut: true }],
  ["aborted busy", { ...nativeBusy, aborted: true }],
  ["spawn-error busy", { ...nativeBusy, spawnError: new Error("spawn failed") }],
]) {
  test(`${name} remains unknown without retries or cached success`, async t => {
    const state = restoreState();
    const h = prepared(t, { infoResults: [{ ...result, stdoutSpillPath: "/fixture/unknown-spill" }, matchingPolicy] });
    const policy = await h.api.acquireOwnedManagedSessionDaemonPolicy(policyRequest(state));
    assert.match(policy.error, /could not verify.*restore policy/);
    assert.equal(h.calls.length, 1);
    assert.equal(h.waits.length, 0);
    assert.deepEqual(h.removed, ["/fixture/unknown-spill"]);
    assert.equal(state.keys.get("managed"), "saved-key");
    await policy.lock.release();
  });
}

test("busy followed by mismatched actual policy refuses and never adopts a cached key", async t => {
  const state = restoreState();
  const h = prepared(t, { infoResults: [nativeBusy, { stdout: JSON.stringify({ success: true, data: { active: true, runtime: { restoreKey: "different-key" } } }) }] });
  const result = await h.api.acquireOwnedManagedSessionDaemonPolicy(policyRequest(state));
  assert.match(result.error, /does not match.*managed-restore policy/);
  assert.equal(result.daemonStatus, "active");
  assert.equal(h.calls.length, 2);
  assert.equal(state.keys.get("managed"), "saved-key");
  await result.lock.release();
});

for (const stage of ["before", "process", "wait"]) {
  test(`abort during ${stage} cannot reach matching success or leak policy ownership`, async t => {
    const controller = new AbortController();
    const state = restoreState();
    if (stage === "before") controller.abort();
    const h = prepared(t, {
      infoResults: [stage === "process" ? matchingPolicy : { ...nativeBusy, stdoutSpillPath: "/fixture/abort-spill" }, matchingPolicy],
      onInfo: stage === "process" ? () => controller.abort() : undefined,
      onDelay: stage === "wait" ? () => controller.abort() : undefined,
    });
    const result = await h.api.acquireOwnedManagedSessionDaemonPolicy(policyRequest(state, controller.signal));
    assert.match(result.error, /could not verify.*restore policy/);
    assert.equal(h.calls.length, stage === "before" ? 0 : 1);
    assert.equal(result.lock, h.lock);
    assert.equal(h.released(), 0);
    assert.equal(state.keys.get("managed"), "saved-key");
    if (stage === "wait") assert.deepEqual(h.removed, ["/fixture/abort-spill"]);
    await result.lock.release();
    assert.equal(h.released(), 1);
  });
}

test("missing binary remains a known missing outcome, not a busy retry", async t => {
  const h = prepared(t, { infoResults: [{ spawnError: { code: "ENOENT" } }] });
  assert.deepEqual(await h.api.inspectManagedSessionDaemon({ cwd: "/fixture", sessionName: "managed" }), { status: "missing-binary" });
  assert.equal(h.calls.length, 1);
  assert.equal(h.waits.length, 0);
});

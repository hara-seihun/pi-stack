import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";

const root = mkdtempSync(path.join(tmpdir(), "workspace-job-observation-"));
after(() => rmSync(root, { recursive: true, force: true }));
const state = path.join(root, "registry.sqlite3");
const cli = new URL("./workspace.mjs", import.meta.url).pathname;
const bin = path.join(root, "bin");
mkdirSync(bin);
writeFileSync(path.join(bin, "systemctl"), "#!/bin/sh\nprintf 'LoadState=loaded\\nActiveState=active\\nSubState=running\\nResult=success\\nExecMainStatus=0\\n'\n");
chmodSync(path.join(bin, "systemctl"), 0o700);
function job(kind, id, result) {
  const directory = kind === "source" ? path.join(root, "source-preparations", "jobs", id)
    : path.join(root, "checkout-jobs", "fixture-workspace", id);
  mkdirSync(directory, { recursive: true });
  writeFileSync(path.join(directory, "request.json"), JSON.stringify({ id: "fixture-workspace" }));
  writeFileSync(path.join(directory, "attempt.json"), JSON.stringify({ unit: "fixture.service", number: 1 }));
  writeFileSync(path.join(directory, "progress.json"), JSON.stringify({ state: "running" }));
  if (result !== null) writeFileSync(path.join(directory, "result.json"), JSON.stringify(result));
  return directory;
}
function observe(command, id) {
  const result = spawnSync(process.execPath, [cli, command, "--job-id", id, "--json"], {
    encoding: "utf8", timeout: 5000,
    env: { ...process.env, PI_WORKSPACE_STATE: state, PATH: `${bin}:${process.env.PATH}` },
  });
  assert.equal(result.error, undefined);
  return { exit: result.status, value: JSON.parse(result.stdout) };
}
function files(directory) {
  return Object.fromEntries(readdirSync(directory).map(name => [name, readFileSync(path.join(directory, name), "utf8")]));
}

test("create-returned checkout identity is ready, wrong-kind is actionable, and observation writes nothing", () => {
  const id = "1".repeat(64);
  const directory = job("checkout", id, { state: "ready", value: { id: "fixture-workspace" } });
  const before = files(directory);
  const ready = observe("job-status", id);
  assert.equal(ready.exit, 0);
  assert.equal(ready.value.state, "ready");
  assert.equal(ready.value.jobKind, "checkout");
  assert.equal(ready.value.workspaceId, "fixture-workspace");
  const wrong = observe("source-status", id);
  assert.equal(wrong.exit, 2);
  assert.equal(wrong.value.state, "observation-error");
  assert.equal(wrong.value.error.code, "job-kind-mismatch");
  assert.equal(wrong.value.observeCommand, `agent-workspace job-status --job-id ${id} --json`);
  assert.equal(observe("job-status", id).value.state, "ready");
  assert.deepEqual(files(directory), before);
  assert.equal(existsSync(state), false);
});

test("source success and terminal failure retain authoritative results despite running progress", () => {
  const id = "2".repeat(64);
  job("source", id, { state: "ready", value: { sourceCommit: "a".repeat(40) } });
  assert.equal(observe("source-status", id).value.state, "ready");
  assert.equal(observe("job-status", id).value.jobKind, "source");
  const failed = "3".repeat(64);
  job("checkout", failed, { state: "failed", error: { code: "checkout-materialization-failed", message: "fixture failure" } });
  const result = observe("job-status", failed);
  assert.equal(result.exit, 2);
  assert.equal(result.value.state, "failed");
  assert.equal(result.value.error.code, "checkout-materialization-failed");
});

test("running source and checkout remain pending without submitting or creating registry", () => {
  for (const [kind, digit] of [["source", "4"], ["checkout", "5"]]) {
    const id = digit.repeat(64);
    job(kind, id, null);
    const result = observe("job-status", id);
    assert.equal(result.exit, 75);
    assert.equal(result.value.state, "pending");
    assert.equal(result.value.jobKind, kind);
  }
  assert.equal(existsSync(state), false);
});

test("unknown, malformed and ambiguous identities are observation errors, never fabricated work failure", () => {
  for (const [id, code] of [["6".repeat(64), "job-not-found"], ["bad", "invalid-job-id"]]) {
    const result = observe("job-status", id);
    assert.equal(result.exit, 2);
    assert.equal(result.value.state, "observation-error");
    assert.equal(result.value.jobKind, null);
    assert.equal(result.value.error.code, code);
  }
  const id = "7".repeat(64);
  for (const kind of ["source", "checkout"]) job(kind, id, { state: "ready", value: {} });
  assert.equal(observe("job-status", id).value.error.code, "job-identity-ambiguous");
});

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runJob } from "./run-jobs.mjs";

test("job output is visible before the process finishes", async () => {
  let complete = false;
  let sawLiveOutput = false;
  const result = await runJob(["stream", process.execPath, ["-e", "console.log('READY'); setTimeout(() => {}, 100)"]], text => {
    if (text.includes("READY")) sawLiveOutput = !complete;
  });
  complete = true;
  assert.equal(sawLiveOutput, true);
  assert.equal(result.code, 0);
});

test("an exited job with inherited descendant pipes fails instead of hanging", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-job-pipe-"));
  const pidFile = join(root, "pid");
  try {
    const code = `const {spawn}=require('node:child_process'); const child=spawn(process.execPath,['-e','setInterval(()=>{},60000)'],{detached:true,stdio:['ignore','inherit','inherit']}); require('node:fs').writeFileSync(${JSON.stringify(pidFile)},String(child.pid)); child.unref();`;
    const result = await runJob(["leak", process.execPath, ["-e", code], { drainTimeoutMs: 25 }], () => {});
    assert.equal(result.code, 1);
    assert.match(result.error, /descendants still hold/);
    assert.ok(result.elapsedMs < 2_000);
  } finally {
    try { process.kill(Number(readFileSync(pidFile, "utf8")), "SIGKILL"); } catch {}
    rmSync(root, { recursive: true, force: true });
  }
});

test("a running job has a bounded deadline", async () => {
  const result = await runJob(["stuck", process.execPath, ["-e", "setInterval(()=>{},60000)"], { timeoutMs: 50 }], () => {});
  assert.equal(result.code, 1);
  assert.match(result.error, /deadline/);
  assert.ok(result.elapsedMs < 2_000);
});

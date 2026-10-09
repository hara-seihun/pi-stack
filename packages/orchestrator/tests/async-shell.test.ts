import { afterEach, expect, it } from "vitest";
import { SessionManager, type AgentSession } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import { readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { PiExecution } from "../src/threads/pi-execution.js";
import { asynchronousShellTools, ownedPipeShellOperations } from "../src/threads/async-shell.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });
async function fixture(manager = SessionManager.inMemory(), owner = "own-thread", execution = new PiExecution()) {
  const tools = await asynchronousShellTools({ cwd: process.cwd(), env: { PI_REMOTE_BASH_TIMEOUT_MAX_SECONDS: "3" }, owner, manager, execution,
    backend: await ownedPipeShellOperations(join(process.cwd(), "../runtime/pi-shell-owner.mjs")) });
  const session = { clearQueue() {}, abortBash() {}, abort: async () => {}, agent: { waitForIdle: async () => {} }, isIdle: true, isBashRunning: false } as unknown as AgentSession;
  cleanups.push(() => execution.halt(session, 4000));
  const invoke = async (name: string, input: unknown, id = Math.random().toString()) =>
    (await tools.find(tool => tool.name === name)!.execute(id, input as never, undefined, undefined, undefined as never)).details as any;
  return { invoke, manager, execution, session };
}

it("returns completed commands and bounds yielding while other work proceeds", async () => {
  const f = await fixture();
  const fast = await f.invoke("bash", { command: "printf fast", timeout: 2, yield_time_ms: 1000 });
  expect(fast).toMatchObject({ status: "completed", exit_code: 0, output: "fast" });
  const started = Date.now();
  const slow = await f.invoke("bash", { command: "printf start; sleep .15; printf finish", timeout: 2, yield_time_ms: 5 });
  expect(Date.now() - started).toBeLessThan(200);
  expect(slow.status).toBe("running"); expect(f.execution.activeTools).toBe(1);
  expect(1 + 1).toBe(2);
  const completed = await f.invoke("bash_session", { session_id: slow.session_id, yield_time_ms: 1000 });
  expect(completed).toMatchObject({ status: "completed", output: "startfinish", exit_code: 0 });
  expect(completed.elapsed_ms).toBeGreaterThan(100); expect(f.execution.active).toBe(false);
});

it("supports stdin and EOF without an unbounded pipe write", async () => {
  const f = await fixture();
  const running = await f.invoke("bash", { command: "read -r value; printf 'got:%s' \"$value\"; cat", timeout: 2, yield_time_ms: 10 });
  const result = await f.invoke("bash_session", { session_id: running.session_id, stdin: "hello\n", eof: true, yield_time_ms: 1000 });
  expect(result).toMatchObject({ status: "completed", output: "got:hello" });
  expect(await f.invoke("bash_session", { session_id: running.session_id, stdin: "again" })).toMatchObject({ status: "error", code: "stdin_unavailable" });
});

it("separates yield from the hard deadline, retains nonzero exit and exact bounded output", async () => {
  const f = await fixture();
  const running = await f.invoke("bash", { command: "sleep 2", timeout: .1, yield_time_ms: 0 });
  expect(running.status).toBe("running");
  expect(await f.invoke("bash_session", { session_id: running.session_id, yield_time_ms: 1000 })).toMatchObject({ status: "failed", error: "timeout:0.1" });
  const spills = readdirSync(tmpdir()).filter(name => /^pi-(bash|output)-.*\.log$/.test(name));
  const output = await f.invoke("bash", { command: "python3 -c 'print(\"x\"*200000); print(\"tail\")'; exit 7", timeout: 2, yield_time_ms: 1000 });
  expect(output).toMatchObject({ status: "completed", exit_code: 7, truncated: true });
  expect(Buffer.byteLength(output.output)).toBeLessThanOrEqual(51200); expect(output.output.trimEnd().endsWith("tail")).toBe(true);
  expect(readdirSync(tmpdir()).filter(name => /^pi-(bash|output)-.*\.log$/.test(name))).toEqual(spills);
});

it("cancels only the named shell while Stop owns every remaining descendant", async () => {
  const f = await fixture();
  const a = await f.invoke("bash", { command: "echo $$; sleep 2", timeout: 3, yield_time_ms: 50 });
  const b = await f.invoke("bash", { command: "echo $$; sleep 2", timeout: 3, yield_time_ms: 50 });
  const cancelled = await f.invoke("bash_session", { session_id: a.session_id, cancel: true, yield_time_ms: 1000 });
  expect(cancelled).toMatchObject({ status: "failed", error: "aborted" });
  expect(() => process.kill(Number(cancelled.output.trim()), 0)).toThrow();
  expect(() => process.kill(Number(b.output.trim()), 0)).not.toThrow();
  await f.execution.halt(f.session, 3000);
  expect(() => process.kill(Number(b.output.trim()), 0)).toThrow();
  expect(f.execution.active).toBe(false);
});

it("refuses replay of stdin and rejects pipe backpressure without waiting for consumption", async () => {
  const f = await fixture();
  const running = await f.invoke("bash", { command: "cat", timeout: 2, yield_time_ms: 10 });
  expect(await f.invoke("bash_session", { session_id: running.session_id, stdin: "once", yield_time_ms: 10 }, "stdin-once")).toMatchObject({ stdin_queued: true });
  expect(await f.invoke("bash_session", { session_id: running.session_id, stdin: "once", yield_time_ms: 0 }, "stdin-once")).toMatchObject({ code: "stdin_already_submitted" });
  const done = await f.invoke("bash_session", { session_id: running.session_id, eof: true, yield_time_ms: 1000 });
  expect(done).toMatchObject({ status: "completed", output: "once" });
  const stalled = await f.invoke("bash", { command: "sleep 2", timeout: 3, yield_time_ms: 10 });
  const started = Date.now();
  expect(await f.invoke("bash_session", { session_id: stalled.session_id, stdin: "界".repeat(65536) })).toMatchObject({ code: "stdin_failed" });
  expect(Date.now() - started).toBeLessThan(100);
});

it("owns signal-resistant descendants that leave the process group", async () => {
  const f = await fixture();
  const running = await f.invoke("bash", { command: `python3 -c 'import os,signal,time; os.setsid(); signal.signal(signal.SIGTERM,signal.SIG_IGN); print(os.getpid(),flush=True); time.sleep(2)'; true`, timeout: 3, yield_time_ms: 100 });
  const pid = Number(running.output.trim()); expect(pid).toBeGreaterThan(0);
  const closed = await f.invoke("bash_session", { session_id: running.session_id, cancel: true, yield_time_ms: 1000 });
  expect(closed).toMatchObject({ status: "failed", error: "aborted" });
  expect(() => process.kill(pid, 0)).toThrow();
});

it("persists launch intent, refuses duplicate launch and preserves unknown restart outcomes", async () => {
  const f = await fixture();
  const running = await f.invoke("bash", { command: "sleep .2", timeout: 2, yield_time_ms: 10 }, "stable-call");
  const duplicate = await f.invoke("bash", { command: "printf must-not-run", timeout: 2, yield_time_ms: 0 }, "stable-call");
  expect(duplicate.session_id).toBe(running.session_id);
  const restarted = await fixture(f.manager);
  const unknown = await restarted.invoke("bash_session", { session_id: running.session_id, yield_time_ms: 0 });
  expect(unknown).toMatchObject({ status: "interrupted", output_available: false });
  expect(unknown.error).toMatch(/outcome unknown/);
  expect((await restarted.invoke("bash", { command: "printf must-not-replay", timeout: 1 }, "stable-call")).status).toBe("interrupted");
  const foreign = await fixture(f.manager, "other-thread");
  expect(await foreign.invoke("bash_session", { session_id: running.session_id })).toMatchObject({ code: "session_not_found" });
});

it("rejects malformed receipts and invalid deadlines/yields before launching", async () => {
  const f = await fixture();
  expect(await f.invoke("bash", { command: "exit 0", timeout: 4 })).toMatchObject({ code: "invalid_timeout" });
  expect(await f.invoke("bash", { command: "exit 0", timeout: 1, yield_time_ms: 1001 })).toMatchObject({ code: "invalid_yield" });
  expect(f.manager.getBranch()).toHaveLength(0);
  f.manager.appendCustomEntry("thread_shell_session_v1", { status: "completed" });
  await expect(fixture(f.manager)).rejects.toThrow("Invalid persisted");
});

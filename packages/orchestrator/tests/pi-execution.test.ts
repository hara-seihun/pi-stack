import { expect, it } from "vitest";
import { Agent } from "@earendil-works/pi-agent-core";
import { createBashTool, type AgentSession } from "@earendil-works/pi-coding-agent";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PiExecution } from "../src/threads/pi-execution.js";

function fixture(tool: any) {
  const agent = new Agent({ initialState: { tools: [tool] }, streamFn: () => { throw new Error("No model calls in cancellation fixtures"); } });
  const session = { agent, executeBash: async () => {}, compact: async () => {}, navigateTree: async () => {}, prompt: async () => {}, abort: async () => {}, abortBash() {}, clearQueue() {}, isStreaming: false, isCompacting: false, isBashRunning: false } as unknown as AgentSession;
  const execution = new PiExecution();
  execution.bind(session);
  return { execution, session, tool: agent.state.tools[0] };
}

it("signals a running shell and waits until its local process has stopped", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-cancel-"));
  try {
    const { execution, session, tool } = fixture(createBashTool(cwd));
    let ready!: () => void;
    let pid = 0;
    const started = new Promise<void>(resolve => { ready = resolve; });
    const running = tool.execute("shell", { command: "echo $$; sleep 30", timeout: 32 }, undefined, update => {
      const text = update.content.find(block => block.type === "text");
      if (text?.type === "text") { pid = Number(text.text.trim()); if (pid) ready(); }
    });
    void running.catch(() => {});
    await started;
    await execution.cancel(session, 1000);
    await expect(running).rejects.toThrow(/aborted/i);
    expect(() => process.kill(pid, 0)).toThrow();
    expect(execution.activeTools).toBe(0);
    expect(execution.blocked).toBe(false);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

it("does not permit another generation when a tool ignores cancellation", async () => {
  let finish!: () => void;
  const { execution, session, tool } = fixture({ name: "ignores-cancel", description: "fixture", parameters: { type: "object" }, execute: () => new Promise<void>(resolve => { finish = resolve; }) });
  const running = tool.execute("slow", {}, undefined);
  await Promise.resolve();
  await expect(execution.cancel(session, 10)).rejects.toThrow("Cancellation failed");
  expect(execution.blocked).toBe(true);
  expect(() => execution.run(() => 1)).toThrow("cancelled");
  finish(); await running;
  expect(execution.blocked).toBe(true);
  await execution.cancel(session, 1000);
  expect(execution.run(() => 1)).toBe(1);
});

it("fences late preflight callbacks and confirms they ended before cancellation succeeds", async () => {
  let finish!: () => void;
  const agent = new Agent({ streamFn: () => { throw new Error("No model calls in cancellation fixtures"); } });
  const session = { agent, executeBash: async () => {}, compact: async () => {}, navigateTree: async () => {}, prompt: () => new Promise<void>(resolve => { finish = resolve; }), abort: async () => {}, abortBash() {}, clearQueue() {}, isStreaming: false, isCompacting: false, isBashRunning: false } as unknown as AgentSession;
  const execution = new PiExecution(); execution.bind(session);
  const pending = session.prompt("fixture");
  await expect(execution.cancel(session, 10)).rejects.toThrow("Cancellation failed");
  finish(); await pending;
  await execution.cancel(session, 1000);
});

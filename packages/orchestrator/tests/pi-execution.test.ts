import { expect, it, vi } from "vitest";
import { Agent } from "@earendil-works/pi-agent-core";
import { createBashTool, type AgentSession } from "@earendil-works/pi-coding-agent";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PiExecution } from "../src/threads/pi-execution.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

function fixture(tool?: any, overrides: Partial<AgentSession> = {}, onIdle?: () => void) {
  const agent = new Agent({ initialState: { tools: tool ? [tool] : [] }, streamFn: () => { throw new Error("No model calls in cancellation fixtures"); } });
  const session = { agent, executeBash: async () => {}, compact: async () => {}, navigateTree: async () => {},
    prompt: async () => {}, steer: async () => {}, followUp: async () => {}, sendCustomMessage: async () => {}, sendUserMessage: async () => {},
    abort: vi.fn(async () => {}), abortBash: vi.fn(), clearQueue: vi.fn(), isIdle: true, isBashRunning: false, ...overrides } as unknown as AgentSession;
  const execution = new PiExecution(onIdle);
  execution.bind(session);
  return { execution, session, tool: agent.state.tools[0] };
}

it("signals a running shell and waits until its local process has stopped", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-cancel-"));
  try {
    const { execution, session, tool } = fixture(createBashTool(cwd));
    const started = deferred();
    let pid = 0;
    const running = tool.execute("shell", { command: "echo $$; sleep 30", timeout: 32 }, undefined, update => {
      const text = update.content.find(block => block.type === "text");
      if (text?.type === "text") { pid = Number(text.text.trim()); if (pid) started.resolve(); }
    });
    const result = expect(running).rejects.toThrow(/aborted/i);
    await started.promise;
    await execution.halt(session, 1000);
    await result;
    expect(() => process.kill(pid, 0)).toThrow();
    expect(execution.active).toBe(false);
    expect(execution.blocked).toBe(false);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

it("keeps a timed-out halt blocked until an explicit confirmation, including stale callbacks", async () => {
  const finish = deferred(), entered = deferred();
  let late!: () => number;
  const { execution, session, tool } = fixture({ name: "ignores-cancel", description: "fixture", parameters: { type: "object" }, execute: async () => {
    late = () => execution.run(() => 1);
    const callback = new Promise<void>(resolve => { finish.promise.then(() => { expect(late).toThrow("cancelled"); resolve(); }); });
    entered.resolve();
    await callback;
  } });
  const running = tool.execute("slow", {}, undefined);
  await entered.promise;
  await expect(execution.halt(session, 10)).rejects.toThrow("Cancellation failed");
  expect(execution.blocked).toBe(true);
  expect(() => execution.run(() => 1)).toThrow("cancelled");
  finish.resolve(); await running;
  expect(execution.blocked).toBe(true);
  await execution.halt(session, 1000);
  expect(execution.run(() => 1)).toBe(1);
});

it("shares one halt and keeps admission closed through settlement", async () => {
  const finish = deferred(), entered = deferred();
  const { execution, session } = fixture(undefined, { prompt: async () => { entered.resolve(); await finish.promise; } });
  const pending = session.prompt("fixture");
  await entered.promise;
  const settled = vi.fn(() => { expect(execution.active).toBe(false); expect(execution.blocked).toBe(true); });
  const first = execution.halt(session, 1000, settled);
  expect(execution.halt(session, 1000, settled)).toBe(first);
  expect(() => session.prompt("overlap")).toThrow("cancelled");
  finish.resolve(); await pending; await first;
  expect(session.abort).toHaveBeenCalledTimes(1);
  expect(settled).toHaveBeenCalledTimes(1);
});

it("notifies idle after prompt rejection consumers, never from inside the tracked prompt", async () => {
  const order: string[] = [];
  const { execution, session } = fixture(undefined, { prompt: async () => { throw new Error("preflight"); } }, () => {
    expect(execution.active).toBe(false);
    order.push("idle");
  });
  await session.prompt("fixture").catch(() => { order.push("rejected"); });
  await Promise.resolve();
  expect(order).toEqual(["rejected", "idle"]);
});

it("does not reopen admission when durable settlement fails", async () => {
  const { execution, session } = fixture();
  await expect(execution.halt(session, 1000, () => { throw new Error("receipt write failed"); })).rejects.toThrow("receipt write failed");
  expect(execution.blocked).toBe(true);
});

it("fences callbacks from a cancelled run after a new run is admitted", async () => {
  const gate = deferred();
  let callback!: Promise<unknown>;
  const { execution, session } = fixture(undefined, { prompt: async () => {
    callback = gate.promise.then(() => session.executeBash("must not run"));
  } });
  await session.prompt("fixture");
  await execution.halt(session, 1000);
  expect(execution.run(() => 1)).toBe(1);
  const rejected = expect(callback).rejects.toThrow("cancelled");
  gate.resolve();
  await rejected;
});

it("rejects a halt from inside the prompt it would have to await", async () => {
  const { execution, session } = fixture(undefined, { prompt: async () => {
    await expect(execution.halt(session, 1000)).rejects.toThrow("from its own callback");
  } });
  await session.prompt("fixture");
  expect(execution.blocked).toBe(false);
  expect(execution.active).toBe(false);
});

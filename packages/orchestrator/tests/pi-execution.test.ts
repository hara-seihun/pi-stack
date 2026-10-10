import { afterEach, expect, it, vi } from "vitest";
import { Agent } from "@earendil-works/pi-agent-core";
import { SessionManager, type AgentSession } from "@earendil-works/pi-coding-agent";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PiExecution, type OperationCompletion } from "../src/threads/pi-execution.js";
import { seedPiSession, checkpointPiSession } from "../src/threads/pi-session-file.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const gate = () => { let resolve!: (value?: any) => void; const promise = new Promise<any>(done => { resolve = done; }); return { promise, resolve }; };
const result = { content: [{ type: "text" as const, text: "done" }], details: {} };
function fixture(execute: any, manager?: SessionManager) {
  const root = mkdtempSync(join(tmpdir(), "pi-operation-")); roots.push(root);
  const path = join(root, "session.jsonl");
  if (!manager) { seedPiSession(path, root); manager = SessionManager.open(path); }
  const agent = new Agent({ initialState: { tools: [{ name: "fixture", label: "Fixture", description: "fixture", parameters: { type: "object" }, execute }] }, streamFn: () => { throw new Error("No provider in operation fixture"); } });
  const session = { agent, sessionManager: manager, sessionId: manager.getSessionId(), sessionFile: manager.getSessionFile(),
    abort: vi.fn(async () => {}), abortBash: vi.fn(), isIdle: true, isBashRunning: false } as unknown as AgentSession;
  const completions: OperationCompletion[] = [], completed = gate();
  const execution = new PiExecution(() => {}, event => { completions.push(event); completed.resolve(); });
  execution.bind(session);
  return { execution, completions, completed, session, tool: agent.state.tools[0]! };
}

it("yields an observation while the operation survives, then emits one correlated completion", async () => {
  const started = gate(), finish = gate(); let signal!: AbortSignal;
  const raw = vi.fn(async (_id, _args, ownedSignal) => { signal = ownedSignal; started.resolve(); await finish.promise; return result; });
  const f = fixture(raw);
  const observing = f.tool.execute("call", {}, new AbortController().signal);
  await started.promise;
  f.execution.releaseObservations();
  const running = await observing;
  expect(running.details).toMatchObject({ state: "running" });
  expect(f.execution.active).toBe(false);
  expect(f.execution.activeTools).toBe(1);
  expect(signal.aborted).toBe(false);
  finish.resolve(); await f.completed.promise;
  expect(f.completions).toHaveLength(1);
  expect(f.completions[0]).toMatchObject({ toolCallId: "call", outcome: { kind: "complete" } });
  await f.tool.execute("call", {}, undefined);
  expect(raw).toHaveBeenCalledTimes(1);
});

it("terminal selection wins the release race and suppresses the automatic completion", async () => {
  const finish = gate(); const f = fixture(async () => { await finish.promise; return result; });
  const observing = f.tool.execute("call", {}, undefined);
  await Promise.resolve(); await Promise.resolve();
  finish.resolve(); await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
  f.execution.releaseObservations();
  expect(await observing).toEqual(result);
  expect(f.completions).toEqual([]);
});

it("keeps sequential raw effects ordered after both observations have yielded", async () => {
  const first = gate(), started = gate(), second = gate(); const order: string[] = [];
  const f = fixture(async (id: string) => { order.push(id); if (id === "first") { started.resolve(); await first.promise; } else second.resolve(); return result; });
  f.session.agent.toolExecution = "sequential";
  const a = f.tool.execute("first", {}, undefined);
  await started.promise;
  f.execution.releaseObservations(); await a;
  const b = await f.tool.execute("second", {}, undefined);
  expect(b.details).toMatchObject({ state: "accepted" });
  expect(order).toEqual(["first"]);
  first.resolve(); await second.promise;
  expect(order).toEqual(["first", "second"]);
  await f.execution.halt(f.session, 1000);
});

it("fences replay after restart and reports owner loss as uncertainty", async () => {
  const started = gate(), finish = gate(); const raw = vi.fn(async () => { started.resolve(); await finish.promise; return result; });
  const f = fixture(raw);
  const observing = f.tool.execute("call", {}, undefined);
  await started.promise; f.execution.releaseObservations(); const running = await observing;
  const restarted = fixture(raw, SessionManager.open(f.session.sessionFile!));
  const snapshot = restarted.execution.inspect((running.details as any).operationId);
  expect(snapshot).toMatchObject({ ok: true, value: { state: "terminal", outcome: { kind: "uncertain" } } });
  await restarted.tool.execute("call", {}, undefined);
  expect(raw).toHaveBeenCalledTimes(1);
  finish.resolve();
  await f.execution.halt(f.session, 1000);
});

it("adopts a predecessor dangling call as uncertain without executing it", async () => {
  const original = fixture(vi.fn(async () => result));
  original.session.sessionManager.appendMessage({ role: "assistant", content: [{ type: "toolCall", id: "old-call", name: "fixture", arguments: {} }],
    api: "openai-completions", provider: "fixture", model: "fixture", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "toolUse", timestamp: Date.now() });
  checkpointPiSession(original.session.sessionManager);
  const raw = vi.fn(async () => result);
  const adopted = fixture(raw, SessionManager.open(original.session.sessionFile!));
  const repaired = adopted.session.agent.state.messages.at(-1);
  expect(repaired).toMatchObject({ role: "toolResult", toolCallId: "old-call", isError: true });
  await expect(adopted.tool.execute("old-call", {}, undefined)).rejects.toThrow("owner_lost");
  expect(raw).not.toHaveBeenCalled();
});

it("slow admission and result hooks belong to raw operation custody, not model observation", async () => {
  const before = gate(), admitted = gate(), after = gate(), transformed = gate();
  const raw = vi.fn(async () => result);
  const f = fixture(raw);
  f.session.agent.beforeToolCall = async () => { admitted.resolve(); await before.promise; return undefined; };
  f.session.agent.afterToolCall = async () => { transformed.resolve(); await after.promise; return { content: [{ type: "text", text: "transformed" }] }; };
  await f.session.agent.beforeToolCall!({ toolCall: { id: "call", name: "fixture", arguments: {}, type: "toolCall" }, args: {}, assistantMessage: {} as any, context: { messages: [] } }, undefined);
  const observing = f.tool.execute("call", {}, undefined);
  await admitted.promise;
  f.execution.releaseObservations();
  expect((await observing).details).toMatchObject({ state: "running" });
  expect(raw).not.toHaveBeenCalled();
  before.resolve(); await transformed.promise;
  expect(f.completions).toHaveLength(0);
  after.resolve();
  await f.execution.halt(f.session, 1000);
  expect(f.completions[0]?.result?.content).toEqual([{ type: "text", text: "transformed" }]);
});

it("explicit Stop cancels operation custody, but observation release never does", async () => {
  const started = gate(); let aborted = false;
  const f = fixture(async (_id: any, _args: any, signal: AbortSignal) => {
    started.resolve(); await new Promise<void>(resolve => signal.addEventListener("abort", () => { aborted = true; resolve(); }, { once: true }));
    throw new Error("cancelled");
  });
  const observing = f.tool.execute("call", {}, undefined);
  await started.promise; f.execution.releaseObservations(); await observing;
  expect(aborted).toBe(false);
  await f.execution.halt(f.session, 1000);
  expect(aborted).toBe(true);
  expect(f.completions[0]?.outcome.kind).toBe("cancelled");
  expect(f.execution.activeTools).toBe(0);
});

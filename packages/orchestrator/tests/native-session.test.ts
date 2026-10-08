import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { afterEach, expect, it, vi } from "vitest";
import { AgentCapacityAuthority } from "../src/agent-capacity-authority.js";
import type { AgentCapacity, AgentExecution, CapacityCustody } from "../src/agent-capacity.js";
import type { Result } from "../src/threads/contracts.js";
import { createManagedAgentSession } from "../src/threads/native-session.js";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
function value<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}
function capacityFixture(exhausted = false) {
  const authority = new AgentCapacityAuthority(":memory:");
  cleanups.push(() => authority.close());
  value(authority.initialize(exhausted ? Array.from({ length: 100 }, (_, index) => ({
    ownerId: "fixture", agentId: `occupied-${index}`, executionId: `occupied-execution-${index}`,
  })) : []));
  const release = vi.fn(async (custody: CapacityCustody) => authority.release("fixture", custody));
  const acquire = vi.fn(async (execution: AgentExecution) => {
    const acquired = authority.acquire("fixture", execution);
    return acquired.ok ? { ok: true as const, value: { ...acquired.value, release: () => release(acquired.value) } } : acquired;
  });
  const capacity: AgentCapacity = {
    acquire, release,
    inspect: async execution => authority.inspect("fixture", execution),
    withdraw: async execution => authority.withdraw("fixture", execution),
  };
  return { authority, capacity, acquire, release };
}
function options(capacity: AgentCapacity) {
  const cwd = mkdtempSync(join(tmpdir(), "managed-native-session-"));
  cleanups.push(() => rmSync(cwd, { recursive: true, force: true }));
  return { cwd, databasePath: join(cwd, "threads.sqlite3"), sessionsDir: join(cwd, "sessions"), capacity };
}

// Model only the SDK boundary: orchestration, durable commands and capacity are real.
function nativeFixture() {
  const result = { content: [{ type: "text", text: "fixture result" }], details: {} };
  const execute = vi.fn(async (..._args: unknown[]) => result);
  const state = { tools: [{ name: "fixture_tool", execute }] };
  let tools = state.tools;
  Object.defineProperty(state, "tools", {
    configurable: true, enumerable: true,
    get: () => tools,
    set: next => { tools = next; },
  });
  const agent = {
    state,
    continue: vi.fn(async () => { await state.tools[0]!.execute("tool-call", {}); }),
    prompt: vi.fn(async (_text: string) => { await agent.continue(); }),
  };
  const session = {
    agent, messages: [], sessionFile: undefined, pendingMessageCount: 0,
    isStreaming: false, isCompacting: false, isBashRunning: false,
    prompt: vi.fn(async (text: string) => {
      session.isStreaming = true;
      try { await agent.prompt(text); } finally { session.isStreaming = false; }
    }),
    subscribe: vi.fn(() => vi.fn()),
    clearQueue: vi.fn(), abortCompaction: vi.fn(), abortBash: vi.fn(),
    abort: vi.fn(async () => {}), dispose: vi.fn(),
  };
  const nativeDispose = session.dispose;
  const factory = vi.fn(async () => ({ session: session as unknown as AgentSession }));
  return { session, execute, nativeDispose, nativePrompt: session.prompt,
    nativeAgentPrompt: agent.prompt, nativeContinue: agent.continue, factory, result };
}
async function admitted() {
  const capacity = capacityFixture();
  const native = nativeFixture();
  native.factory.mockImplementation(async () => {
    expect(capacity.authority.status().active).toBe(1);
    return { session: native.session as unknown as AgentSession };
  });
  const managed = await createManagedAgentSession(native.factory, options(capacity.capacity));
  cleanups.push(() => managed.close());
  expect(capacity.acquire).toHaveBeenCalledTimes(1);
  expect(capacity.release).toHaveBeenCalledTimes(1);
  expect(capacity.authority.status().active).toBe(0);
  capacity.acquire.mockClear(); capacity.release.mockClear();
  return { ...capacity, ...native, managed };
}

it("denies an exhausted-capacity factory before native session entry", async () => {
  const fixture = capacityFixture(true);
  const native = nativeFixture();
  await expect(createManagedAgentSession(native.factory, options(fixture.capacity))).rejects.toMatchObject({ code: "unavailable" });
  expect(native.factory).not.toHaveBeenCalled();
  expect(native.nativeDispose).not.toHaveBeenCalled();
  expect(fixture.acquire).toHaveBeenCalledTimes(1);
  expect(fixture.release).not.toHaveBeenCalled();
  expect(fixture.authority.status()).toMatchObject({ active: 100, queued: 0 });
}, 3_000);

it("owns one lease for the full prompt, nested agent continuation and tools", async () => {
  const fixture = await admitted();
  const entered = deferred(), toolDone = deferred(), continuationDone = deferred(), finishPrompt = deferred();
  cleanups.push(() => { toolDone.resolve(); finishPrompt.resolve(); });
  fixture.execute.mockImplementation(async () => {
    expect(fixture.authority.status().active).toBe(1);
    entered.resolve();
    await toolDone.promise;
    return fixture.result;
  });
  fixture.nativeAgentPrompt.mockImplementation(async () => {
    await fixture.session.agent.continue();
    continuationDone.resolve();
    await finishPrompt.promise;
  });
  const fullPrompt = "Full native input\n\nincluding context and exact whitespace  ";
  let settled = false;
  const operation = fixture.managed.session.prompt(fullPrompt).then(() => { settled = true; });
  await entered.promise;
  expect(fixture.factory).toHaveBeenCalledTimes(1);
  expect(fixture.nativePrompt).toHaveBeenCalledWith(fullPrompt);
  expect(fixture.nativeAgentPrompt).toHaveBeenCalledWith(fullPrompt);
  expect(fixture.nativeContinue).toHaveBeenCalledTimes(1);
  expect(fixture.acquire).toHaveBeenCalledTimes(1);
  expect(fixture.release).not.toHaveBeenCalled();
  expect(settled).toBe(false);
  toolDone.resolve();
  await continuationDone.promise;
  expect(fixture.authority.status().active).toBe(1);
  expect(fixture.release).not.toHaveBeenCalled();
  finishPrompt.resolve();
  await operation;
  expect(fixture.acquire).toHaveBeenCalledTimes(1);
  expect(fixture.release).toHaveBeenCalledTimes(1);
  expect(fixture.authority.status().active).toBe(0);
  expect(fixture.managed.threadService.get(fixture.managed.threadId)?.state).toBe("idle");
}, 3_000);

it("gives externally invoked tools their own operation, including tools installed after creation", async () => {
  const fixture = await admitted();
  const entered = deferred(), finish = deferred();
  cleanups.push(() => finish.resolve());
  const execute = vi.fn(async (..._args: unknown[]) => {
    expect(fixture.authority.status().active).toBe(1);
    entered.resolve(); await finish.promise;
    return fixture.result;
  });
  fixture.session.agent.state.tools = [{ name: "later_tool", execute }];
  const operation = fixture.session.agent.state.tools[0]!.execute("external-call", { payload: "outside prompt" });
  await entered.promise;
  expect(fixture.acquire).toHaveBeenCalledTimes(1);
  expect(fixture.release).not.toHaveBeenCalled();
  expect(fixture.nativePrompt).not.toHaveBeenCalled();
  expect(fixture.nativeContinue).not.toHaveBeenCalled();
  finish.resolve();
  expect(await operation).toEqual(fixture.result);
  expect(execute).toHaveBeenCalledWith("external-call", { payload: "outside prompt" });
  expect(fixture.release).toHaveBeenCalledTimes(1);
  expect(fixture.authority.status().active).toBe(0);
  await fixture.managed.session.agent.continue();
  expect(fixture.acquire).toHaveBeenCalledTimes(2);
  expect(fixture.release).toHaveBeenCalledTimes(2);
  expect(fixture.acquire.mock.calls[0]![0].executionId).not.toBe(fixture.acquire.mock.calls[1]![0].executionId);
}, 3_000);

it("releases a failed settled operation and admits the next operation", async () => {
  const fixture = await admitted();
  const failure = new Error("fixture tool failed after entry");
  fixture.execute.mockImplementationOnce(async () => {
    expect(fixture.authority.status().active).toBe(1);
    throw failure;
  });
  await expect(fixture.managed.session.prompt("fails")).rejects.toBe(failure);
  expect(fixture.acquire).toHaveBeenCalledTimes(1);
  expect(fixture.release).toHaveBeenCalledTimes(1);
  expect(fixture.authority.status().active).toBe(0);
  await fixture.managed.session.prompt("next execution");
  expect(fixture.acquire).toHaveBeenCalledTimes(2);
  expect(fixture.release).toHaveBeenCalledTimes(2);
  expect(fixture.authority.status().active).toBe(0);
}, 3_000);

it("keeps async close and custody pending until an abort-resistant detached tool settles", async () => {
  const fixture = await admitted();
  const entered = deferred(), finish = deferred(), aborted = deferred();
  cleanups.push(() => finish.resolve());
  fixture.execute.mockImplementation(async () => {
    entered.resolve(); await finish.promise;
    return fixture.result;
  });
  fixture.session.abort.mockImplementation(async () => { aborted.resolve(); });
  fixture.nativeContinue.mockImplementation(async () => {
    void fixture.session.agent.state.tools[0]!.execute("stubborn-tool", {});
  });
  let promptSettled = false, closeSettled = false;
  const operation = fixture.managed.session.prompt("starts detached tool").then(() => { promptSettled = true; });
  await entered.promise;
  const closing = fixture.managed.close().then(() => { closeSettled = true; });
  await aborted.promise;
  expect(fixture.session.clearQueue).toHaveBeenCalledTimes(1);
  expect(fixture.session.abortCompaction).toHaveBeenCalledTimes(1);
  expect(fixture.session.abortBash).toHaveBeenCalledTimes(1);
  expect(promptSettled).toBe(false);
  expect(closeSettled).toBe(false);
  expect(fixture.acquire).toHaveBeenCalledTimes(1);
  expect(fixture.release).not.toHaveBeenCalled();
  expect(fixture.nativeDispose).not.toHaveBeenCalled();
  expect(fixture.authority.status().active).toBe(1);
  await expect(fixture.managed.session.prompt("cannot enter while closing")).rejects.toThrow("closed");
  finish.resolve();
  await Promise.all([operation, closing]);
  expect(fixture.release).toHaveBeenCalledTimes(1);
  expect(fixture.authority.status().active).toBe(0);
  expect(fixture.nativeDispose).toHaveBeenCalledTimes(1);
  await fixture.managed.close();
  expect(fixture.nativeDispose).toHaveBeenCalledTimes(1);
  expect(fixture.release).toHaveBeenCalledTimes(1);
}, 3_000);

import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { afterEach, expect, it, vi } from "vitest";
import { AgentCapacityAuthority } from "../src/agent-capacity-authority.js";
import type { AgentCapacity, AgentExecution, CapacityCustody } from "../src/agent-capacity.js";
import type { Result } from "../src/threads/contracts.js";
import { createManagedAgentSession } from "../src/threads/native-session.js";
import { recoverNativeSessionOwners, type NativeOwnerRecord } from "../src/threads/native-owner-recovery.js";
import { ThreadCapacityLedger } from "../src/threads/capacity-ledger.js";
import { openSqlite } from "../src/sqlite.js";

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
    convertToLlm: vi.fn(async (messages: unknown[]) => messages),
    continue: vi.fn(async () => { await state.tools[0]!.execute("tool-call", {}); }),
    prompt: vi.fn(async (_text: string) => { await agent.continue(); }),
  };
  const session = {
    agent, messages: [], sessionFile: undefined, pendingMessageCount: 0,
    sessionManager: { getBranch: () => [], appendCustomEntry: vi.fn() },
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

it.each<{ label: string; proof: Result<boolean>; active: number; nested?: true; scope?: true }>([
  { label: "positive native-owner absence", proof: { ok: true, value: true }, active: 0 },
  { label: "nested canonical native-owner database", proof: { ok: true, value: true }, active: 0, nested: true },
  { label: "same-UID foreground scope owner", proof: { ok: true, value: true }, active: 0, scope: true },
  { label: "a still-present native owner", proof: { ok: true, value: false }, active: 1 },
  { label: "an unavailable absence proof", proof: { ok: false, error: { code: "unavailable", message: "fixture absence unknown" } }, active: 1 },
])("recovers crash custody only on positive absence: $label", async ({ proof, active, nested, scope }) => {
  const fixture = capacityFixture();
  const paths = options(fixture.capacity);
  const directory = nested ? join(paths.cwd, "b941ac15-36b6-42f2-928f-17b98f71a937") : paths.cwd;
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (nested) paths.databasePath = join(directory, "threads.sqlite3");
  const owner: NativeOwnerRecord = {
    threadId: "crashed-native-thread", databasePath: paths.databasePath,
    unit: `pi-native-01234567.${scope ? "scope" : "service"}`, cgroup: `/user.slice/fixture/pi-native-01234567.${scope ? "scope" : "service"}`, bootId: "942aba85-5d69-45dc-a708-065084d6e4c4",
    ...(scope ? { uid: process.getuid!() } : {}),
  };
  const db = openSqlite(paths.databasePath);
  try {
    db.exec("CREATE TABLE thread(id TEXT PRIMARY KEY,state TEXT,held INTEGER,metadata TEXT); CREATE TABLE thread_request(id TEXT PRIMARY KEY,kind TEXT,target TEXT,response TEXT)");
    db.prepare("INSERT INTO thread VALUES(?,'running',0,?)").run(owner.threadId, JSON.stringify({ runnerReference: { control: "stopped-unit" } }));
    db.prepare("INSERT INTO thread_request VALUES(?,'command',?,NULL)").run("crashed-command", owner.threadId);
    const ledger = new ThreadCapacityLedger(db, fixture.capacity);
    value(await ledger.acquire(owner.threadId, "crashed-execution", "crashed-command", "command"));
    ledger.entered(owner.threadId, "crashed-execution");
  } finally { db.close(); }
  writeFileSync(join(directory, "threads.owner.json"), JSON.stringify(owner));
  const absent = vi.fn(async () => proof);
  const recovery = await recoverNativeSessionOwners(paths.cwd, { capacity: fixture.capacity, absent });
  expect(absent).toHaveBeenCalledExactlyOnceWith(owner);
  expect(recovery).toEqual(proof.ok ? { ok: true, value: undefined } : proof);
  expect(fixture.authority.status().active).toBe(active);
  expect(fixture.release).toHaveBeenCalledTimes(active === 0 ? 1 : 0);
  const reopened = openSqlite(paths.databasePath);
  try {
    const ledger = new ThreadCapacityLedger(reopened, fixture.capacity);
    expect(ledger.current(owner.threadId)).toHaveLength(active);
    const thread = reopened.prepare("SELECT state,metadata FROM thread WHERE id=?").get(owner.threadId) as { state: string; metadata: string };
    const command = reopened.prepare("SELECT response FROM thread_request WHERE id='crashed-command'").get() as { response: string | null };
    if (active) {
      expect(ledger.current(owner.threadId)[0]).toMatchObject({ state: "held", entered_native: 1 });
      expect(thread.state).toBe("running");
      expect(command.response).toBeNull();
      expect(JSON.parse(thread.metadata).runnerReference).toBeDefined();
    } else {
      expect(thread.state).toBe("idle");
      expect(JSON.parse(command.response!)).toMatchObject({ ok: false, error: { code: "unavailable" } });
      expect(JSON.parse(thread.metadata).runnerReference).toBeUndefined();
      expect(JSON.parse(thread.metadata).commandError).toMatch(/cannot be replayed/);
    }
  } finally { reopened.close(); }
  if (active === 0) {
    expect(await recoverNativeSessionOwners(paths.cwd, { capacity: fixture.capacity, absent })).toEqual({ ok: true, value: undefined });
    expect(absent).toHaveBeenCalledTimes(1);
    expect(fixture.release).toHaveBeenCalledTimes(1);
  }
}, 3_000);

it("rejects linked owner roots without reading the target or releasing custody", async () => {
  const fixture = capacityFixture();
  const paths = options(fixture.capacity);
  const target = join(paths.cwd, "private-target");
  mkdirSync(target);
  writeFileSync(join(target, "threads.owner.json"), "not readable owner metadata");
  symlinkSync(target, join(paths.cwd, "b941ac15-36b6-42f2-928f-17b98f71a937"));
  const absent = vi.fn(async () => ({ ok: true as const, value: true }));
  const result = await recoverNativeSessionOwners(paths.cwd, { capacity: fixture.capacity, absent });
  expect(result).toMatchObject({ ok: false, error: { code: "unavailable", message: expect.stringContaining("must not be a link") } });
  expect(absent).not.toHaveBeenCalled();
  expect(fixture.release).not.toHaveBeenCalled();
});

it("rejects another UID's scope before asking its manager or releasing custody", async () => {
  const fixture = capacityFixture();
  const paths = options(fixture.capacity);
  writeFileSync(join(paths.cwd, "threads.owner.json"), JSON.stringify({ threadId: "another-uid", databasePath: paths.databasePath,
    unit: "pi-native-01234567.scope", cgroup: "/user.slice/fixture/pi-native-01234567.scope", uid: process.getuid!() + 1,
    bootId: "942aba85-5d69-45dc-a708-065084d6e4c4" }));
  const absent = vi.fn(async () => ({ ok: true as const, value: true }));
  expect(await recoverNativeSessionOwners(paths.cwd, { capacity: fixture.capacity, absent })).toMatchObject({ ok: false, error: { code: "unavailable", message: expect.stringContaining("Invalid native owner record") } });
  expect(absent).not.toHaveBeenCalled();
  expect(fixture.release).not.toHaveBeenCalled();
});

it("rejects a cgroup belonging to another unit before considering absence", async () => {
  const fixture = capacityFixture();
  const paths = options(fixture.capacity);
  writeFileSync(join(paths.cwd, "threads.owner.json"), JSON.stringify({ threadId: "invalid-owner", databasePath: paths.databasePath,
    unit: "pi-native-01234567.service", cgroup: "/user.slice/another.service", bootId: "942aba85-5d69-45dc-a708-065084d6e4c4" }));
  const absent = vi.fn(async () => ({ ok: true as const, value: true }));
  expect(await recoverNativeSessionOwners(paths.cwd, { capacity: fixture.capacity, absent })).toMatchObject({ ok: false, error: { code: "unavailable", message: expect.stringContaining("Invalid native owner record") } });
  expect(absent).not.toHaveBeenCalled();
  expect(fixture.release).not.toHaveBeenCalled();
});

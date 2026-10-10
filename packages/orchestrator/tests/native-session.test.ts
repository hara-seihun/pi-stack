import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "@earendil-works/pi-agent-core";
import { SessionManager, type AgentSession } from "@earendil-works/pi-coding-agent";
import { afterEach, expect, it, vi } from "vitest";
import { AgentCapacityAuthority } from "../src/agent-capacity-authority.js";
import type { AgentCapacity, AgentExecution, CapacityCustody } from "../src/agent-capacity.js";
import type { Result } from "../src/threads/contracts.js";
import { createManagedAgentSession } from "../src/threads/native-session.js";
import { recoverNativeSessionOwners, type NativeOwnerRecord } from "../src/threads/native-owner-recovery.js";
import { ThreadCapacityLedger } from "../src/threads/capacity-ledger.js";
import { openSqlite } from "../src/sqlite.js";
import { seedPiSession } from "../src/threads/pi-session-file.js";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
function value<T>(result: Result<T>): T { if (!result.ok) throw new Error(result.error.message); return result.value; }
function capacityFixture() {
  const authority = new AgentCapacityAuthority(":memory:"); cleanups.push(() => authority.close());
  value(authority.initialize([]));
  const release = vi.fn(async (custody: CapacityCustody) => authority.release("fixture", custody));
  const capacity: AgentCapacity = {
    acquire: vi.fn(async (execution: AgentExecution) => {
      const acquired = authority.acquire("fixture", execution);
      return acquired.ok ? { ok: true as const, value: { ...acquired.value, release: () => release(acquired.value) } } : acquired;
    }), release, inspect: async execution => authority.inspect("fixture", execution), withdraw: async execution => authority.withdraw("fixture", execution),
  };
  return { authority, capacity, release };
}
function options(capacity: AgentCapacity) {
  const cwd = mkdtempSync(join(tmpdir(), "managed-native-session-"));
  cleanups.push(() => rmSync(cwd, { recursive: true, force: true }));
  return { cwd, databasePath: join(cwd, "threads.sqlite3"), sessionsDir: join(cwd, "sessions"), capacity };
}
function nativeFixture(paths: ReturnType<typeof options>, execute = async () => ({ content: [{ type: "text" as const, text: "done" }], details: {} })) {
  const file = join(paths.cwd, "native.jsonl"); seedPiSession(file, paths.cwd);
  const manager = SessionManager.open(file);
  const agent = new Agent({ initialState: { tools: [{ name: "fixture_tool", label: "Fixture", description: "Fixture", parameters: { type: "object" }, execute }] }, streamFn: () => { throw new Error("No provider in native fixture"); } });
  const queue: any[] = [];
  let queued!: () => void; const queuedMessage = new Promise<void>(resolve => { queued = resolve; });
  const dispose = vi.fn();
  const session = { agent, sessionManager: manager, sessionFile: file, sessionId: manager.getSessionId(),
    get messages() { return agent.state.messages; }, get isStreaming() { return agent.state.isStreaming; }, get isIdle() { return !agent.state.isStreaming; },
    isCompacting: false, isBashRunning: false, pendingMessageCount: 0,
    subscribe: () => () => {}, sendCustomMessage: async (message: unknown) => { queue.push(message); queued(); },
    prompt: async () => {}, steer: async () => {}, followUp: async () => {},
    abortCompaction: () => {}, abortBash: () => {}, abort: async () => { agent.abort(); await agent.waitForIdle(); }, dispose,
  } as unknown as AgentSession;
  return { session, manager, queue, dispose, queuedMessage };
}
it("preserves a native construction failure through cleanup", async () => {
  const paths = options(capacityFixture().capacity), error = new Error("Resource construction failed");
  await expect(createManagedAgentSession(async () => { throw error; }, paths)).rejects.toBe(error);
});
it("native UI inputs use the same durable batch adapter and close is idempotent", async () => {
  const paths = options(capacityFixture().capacity), f = nativeFixture(paths);
  const managed = await createManagedAgentSession(async () => ({ session: f.session }), paths);
  await managed.session.prompt("exact native input\n\nwhitespace  ");
  await f.queuedMessage;
  const receipt = f.manager.getEntries().find(entry => entry.type === "custom" && entry.customType === "thread_input_batch_accepted");
  expect(receipt?.type === "custom" ? receipt.data : undefined).toMatchObject({ inputs: [{ message: "exact native input\n\nwhitespace  " }] });
  expect(f.queue).toHaveLength(1);
  expect(managed.session.agent.state.tools.some(tool => tool.name === "tool_operation")).toBe(true);
  await managed.close(); await managed.close();
  expect(f.dispose).toHaveBeenCalledTimes(1);
});
it("external tools use operation custody without acquiring a parked model lease", async () => {
  const cap = capacityFixture(), paths = options(cap.capacity);
  let finish!: () => void; const gate = new Promise<void>(resolve => { finish = resolve; });
  const f = nativeFixture(paths, async () => { await gate; return { content: [{ type: "text", text: "done" }], details: {} }; });
  const managed = await createManagedAgentSession(async () => ({ session: f.session }), paths);
  const running = managed.session.agent.state.tools[0]!.execute("external-call", {}, undefined);
  await Promise.resolve(); await Promise.resolve();
  expect(cap.authority.status().active).toBe(0);
  finish(); expect(await running).toMatchObject({ content: [{ text: "done" }] });
  await managed.close();
});

it.each<{ label: string; proof: Result<boolean>; active: number; nested?: true; scope?: true }>([
  { label: "positive native-owner absence", proof: { ok: true, value: true }, active: 0 },
  { label: "nested canonical native-owner database", proof: { ok: true, value: true }, active: 0, nested: true },
  { label: "same-UID foreground scope owner", proof: { ok: true, value: true }, active: 0, scope: true },
  { label: "a still-present native owner", proof: { ok: true, value: false }, active: 1 },
  { label: "an unavailable absence proof", proof: { ok: false, error: { code: "unavailable", message: "fixture absence unknown" } }, active: 1 },
])("recovers crash custody only on positive absence: $label", async ({ proof, active, nested, scope }) => {
  const fixture = capacityFixture(), paths = options(fixture.capacity);
  const directory = nested ? join(paths.cwd, "b941ac15-36b6-42f2-928f-17b98f71a937") : paths.cwd;
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (nested) paths.databasePath = join(directory, "threads.sqlite3");
  const owner: NativeOwnerRecord = { threadId: "crashed-native-thread", databasePath: paths.databasePath,
    unit: `pi-native-01234567.${scope ? "scope" : "service"}`, cgroup: `/user.slice/fixture/pi-native-01234567.${scope ? "scope" : "service"}`, bootId: "942aba85-5d69-45dc-a708-065084d6e4c4", ...(scope ? { uid: process.getuid!() } : {}) };
  const db = openSqlite(paths.databasePath);
  try {
    db.exec("CREATE TABLE thread(id TEXT PRIMARY KEY,state TEXT,held INTEGER,metadata TEXT); CREATE TABLE thread_request(id TEXT PRIMARY KEY,kind TEXT,target TEXT,response TEXT)");
    db.prepare("INSERT INTO thread VALUES(?,'running',0,?)").run(owner.threadId, JSON.stringify({ runnerReference: { control: "stopped-unit" } }));
    db.prepare("INSERT INTO thread_request VALUES(?,'command',?,NULL)").run("crashed-command", owner.threadId);
    const ledger = new ThreadCapacityLedger(db, fixture.capacity);
    value(await ledger.acquire(owner.threadId, "crashed-execution", "crashed-command", "command")); ledger.entered(owner.threadId, "crashed-execution");
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
    const ledger = new ThreadCapacityLedger(reopened, fixture.capacity); expect(ledger.current(owner.threadId)).toHaveLength(active);
    const thread = reopened.prepare("SELECT state,metadata FROM thread WHERE id=?").get(owner.threadId) as { state: string; metadata: string };
    const command = reopened.prepare("SELECT response FROM thread_request WHERE id='crashed-command'").get() as { response: string | null };
    if (active) {
      expect(ledger.current(owner.threadId)[0]).toMatchObject({ state: "held", entered_native: 1 }); expect(thread.state).toBe("running");
      expect(command.response).toBeNull(); expect(JSON.parse(thread.metadata).runnerReference).toBeDefined();
    } else {
      expect(thread.state).toBe("idle"); expect(JSON.parse(command.response!)).toMatchObject({ ok: false, error: { code: "unavailable" } });
      expect(JSON.parse(thread.metadata).runnerReference).toBeUndefined(); expect(JSON.parse(thread.metadata).commandError).toMatch(/cannot be replayed/);
    }
  } finally { reopened.close(); }
  if (active === 0) {
    expect(await recoverNativeSessionOwners(paths.cwd, { capacity: fixture.capacity, absent })).toEqual({ ok: true, value: undefined });
    expect(absent).toHaveBeenCalledTimes(1); expect(fixture.release).toHaveBeenCalledTimes(1);
  }
}, 3000);
it("rejects linked owner roots without reading the target or releasing custody", async () => {
  const fixture = capacityFixture(), paths = options(fixture.capacity), target = join(paths.cwd, "private-target");
  mkdirSync(target); writeFileSync(join(target, "threads.owner.json"), "not readable owner metadata");
  symlinkSync(target, join(paths.cwd, "b941ac15-36b6-42f2-928f-17b98f71a937"));
  const absent = vi.fn(async () => ({ ok: true as const, value: true }));
  expect(await recoverNativeSessionOwners(paths.cwd, { capacity: fixture.capacity, absent })).toMatchObject({ ok: false, error: { code: "unavailable", message: expect.stringContaining("must not be a link") } });
  expect(absent).not.toHaveBeenCalled(); expect(fixture.release).not.toHaveBeenCalled();
});
it("rejects another UID's scope before asking its manager or releasing custody", async () => {
  const fixture = capacityFixture(), paths = options(fixture.capacity);
  writeFileSync(join(paths.cwd, "threads.owner.json"), JSON.stringify({ threadId: "another-uid", databasePath: paths.databasePath,
    unit: "pi-native-01234567.scope", cgroup: "/user.slice/fixture/pi-native-01234567.scope", uid: process.getuid!() + 1, bootId: "942aba85-5d69-45dc-a708-065084d6e4c4" }));
  const absent = vi.fn(async () => ({ ok: true as const, value: true }));
  expect(await recoverNativeSessionOwners(paths.cwd, { capacity: fixture.capacity, absent })).toMatchObject({ ok: false, error: { code: "unavailable", message: expect.stringContaining("Invalid native owner record") } });
  expect(absent).not.toHaveBeenCalled(); expect(fixture.release).not.toHaveBeenCalled();
});
it("rejects a cgroup belonging to another unit before considering absence", async () => {
  const fixture = capacityFixture(), paths = options(fixture.capacity);
  writeFileSync(join(paths.cwd, "threads.owner.json"), JSON.stringify({ threadId: "invalid-owner", databasePath: paths.databasePath,
    unit: "pi-native-01234567.service", cgroup: "/user.slice/another.service", bootId: "942aba85-5d69-45dc-a708-065084d6e4c4" }));
  const absent = vi.fn(async () => ({ ok: true as const, value: true }));
  expect(await recoverNativeSessionOwners(paths.cwd, { capacity: fixture.capacity, absent })).toMatchObject({ ok: false, error: { code: "unavailable", message: expect.stringContaining("Invalid native owner record") } });
  expect(absent).not.toHaveBeenCalled(); expect(fixture.release).not.toHaveBeenCalled();
});

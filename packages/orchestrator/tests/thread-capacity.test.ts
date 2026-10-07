import { afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AgentCapacityAuthority, createAgentCapacityServer } from "../src/agent-capacity-authority.js";
import { configuredAgentCapacity, type AgentCapacity } from "../src/agent-capacity.js";
import { ThreadService } from "../src/threads/service.js";
import { RunnerStartupError } from "../src/threads/runner-startup.js";
import type { PiCommand, PiEvent, PiSession, PiSessionOptions, Result } from "../src/threads/contracts.js";

const unwrap = <T>(result: Result<T>): T => { if (!result.ok) throw new Error(result.error.message); return result.value; };
async function until(check: () => boolean) { for (let i = 0; i < 300; i++) { if (check()) return; await new Promise<void>(resolve => setImmediate(resolve)); } throw new Error("Expected capacity transition did not arrive"); }
const roots: string[] = [], owners: ThreadService[] = [], authorities: AgentCapacityAuthority[] = [], servers: ReturnType<typeof createAgentCapacityServer>[] = [];
function client(authority: AgentCapacityAuthority, owner: string, releaseState = { available: true }): AgentCapacity {
  return {
    async acquire(execution) { const result = authority.acquire(owner, execution); return result.ok ? { ok: true, value: { ...result.value, release: () => this.release(result.value) } } : result; },
    async release(custody) { return releaseState.available ? authority.release(owner, custody) : { ok: false, error: { code: "unavailable", message: "Global agent capacity: release acknowledgement unavailable" } }; },
    async inspect(execution) { return authority.inspect(owner, execution); },
    async withdraw(execution) { return authority.withdraw(owner, execution); },
  };
}
class Native implements PiSession {
  busy = false;
  abortFails = false;
  commandBusy = false;
  accepted = new Set<string>();
  completed = new Set<string>();
  lastAssistantMessage: Record<string, unknown> | undefined;
  constructor(readonly options: PiSessionOptions, private output: (event: PiEvent) => void) { writeFileSync(options.sessionFile, ""); }
  bind(output: (event: PiEvent) => void) { this.output = output; }
  async command(command: PiCommand) {
    if (command.type === "abort" && this.abortFails) throw new Error("Tool cancellation unconfirmed");
    if (command.type === "prompt" || command.type === "steer") { this.busy = true; this.accepted.add(String(command.workId)); this.output({ type: "agent_start" }); }
    if (command.type === "compact") { this.busy = true; this.commandBusy = true; this.output({ type: "compaction_start" }); }
    if (command.type === "abort") { this.busy = false; this.commandBusy = false; }
    this.output({ type: "response", id: command.id, command: command.type, success: true,
      data: command.type === "get_state" ? { isStreaming: this.busy && !this.commandBusy, isCompacting: this.commandBusy, pendingMessageCount: 0, acceptedWorkIds: [...this.accepted], completedWorkIds: [...this.completed], sessionFile: this.options.sessionFile, lastAssistantMessage: this.lastAssistantMessage } : {} });
  }
  settle() {
    this.busy = false; this.commandBusy = false;
    for (const id of this.accepted) this.completed.add(id);
    this.lastAssistantMessage = { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "done" }], timestamp: Date.now() };
    this.output({ type: "message_end", message: this.lastAssistantMessage });
    this.output({ type: "agent_settled", workIds: [...this.completed], outcome: "complete", lastAssistantMessage: this.lastAssistantMessage });
  }
  finishCommand() { this.busy = false; this.commandBusy = false; this.output({ type: "compaction_end" }); }
  async close() { if (this.busy) throw new Error("Native custody still active"); }
}
function fixture(capacity: AgentCapacity | { mode: "unmanaged" } | undefined, root?: string, sessions = new Map<string, Native>()) {
  root ??= mkdtempSync(join(tmpdir(), "thread-capacity-")); if (!roots.includes(root)) roots.push(root);
  const options: ConstructorParameters<typeof ThreadService>[0] = { capacity, databasePath: join(root, "threads.sqlite3"), sessionsDir: root,
    openSession: async (input: PiSessionOptions, output: (event: PiEvent) => void) => {
      let native = sessions.get(input.threadId); if (native) native.bind(output); else { native = new Native(input, output); sessions.set(input.threadId, native); }
      output({ type: "runner_attached", control: join(root!, "control.sock"), socketPath: join(root!, input.threadId) });
      return native;
    },
    attachSession: async (reference: { control: string; socketPath: string } | undefined, output: (event: PiEvent) => void) => {
      if (!reference) return null; const native = sessions.get(reference.socketPath.split("/").at(-1)!); if (!native) return null; native.bind(output); return native;
    },
  };
  const service = new ThreadService(options); owners.push(service); return { service, root, sessions, options };
}
function authority() { const value = new AgentCapacityAuthority(":memory:"); authorities.push(value); unwrap(value.initialize([])); return value; }
afterEach(async () => {
  for (const owner of owners.splice(0)) {
    for (const thread of owner.snapshot()) { const runtime = (owner as any).runtimes.get(thread.id); if (runtime?.session instanceof Native) runtime.session.abortFails = false; await owner.control({ threadId: thread.id, action: "cancel" }); }
    await owner.detach();
  }
  for (const server of servers.splice(0)) await new Promise<void>(resolve => server.close(() => resolve()));
  for (const value of authorities.splice(0)) value.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

it("one hard100 gate covers parallel owners, foreground/background and arbitrary launch ancestry", async () => {
  const shared = authority(), fixtures = [fixture(client(shared, "host-a/alice")), fixture(client(shared, "host-b/bob")), fixture(client(shared, "host-a/app"))];
  for (let owner = 0; owner < fixtures.length; owner++) {
    unwrap(await fixtures[owner]!.service.spawn({ id: `origin-${owner}`, requestId: `origin-${owner}`, cwd: fixtures[owner]!.root }));
    for (let i = 0; i < 42; i++) unwrap(await fixtures[owner]!.service.spawn({ id: `agent-${owner}-${i}`, requestId: `work-${owner}-${i}`, ...(i % 3 ? { parentId: `origin-${owner}` } : {}), cwd: fixtures[owner]!.root, message: "work", admission: i % 2 ? "background" : "force", metadata: { source: i % 3 ? "direct" : "lane", ...(i % 6 === 0 ? { mode: "live" } : {}) } }));
  }
  for (const f of fixtures) {
    for (const thread of f.service.snapshot().filter((_thread, index) => index % 2 === 0)) unwrap(await f.service.control({ threadId: thread.id, action: "open" }));
    unwrap(await f.service.start());
  }
  await until(() => fixtures.reduce((sum, f) => sum + [...f.sessions.values()].filter(native => native.busy).length, 0) === 100 && shared.status().queued === 26);
  expect(shared.status()).toMatchObject({ active: 100, queued: 26 });
  expect(fixtures.flatMap(f => f.service.snapshot()).filter(thread => thread.metadata?.admissionWait).every(thread => String((thread.metadata!.admissionWait as any).message).includes("Global agent limit 100/100"))).toBe(true);
  const running = fixtures.flatMap(f => [...f.sessions.values()]).find(native => native.busy)!;
  running.settle(); await until(() => shared.status().active === 99);
  for (const f of fixtures) { (f.service as any).db.exec("UPDATE thread SET metadata=json_remove(metadata,'$.admissionWait')"); f.service.reconcile(); }
  await until(() => shared.status().active === 100 && shared.status().queued === 25);
});

it("lost cancellation confirmation and restart retain one stable agent's capacity custody", async () => {
  const shared = authority(), f = fixture(client(shared, "host-a/alice"));
  unwrap(await f.service.spawn({ id: "retained", requestId: "work", cwd: f.root, message: "work" })); unwrap(await f.service.start());
  await until(() => f.sessions.get("retained")?.busy === true);
  const lease = shared.entries()[0]!, native = f.sessions.get("retained")!; native.abortFails = true;
  expect(await f.service.control({ threadId: "retained", action: "cancel" })).toMatchObject({ ok: false, error: { code: "cancellation_failed" } });
  expect(shared.entries()).toEqual([lease]);
  await f.service.detach(); owners.splice(owners.indexOf(f.service), 1);
  const next = fixture(client(shared, "host-a/alice"), f.root, f.sessions);
  unwrap(await next.service.start()); await until(() => !!next.service.get("retained")?.metadata?.executionError);
  expect(shared.entries()).toEqual([lease]);
  native.abortFails = false;
  unwrap(await next.service.control({ threadId: "retained", action: "cancel" }));
  expect(shared.status().active).toBe(0);
});

it("positive settlement releases native capacity even when the release acknowledgement must be replayed", async () => {
  const shared = authority(), releaseState = { available: true }, f = fixture(client(shared, "host-a/alice", releaseState));
  unwrap(await f.service.spawn({ id: "agent", requestId: "work", cwd: f.root, message: "work" })); unwrap(await f.service.start()); await until(() => f.sessions.get("agent")?.busy === true);
  releaseState.available = false; f.sessions.get("agent")!.settle();
  await until(() => f.service.get("agent")?.state === "idle" && !!f.service.get("agent")?.metadata?.capacityRelease);
  expect(shared.status().active).toBe(1);
  releaseState.available = true; f.service.reconcile(); await until(() => shared.status().active === 0);
  expect((f.service as any).db.prepare("SELECT state FROM thread_capacity WHERE thread_id='agent'").get().state).toBe("released");
});

it("dependency waiting releases its slot and the same agent acquires a new execution when messaged", async () => {
  const shared = authority(), f = fixture(client(shared, "host-a/alice"));
  unwrap(await f.service.spawn({ id: "waiter", requestId: "first", cwd: f.root, message: "work" })); unwrap(await f.service.start()); await until(() => f.sessions.get("waiter")?.busy === true);
  const first = shared.entries()[0]!;
  unwrap(await f.service.agentWait({ action: "set", kind: "job", threadId: "waiter", requestId: "wait", reason: "Durable external job", jobId: "job" }));
  f.sessions.get("waiter")!.settle(); await until(() => f.service.get("waiter")?.state === "waiting" && shared.status().active === 0);
  unwrap(await f.service.send({ threadId: "waiter", requestId: "next", text: "Job result" })); await until(() => shared.status().active === 1 && f.sessions.get("waiter")?.busy === true);
  expect(shared.entries()[0]!.agentId).toBe(first.agentId);
  expect(shared.entries()[0]!.executionId).not.toBe(first.executionId);
});

it("unset managed authority configuration queues every launch class instead of opening native", async () => {
  vi.stubEnv("PI_AGENT_CAPACITY_URL", "http://127.0.0.1:1"); vi.stubEnv("PI_AGENT_CAPACITY_OWNER", "fixture"); vi.stubEnv("PI_AGENT_CAPACITY_TOKEN_FILE", "/nonexistent-capacity-fixture-token");
  const f = fixture(undefined);
  for (const admission of ["force", "background"] as const) unwrap(await f.service.spawn({ id: admission, requestId: admission, cwd: f.root, message: "work", admission }));
  unwrap(await f.service.start()); await until(() => f.service.snapshot().every(thread => !!thread.metadata?.admissionWait));
  expect(f.sessions.size).toBe(0);
  expect(f.service.snapshot().every(thread => thread.pendingMessages === 1 && String((thread.metadata!.admissionWait as any).message).includes("Global agent capacity"))).toBe(true);
});

it("an already queued owner recovers missing authority configuration without restarting native or losing its candidate", async () => {
  const shared = authority(), server = createAgentCapacityServer(shared, [{ id: "host-a/alice", token: "capacity-fixture" }]); servers.push(server);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const root = mkdtempSync(join(tmpdir(), "capacity-config-recovery-")), token = join(root, "token"); roots.push(root);
  const configured = configuredAgentCapacity({ PI_AGENT_CAPACITY_URL: `http://127.0.0.1:${(server.address() as { port: number }).port}`, PI_AGENT_CAPACITY_OWNER: "host-a/alice", PI_AGENT_CAPACITY_TOKEN_FILE: token });
  const f = fixture(configured, root); unwrap(await f.service.spawn({ id: "queued", requestId: "work", cwd: root, message: "work" })); unwrap(await f.service.start());
  await until(() => !!f.service.get("queued")?.metadata?.admissionWait);
  const candidate = (f.service as any).db.prepare("SELECT execution_id FROM thread_capacity WHERE thread_id='queued'").get().execution_id;
  expect(f.sessions.size).toBe(0); expect(shared.status().active).toBe(0);
  writeFileSync(token, "capacity-fixture"); (f.service as any).db.exec("UPDATE thread SET metadata=json_remove(metadata,'$.admissionWait')"); f.service.reconcile();
  await until(() => f.sessions.get("queued")?.busy === true);
  expect(shared.entries()[0]!.executionId).toBe(candidate);
});

it("uncertain native startup and failed cancellation never free capacity or create a retry identity", async () => {
  const shared = authority(), f = fixture(client(shared, "host-a/alice"));
  f.options.openSession = async () => { throw new Error("Native open acknowledgement lost"); };
  unwrap(await f.service.spawn({ id: "uncertain", requestId: "work", cwd: f.root, message: "work" })); unwrap(await f.service.start());
  await until(() => !!f.service.get("uncertain")?.metadata?.startupFailure);
  const custody = shared.entries()[0]!;
  for (let i = 0; i < 3; i++) await (f.service as any).drain("uncertain");
  expect(shared.entries()).toEqual([custody]);
  expect(await f.service.control({ threadId: "uncertain", action: "cancel" })).toMatchObject({ ok: false, error: { code: "cancellation_failed" } });
  expect(shared.entries()).toEqual([custody]);
  expect(f.sessions.size).toBe(0);
});

it.each([false, true])("failed pre-native startup releases its original identity and never replies to a result notice, reference=%s", async reference => {
  const shared = authority(), f = fixture(client(shared, "host-a/alice"));
  (f.options as any).retireIdleSession = () => true;
  unwrap(f.service.importThread({ id: "parent", title: "Parent", cwd: f.root, sessionFile: join(f.root, "parent.jsonl"), held: true,
    settings: { model: "sol", thinkingLevel: "high", speed: "standard" } }));
  unwrap(f.service.importThread({ id: "worker", parentId: "parent", title: "Worker", cwd: f.root, sessionFile: join(f.root, "worker.jsonl"),
    settings: { model: "sol", thinkingLevel: "high", speed: "standard" } }));
  unwrap(f.service.importMessage({ id: "assignment", threadId: "worker", senderId: "parent", text: "work", source: "explicit" }));
  unwrap(await f.service.start()); await until(() => f.sessions.get("worker")?.busy === true);
  f.sessions.get("worker")!.settle(); await until(() => f.service.latestSettlement("worker")?.outcome === "complete" && shared.status().active === 0 && !(f.service as any).runtimes.has("worker"));
  const originalReply = f.service.pending("parent");
  const error = "Pi cwd admission rejected thread.cwd: cwd_unavailable: Session cwd cannot be opened";
  const open = vi.fn(async (input: PiSessionOptions, output: (event: PiEvent) => void): Promise<PiSession> => {
    if (reference) output({ type: "runner_attached", control: join(f.root, "control.sock"), socketPath: join(f.root, input.threadId) });
    throw new RunnerStartupError(error);
  });
  f.options.openSession = open; f.options.attachSession = async () => null;
  unwrap(await f.service.send({ requestId: "thread-result:later:worker", threadId: "worker", senderId: "parent", source: "notification", text: "Result received" }));
  await until(() => f.service.latestSettlement("worker")?.workId === "thread-result:later:worker" && shared.status().active === 0);
  const db = (f.service as any).db;
  const row = db.prepare("SELECT * FROM thread_capacity WHERE source_id='thread-result:later:worker'").get();
  expect(row.state).toBe("released");
  expect(f.service.latestSettlement("worker")).toMatchObject({ outcome: "failed", executionId: row.logical_execution_id });
  expect(f.service.pending("parent")).toEqual(originalReply);
  expect(open).toHaveBeenCalledTimes(1);
  await f.service.detach(); owners.splice(owners.indexOf(f.service), 1);
  const next = fixture(client(shared, "host-a/alice"), f.root);
  next.options.openSession = open; unwrap(await next.service.start());
  unwrap(await next.service.control({ threadId: "worker", action: "close" }));
  next.service.reconcile();
  expect(next.service.get("worker")).toMatchObject({ state: "idle", held: false, metadata: { archived: true } });
  expect(next.service.pending("parent")).toEqual(originalReply);
  expect(open).toHaveBeenCalledTimes(1);
});

it("a failed open cannot release retained native custody on an abort acknowledgement without idle proof", async () => {
  const shared = authority(), f = fixture(client(shared, "host-a/alice"));
  let native!: Native;
  f.options.openSession = async (input, output) => {
    output({ type: "runner_attached", control: join(f.root, "control.sock"), socketPath: join(f.root, input.threadId) });
    throw new RunnerStartupError("Pi cwd admission rejected thread.cwd: cwd_unavailable");
  };
  f.options.attachSession = async (_reference, output) => {
    native = new Native({ threadId: "worker", cwd: f.root, sessionFile: join(f.root, "worker.jsonl"), args: [], env: {} }, output);
    native.busy = true;
    const command = native.command.bind(native);
    native.command = async value => {
      if (value.type === "abort") output({ type: "response", id: value.id, command: "abort", success: true, data: {} });
      else await command(value);
    };
    return native;
  };
  unwrap(await f.service.spawn({ id: "worker", requestId: "assignment", cwd: f.root, message: "work" }));
  unwrap(await f.service.start());
  await until(() => String(f.service.get("worker")?.metadata?.executionError).includes("has not positively settled"));
  expect(shared.status().active).toBe(1);
  expect(f.service.latestSettlement("worker")).toBeNull();
  expect(f.service.pending("worker")).toMatchObject([{ id: "assignment", state: "queued" }]);
  expect(await f.service.control({ threadId: "worker", action: "close" })).toMatchObject({ ok: false, error: { code: "cancellation_failed" } });
  expect(shared.status().active).toBe(1);
  native.busy = false;
});

function failedStartupFixture(releaseState = { available: true }) {
  const shared = authority(), f = fixture(client(shared, "host-a/alice", releaseState));
  const error = "Error: Pi cwd admission rejected thread.cwd: cwd_unavailable: Session cwd cannot be opened";
  unwrap(f.service.importThread({ id: "worker", title: "Worker", cwd: f.root, sessionFile: join(f.root, "worker.jsonl"), held: true,
    settings: { model: "sol", thinkingLevel: "high", speed: "standard" }, metadata: { startupFailure: { workId: "result", nativeNotReady: true, error }, executionError: "Native startup custody has no positive absence or settlement proof; global custody retained" } }));
  unwrap(f.service.importMessage({ id: "result", threadId: "worker", source: "notification", text: "prior result", state: "done", outcome: "failed", executionId: "synthetic-failure" }));
  const db = (f.service as any).db;
  db.prepare("UPDATE thread_execution SET error=? WHERE id='synthetic-failure'").run(error);
  db.exec("UPDATE thread SET state='running' WHERE id='worker'");
  const custody = unwrap(shared.acquire("host-a/alice", { agentId: "worker", executionId: "original-startup" }));
  db.prepare("INSERT INTO thread_capacity(execution_id,logical_execution_id,thread_id,source_id,kind,state,lease_id,entered_native) VALUES('original-startup','original-startup','worker','result','work','held',?,1)").run(custody.leaseId);
  return { ...f, shared, db, custody };
}

it.each([true, false])("recovers persisted failed/unlanded cwd proof across restart without replay, release available=%s", async available => {
  const releaseState = { available }, f = failedStartupFixture(releaseState);
  await f.service.detach(); owners.splice(owners.indexOf(f.service), 1);
  const next = fixture(client(f.shared, "host-a/alice", releaseState), f.root);
  const open = vi.fn(async (): Promise<PiSession> => { throw new Error("Must not replay failed work"); }); next.options.openSession = open;
  unwrap(await next.service.start());
  await until(() => next.service.get("worker")?.state === "idle");
  expect(f.shared.status().active).toBe(available ? 0 : 1);
  expect(next.service.latestSettlement("worker")).toMatchObject({ outcome: "failed", workId: "result", executionId: "synthetic-failure" });
  unwrap(await next.service.control({ threadId: "worker", action: "close" }));
  expect(next.service.get("worker")).toMatchObject({ held: false, state: "idle", metadata: { archived: true } });
  releaseState.available = true; next.service.reconcile(); await until(() => f.shared.status().active === 0);
  expect((next.service as any).db.prepare("SELECT state FROM thread_capacity WHERE execution_id='original-startup'").get().state).toBe("released");
  expect(open).not.toHaveBeenCalled();
});

it.each(["untyped", "inserted", "landed", "different-error", "different-source", "command", "live", "uncertain-reference"])("retains persisted custody without exact failed pre-native proof: %s", async missing => {
  const f = failedStartupFixture();
  if (missing === "untyped") f.db.exec("UPDATE thread SET metadata=json_set(metadata,'$.startupFailure.nativeNotReady',json('false'))");
  if (missing === "inserted") f.db.exec("UPDATE thread_work SET inserted_at=1 WHERE id='result'");
  if (missing === "landed") f.db.exec("UPDATE thread_work SET landed_at=1 WHERE id='result'");
  if (missing === "different-error") f.db.exec("UPDATE thread_execution SET error='Native open acknowledgement lost' WHERE id='synthetic-failure'");
  if (missing === "different-source") f.db.exec("UPDATE thread_capacity SET source_id='unknown' WHERE execution_id='original-startup'");
  if (missing === "command") f.db.exec("UPDATE thread_capacity SET kind='command' WHERE execution_id='original-startup'");
  if (missing === "live") unwrap(f.service.importMessage({ id: "live-work", threadId: "worker", text: "live", state: "dispatched", executionId: "live-execution" }));
  if (missing === "uncertain-reference") {
    f.db.exec("UPDATE thread SET metadata=json_set(metadata,'$.runnerReference',json('{\"control\":\"control.sock\",\"socketPath\":\"worker.sock\"}'))");
    f.options.attachSession = async () => { throw new Error("Runner status unconfirmed"); };
  }
  const before = f.shared.entries();
  expect(await f.service.control({ threadId: "worker", action: "close" })).toMatchObject({ ok: false, error: { code: "cancellation_failed" } });
  expect(f.shared.entries()).toEqual(before);
  expect(f.service.get("worker")).toMatchObject({ state: "running", held: true });
  expect(f.service.get("worker")?.metadata?.archived).not.toBe(true);
});

it("legacy synthetic native-census custody releases only after positive native idle proof", async () => {
  const shared = new AgentCapacityAuthority(":memory:"); authorities.push(shared);
  const original = fixture({ mode: "unmanaged" }); unwrap(await original.service.spawn({ id: "legacy", requestId: "create", cwd: original.root }));
  unwrap(await original.service.command("legacy", { type: "compact", id: "old-command" }));
  await original.service.detach(); owners.splice(owners.indexOf(original.service), 1);
  unwrap(shared.initialize([{ ownerId: "host-a/alice", agentId: "legacy", executionId: "native-census:legacy" }]));
  const next = fixture(client(shared, "host-a/alice"), original.root, original.sessions); unwrap(await next.service.start());
  await until(() => String((next.service.get("legacy")?.metadata?.admissionWait as any)?.message).includes("still executing"));
  expect(shared.status().active).toBe(1);
  original.sessions.get("legacy")!.finishCommand(); await until(() => shared.status().active === 0);
});

it("manual compaction consumes a slot only until positively idle, without creating an agent execution", async () => {
  const shared = authority(), f = fixture(client(shared, "host-a/alice"));
  unwrap(await f.service.spawn({ id: "agent", requestId: "create", cwd: f.root }));
  unwrap(await f.service.command("agent", { type: "compact", id: "compact-one" }));
  expect(shared.status().active).toBe(1);
  expect((f.service as any).db.prepare("SELECT COUNT(*) AS n FROM thread_execution").get().n).toBe(0);
  f.sessions.get("agent")!.finishCommand(); await until(() => shared.status().active === 0);
});

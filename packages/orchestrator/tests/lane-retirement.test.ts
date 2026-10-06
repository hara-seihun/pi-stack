import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";
import { Daemon } from "../src/daemon.js";
import { Store } from "../src/store.js";
import type { PiCommand, PiEvent, PiSession, PiSessionOptions, Result } from "../src/threads/contracts.js";

const unwrap = <T>(result: Result<T>): T => { if (!result.ok) throw new Error(result.error.message); return result.value; };
async function until(check: () => boolean) {
  for (let i = 0; i < 200; i++) { if (check()) return; await new Promise(resolve => setImmediate(resolve)); }
  throw new Error("Lane lifecycle did not reach boundary");
}
class NativeFixture implements PiSession {
  streaming = false;
  closed = false;
  commands: PiCommand[] = [];
  accepted = new Set<string>();
  completed = new Set<string>();
  closeAttempt = vi.fn(async () => {});
  setActive = vi.fn(async (_active: boolean) => {});
  constructor(readonly options: PiSessionOptions, readonly output: (event: PiEvent) => void) {
    output({ type: "runner_attached", control: "fixture.control", socketPath: `${options.threadId}.sock` });
  }
  async command(command: PiCommand) {
    this.commands.push(command);
    if (command.type === "prompt" || command.type === "steer") {
      this.accepted.add(String(command.workId)); this.streaming = true; this.output({ type: "agent_start" });
    }
    if (command.type === "abort") this.streaming = false;
    this.output({ type: "response", id: command.id, command: command.type, success: true, data: command.type === "get_state" ? {
      isStreaming: this.streaming, pendingMessageCount: 0, sessionFile: this.options.sessionFile,
      acceptedWorkIds: [...this.accepted], completedWorkIds: [...this.completed],
    } : {} });
  }
  settle() {
    for (const id of this.accepted) this.completed.add(id);
    this.streaming = false;
    this.output({ type: "agent_settled", outcome: "complete", workIds: [...this.completed], lastAssistantMessage: { role: "assistant", content: [{ type: "text", text: "done" }], stopReason: "stop" } });
  }
  async close() { await this.closeAttempt(); this.closed = true; }
}
function fixture(ids = ["lane"]) {
  const root = mkdtempSync(join(tmpdir(), "lane-retirement-"));
  const store = Store.open(join(root, "ledger.sqlite3"));
  store.reconcileLanes(ids.map(id => ({ id, prompt: "work", cwd: root, profile: "sol", admission: "force", weight: 1, ...(id !== "uncapped" ? { maxActive: 1 } : {}) })));
  const daemon = new Daemon(store, { ...loadConfig(join(root, "missing")), modelBrokerUrl: "http://127.0.0.1:2461", maxConcurrentSessions: 20 });
  const service = daemon.threads, sessions: NativeFixture[] = [], release = vi.fn();
  const options = (service as any).options;
  options.admit = async () => ({ ok: true, value: { env: { PI_MODEL_BROKER_URL: "http://127.0.0.1:2461" }, release } });
  options.openSession = async (input: PiSessionOptions, output: (event: PiEvent) => void) => { const session = new NativeFixture(input, output); sessions.push(session); return session; };
  return { root, daemon: daemon as any, service, sessions, release,
    async close() { await service.close(); await (daemon as any).schedules.close(); store.close(); rmSync(root, { recursive: true, force: true }); } };
}

it("naturally readmits twenty bounded lanes for two cycles, never freeing a still-closing native owner", async () => {
  const f = fixture(Array.from({ length: 20 }, (_, i) => `lane:${i}`));
  try {
    unwrap(await f.service.start()); await f.daemon.fillCapacity();
    await until(() => f.sessions.length === 20 && f.sessions.every(s => s.streaming));
    const first = [...f.sessions]; let acknowledge!: () => void;
    first[0]!.closeAttempt.mockImplementation(() => new Promise<void>(resolve => { acknowledge = resolve; }));
    for (const session of first) session.settle();
    await until(() => first.slice(1).every(s => s.closed) && !!acknowledge);
    expect(f.service.runningSummary().total).toBe(0);
    expect(f.service.laneCustody()).toEqual(new Map([["lane:0", 1]]));
    expect(f.service.get(first[0]!.options.threadId)?.metadata?.runnerReference).toBeDefined();
    await f.daemon.fillCapacity();
    await until(() => f.sessions.length === 39 && f.sessions.slice(20).every(s => s.streaming));
    expect(f.sessions.filter(s => !s.closed)).toHaveLength(20);
    expect(f.service.laneCustody().size).toBe(20);
    acknowledge(); await until(() => first[0]!.closed && !f.service.get(first[0]!.options.threadId)?.metadata?.runnerReference);
    await f.daemon.fillCapacity();
    await until(() => f.sessions.length === 40 && f.sessions[39]!.streaming);
    expect(f.sessions.filter(s => !s.closed)).toHaveLength(20);
    for (const session of f.sessions.slice(20)) session.settle();
    await until(() => f.sessions.every(s => s.closed));
    expect(f.service.laneCustody().size).toBe(0);
    expect(unwrap(f.service.settlements(0, 100)).items).toHaveLength(40);
    expect(f.release).toHaveBeenCalledTimes(40);
    expect(f.service.snapshot()).toHaveLength(40);
    expect(f.sessions.every(s => f.service.get(s.options.threadId)?.sessionFile === s.options.sessionFile)).toBe(true);
  } finally { await f.close(); }
});

it("retains failed native close custody and retries cleanup before readmission", async () => {
  const f = fixture();
  try {
    unwrap(await f.service.start()); await f.daemon.fillCapacity(); await until(() => !!f.sessions[0]?.streaming);
    const first = f.sessions[0]!;
    first.closeAttempt.mockRejectedValue(new Error("Native close unconfirmed")); first.settle();
    await until(() => !!f.service.get(first.options.threadId)?.metadata?.executionError);
    expect(f.service.laneCustody().get("lane")).toBe(1);
    await f.daemon.fillCapacity(); expect(f.sessions).toHaveLength(1); expect(first.closed).toBe(false);
    first.closeAttempt.mockResolvedValue(); f.service.reconcile(); await until(() => first.closed);
    await f.daemon.fillCapacity(); await until(() => f.sessions.length === 2 && f.sessions[1]!.streaming);
    expect(unwrap(f.service.settlements()).items).toHaveLength(1);
  } finally { await f.close(); }
});

it("preserves queued continuation and warm interactive, unbounded, live and waiting coordinators", async () => {
  const f = fixture(["lane", "waiting", "scheduled", "live", "uncapped"]);
  try {
    unwrap(await f.service.start());
    const thread = unwrap(await f.service.spawn({ requestId: "first", cwd: f.root, message: "first", settings: { model: "sol" }, metadata: { laneId: "lane" } }));
    await until(() => !!f.sessions[0]?.streaming);
    unwrap(await f.service.send({ requestId: "next", threadId: thread.id, text: "next", delivery: "queue" }));
    f.sessions[0]!.settle(); await until(() => f.sessions[0]!.commands.some(c => c.workId === "next"));
    expect(f.sessions).toHaveLength(1); expect(f.sessions[0]!.closeAttempt).not.toHaveBeenCalled();
    f.sessions[0]!.settle(); await until(() => f.sessions[0]!.closed);
    for (const id of ["interactive", "uncapped", "waiting", "scheduled", "live"]) {
      const created = unwrap(await f.service.spawn({ requestId: id, cwd: f.root, message: id, settings: { model: "sol" }, metadata: id === "interactive" ? {} : { laneId: id, ...(id === "live" ? { mode: "live" } : {}) } }));
      await until(() => f.sessions.at(-1)?.streaming === true);
      const session = f.sessions.at(-1)!;
      if (id === "waiting") {
        const waiting = unwrap(await f.service.agentWait({ requestId: "wait", threadId: created.id, action: "set", kind: "job", jobId: "durable-job", reason: "durable job" }));
        expect(waiting.waitingOnAgents).toMatchObject({ kind: "job", jobId: "durable-job" });
      }
      if (id === "scheduled") unwrap(await f.service.wakeSchedule({ requestId: "wake", threadId: created.id, action: "set", reason: "recovery", cadenceMs: 60000 }));
      session.settle(); await until(() => session.setActive.mock.calls.some(([active]) => !active));
      f.service.reconcile(); await new Promise(resolve => setImmediate(resolve));
      expect(session.closed).toBe(false); expect(f.service.get(created.id)?.metadata?.runnerReference).toBeDefined();
    }
  } finally { await f.close(); }
});

it("never releases unknown retained native custody or runnable queues, and never resumes held queues", async () => {
  const f = fixture(["unknown", "queued", "held"]);
  const settings = { model: "sol", thinkingLevel: "high" as const, speed: "standard" as const };
  try {
    unwrap(f.service.importState(["unknown", "queued", "held"].map(id => ({ id, title: id, cwd: f.root, sessionFile: join(f.root, `${id}.jsonl`), settings,
      held: id === "held", metadata: { laneId: id, ...(id === "unknown" ? { runnerReference: { control: "unknown.control", socketPath: "unknown.sock" } } : {}) } })),
      ["queued", "held"].map(id => ({ id: `${id}-input`, threadId: id, text: "accepted", settings }))));
    const attach = vi.fn(async () => { throw new Error("Unknown custody must not be guessed idle"); });
    (f.service as any).options.attachSession = attach;
    (f.service as any).options.admit = async () => ({ ok: false, error: { code: "unavailable", message: "No model capacity" } });
    unwrap(await f.service.start());
    await f.daemon.fillCapacity(); await new Promise(resolve => setImmediate(resolve));
    expect(f.service.laneCustody()).toEqual(new Map([["unknown", 1], ["queued", 1], ["held", 1]]));
    expect(f.service.get("unknown")?.metadata?.runnerReference).toBeDefined(); expect(attach).not.toHaveBeenCalled();
    expect(f.service.get("held")).toMatchObject({ held: true, state: "idle", pendingMessages: 1 });
    expect(f.service.pending("held")[0]).toMatchObject({ id: "held-input", state: "queued", insertedAt: null });
    expect(f.sessions).toHaveLength(0);
    expect(f.service.snapshot().filter(t => t.metadata?.laneId === "held")).toHaveLength(2);
  } finally { await f.close(); }
});

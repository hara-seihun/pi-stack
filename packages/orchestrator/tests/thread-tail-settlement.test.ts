import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, test } from "vitest";
import type { PiCommand, PiEvent, PiSessionOptions, Result, WorkOutcome } from "../src/threads/contracts.js";
import { ThreadService } from "../src/threads/service.js";
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const turn = () => new Promise<void>(resolve => setImmediate(resolve));
async function until(check: () => boolean) { for (let n = 0; n < 60; n++) { if (check()) return; await turn(); } throw Error("Settlement fixture did not reach its state"); }
function value<T>(result: Result<T>): T { if (!result.ok) throw Error(result.error.message); return result.value; }
const final = (text: string, stopReason = "stop") => ({ role: "assistant", content: [{ type: "text", text }], stopReason, timestamp: 1 });
class Native {
  accepted = new Set<string>(); completed = new Set<string>(); commands: PiCommand[] = [];
  streaming = false; pendingMessages = 0; tools = 0; last: ReturnType<typeof final> | null = null;
  beforeState?: () => void;
  constructor(readonly options: PiSessionOptions, readonly emit: (event: PiEvent) => void) {}
  async command(command: PiCommand) {
    this.commands.push(command);
    if (command.type === "input_batch") {
      for (const input of command.inputs as { workId: string }[]) this.accepted.add(input.workId);
      this.streaming = true; this.emit({ type: "agent_start" });
      this.emit({ type: "thread_landed", workIds: [...this.accepted] });
    }
    if (command.type === "abort") { this.streaming = false; this.pendingMessages = 0; this.tools = 0; }
    if (command.type === "get_state") this.beforeState?.();
    this.emit({ type: "response", id: command.id, command: command.type, success: true, data: command.type === "get_state" ? {
      nativeProtocolVersion: "batch-operations-v1", isStreaming: this.streaming, isCompacting: false, isBashRunning: false,
      localTools: this.tools, pendingMessageCount: this.pendingMessages, pendingCommandCount: 0, backgroundOperationCount: this.tools, cancellationFailed: false,
      sessionFile: this.options.sessionFile, acceptedWorkIds: [...this.accepted], landedWorkIds: [...this.accepted], completedWorkIds: [...this.completed], lastAssistantMessage: this.last,
    } : {} });
  }
  boundary(workIds: string[], message: ReturnType<typeof final> | null, outcome: WorkOutcome = "complete") {
    for (const id of workIds) this.completed.add(id);
    this.last = message;
    this.emit({ type: "agent_settled", workIds, outcome, lastAssistantMessage: message });
  }
  async close() {}
}
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "tail-settlement-")), natives: Native[] = [], events: PiEvent[] = [];
  const databasePath = join(root, "threads.sqlite"), admission = { released: 0 };
  const service = new ThreadService({ capacity: { mode: "unmanaged" }, databasePath, sessionsDir: join(root, "sessions"),
    admit: async () => ({ ok: true, value: { release: () => { admission.released++; } } }),
    openSession: async (options, output) => { const native = new Native(options, output); natives.push(native); return native; } });
  service.subscribe(event => { if ("event" in event) events.push(event.event); });
  cleanups.push(async () => { await service.close(); rmSync(root, { recursive: true, force: true }); });
  const thread = value(await service.spawn({ requestId: "original", cwd: root, message: "original work" }));
  value(await service.control({ threadId: thread.id, action: "placement", foreground: true }));
  value(await service.start()); await until(() => natives[0]?.accepted.has("original") === true);
  const native = natives[0]!;
  for (const id of ["middle", "tail"]) value(await service.send({ requestId: id, threadId: thread.id, text: id }));
  await until(() => native.accepted.size === 3);
  const db = new DatabaseSync(databasePath); cleanups.push(async () => { db.close(); });
  const execution = db.prepare("SELECT id FROM thread_execution WHERE thread_id=? AND ended_at IS NULL").get(thread.id) as { id: string };
  return { service, native, thread, db, execution, events, admission };
}

test.each(["complete", "failed", "cancelled"] as const)("tail-only native receipt completes all assigned current work once with its %s provenance", async outcome => {
  const f = await fixture();
  f.native.boundary(["original"], final("early boundary"));
  await turn(); await turn();
  expect(f.service.latestSettlement(f.thread.id)).toBeNull();
  f.native.completed.add("middle"); f.native.streaming = false;
  const last = final("tail result", outcome === "failed" ? "error" : outcome === "cancelled" ? "aborted" : "stop");
  f.native.boundary(["tail"], last, outcome);
  await until(() => !!f.service.latestSettlement(f.thread.id));
  expect(f.service.latestSettlement(f.thread.id)).toMatchObject({ executionId: f.execution.id, outcome, finalMessage: last });
  expect(f.db.prepare("SELECT id,status,outcome FROM thread_work WHERE execution_id=? ORDER BY ordinal").all(f.execution.id)).toEqual(
    ["original", "middle", "tail"].map(id => ({ id, status: "done", outcome })));
  f.native.boundary(["tail"], last, outcome); await turn(); await turn();
  expect(f.events.filter(event => event.type === "thread_settled")).toHaveLength(1);
  expect(f.admission.released).toBe(1);
  expect(f.native.commands.filter(command => command.type === "input_batch").flatMap(command => (command.inputs as { workId: string }[]).map(input => input.workId))).toEqual(["original", "middle", "tail"]);
});

test.each(["incomplete", "streaming", "queued", "tools", "stale-execution", "second-read-incomplete", "second-read-busy"] as const)("refuses tail completion without exact cumulative idle proof: %s", async refusal => {
  const f = await fixture();
  f.native.completed.add("original"); if (refusal !== "incomplete") f.native.completed.add("middle");
  f.native.streaming = refusal === "streaming";
  if (refusal === "queued") f.native.pendingMessages = 1;
  if (refusal === "tools") f.native.tools = 1;
  let reads = 0;
  f.native.beforeState = () => {
    reads++;
    if (refusal === "second-read-incomplete" && reads === 2) f.native.completed.delete("middle");
    if (refusal === "second-read-busy" && reads === 2) { f.native.streaming = true; f.native.emit({ type: "agent_start" }); }
    if (refusal === "stale-execution" && reads === 1) {
      f.db.prepare("UPDATE thread_execution SET ended_at=? WHERE id=?").run(Date.now(), f.execution.id);
      f.db.prepare("INSERT INTO thread_execution(id,thread_id,work_id,settings,created_at) SELECT 'new-execution',thread_id,work_id,settings,created_at FROM thread_execution WHERE id=?").run(f.execution.id);
    }
  };
  f.native.boundary(["tail"], final("tail result")); await turn(); await turn(); await turn();
  expect(f.events.filter(event => event.type === "thread_settled")).toEqual([]);
  expect(f.db.prepare("SELECT status FROM thread_work WHERE execution_id=?").all(f.execution.id)).toEqual([{ status: "dispatched" }, { status: "dispatched" }, { status: "dispatched" }]);
  f.native.beforeState = undefined;
});

test("cumulative landing proof repairs a missed notification without replay", async () => {
  const f = await fixture();
  f.db.prepare("UPDATE thread_work SET landed_at=NULL WHERE execution_id=?").run(f.execution.id);
  for (const workId of f.native.accepted) f.native.completed.add(workId);
  f.native.streaming = false; f.native.boundary(["tail"], final("landed final"));
  await until(() => !!f.service.latestSettlement(f.thread.id));
  expect(f.db.prepare("SELECT id FROM thread_work WHERE execution_id=? AND landed_at IS NULL").all(f.execution.id)).toEqual([]);
  expect(f.native.commands.filter(command => command.type === "input_batch").flatMap(command => (command.inputs as { workId: string }[]).map(input => input.workId))).toEqual(["original", "middle", "tail"]);
});

test("tail completion retains a registered dependency as pending assignment", async () => {
  const f = await fixture();
  expect(value(await f.service.agentWait({ threadId: f.thread.id, requestId: "wait", action: "set", kind: "job", jobId: "durable-job" })).waitRegistration.status).toBe("registered");
  for (const workId of f.native.accepted) f.native.completed.add(workId);
  f.native.streaming = false; f.native.boundary(["tail"], null);
  await until(() => f.events.some(event => event.type === "thread_settled"));
  expect(f.service.latestSettlement(f.thread.id)).toMatchObject({ assignmentPending: true, outcome: "complete", finalMessage: null });
  expect(f.service.get(f.thread.id)?.metadata?.agentWait).toMatchObject({ kind: "job", jobId: "durable-job" });
  expect(f.events.find(event => event.type === "thread_settled")).toMatchObject({ assignmentPending: true, outcome: "complete" });
  expect(f.db.prepare("SELECT assignment_pending FROM thread_execution WHERE id=?").get(f.execution.id)).toEqual({ assignment_pending: 1 });
  expect(f.admission.released).toBe(1);
});

test("an earlier boundary cannot supply the outcome or final message of a later cumulative completion", async () => {
  const f = await fixture(); f.native.streaming = false;
  for (const workId of f.native.accepted) f.native.completed.add(workId);
  const earlier = final("earlier failure", "error"), latest = final("actual final result");
  f.native.last = latest;
  f.native.emit({ type: "agent_settled", workIds: ["original"], outcome: "failed", lastAssistantMessage: earlier });
  await until(() => !!f.service.latestSettlement(f.thread.id));
  expect(f.service.latestSettlement(f.thread.id)).toMatchObject({ outcome: "complete", finalMessage: latest });
});

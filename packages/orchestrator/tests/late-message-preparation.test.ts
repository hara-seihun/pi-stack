import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ThreadService } from "../src/threads/service.js";
import type { PiCommand, PiEvent, PiSession, Result } from "../src/threads/contracts.js";

const services: ThreadService[] = [], roots: string[] = [];
afterEach(async () => { for (const service of services.splice(0)) await service.close(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const turn = () => new Promise<void>(resolve => setImmediate(resolve));
async function until(check: () => boolean) { for (let n = 0; n < 100; n++) { if (check()) return; await turn(); } throw new Error("Synthetic preparation did not reach its expected state"); }
function value<T>(result: Result<T>): T { if (!result.ok) throw new Error(result.error.message); return result.value; }
class Native implements PiSession {
  commands: PiCommand[] = []; accepted = new Set<string>(); busy = false; closed = false;
  constructor(private output: (event: PiEvent) => void) {}
  async command(command: PiCommand) {
    this.commands.push(command);
    if (command.type === "input_batch") { for (const input of command.inputs as { workId: string }[]) { this.accepted.add(input.workId); this.output({ type: "thread_landed", workIds: [input.workId], batchId: command.batchId }); } this.busy = true; this.output({ type: "agent_start" }); }
    if (command.type === "abort") this.busy = false;
    this.output({ type: "response", id: command.id, command: command.type, success: true, data: command.type === "get_state" ? { nativeProtocolVersion: "batch-operations-v1", isStreaming: this.busy, pendingMessageCount: 0, backgroundOperationCount: 0, acceptedWorkIds: [...this.accepted], landedWorkIds: [...this.accepted], completedWorkIds: [] } : {} });
  }
  async close() { this.closed = true; }
}
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "late-preparation-")); roots.push(root);
  const natives: Native[] = []; let ready = false, attempts = 0;
  const service = new ThreadService({ databasePath: join(root, "threads.sqlite"), sessionsDir: root, capacity: { mode: "unmanaged" },
    openSession: async (_options, output) => { const native = new Native(output); natives.push(native); return native; },
    prepareMessage: async (_thread, message) => { attempts++; return ready ? { ok: true, value: { text: message.text } } : { ok: false, error: { code: "unavailable", retryable: true, retryAt: 0, message: "Synthetic callback socket has not appeared" } }; } });
  services.push(service);
  return { root, service, natives, ready: (value: boolean) => { ready = value; }, attempts: () => attempts };
}

test("late preparation remains a durable dependency beyond the startup failure budget, then dispatches original IDs once", async () => {
  const f = fixture(); value(await f.service.start());
  const thread = value(await f.service.spawn({ requestId: "original-input", cwd: f.root, message: "Original accepted bytes" }));
  await until(() => f.attempts() === 1);
  for (let n = 2; n <= 5; n++) { f.service.reconcile(); await until(() => f.attempts() === n); await turn(); }
  const waiting = f.service.get(thread.id)!;
  expect(waiting.held).toBe(false);
  expect(waiting.metadata).toMatchObject({ preparationWait: { dependency: "message-preparation", workId: "original-input", code: "unavailable" } });
  expect(waiting.metadata?.startupFailure).toBeUndefined(); expect(waiting.metadata?.executionError).toBeUndefined();
  expect(waiting.lifecycle).toMatchObject({ kind: "waiting", target: "retry" });
  expect(f.service.pending(thread.id).map(item => item.id)).toEqual(["original-input"]);
  expect(f.natives).toHaveLength(0);
  value(await f.service.detach());
  // The same durable store, not another accepted request, owns recovery after restart.
  const recovered = new ThreadService({ databasePath: join(f.root, "threads.sqlite"), sessionsDir: f.root, capacity: { mode: "unmanaged" }, openSession: async (_options, output) => { const native = new Native(output); f.natives.push(native); return native; }, prepareMessage: async (_thread, message) => ({ ok: true, value: { text: message.text } }) }); services.push(recovered);
  value(await recovered.start()); await until(() => f.natives[0]?.accepted.has("original-input") === true);
  expect(recovered.get(thread.id)?.metadata?.preparationWait).toBeUndefined();
  recovered.reconcile(); await turn();
  expect(f.natives[0]!.commands.filter(c => c.type === "input_batch").flatMap(c => (c.inputs as { workId: string }[]).map(i => i.workId))).toEqual(["original-input"]);
});

test("preparation outage leaves active native execution untouched and resumes only the queued original work", async () => {
  const f = fixture(); f.ready(true); value(await f.service.start());
  const thread = value(await f.service.spawn({ requestId: "already-native", cwd: f.root, message: "Executing" }));
  await until(() => f.natives[0]?.accepted.has("already-native") === true); await turn();
  f.ready(false); value(await f.service.send({ requestId: "queued-original", threadId: thread.id, text: "Queue exact bytes", delivery: "steer" }));
  await until(() => !!f.service.get(thread.id)?.metadata?.preparationWait);
  const native = f.natives[0]!;
  expect(native.busy).toBe(true); expect(native.closed).toBe(false); expect(native.commands.some(c => c.type === "abort")).toBe(false);
  expect(f.service.get(thread.id)?.held).toBe(false);
  f.ready(true); f.service.reconcile(); await until(() => native.accepted.has("queued-original"));
  expect(f.natives).toHaveLength(1);
  expect(native.commands.filter(c => c.type === "input_batch").flatMap(c => (c.inputs as { workId: string }[]).map(i => i.workId))).toEqual(["already-native", "queued-original"]);
});

test("a user stop during the dependency wait stays stopped when preparation returns", async () => {
  const f = fixture(); value(await f.service.start());
  const thread = value(await f.service.spawn({ requestId: "held-original", cwd: f.root, message: "Accepted, then stopped" }));
  await until(() => !!f.service.get(thread.id)?.metadata?.preparationWait);
  value(await f.service.control({ threadId: thread.id, action: "close" }));
  f.ready(true); f.service.reconcile(); await turn();
  expect(f.service.get(thread.id)?.lifecycle.kind).toBe("archived"); expect(f.natives).toHaveLength(0);
  expect(f.service.pending(thread.id).map(item => item.id)).toEqual(["held-original"]);
});

test("a close while preparation is awaiting its callback cannot turn the late response into native work", async () => {
  const root = mkdtempSync(join(tmpdir(), "preparation-stop-race-")); roots.push(root);
  let reply!: (result: Result<{ text: string }>) => void, entered = false;
  const response = new Promise<Result<{ text: string }>>(resolve => { reply = resolve; });
  const natives: Native[] = [];
  const service = new ThreadService({ databasePath: join(root, "threads.sqlite"), sessionsDir: root, capacity: { mode: "unmanaged" }, openSession: async (_options, output) => { const native = new Native(output); natives.push(native); return native; }, prepareMessage: async () => { entered = true; return response; } }); services.push(service);
  value(await service.start()); const thread = value(await service.spawn({ requestId: "original-stopped-race", cwd: root, message: "Do not dispatch after Close" }));
  await until(() => entered);
  value(await service.control({ threadId: thread.id, action: "close" }));
  reply({ ok: true, value: { text: "Do not dispatch after Close" } });
  await turn(); service.reconcile(); await turn();
  expect(service.get(thread.id)?.lifecycle.kind).toBe("archived"); expect(natives).toHaveLength(0);
  expect(service.pending(thread.id).map(item => item.id)).toEqual(["original-stopped-race"]);
});

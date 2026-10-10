import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ThreadService } from "../src/threads/service.js";
import type { PiCommand, PiEvent, PiSession, PiSessionOptions, Result } from "../src/threads/contracts.js";
import { threadTools } from "../src/threads/pi-tools.js";
import { roleTools } from "../src/threads/roles.js";
import { MANAGER_DIGEST_MS } from "../src/threads/manager-watchdog.js";
import { WatchList } from "../src/threads/watch-list.js";

const roots: string[] = [], services: ThreadService[] = [];
const unwrap = <T>(result: Result<T>): T => { if (!result.ok) throw new Error(result.error.message); return result.value; };
const turn = () => new Promise<void>(resolve => setImmediate(resolve));
async function until(check: () => boolean) {
  for (let i = 0; i < 80; i++) { if (check()) return; await turn(); }
  throw new Error("Expected transition did not occur");
}
class Native implements PiSession {
  commands: PiCommand[] = []; accepted: string[] = []; landed: string[] = []; completed: string[] = [];
  streaming = false; background = 0;
  lastAssistantMessage: Record<string, unknown> | null = null;
  constructor(readonly options: PiSessionOptions, readonly output: (event: PiEvent) => void) {}
  async command(command: PiCommand) {
    this.commands.push(command);
    if (command.type === "input_batch") {
      const inputs = command.inputs as Array<{ workId: string }>;
      this.accepted.push(...inputs.map(input => input.workId));
      if (!this.streaming) {
        this.streaming = true; this.landed.push(...this.accepted);
        this.output({ type: "agent_start" });
        this.output({ type: "thread_landed", workIds: this.landed });
      }
    }
    if (command.type === "abort") this.streaming = false;
    this.output({ type: "response", command: command.type, id: command.id, success: true,
      data: command.type === "get_state" ? { isStreaming: this.streaming, backgroundOperationCount: this.background,
        sessionFile: this.options.sessionFile, acceptedWorkIds: this.accepted, landedWorkIds: this.landed,
        completedWorkIds: this.completed, lastAssistantMessage: this.lastAssistantMessage } : {} });
  }
  settle() {
    this.streaming = false; this.completed = [...this.accepted]; this.landed = [...this.accepted];
    this.output({ type: "thread_landed", workIds: this.landed });
    this.lastAssistantMessage = { role: "assistant", content: [{ type: "text", text: "State written to owning Markdown" }], stopReason: "stop", timestamp: Date.now() };
    this.output({ type: "message_end", message: this.lastAssistantMessage });
    this.output({ type: "agent_settled", workIds: this.completed, outcome: "complete", lastAssistantMessage: this.lastAssistantMessage });
  }
  closed = false;
  async close() { this.closed = true; }
}
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "roles-lifecycle-")); roots.push(root);
  const natives: Native[] = [];
  const service = new ThreadService({ capacity: { mode: "unmanaged" }, databasePath: join(root, "threads.sqlite"), sessionsDir: root,
    openSession: async (options, output) => { const native = new Native(options, output); natives.push(native); return native; } });
  services.push(service);
  return { root, service, natives };
}
afterEach(async () => {
  vi.useRealTimers();
  for (const service of services.splice(0)) await service.detach();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("thread roles and accepted input custody", () => {
  it("enforces hierarchy while kenatia keeps authorized listing and messaging", async () => {
    const { root, service } = fixture();
    const manager = unwrap(await service.spawn({ requestId: "manager", cwd: root, title: "Managing the person", metadata: { manager: true } }));
    const kena = unwrap(await service.spawn({ requestId: "kena", parentId: manager.id, cwd: root, title: "Repair a thing" }));
    const kenatia = unwrap(await service.spawn({ requestId: "kenatia", parentId: kena.id, cwd: root, title: "Check the repair" }));
    expect([manager.role, kena.role, kenatia.role]).toEqual(["kenaznia", "kena", "kenatia"]);
    expect((await service.spawn({ requestId: "forbidden", parentId: kenatia.id, cwd: root, title: "Cannot launch" })).ok).toBe(false);
    expect(unwrap(await service.list()).threads.map(thread => thread.id)).toContain(manager.id);
    expect(unwrap(await service.send({ requestId: "peer", threadId: manager.id, senderId: kenatia.id, text: "Repair complete" })).senderName).toBe("Check the repair");
    expect(kena.agentName).toBeUndefined();
    const options: PiSessionOptions = { threadId: kenatia.id, cwd: root, sessionFile: kenatia.sessionFile, args: [], env: { PI_THREAD_ROLE: "kenatia" }, threads: service };
    expect(threadTools(options).map(tool => tool.name)).toEqual(expect.arrayContaining(["thread_list", "thread_send"]));
    expect(threadTools(options).map(tool => tool.name)).not.toContain("thread_spawn");
    expect(threadTools(options).map(tool => tool.name)).not.toContain("thread_wake");
    expect(roleTools("kenaznia", ["bash", "read", "write", "edit", "thread_spawn", "thread_send"])).toEqual(["thread_spawn", "thread_send"]);
  });
  it("batches every queued identity, adopts old delivery values and never interrupts active output", async () => {
    const { root, service, natives } = fixture();
    const worker = unwrap(await service.spawn({ requestId: "first", cwd: root, title: "Write the result", message: "first", ephemeral: true }));
    unwrap(await service.send({ requestId: "second", threadId: worker.id, text: "second", delivery: "queue" }));
    unwrap(await service.send({ requestId: "third", threadId: worker.id, text: "third", delivery: "hardSteer" }));
    expect(service.pending(worker.id).map(input => input.delivery)).toEqual(["pending", "pending", "pending"]);
    unwrap(await service.start());
    await until(() => natives[0]?.commands.some(command => command.type === "input_batch") === true);
    const native = natives[0]!;
    expect((native.commands.find(command => command.type === "input_batch")!.inputs as Array<{ workId: string }>).map(input => input.workId)).toEqual(["first", "second", "third"]);
    expect(service.pending(worker.id)).toEqual([]);
    expect(service.get(worker.id)?.pendingMessages).toBe(0);
    expect(service.inputStates(worker.id)).toHaveLength(3);
    expect(service.inputStates(worker.id).every(input => input.landedAt !== null && input.state === "dispatched")).toBe(true);
    unwrap(await service.send({ requestId: "fourth", threadId: worker.id, text: "fourth", delivery: "hardSteer" }));
    await until(() => native.accepted.includes("fourth"));
    expect(service.pending(worker.id).map(input => input.id)).toEqual(["fourth"]);
    expect(service.get(worker.id)?.pendingMessages).toBe(1);
    expect(native.commands.some(command => command.type === "abort")).toBe(false);
    native.settle();
    await until(() => service.get(worker.id)?.state === "idle");
    expect(service.get(worker.id)?.metadata?.archived).not.toBe(true);
    service.reconcile(); await turn();
    expect(service.get(worker.id)?.metadata?.archived).not.toBe(true);
  });
  it("Close retains pending receipts and explicit reopen makes them available again", async () => {
    const { root, service } = fixture();
    const worker = unwrap(await service.spawn({ requestId: "accepted", cwd: root, title: "Pending work", message: "Do not lose this" }));
    unwrap(await service.control({ threadId: worker.id, action: "close" }));
    expect(service.get(worker.id)?.metadata?.archived).toBe(true);
    expect(service.pending(worker.id).map(input => input.id)).toEqual(["accepted"]);
    unwrap(await service.control({ threadId: worker.id, action: "reopen" }));
    expect(service.pending(worker.id).map(input => input.id)).toEqual(["accepted"]);
    expect(service.get(worker.id)?.state).toBe("running");
    expect((await service.control({ threadId: worker.id, action: "archiveInactive", inactiveBefore: Date.now() })).ok).toBe(false);
  });
  it("worker wake custody exports exact occurrence and stop state without producing recurring work", async () => {
    const { root, service } = fixture();
    const worker = unwrap(await service.spawn({ requestId: "worker", cwd: root, title: "A duty" }));
    expect((await service.wakeSchedule({ action: "set", threadId: worker.id, requestId: "bad-wake", cadenceMs: 60_000, reason: "park" })).ok).toBe(false);
    const db = new DatabaseSync(join(root, "threads.sqlite"));
    db.prepare("INSERT INTO thread_wake(thread_id,generation,data) VALUES(?,?,?)").run(worker.id, "generation-17", JSON.stringify({ reason: "Call broker", cadenceMs: 60_000, nextDueAt: 1, lastMessageId: "occurrence-17" }));
    unwrap(await service.send({ requestId: "occurrence-17", threadId: worker.id, text: "Already accepted", source: "notification" }));
    db.prepare("UPDATE thread SET held=1 WHERE id=?").run(worker.id);
    const exported = service.exportWakeDuties()[0]!;
    expect(exported).toMatchObject({ held: true, generation: "generation-17", schedule: { lastMessageId: "occurrence-17" }, pendingMessageIds: ["occurrence-17"] });
    unwrap(service.adoptWakeDuty(worker.id, "notes/duties.md#receipt-17"));
    expect(service.pending(worker.id).map(input => input.id)).toEqual(["occurrence-17"]);
    expect(service.get(worker.id)?.held).toBe(true);
    db.close();
  });
  it("Kenaznia digest is periodic and a new human message does not erase an accepted digest", async () => {
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date("2026-10-10T20:00:00Z"));
    const { root, service } = fixture();
    const manager = unwrap(await service.spawn({ requestId: "manager", cwd: root, title: "Manage", metadata: { manager: true } }));
    service.setManagerWatchdog(async () => ({ ok: true, value: { managerThreadId: manager.id, activeWork: true, lastHumanMessageAt: null } }), () => {});
    unwrap(await service.start()); await turn(); await turn();
    const db = new DatabaseSync(join(root, "threads.sqlite"));
    expect((db.prepare("SELECT next_due_at FROM manager_watchdog").get() as { next_due_at: number }).next_due_at).toBe(Date.now() + MANAGER_DIGEST_MS);
    db.prepare("UPDATE thread SET held=1 WHERE id=?").run(manager.id);
    unwrap(await service.send({ requestId: "thread-wake:manager-inactivity:accepted", threadId: manager.id, senderId: manager.id, text: "Accepted digest", source: "notification" }));
    unwrap(await service.send({ requestId: "human", threadId: manager.id, text: "New human input", humanActivity: true }));
    expect(service.pending(manager.id).map(input => input.id)).toContain("thread-wake:manager-inactivity:accepted");
    db.close();
  });
  it("open-work digest gives the manager Markdown pointers and the final state of idle completed workers", async () => {
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date("2026-10-10T20:00:00Z"));
    const { root, service, natives } = fixture();
    const manager = unwrap(await service.spawn({ requestId: "manager", cwd: root, title: "Manage", metadata: { manager: true } }));
    unwrap(service.update(manager.id, { metadata: { markdownDutiesPath: join(root, "duties.md") } }));
    const worker = unwrap(await service.spawn({ requestId: "work", parentId: manager.id, cwd: root, title: "Open duty", message: "Record next action" }));
    unwrap(await service.start());
    await until(() => natives[0]?.accepted.includes("work") === true);
    natives[0]!.settle(); await until(() => service.get(worker.id)?.state === "idle");
    service.setManagerWatchdog(async () => ({ ok: true, value: { managerThreadId: manager.id, activeWork: true, lastHumanMessageAt: null } }), () => {});
    service.reconcile(); await turn(); await turn();
    vi.setSystemTime(new Date(Date.now() + MANAGER_DIGEST_MS)); service.reconcile();
    await until(() => service.inputStates(manager.id).some(input => input.id.startsWith("thread-wake:manager-inactivity:")));
    const db = new DatabaseSync(join(root, "threads.sqlite"));
    const row = db.prepare("SELECT text FROM thread_work WHERE thread_id=? AND id LIKE 'thread-wake:manager-inactivity:%'").get(manager.id) as { text: string };
    expect(row.text).toContain(join(root, "duties.md"));
    expect(row.text).toContain('"finalState":"State written to owning Markdown"');
    expect(row.text).toContain("Luna-low reader");
    expect(row.text).toContain("2026-10-10T20:20:00.000Z");
    db.close();
  });
  it("watch adoption preserves the accepted spool and cannot start another worker factory", async () => {
    const root = mkdtempSync(join(tmpdir(), "watch-duties-")); roots.push(root);
    const spawn = vi.fn();
    const list = new WatchList({ databasePath: join(root, "watch.sqlite"), threads: { spawn, list: vi.fn(), questions: vi.fn() },
      placement: vi.fn(), checkOutcome: vi.fn(), onError: vi.fn() });
    const db = new DatabaseSync(join(root, "watch.sqlite"));
    db.prepare("INSERT INTO watch_item(id,body) VALUES(?,?)").run("item-1", JSON.stringify({ id: "item-1", what: "Check broker", why: "Pending task", nextDueAt: 1, addedBy: "worker", createdAt: 1, updatedAt: 1, lastThreadId: "original-worker" }));
    db.prepare("INSERT INTO watch_wake(id,input) VALUES(?,?)").run("occurrence-1", JSON.stringify({ id: "occurrence-1", requestId: "watch-wake:occurrence-1", cwd: root, title: "Accepted check" }));
    const exported = list.exportDuties();
    unwrap(list.adoptDuties("notes/duties.md#receipt-1"));
    expect(list.exportDuties().items).toEqual(exported.items);
    expect(list.exportDuties().pendingOccurrences).toEqual(exported.pendingOccurrences);
    list.start(); await turn();
    expect(spawn).not.toHaveBeenCalled();
    expect((await list.watch({ action: "checkNow", threadId: "manager", requestId: "new" })).ok).toBe(false);
    await list.close(); db.close();
  });
});

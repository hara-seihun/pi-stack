import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { ThreadService, type ThreadServiceOptions } from "../src/threads/service.js";
import { ThreadDirectory } from "../src/threads/directory.js";
import type { PiCommand, PiEvent, PiSessionOptions, Result } from "../src/threads/contracts.js";
const roots: string[] = [], owners: ThreadService[] = [];
const value = <T>(r: Result<T>): T => { if (!r.ok) throw new Error(r.error.message); return r.value; };
const boundary = () => new Promise<void>(resolve => setImmediate(resolve));
async function until(check: () => boolean) { for (let i = 0; i < 100; i++) { if (check()) return; await boundary(); } throw new Error("Expected native boundary"); }
function fixture(root = mkdtempSync(join(tmpdir(), "manager-dispatch-")), admission?: ThreadServiceOptions["admit"]) {
  if (!roots.includes(root)) roots.push(root);
  const sessions: Array<{ options: PiSessionOptions; commands: PiCommand[]; emit(e: PiEvent): void; settle(): void }> = [];
  const service = new ThreadService({ databasePath: join(root, "threads.sqlite"), sessionsDir: join(root, "sessions"), capacity: { mode: "unmanaged" },
    environment: () => ({ PI_THREAD_MANAGER: "1" }), ...(admission ? { admit: admission } : {}),
    openSession: async (options, emit) => {
      let streaming = false; const accepted: string[] = [];
      const session = { options, commands: [] as PiCommand[], emit,
        settle() { streaming = false; emit({ type: "message_end", message: { role: "assistant", timestamp: 111, content: [{ type: "text", text: "done" }], stopReason: "stop" } }); emit({ type: "agent_settled" }); },
        async command(command: PiCommand) {
          session.commands.push(command);
          if (command.type === "prompt" || command.type === "steer") { streaming = true; accepted.push(String(command.workId)); emit({ type: "agent_start" }); }
          if (command.type === "abort") streaming = false;
          emit({ type: "response", id: command.id, command: command.type, success: true,
            data: command.type === "get_state" ? { isStreaming: streaming, pendingMessageCount: 0, acceptedWorkIds: accepted } : {} });
        }, async close() {},
      }; sessions.push(session); return session;
    },
  }); owners.push(service); return { root, service, sessions };
}
afterEach(async () => { for (const owner of owners.splice(0)) await owner.detach(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
async function create(f: ReturnType<typeof fixture>) {
  value(await f.service.spawn({ requestId: "manager-create", id: "manager", cwd: f.root, metadata: { manager: true } }));
  value(await f.service.spawn({ requestId: "worker-create", id: "worker", cwd: f.root }));
}
it("all manager ingress is high-priority steer; human input is FIFO ahead of machine traffic without dropping any accepted input", async () => {
  const f = fixture(); await create(f);
  for (let i = 0; i < 20; i++) expect(value(await f.service.send({ threadId: "manager", senderId: "worker", requestId: `machine-${i}`, text: "Progress", delivery: "queue" })).priority).toBe("manager");
  for (const id of ["human-1", "human-2"]) value(await f.service.send({ threadId: "manager", requestId: id, text: id, delivery: "queue", humanActivity: true }));
  expect(f.service.pending("manager").map(m => m.id)).toEqual(["human-1", "human-2", ...Array.from({ length: 20 }, (_, i) => `machine-${i}`)]);
  value(await f.service.start()); await until(() => f.sessions[0]?.commands.filter(c => c.type === "prompt" || c.type === "steer").length === 22);
  const commands = f.sessions[0]!.commands.filter(c => c.type === "prompt" || c.type === "steer");
  expect(commands[0]!.workId).toBe("human-1"); expect(commands[1]!.workId).toBe("human-2");
  expect(commands.filter(c => c.type === "prompt")).toHaveLength(1);
  expect(value(await f.service.inspect("manager")).inputs).toHaveLength(22);
  expect(f.sessions[0]!.options.env.PI_THREAD_MANAGER).toBe("1");
});
it("human input arriving during machine admission wins the next unentered execution without cancelling effects", async () => {
  let release!: () => void, entered = false, calls = 0, released = 0;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const f = fixture(undefined, async () => { if (++calls === 1) { entered = true; await gate; } return { ok: true, value: { release() { released++; } } }; });
  await create(f); value(await f.service.send({ threadId: "manager", requestId: "machine", senderId: "worker", text: "Progress" }));
  value(await f.service.start()); await until(() => entered);
  value(await f.service.send({ threadId: "manager", requestId: "human", text: "New instruction", humanActivity: true })); release();
  await until(() => f.sessions[0]?.commands.some(c => c.type === "prompt") === true);
  expect(f.sessions[0]!.commands.find(c => c.type === "prompt")!.workId).toBe("human"); expect(released).toBeGreaterThan(0);
  expect(f.sessions[0]!.commands.some(c => c.type === "abort")).toBe(false);
});
it("manager hard steer cannot cancel accepted effects; native queued receipts are distinct from landed execution and survive restart", async () => {
  const f = fixture(); await create(f);
  value(await f.service.send({ threadId: "manager", requestId: "accepted", text: "Coordinate" }));
  value(await f.service.start()); await until(() => f.sessions[0]?.commands.some(c => c.workId === "accepted") === true);
  const sent = value(await f.service.send({ threadId: "manager", requestId: "urgent", text: "Reply now", humanActivity: true, delivery: "hardSteer" }));
  expect(sent.delivery).toBe("steer");
  await until(() => f.sessions[0]!.commands.some(c => c.workId === "urgent"));
  expect(f.sessions[0]!.commands.some(c => c.type === "abort")).toBe(false);
  const queued = value(await f.service.inspect("manager")).inputs!.find(m => m.id === "urgent")!;
  expect(queued.state).toBe("dispatched"); expect(queued.insertedAt).not.toBeNull(); expect(queued.landedAt).toBeNull();
  f.sessions[0]!.emit({ type: "message_start", inputWorkId: "urgent", message: { role: "user", timestamp: 100, content: [] } });
  expect(value(await f.service.inspect("manager")).inputs!.find(m => m.id === "urgent")!.landedAt).not.toBeNull();
  f.sessions[0]!.settle(); await until(() => f.service.pending("manager").length === 0);
  value(await f.service.close()); const next = fixture(f.root);
  expect(value(await next.service.inspect("manager")).inputs!.find(m => m.id === "urgent")).toMatchObject({ state: "done", outcome: "complete", priority: "human" });
});
it.each([false, true])("manager progress senders receive no unsolicited finals across blended human turns (restart=%s)", async restart => {
  const f = fixture(); await create(f);
  value(await f.service.send({ threadId: "manager", senderId: "worker", requestId: "progress", text: "Progress, no reply needed" }));
  let active = f;
  if (restart) { value(await f.service.close()); active = fixture(f.root); }
  value(await active.service.send({ threadId: "manager", requestId: "human", text: "Answer my unrelated question", humanActivity: true }));
  value(await active.service.start());
  await until(() => active.sessions[0]?.commands.filter(c => c.type === "prompt" || c.type === "steer").length === 2);
  expect(active.sessions[0]!.commands.find(c => c.type === "prompt")!.workId).toBe("human");
  active.sessions[0]!.settle();
  await until(() => active.service.latestSettlement("manager")?.outcome === "complete");
  await boundary();
  expect(active.service.inputStates("worker")).toEqual([]);
  expect(active.sessions).toHaveLength(1);
  expect(active.service.get("worker")?.lifecycle).toEqual({ kind: "idle" });
});

it("manager result delivery requires explicit subscriber custody, not merely sending it progress", async () => {
  const f = fixture(); await create(f);
  value(await f.service.spawn({ requestId: "reporter-create", id: "reporter", cwd: f.root }));
  value(await f.service.control({ action: "placement", threadId: "worker", foreground: true }));
  value(await f.service.agentWait({ action: "set", kind: "message", threadId: "worker", requestId: "wait-manager", fromThreadId: "manager" }));
  for (const senderId of ["worker", "reporter"]) value(await f.service.send({ threadId: "manager", senderId, requestId: `progress:${senderId}`, text: "Progress" }));
  value(await f.service.send({ threadId: "manager", requestId: "human", text: "Answer", humanActivity: true }));
  value(await f.service.start());
  await until(() => f.sessions[0]?.commands.filter(c => c.type === "prompt" || c.type === "steer").length === 3);
  f.sessions[0]!.settle();
  await until(() => f.service.inputStates("worker").length === 1);
  expect(f.service.inputStates("worker")[0]).toMatchObject({ senderId: "manager", source: "notification" });
  expect(f.service.get("worker")?.waitingOnAgents).toBeUndefined();
  expect(f.service.get("worker")?.dependencies).toEqual([]);
  expect(f.service.inputStates("reporter")).toEqual([]);
});

it("cross-owner manager results reach named waiters without waking report senders", async () => {
  const manager = fixture(), peers = fixture(); await create(manager);
  for (const id of ["watcher", "reporter"]) value(await peers.service.spawn({ requestId: `spawn:${id}`, id, cwd: peers.root }));
  const directory = new ThreadDirectory({ id: "person", api: manager.service }, [{ id: "fleet", api: peers.service }]);
  manager.service.setDirectory(directory); peers.service.setDirectory(directory);
  value(await peers.service.agentWait({ action: "set", kind: "message", threadId: "watcher", requestId: "wait-manager", fromThreadId: "manager" }));
  value(await directory.send({ threadId: "manager", senderId: "reporter", requestId: "progress", text: "Progress" }));
  value(await manager.service.send({ threadId: "manager", requestId: "human", text: "Answer", humanActivity: true }));
  value(await manager.service.start());
  await until(() => manager.sessions[0]?.commands.filter(c => c.type === "prompt" || c.type === "steer").length === 2);
  manager.sessions[0]!.settle();
  await until(() => peers.service.inputStates("watcher").length === 1);
  expect(peers.service.inputStates("watcher")[0]).toMatchObject({ senderId: "manager", source: "notification" });
  expect(peers.service.get("watcher")?.waitingOnAgents).toBeUndefined();
  expect(peers.service.get("watcher")?.dependencies).toEqual([]);
  expect(peers.service.inputStates("reporter")).toEqual([]);
});

it("manager cancellation notifies explicit subscribers but not progress senders", async () => {
  const f = fixture(); await create(f);
  value(await f.service.spawn({ requestId: "reporter-create", id: "reporter", cwd: f.root }));
  value(await f.service.control({ action: "dependencies", threadId: "worker", threadIds: ["manager"] }));
  value(await f.service.send({ threadId: "manager", senderId: "reporter", requestId: "progress", text: "Progress" }));
  value(await f.service.control({ action: "cancel", threadId: "manager" }));
  expect(f.service.inputStates("worker")).toMatchObject([{ senderId: "manager", source: "notification" }]);
  expect(f.service.inputStates("reporter")).toEqual([]);
});

it("manager-spawned assignments still deliver their automatic terminal result", async () => {
  const f = fixture(); await create(f);
  value(await f.service.spawn({ requestId: "assignment", id: "child", parentId: "manager", cwd: f.root, message: "Do this assignment", ephemeral: true }));
  value(await f.service.start());
  await until(() => f.sessions[0]?.commands.some(c => c.workId === "assignment") === true);
  f.sessions[0]!.settle();
  await until(() => f.service.inputStates("manager").length === 1);
  expect(f.service.pending("manager")[0]).toMatchObject({ senderId: "child", source: "notification", replyTo: "assignment" });
  expect(f.service.get("child")?.metadata?.archived).toBe(true);
});

it("worker delivery and marker remain ordinary, while ended assistant output is not restored as live text", async () => {
  const f = fixture(); await create(f);
  expect((await f.service.send({ threadId: "worker", senderId: "manager", requestId: "bad-queue", text: "Task", delivery: "queue" })).ok).toBe(false);
  value(await f.service.send({ threadId: "worker", requestId: "worker-task", text: "Task" })); value(await f.service.start());
  await until(() => f.sessions[0]?.commands.some(c => c.workId === "worker-task") === true);
  expect(f.sessions[0]!.options.env.PI_THREAD_MANAGER).toBe("0");
  expect(value(await f.service.inspect("worker")).inputs![0]!.priority).toBe("normal");
  f.sessions[0]!.emit({ type: "message_start", message: { role: "assistant", timestamp: 111 } });
  f.sessions[0]!.emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "Answer" } });
  expect(f.service.live("worker")).toMatchObject({ text: "Answer", messageTimestamp: 111 });
  f.sessions[0]!.settle(); expect(f.service.live("worker")).toMatchObject({ text: "", thinking: "", messageTimestamp: null });
  f.sessions[0]!.emit({ type: "response", command: "get_state", success: true, data: { live: { text: "", thinking: "", messageTimestamp: null } } });
  expect(f.service.live("worker")).toMatchObject({ text: "", messageTimestamp: null });
});

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { ThreadService, type ThreadServiceOptions } from "../src/threads/service.js";
import { ThreadDirectory } from "../src/threads/directory.js";
import { threadTools } from "../src/threads/pi-tools.js";
import { createThreadClient, threadHttp } from "../src/threads/http.js";
import { admissionFor, callerResolver, threadCapability } from "../src/threads/caller.js";
import { createExecutionActivity, observeExecutionActivity } from "../src/threads/execution-activity.js";
import type { PiCommand, PiEvent, Result } from "../src/threads/contracts.js";

const roots: string[] = [], owners: ThreadService[] = [];
const unwrap = <T>(value: Result<T>): T => { if (!value.ok) throw new Error(value.error.message); return value.value; };
const boundary = () => new Promise<void>(resolve => setImmediate(resolve));
async function until(check: () => boolean) { for (let n = 0; n < 100; n++) { if (check()) return; await boundary(); } throw new Error("Lifecycle did not reach expected boundary"); }
function pauseRegistration(service: ThreadService, kind: "agents" | "message", entered: () => void): () => void {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  if (kind === "agents") {
    const call = service.await.bind(service);
    vi.spyOn(service, "await").mockImplementationOnce(async input => { const result = call(input); entered(); await gate; return result; });
  } else {
    const owner = service as unknown as { validateDependencies(id: string, ids: string[]): Promise<Result<void>> };
    const call = owner.validateDependencies.bind(service);
    vi.spyOn(owner, "validateDependencies").mockImplementationOnce(async (id, ids) => { const result = await call(id, ids); entered(); await gate; return result; });
  }
  return release;
}
function fixture(root = mkdtempSync(join(tmpdir(), "thread-wake-")), options: Partial<ThreadServiceOptions> = {}, beforeOpen?: () => Promise<void>) {
  if (!roots.includes(root)) roots.push(root);
  const sessions: Array<{ commands: PiCommand[]; settle(): void; emit(event: PiEvent): void }> = [];
  const service = new ThreadService({ capacity: { mode: "unmanaged" }, databasePath: join(root, "threads.sqlite"), sessionsDir: join(root, "sessions"), ...options,
    openSession: async (_options, output) => {
      await beforeOpen?.();
      let running = false;
      const accepted = new Set<string>();
      const session = { commands: [] as PiCommand[], emit: output,
        settle() { running = false; output({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "done" }], stopReason: "stop" } }); output({ type: "agent_settled" }); },
        async command(command: PiCommand) {
          session.commands.push(command);
          if (command.type === "prompt" || command.type === "steer") { running = true; accepted.add(String(command.workId)); output({ type: "agent_start" }); }
          if (command.type === "abort") running = false;
          output({ type: "response", id: command.id, command: command.type, success: true, data: command.type === "get_state" ? { isStreaming: running, pendingMessageCount: 0, acceptedWorkIds: [...accepted] } : {} });
        }, async close() {},
      };
      sessions.push(session); return session;
    },
  }); owners.push(service); return { root, service, sessions };
}
afterEach(async () => { vi.restoreAllMocks(); for (const owner of owners.splice(0)) await owner.detach(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
async function spawn(f: ReturnType<typeof fixture>, id: string) {
  const thread = unwrap(await f.service.spawn({ requestId: `spawn:${id}`, id, cwd: f.root }));
  return f.service.control({ threadId: thread.id, action: "placement", foreground: true });
}
const schedule = (f: ReturnType<typeof fixture>, threadId: string, requestId = "schedule") => f.service.wakeSchedule({ threadId, action: "set", requestId, reason: "Inspect durable job", cadenceMs: 60000, nextDueAt: 0 });

it.each([false, true])("replaces wait-owned peers atomically while retaining explicit subscriptions across restart (cross-owner=%s)", async crossOwner => {
  const parent = fixture(), peers = crossOwner ? fixture(undefined, { workersOnly: true }) : parent;
  let directory = new ThreadDirectory({ id: "person", api: parent.service }, crossOwner ? [{ id: "fleet", api: peers.service }] : []);
  parent.service.setDirectory(directory); peers.service.setDirectory(directory);
  await spawn(parent, "parent");
  for (const id of ["explicit", "old", "next"]) await spawn(peers, id);
  unwrap(await parent.service.control({ action: "dependencies", threadId: "parent", threadIds: ["explicit"] }));
  unwrap(await parent.service.agentWait({ action: "set", kind: "agents", threadId: "parent", requestId: "first", threadIds: ["old", "explicit"] }));
  const replacement = unwrap(await parent.service.agentWait({ action: "set", kind: "agents", threadId: "parent", requestId: "next", threadIds: ["next"] }));
  expect(replacement).toMatchObject({ dependencies: ["explicit", "next"], waitingOnAgents: { threadIds: ["next"] } });
  expect(peers.service.get("old")?.metadata?.peerDependents).toEqual([]);
  expect(peers.service.get("explicit")?.metadata?.peerDependents).toEqual(["parent"]);
  expect(await parent.service.agentWait({ action: "set", kind: "agents", threadId: "parent", requestId: "missing", threadIds: ["missing"] })).toMatchObject({ ok: false });
  expect(parent.service.get("parent")?.dependencies).toEqual(["explicit", "next"]);
  await boundary(); unwrap(await parent.service.close());
  const recovered = fixture(parent.root);
  directory = new ThreadDirectory({ id: "person", api: recovered.service }, crossOwner ? [{ id: "fleet", api: peers.service }] : []);
  recovered.service.setDirectory(directory); if (crossOwner) peers.service.setDirectory(directory);
  expect(recovered.service.get("parent")).toMatchObject({ dependencies: ["explicit", "next"], waitingOnAgents: replacement.waitingOnAgents });
  unwrap(await recovered.service.send({ requestId: "human", threadId: "parent", text: "Continue local work" }));
  expect(recovered.service.get("parent")?.waitingOnAgents).toBeUndefined();
  expect(recovered.service.get("parent")?.dependencies).toEqual(["explicit", "next"]);
  expect(unwrap(await recovered.service.agentWait({ action: "set", kind: "job", threadId: "parent", requestId: "job", jobId: "job" })).dependencies).toEqual(["explicit"]);
});

it("a resumed registration preserves explicit custody without creating wait-owned custody", async () => {
  const f = fixture(); for (const id of ["self", "explicit", "peer"]) await spawn(f, id);
  unwrap(await f.service.control({ action: "dependencies", threadId: "self", threadIds: ["explicit"] }));
  unwrap(await f.service.send({ requestId: "human", threadId: "self", text: "Continue local work" }));
  const request = { action: "set" as const, kind: "message" as const, threadId: "self", requestId: "resumed", fromThreadId: "peer" };
  const result = unwrap(await f.service.agentWait(request));
  expect(result).toMatchObject({ dependencies: ["explicit"], waitRegistration: { status: "resumed" } });
  expect(result.waitingOnAgents).toBeUndefined();
  expect(f.service.get("explicit")?.metadata?.peerDependents).toEqual(["self"]);
  expect(f.service.get("peer")?.metadata?.peerDependents ?? []).toEqual([]);
  expect(unwrap(await f.service.agentWait(request)).dependencies).toEqual(["explicit"]);
});

it("a completed resumed background worker archives without cancelling its running peer", async () => {
  const f = fixture(); await spawn(f, "self");
  unwrap(await f.service.control({ action: "placement", threadId: "self", foreground: false }));
  unwrap(await f.service.spawn({ requestId: "peer-work", id: "peer", cwd: f.root, message: "Continue peer work" }));
  unwrap(await f.service.send({ requestId: "human", threadId: "self", text: "Complete this local assignment" }));
  expect(unwrap(await f.service.agentWait({ action: "set", kind: "message", threadId: "self", requestId: "wait", fromThreadId: "peer" })).waitRegistration.status).toBe("resumed");
  unwrap(await f.service.start());
  await until(() => f.sessions.filter(s => s.commands.some(c => c.type === "prompt")).length === 2);
  f.sessions.find(s => s.commands.some(c => c.workId === "human"))!.settle();
  await until(() => f.service.get("self")?.metadata?.archived === true);
  expect(f.service.latestSettlement("self")?.assignmentPending).toBeUndefined();
  expect(f.service.get("peer")).toMatchObject({ state: "running", held: false });
  expect(f.sessions.find(s => s.commands.some(c => c.workId === "peer-work"))!.commands.some(c => c.type === "abort")).toBe(false);
  unwrap(await f.service.control({ action: "stop", threadId: "peer", descendants: false }));
});

it("a failed current-assignment probe does not change the accepted wait or subscriptions", async () => {
  const f = fixture(); for (const id of ["parent", "old", "next"]) await spawn(f, id);
  const accepted = unwrap(await f.service.agentWait({ action: "set", kind: "agents", threadId: "parent", requestId: "first", threadIds: ["old"] }));
  vi.spyOn(f.service, "await").mockResolvedValueOnce({ ok: false, error: { code: "unavailable", message: "Peer owner unavailable" } });
  expect(await f.service.agentWait({ action: "set", kind: "agents", threadId: "parent", requestId: "next", threadIds: ["next"] })).toMatchObject({ ok: false, error: { code: "unavailable" } });
  expect(f.service.get("parent")).toMatchObject({ dependencies: ["old"], waitingOnAgents: accepted.waitingOnAgents });
  expect(f.service.get("next")?.metadata?.peerDependents ?? []).toEqual([]);
});

it("accepted wait replacement retains durable subscription custody through owner failure and restart", async () => {
  const parent = fixture(), peers = fixture(undefined, { workersOnly: true });
  let directory = new ThreadDirectory({ id: "person", api: parent.service }, [{ id: "fleet", api: peers.service }]);
  parent.service.setDirectory(directory); peers.service.setDirectory(directory);
  await spawn(parent, "parent"); for (const id of ["old", "next"]) await spawn(peers, id);
  unwrap(await parent.service.agentWait({ action: "set", kind: "agents", threadId: "parent", requestId: "first", threadIds: ["old"] }));
  const control = peers.service.control.bind(peers.service);
  vi.spyOn(peers.service, "control").mockImplementation(input => input.action === "resultSubscribe" && input.active && input.threadId === "next"
    ? Promise.resolve({ ok: false, error: { code: "unavailable", message: "Subscription transport unavailable" } }) : control(input));
  const request = { action: "set" as const, kind: "agents" as const, threadId: "parent", requestId: "next", reason: "Next result", threadIds: ["next"] };
  const accepted = unwrap(await parent.service.agentWait(request));
  expect(accepted).toMatchObject({ dependencies: ["next"], waitRegistration: { status: "registered" }, metadata: { dependencyUpdate: { desired: ["next"] }, dependencyError: "Subscription transport unavailable" } });
  expect(peers.service.get("old")?.metadata?.peerDependents).toEqual([]);
  await boundary(); unwrap(await parent.service.close()); vi.restoreAllMocks();
  const recovered = fixture(parent.root);
  directory = new ThreadDirectory({ id: "person", api: recovered.service }, [{ id: "fleet", api: peers.service }]);
  recovered.service.setDirectory(directory); peers.service.setDirectory(directory);
  expect(unwrap(await recovered.service.agentWait(request)).waitRegistration).toEqual(accepted.waitRegistration);
  unwrap(await recovered.service.start());
  await until(() => !recovered.service.get("parent")?.metadata?.dependencyUpdate);
  expect(recovered.service.get("parent")).toMatchObject({ dependencies: ["next"], waitingOnAgents: accepted.waitingOnAgents });
  expect(recovered.service.get("parent")?.metadata?.dependencyError).toBeUndefined();
  expect(peers.service.get("next")?.metadata?.peerDependents).toEqual(["parent"]);
  expect(recovered.sessions).toHaveLength(0);
});

it.each([false, true])("auto-archive releases completed peer edges without clear and preserves unfinished named work (cross-owner=%s)", async crossOwner => {
  const parent = fixture(), peers = crossOwner ? fixture(undefined, { workersOnly: true }) : parent;
  const directory = new ThreadDirectory({ id: "person", api: parent.service }, crossOwner ? [{ id: "fleet", api: peers.service }] : []);
  parent.service.setDirectory(directory); peers.service.setDirectory(directory);
  await spawn(parent, "parent"); unwrap(await peers.service.start());
  unwrap(await peers.service.spawn({ requestId: "complete-work", id: "complete", parentId: "parent", cwd: peers.root, message: "Complete assignment" }));
  await until(() => peers.sessions.some(s => s.commands.some(c => c.workId === "complete-work")));
  unwrap(await parent.service.agentWait({ action: "set", kind: "agents", threadId: "parent", requestId: "complete-wait", threadIds: ["complete"] }));
  peers.sessions.find(s => s.commands.some(c => c.workId === "complete-work"))!.settle();
  await until(() => peers.service.get("complete")?.metadata?.archived === true && parent.service.get("parent")?.dependencies?.length === 0);
  expect(peers.service.get("complete")?.metadata?.peerDependents).toEqual([]);
  unwrap(await peers.service.spawn({ requestId: "next-work", id: "next", parentId: "parent", cwd: peers.root, message: "Unfinished assignment" }));
  await until(() => peers.sessions.some(s => s.commands.some(c => c.workId === "next-work")));
  unwrap(await peers.service.agentWait({ action: "set", kind: "job", threadId: "next", requestId: "next-job", jobId: "job" }));
  peers.sessions.find(s => s.commands.some(c => c.workId === "next-work"))!.settle();
  await until(() => peers.service.latestSettlement("next")?.assignmentPending === true);
  const next = unwrap(await parent.service.agentWait({ action: "set", kind: "agents", threadId: "parent", requestId: "next-wait", threadIds: ["next"] }));
  expect(next).toMatchObject({ dependencies: ["next"], waitRegistration: { status: "registered" }, waitingOnAgents: { threadIds: ["next"] } });
  expect(peers.service.get("next")?.metadata?.archived).not.toBe(true);
  expect(peers.service.get("next")?.metadata?.peerDependents).toEqual(["parent"]);
  expect(unwrap(await parent.service.agentWait({ action: "set", kind: "agents", threadId: "parent", requestId: "archived-result", threadIds: ["complete"] }))).toMatchObject({ dependencies: [], waitRegistration: { status: "already_arrived", settlement: { threadId: "complete" } } });
  expect(peers.service.get("complete")?.metadata?.archived).toBe(true);
});

it("wakes an idle existing thread once, persists observability and coalesces overdue checks under admission", async () => {
  let now = 100000;
  vi.spyOn(Date, "now").mockImplementation(() => now);
  const admit = vi.fn(async () => ({ ok: false as const, error: { code: "unavailable" as const, message: "Capacity unavailable" } }));
  const f = fixture(undefined, { admit }); await spawn(f, "self"); unwrap(await schedule(f, "self"));
  unwrap(await f.service.start()); await until(() => admit.mock.calls.length > 0);
  const queued = f.service.pending("self"); expect(queued).toHaveLength(1); expect(queued[0]).toMatchObject({ source: "notification", threadId: "self" });
  expect(f.service.get("self")?.wakeSchedule).toMatchObject({ nextDueAt: 160000, lastMessageId: queued[0]!.id });
  now += 600000; f.service.reconcile(); f.service.reconcile(); await boundary();
  expect(f.service.pending("self")).toHaveLength(1); expect(f.sessions).toHaveLength(0);
  expect(f.service.get("self")?.metadata?.admissionWait).toBeDefined();
  unwrap(await f.service.control({ threadId: "self", action: "stop", descendants: false }));
  unwrap(await f.service.wakeSchedule({ threadId: "self", action: "cancel", requestId: "cancel" }));
  expect(f.service.pending("self")).toHaveLength(0); expect(unwrap(await f.service.wakeSchedule({ threadId: "self", action: "list" }))).toBeNull();
});

it("recovers a stored timer after controller restart and does not duplicate a delivered wake across another restart", async () => {
  const first = fixture(); await spawn(first, "self"); unwrap(await schedule(first, "self")); unwrap(await first.service.close());
  const next = fixture(first.root); expect(next.service.get("self")?.wakeSchedule?.nextDueAt).toBe(0);
  unwrap(await next.service.start()); await until(() => next.sessions[0]?.commands.some(c => c.type === "prompt") === true);
  const id = next.service.get("self")!.wakeSchedule!.lastMessageId;
  next.sessions[0]!.settle(); await until(() => next.service.get("self")?.state === "idle"); await boundary(); unwrap(await next.service.close());
  const restarted = fixture(first.root); unwrap(await restarted.service.start()); restarted.service.reconcile(); await boundary();
  expect(restarted.sessions).toHaveLength(0); expect(restarted.service.get("self")!.wakeSchedule!.lastMessageId).toBe(id);
  expect(restarted.service.pending("self")).toHaveLength(0);
});

it.each([
  { kind: "agents" as const, threadIds: ["peer"] },
  { kind: "job" as const, jobId: "external-job" },
  { kind: "deployment" as const, publicationId: "PUB-release" },
  { kind: "message" as const, fromThreadId: "peer" },
])("overdue recovery wakes resume a $kind waiter after restart without duplicating input or retaining wait-owned peers", async dependency => {
  const first = fixture();
  for (const id of ["self", "peer", "explicit"]) await spawn(first, id);
  unwrap(await first.service.control({ action: "dependencies", threadId: "self", threadIds: ["explicit"] }));
  unwrap(await schedule(first, "self"));
  unwrap(await first.service.agentWait({ requestId: "wait", action: "set", threadId: "self", ...dependency }));
  expect(first.service.get("self")?.state).toBe("waiting");
  unwrap(await first.service.close());
  const recovered = fixture(first.root);
  unwrap(await recovered.service.start());
  await until(() => recovered.sessions.some(s => s.commands.some(c => c.type === "prompt")));
  const queued = recovered.service.pending("self");
  expect(queued).toHaveLength(1);
  expect(queued[0]).toMatchObject({ source: "notification", senderId: "self" });
  expect(recovered.service.get("self")).toMatchObject({ state: "running", dependencies: ["explicit"] });
  expect(recovered.service.get("self")?.waitingOnAgents).toBeUndefined();
  await until(() => !recovered.service.get("self")?.metadata?.dependencyUpdate);
  expect(recovered.service.get("peer")?.metadata?.peerDependents ?? []).toEqual([]);
  expect(recovered.service.get("explicit")?.metadata?.peerDependents).toEqual(["self"]);
  const receipt = recovered.service.get("self")!.wakeSchedule!.lastMessageId;
  recovered.service.reconcile(); recovered.service.reconcile();
  expect(recovered.service.pending("self")).toHaveLength(1);
  recovered.sessions[0]!.settle();
  await until(() => recovered.service.latestSettlement("self")?.workId === receipt);
  await boundary(); unwrap(await recovered.service.close());
  const restarted = fixture(first.root); unwrap(await restarted.service.start());
  restarted.service.reconcile(); await boundary();
  expect(restarted.sessions).toHaveLength(0);
  expect(restarted.service.get("self")!.wakeSchedule!.lastMessageId).toBe(receipt);
});

it("enqueues a recovery wake behind unrelated queued input even during admission, coalescing across restart", async () => {
  let now = 100000, entered = false, release!: () => void;
  vi.spyOn(Date, "now").mockImplementation(() => now);
  const gate = new Promise<void>(resolve => { release = resolve; });
  const refuse = { ok: false as const, error: { code: "unavailable" as const, message: "Capacity unavailable" } };
  const f = fixture(undefined, { admit: async () => { entered = true; await gate; return refuse; } });
  await spawn(f, "self");
  unwrap(await f.service.send({ requestId: "unrelated", threadId: "self", text: "Publication report" }));
  unwrap(await f.service.start()); await until(() => entered);
  unwrap(await schedule(f, "self"));
  f.service.reconcile();
  const receipt = f.service.get("self")!.wakeSchedule!.lastMessageId;
  expect(receipt).toMatch(/^thread-wake:/);
  expect(f.service.pending("self").map(w => w.id)).toEqual(["unrelated", receipt]);
  now += 600000; f.service.reconcile(); f.service.reconcile();
  expect(f.service.pending("self")).toHaveLength(2);
  release(); await boundary(); await boundary(); unwrap(await f.service.close());
  const recovered = fixture(f.root, { admit: async () => refuse });
  unwrap(await recovered.service.start()); recovered.service.reconcile(); await boundary();
  expect(recovered.service.pending("self").map(w => w.id)).toEqual(["unrelated", receipt]);
  expect(recovered.service.get("self")!.wakeSchedule!.lastMessageId).toBe(receipt);
});

it("an overdue waiter wake coalesces behind its active execution and delivers after settlement", async () => {
  const f = fixture(); await spawn(f, "self");
  unwrap(await f.service.send({ requestId: "work", threadId: "self", text: "Start work" }));
  unwrap(await f.service.start());
  await until(() => f.sessions[0]?.commands.some(c => c.type === "prompt") === true);
  unwrap(await schedule(f, "self"));
  unwrap(await f.service.agentWait({ requestId: "wait", action: "set", kind: "job", threadId: "self", jobId: "job" }));
  f.service.reconcile(); f.service.reconcile();
  expect(f.service.get("self")!.wakeSchedule!.lastMessageId).toBeUndefined();
  f.sessions[0]!.settle();
  await until(() => f.service.get("self")?.state === "waiting");
  await boundary(); f.service.reconcile();
  await until(() => f.sessions.flatMap(s => s.commands).some(c => typeof c.workId === "string" && c.workId.startsWith("thread-wake:")));
  expect(f.service.pending("self")).toHaveLength(1);
  expect(f.service.get("self")?.waitingOnAgents).toBeUndefined();
});

it.each([true, false])("dependency settlement resumes a durable waiter through the existing cross-owner result route (legacy=%s)", async legacy => {
  const parent = fixture(), child = fixture(undefined, { workersOnly: true });
  const directory = new ThreadDirectory({ id: "person", api: parent.service }, [{ id: "fleet", api: child.service }]);
  parent.service.setDirectory(directory); child.service.setDirectory(directory);
  await spawn(parent, "parent"); unwrap(await parent.service.start()); unwrap(await child.service.start());
  unwrap(await child.service.spawn({ requestId: "child", id: "child", parentId: "parent", cwd: child.root, message: "work" }));
  await until(() => child.sessions[0]?.commands.some(c => c.type === "prompt") === true);
  const wait = unwrap(await parent.service.agentWait({ requestId: "wait", threadId: "parent", action: "set", ...(legacy ? {} : { kind: "agents" as const }), threadIds: ["child"] }));
  expect(wait).toMatchObject({ state: "waiting", waitingOnAgents: { threadIds: ["child"] } });
  expect(parent.sessions).toHaveLength(0);
  child.sessions[0]!.settle(); await until(() => parent.sessions[0]?.commands.some(c => c.type === "prompt") === true);
  expect(parent.service.get("parent")?.waitingOnAgents).toBeUndefined();
  expect(parent.service.pending("parent")).toHaveLength(1);
  expect(parent.service.pending("parent")[0]).toMatchObject({ senderId: "child", source: "notification" });
  unwrap(await parent.service.agentWait({ requestId: "release-result", threadId: "parent", action: "clear" }));
  parent.sessions[0]!.settle(); await until(() => parent.service.get("parent")?.state === "idle");
  await until(() => child.service.get("child")?.metadata?.archived === true);
  expect(await parent.service.agentWait({ requestId: "wait-closed-child", threadId: "parent", action: "set", kind: "agents", threadIds: ["child"] })).toMatchObject({ ok: true, value: { waitRegistration: { status: "already_arrived", settlement: { outcome: "complete" } } } });
  unwrap(await child.service.control({ threadId: "child", action: "reopen" }));
  const arrived = unwrap(await parent.service.agentWait({ requestId: "wait-after-result", threadId: "parent", action: "set", kind: "agents", threadIds: ["child"] }));
  expect(arrived.waitingOnAgents).toBeUndefined();
  expect(arrived.waitRegistration).toMatchObject({ status: "already_arrived", settlement: { threadId: "child", outcome: "complete" } });
});

it.each([
  { kind: "agents" as const, completed: false },
  { kind: "agents" as const, completed: true },
  { kind: "message" as const, completed: false },
  { kind: "message" as const, completed: true },
])("explicit input wins asynchronous $kind wait registration (completed=$completed)", async ({ kind, completed }) => {
  vi.spyOn(Date, "now").mockReturnValue(100000);
  const f = fixture(); await spawn(f, "self"); await spawn(f, "collaborator");
  unwrap(await f.service.spawn({ requestId: "child", id: "child", parentId: "self", cwd: f.root }));
  const directory = new ThreadDirectory({ id: "person", api: f.service }); f.service.setDirectory(directory);
  let entered = false;
  const release = pauseRegistration(f.service, kind, () => { entered = true; });
  const request = { requestId: "racing-wait", threadId: "self", action: "set" as const, reason: "Dependency result",
    ...(kind === "agents" ? { kind, threadIds: ["child"] } : { kind, fromThreadId: "collaborator" }) };
  const registering = f.service.agentWait(request); await until(() => entered);
  unwrap(await f.service.send({ requestId: "human", threadId: "self", text: "Continue with my new instruction" }));
  if (completed) {
    unwrap(await f.service.start()); await until(() => f.sessions[0]?.commands.some(c => c.type === "prompt") === true);
    f.sessions[0]!.settle(); await until(() => f.service.latestSettlement("self")?.outcome === "complete");
    expect(f.service.pending("self")).toHaveLength(0);
  }
  release();
  const result = unwrap(await registering);
  expect(result.waitingOnAgents).toBeUndefined();
  expect(result.waitRegistration).toEqual({ status: "resumed", messageIds: ["human"] });
  expect(result.dependencies).toEqual([]);
  expect(f.service.get(kind === "agents" ? "child" : "collaborator")?.metadata?.peerDependents ?? []).toEqual([]);
  expect(unwrap(await f.service.agentWait(request)).waitRegistration).toEqual(result.waitRegistration);
  expect(f.service.get("self")?.metadata?.agentWait).toBeUndefined();
  if (!completed) expect(f.service.pending("self")).toMatchObject([{ id: "human", source: "explicit" }]);
  await boundary(); unwrap(await f.service.close());
  const next = fixture(f.root);
  expect(next.service.get("self")?.waitingOnAgents).toBeUndefined();
  expect(next.service.get("self")?.dependencies).toEqual([]);
  expect(unwrap(await next.service.agentWait(request)).waitRegistration).toEqual(result.waitRegistration);
});

it.each(["queued", "running", "waiting"])("historical assignment results and parked notifications cannot swallow a %s peer wait", async state => {
  const parent = fixture(), first = fixture(undefined, { workersOnly: true });
  let directory = new ThreadDirectory({ id: "person", api: parent.service }, [{ id: "fleet", api: first.service }]);
  parent.service.setDirectory(directory); first.service.setDirectory(directory);
  await spawn(parent, "parent"); unwrap(await first.service.start());
  unwrap(await first.service.spawn({ requestId: "assignment-one", id: "child", parentId: "parent", cwd: first.root, message: "First assignment" }));
  unwrap(await first.service.control({ threadId: "child", action: "placement", foreground: true }));
  await until(() => first.sessions[0]?.commands.some(c => c.type === "prompt") === true);
  first.sessions[0]!.settle(); await until(() => first.service.latestSettlement("child")?.outcome === "complete");
  await until(() => parent.service.pending("parent").length === 1);
  const historical = first.service.latestSettlement("child")!;
  expect(parent.service.pending("parent")[0]).toMatchObject({ source: "notification", senderId: "child", landedAt: null });
  await boundary(); unwrap(await first.service.close());
  const next = fixture(first.root, { workersOnly: true });
  directory = new ThreadDirectory({ id: "person", api: parent.service }, [{ id: "fleet", api: next.service }]);
  parent.service.setDirectory(directory); next.service.setDirectory(directory);
  unwrap(await next.service.send({ requestId: "assignment-two", threadId: "child", senderId: "parent", text: "Second assignment" }));
  if (state !== "queued") {
    unwrap(await next.service.start()); await until(() => next.sessions[0]?.commands.some(c => c.type === "prompt") === true);
    if (state === "waiting") {
      unwrap(await next.service.agentWait({ requestId: "child-job", threadId: "child", action: "set", kind: "job", jobId: "current-job", }));
      next.sessions[0]!.settle(); await until(() => next.service.latestSettlement("child")?.assignmentPending === true);
    }
  }
  expect(unwrap(await directory.await({ parentId: "parent", threadIds: ["child"], timeoutMs: 0 })).settlement?.seq).toBe(historical.seq);
  const request = { requestId: "current-wait", threadId: "parent", action: "set" as const, kind: "agents" as const, threadIds: ["child"], reason: "Second assignment result" };
  const waiting = unwrap(await parent.service.agentWait(request));
  expect(waiting).toMatchObject({ waitRegistration: { status: "registered" }, dependencies: ["child"], metadata: { agentWait: { kind: "agents", threadIds: ["child"] } } });
  expect(waiting.waitRegistration).toEqual({ status: "registered", wait: waiting.waitingOnAgents });
  expect(unwrap(await directory.await({ parentId: "parent", threadIds: ["child"], timeoutMs: 0, currentAssignment: true })).settlement).toBeNull();
  await boundary(); unwrap(await parent.service.close());
  const recovered = fixture(parent.root);
  const retried = unwrap(await recovered.service.agentWait(request));
  expect(retried.waitRegistration).toEqual(waiting.waitRegistration);
  expect(retried.waitingOnAgents).toEqual(waiting.waitingOnAgents);
  expect(retried.dependencies).toEqual(["child"]);
});

it.each([false, true])("delayed historical notifications preserve a current peer wait (cross-owner=%s)", async crossOwner => {
  const parent = fixture(), peer = crossOwner ? fixture(undefined, { workersOnly: true }) : parent;
  const directory = new ThreadDirectory({ id: "person", api: parent.service }, crossOwner ? [{ id: "fleet", api: peer.service }] : []);
  parent.service.setDirectory(directory); peer.service.setDirectory(directory);
  await spawn(parent, "parent"); await spawn(peer, "peer");
  unwrap(await peer.service.send({ requestId: "first", threadId: "peer", text: "First assignment" }));
  unwrap(await peer.service.start()); await until(() => peer.sessions[0]?.commands.some(c => c.workId === "first") === true);
  peer.sessions[0]!.settle(); await until(() => peer.service.latestSettlement("peer")?.workId === "first");
  const historical = peer.service.latestSettlement("peer")!;
  unwrap(await peer.service.send({ requestId: "second", threadId: "peer", text: "Second assignment" }));
  await until(() => peer.sessions[0]?.commands.some(c => c.workId === "second") === true);
  const request = { requestId: "wait", threadId: "parent", action: "set" as const, kind: "agents" as const, threadIds: ["peer"], reason: "Second result" };
  const registered = unwrap(await parent.service.agentWait(request));
  const staleId = `thread-result:${historical.executionId}:parent`;
  const notification = { requestId: staleId, threadId: "parent", senderId: "peer", source: "notification" as const, text: "Delayed first result" };
  unwrap(await parent.service.send(notification));
  expect(parent.service.get("parent")?.waitingOnAgents).toEqual(registered.waitingOnAgents);
  expect(parent.service.get("parent")?.dependencies).toEqual(["peer"]);
  expect(parent.service.pending("parent")).toContainEqual(expect.objectContaining({ id: staleId }));
  expect(unwrap(await parent.service.agentWait(request)).waitRegistration).toEqual(registered.waitRegistration);
  peer.sessions[0]!.settle(); await until(() => peer.service.latestSettlement("peer")?.workId === "second");
  await until(() => parent.service.get("parent")?.waitingOnAgents === undefined);
  expect(parent.service.get("parent")?.dependencies).toEqual([]);
  const current = peer.service.latestSettlement("peer")!;
  expect(parent.service.pending("parent")).toContainEqual(expect.objectContaining({ id: `thread-result:${current.executionId}:parent` }));
});

it("reports the latest completed assignment and new input without terminating either path", async () => {
  const f = fixture(); await spawn(f, "self"); await spawn(f, "child");
  unwrap(await f.service.send({ requestId: "first", threadId: "child", text: "First" }));
  unwrap(await f.service.start()); await until(() => f.sessions[0]?.commands.some(c => c.workId === "first") === true);
  f.sessions[0]!.settle(); await until(() => f.service.latestSettlement("child")?.workId === "first");
  unwrap(await f.service.send({ requestId: "second", threadId: "child", text: "Second" }));
  await until(() => f.sessions[0]?.commands.some(c => c.workId === "second") === true);
  f.sessions[0]!.settle(); await until(() => f.service.latestSettlement("child")?.workId === "second");
  const tools = threadTools({ threadId: "self", cwd: f.root, sessionFile: "none", args: [], env: {}, threads: f.service });
  const wait = tools.find(t => t.name === "thread_wait")!;
  const execute = (id: string, input: unknown) => wait.execute(id, input as never, undefined, undefined, {} as never);
  const arrived = await execute("arrived", { action: "set", kind: "agents", threadIds: ["child"] });
  expect(arrived).toMatchObject({ details: { ok: true, value: { status: "already_arrived", settlement: { threadId: "child" } } } });
  expect(arrived).not.toHaveProperty("terminate");
  unwrap(await f.service.send({ requestId: "human", threadId: "self", text: "Next instruction" }));
  const resumed = await execute("resumed", { action: "set", kind: "job", jobId: "job" });
  expect(resumed).toMatchObject({ details: { ok: true, value: { status: "resumed", messageIds: ["human"] } } });
  expect(resumed).not.toHaveProperty("terminate");
});

it("withdrawn unlanded input cannot swallow a wait during validation", async () => {
  const f = fixture(); await spawn(f, "self"); await spawn(f, "child");
  const directory = new ThreadDirectory({ id: "person", api: f.service }); f.service.setDirectory(directory);
  let entered = false;
  const release = pauseRegistration(f.service, "agents", () => { entered = true; });
  const registering = f.service.agentWait({ requestId: "wait", threadId: "self", action: "set", kind: "agents", threadIds: ["child"], });
  await until(() => entered);
  unwrap(await f.service.send({ requestId: "withdrawn", threadId: "self", text: "Never mind" }));
  unwrap(await f.service.control({ threadId: "self", action: "cancelMessage", messageId: "withdrawn" }));
  release();
  expect(unwrap(await registering)).toMatchObject({ waitRegistration: { status: "registered" }, metadata: { agentWait: { kind: "agents", threadIds: ["child"] } } });
});

it("rejects a competing registration without overwriting accepted intent", async () => {
  const f = fixture(); await spawn(f, "self"); await spawn(f, "child");
  const directory = new ThreadDirectory({ id: "person", api: f.service }); f.service.setDirectory(directory);
  let entered = false;
  const release = pauseRegistration(f.service, "agents", () => { entered = true; });
  const registering = f.service.agentWait({ requestId: "wait", threadId: "self", action: "set", kind: "agents", threadIds: ["child"], });
  await until(() => entered);
  expect(await f.service.agentWait({ requestId: "clear", threadId: "self", action: "clear" })).toMatchObject({ ok: false, error: { code: "conflict" } });
  expect(await f.service.control({ action: "dependencies", threadId: "self", threadIds: [] })).toMatchObject({ ok: false, error: { code: "conflict" } });
  release();
  expect(unwrap(await registering)).toMatchObject({ waitRegistration: { status: "registered" }, metadata: { agentWait: { kind: "agents", threadIds: ["child"] } } });
  expect(unwrap(await f.service.agentWait({ requestId: "clear", threadId: "self", action: "clear" }))).toMatchObject({ waitRegistration: { status: "cleared" }, dependencies: [] });
});

it.each([
  { kind: "agents" as const, threadIds: ["child"] },
  { kind: "job" as const, jobId: "job-123" },
  { kind: "deployment" as const, publicationId: "PUB-123" },
  { kind: "message" as const, fromThreadId: "collaborator" },
])("unlanded explicit input prevents a $kind wait even when accepted before registration", async dependency => {
  const f = fixture(); await spawn(f, "self"); await spawn(f, "collaborator");
  unwrap(await f.service.spawn({ requestId: "child", id: "child", parentId: "self", cwd: f.root }));
  unwrap(await f.service.send({ requestId: "human", threadId: "self", text: "New instruction" }));
  const result = unwrap(await f.service.agentWait({ requestId: "wait", threadId: "self", action: "set", ...dependency }));
  expect(result.waitingOnAgents).toBeUndefined();
  expect(result.waitRegistration).toEqual({ status: "resumed", messageIds: ["human"] });
  expect(result.dependencies).toEqual([]);
  expect(f.service.pending("self")).toMatchObject([{ id: "human" }]);
  expect(f.sessions).toHaveLength(0);
});

it.each(["collaborator", "other"])("completed notification from %s during validation obeys the named message dependency", async senderId => {
  const f = fixture(); for (const id of ["self", "collaborator", "other"]) await spawn(f, id);
  const directory = new ThreadDirectory({ id: "person", api: f.service }); f.service.setDirectory(directory);
  let entered = false;
  const release = pauseRegistration(f.service, "message", () => { entered = true; });
  const registering = f.service.agentWait({ requestId: "wait", threadId: "self", action: "set", kind: "message", fromThreadId: "collaborator" });
  await until(() => entered);
  unwrap(await f.service.send({ requestId: "notification", threadId: "self", senderId, source: "notification", text: "Result" }));
  unwrap(await f.service.start()); await until(() => f.sessions[0]?.commands.some(c => c.type === "prompt") === true);
  f.sessions[0]!.settle(); await until(() => f.service.get("self")?.state === "idle");
  expect(f.service.pending("self")).toHaveLength(0);
  release(); const result = unwrap(await registering);
  if (senderId === "collaborator") expect(result.waitingOnAgents).toBeUndefined();
  else expect(result.waitingOnAgents).toMatchObject({ kind: "message", fromThreadId: "collaborator" });
});

it("a settled parent has no explicit wait even when its cleanup child waits across restart", async () => {
  const f = fixture(); await spawn(f, "parent"); await spawn(f, "collaborator");
  unwrap(await f.service.send({ requestId: "parent-work", threadId: "parent", text: "Complete local work" }));
  unwrap(await f.service.spawn({ requestId: "cleanup", id: "cleanup", parentId: "parent", cwd: f.root, message: "Keep cleanup custody" }));
  unwrap(await f.service.start()); await until(() => f.sessions.filter(s => s.commands.some(c => c.type === "prompt")).length === 2);
  const childSession = f.sessions.find(s => s.commands.some(c => c.workId === "cleanup"))!;
  const parentSession = f.sessions.find(s => s.commands.some(c => c.workId === "parent-work"))!;
  const request = { requestId: "cleanup-wait", threadId: "cleanup", action: "set" as const, kind: "message" as const,
    reason: "Cleanup owner reply", fromThreadId: "collaborator" };
  const wait = unwrap(await f.service.agentWait(request)).waitingOnAgents;
  childSession.settle(); await until(() => !!f.service.latestSettlement("cleanup"));
  expect(parentSession.commands.some(c => c.type === "steer")).toBe(false);
  parentSession.settle(); await until(() => f.service.get("parent")?.state === "idle");
  const settlement = f.service.latestSettlement("parent");
  const assertProjection = async (service: ThreadService) => {
    const parent = service.get("parent")!;
    expect(parent).toMatchObject({ state: "idle", held: false, pendingMessages: 0 });
    expect(parent.metadata?.agentWait).toBeUndefined(); expect(parent.waitingOnAgents).toBeUndefined();
    expect(unwrap(await service.list({ id: "parent" })).threads[0]?.waitingOnAgents).toBeUndefined();
    expect(unwrap(await service.inspect("parent")).thread.waitingOnAgents).toBeUndefined();
    expect(service.latestSettlement("parent")).toEqual(settlement);
    expect(service.get("cleanup")).toMatchObject({ state: "waiting", held: false, pendingMessages: 0, waitingOnAgents: wait });
  };
  await assertProjection(f.service); await boundary(); unwrap(await f.service.close());
  const next = fixture(f.root); unwrap(await next.service.start()); next.service.reconcile(); await boundary();
  await assertProjection(next.service); expect(next.sessions).toHaveLength(0);
  unwrap(await next.service.control({ threadId: "parent", action: "stop", descendants: false }));
  expect(next.service.get("parent")?.waitingOnAgents).toBeUndefined();
  expect(next.service.get("cleanup")?.waitingOnAgents).toEqual(wait);
});

it("Close discards wakes across restart; reopen creates no work", async () => {
  const f = fixture(); await spawn(f, "held"); await spawn(f, "archived");
  unwrap(await schedule(f, "held", "wake-held")); unwrap(await schedule(f, "archived", "wake-archived"));
  unwrap(await f.service.agentWait({ requestId: "wait-held", threadId: "held", action: "set", kind: "job", jobId: "external-job", }));
  unwrap(await f.service.control({ threadId: "held", action: "stop", descendants: false }));
  unwrap(await f.service.control({ threadId: "archived", action: "update", archived: true })); unwrap(await f.service.close());
  const next = fixture(f.root); unwrap(await next.service.start()); next.service.reconcile(); await boundary();
  expect(next.sessions).toHaveLength(0); expect(next.service.pending("held")).toHaveLength(0);
  unwrap(await next.service.control({ threadId: "archived", action: "restore", descendants: false })); next.service.reconcile(); await boundary();
  expect(next.sessions).toHaveLength(0); expect(next.service.get("archived")?.held).toBe(false);
  expect(next.service.get("archived")?.wakeSchedule).toBeUndefined();
  unwrap(await next.service.control({ threadId: "held", action: "reopen" }));
  unwrap(await next.service.wakeSchedule({ threadId: "archived", action: "cancel", requestId: "cancel-archived" }));
  unwrap(await next.service.send({ requestId: "resume-held", threadId: "held", text: "Continue" }));
  await until(() => next.sessions[0]?.commands.some(c => c.type === "prompt") === true);
  expect(next.service.get("held")?.waitingOnAgents).toBeUndefined(); next.service.reconcile(); expect(next.service.pending("held")).toHaveLength(1);
});

it("set/change/cancel retries have stable custody, invalid dependencies cannot mark waiting, and pending waits resist auto-archive", async () => {
  const f = fixture(); await spawn(f, "self"); await spawn(f, "other");
  const input = { threadId: "self", action: "set" as const, requestId: "schedule", reason: "job", cadenceMs: 60000, nextDueAt: 500000 };
  unwrap(await f.service.wakeSchedule(input)); unwrap(await f.service.wakeSchedule(input));
  expect((await f.service.wakeSchedule({ ...input, cadenceMs: 70000 })).ok).toBe(false);
  unwrap(await f.service.wakeSchedule({ ...input, requestId: "retime", nextDueAt: 900000 }));
  unwrap(await f.service.wakeSchedule(input)); expect(f.service.get("self")?.wakeSchedule?.nextDueAt).toBe(900000);
  const bad = await f.service.agentWait({ requestId: "bad", threadId: "self", action: "set", kind: "agents", threadIds: ["missing"] }); expect(bad.ok).toBe(false);
  expect(f.service.get("self")?.waitingOnAgents).toBeUndefined();
  unwrap(await f.service.wakeSchedule({ threadId: "self", action: "cancel", requestId: "cancel" }));
  unwrap(await f.service.wakeSchedule({ threadId: "self", action: "cancel", requestId: "cancel" }));
  unwrap(await f.service.wakeSchedule(input)); expect(f.service.get("self")?.wakeSchedule).toBeUndefined();
  unwrap(await f.service.agentWait({ requestId: "wait", threadId: "self", action: "set", kind: "job", jobId: "external-job", }));
  const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 10000);
  unwrap(await f.service.control({ threadId: "self", action: "archiveInactive", inactiveBefore: Date.now() - 1 })); expect(f.service.get("self")?.metadata?.archived).not.toBe(true);
  clock.mockRestore(); unwrap(await f.service.agentWait({ requestId: "clear", threadId: "self", action: "clear" })); expect(f.service.get("self")?.waitingOnAgents).toBeUndefined();
});

it("capability admission denies other threads and other people, including schedule reads", async () => {
  const f = fixture(); await spawn(f, "self"); await spawn(f, "other");
  const key = threadCapability(join(f.root, "key")), foreignKey = threadCapability(join(f.root, "foreign-key"));
  const resolver = callerResolver({ capability: key });
  const transport = async (url: string | URL | Request, init?: RequestInit) => {
    const request = new Request(String(url), init); return (await threadHttp(f.service, request, "/v1/threads", admissionFor(resolver, { headers: request.headers })))!;
  };
  const own = createThreadClient("http://fixture/v1/threads", transport, { token: key.issue("self") });
  unwrap(await own.wakeSchedule({ threadId: "self", action: "set", requestId: "own", reason: "job", cadenceMs: 60000 }));
  for (const action of ["list", "cancel"] as const) expect((await own.wakeSchedule({ threadId: "other", action, requestId: "forged" })).ok).toBe(false);
  expect((await own.agentWait({ threadId: "other", action: "set", kind: "job", jobId: "external-job", requestId: "forged-wait", })).ok).toBe(false);
  const foreign = createThreadClient("http://fixture/v1/threads", transport, { token: foreignKey.issue("self") });
  expect((await foreign.wakeSchedule({ threadId: "self", action: "list" })).ok).toBe(false);
  const process = createThreadClient("http://fixture/v1/threads", transport); expect((await process.wakeSchedule({ threadId: "self", action: "list" })).ok).toBe(false);
});

it.each(["prepare", "admit", "open"] as const)("cancel fences a queued wake while %s is in flight", async phase => {
  let release!: () => void, entered = false;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const f = fixture(undefined, phase === "prepare" ? { prepareMessage: async (_thread, message) => { entered = true; await gate; return { ok: true, value: { text: message.text } }; } }
    : phase === "admit" ? { admit: async () => { entered = true; await gate; return { ok: true, value: { release() {} } }; } } : {}, phase === "open" ? async () => { entered = true; await gate; } : undefined);
  await spawn(f, "self"); unwrap(await schedule(f, "self")); unwrap(await f.service.start());
  await until(() => entered);
  unwrap(await f.service.wakeSchedule({ action: "cancel", threadId: "self", requestId: "cancel-in-flight" }));
  expect(f.service.get("self")?.state).toBe("idle"); release(); await boundary(); await boundary();
  expect(f.sessions.flatMap(session => session.commands).some(command => command.type === "prompt")).toBe(false);
  expect(f.service.pending("self")).toHaveLength(0);
});

it("typed external waits survive restart and collaborator messages clear only the named message wait", async () => {
  const f = fixture(); await spawn(f, "self"); await spawn(f, "collaborator"); await spawn(f, "other");
  expect((await f.service.agentWait({ requestId: "generic", threadId: "self", action: "set", reason: "available" } as never)).ok).toBe(false);
  expect((await f.service.agentWait({ requestId: "empty", threadId: "self", action: "set", kind: "agents", threadIds: [] })).ok).toBe(false);
  unwrap(await f.service.agentWait({ requestId: "job", threadId: "self", action: "set", kind: "job", jobId: "assay-123" }));
  unwrap(await f.service.close()); const next = fixture(f.root);
  expect(next.service.get("self")?.waitingOnAgents).toMatchObject({ kind: "job", jobId: "assay-123" });
  unwrap(await next.service.agentWait({ requestId: "release", threadId: "self", action: "set", kind: "deployment", publicationId: "PUB-123" }));
  expect(next.service.get("self")?.waitingOnAgents).toMatchObject({ kind: "deployment", publicationId: "PUB-123" });
  expect((await next.service.agentWait({ requestId: "foreign", threadId: "self", action: "set", kind: "message", fromThreadId: "inaccessible" })).ok).toBe(false);
  unwrap(await next.service.agentWait({ requestId: "message", threadId: "self", action: "set", kind: "message", fromThreadId: "collaborator" }));
  unwrap(await next.service.send({ requestId: "unrelated", threadId: "self", senderId: "other", source: "notification", text: "Unrelated result" }));
  expect(next.service.get("self")?.waitingOnAgents).toMatchObject({ kind: "message", fromThreadId: "collaborator" });
  unwrap(await next.service.send({ requestId: "matched", threadId: "self", senderId: "collaborator", source: "notification", text: "Named result" }));
  expect(next.service.get("self")?.waitingOnAgents).toBeUndefined();
});

it.each([
  { kind: "agents", threadIds: ["child"], after: { child: 0 } },
  { kind: "job", jobId: "job-123" },
  { kind: "deployment", publicationId: "PUB-123" },
  { kind: "message", fromThreadId: "collaborator" },
])("authenticated wire/tool custody accepts $kind, terminates only a registered wait, and clear creates no work", async dependency => {
  const f = fixture(); await spawn(f, "self"); await spawn(f, "collaborator");
  unwrap(await f.service.spawn({ requestId: "child", id: "child", parentId: "self", cwd: f.root }));
  const key = threadCapability(join(f.root, "key"));
  const resolver = callerResolver({ capability: key });
  const transport = async (url: string | URL | Request, init?: RequestInit) => {
    const request = new Request(String(url), init);
    return (await threadHttp(f.service, request, "/v1/threads", admissionFor(resolver, { headers: request.headers })))!;
  };
  const tools = threadTools({ threadId: "self", cwd: f.root, sessionFile: "none", args: [], env: {}, threads: createThreadClient("http://fixture/v1/threads", transport, { token: key.issue("self") }) });
  const wait = tools.find(t => t.name === "thread_wait")!;
  const execute = (id: string, input: unknown) => wait.execute(id, input as never, undefined, undefined, {} as never);
  for (const [n, input] of [{ action: "set", reason: "done" }, { action: "set", reason: "done", threadIds: [] }, { action: "set", kind: "agents", reason: "done", threadIds: [] }].entries()) {
    expect(await execute(`bad:${n}`, input)).toMatchObject({ isError: true, details: { ok: false } });
    expect(await execute(`bad:${n}`, input)).not.toHaveProperty("terminate");
    expect(f.service.get("self")?.waitingOnAgents).toBeUndefined();
  }
  const input = { action: "set", reason: "needed", ...dependency };
  expect(await execute("wait", input)).toMatchObject({ terminate: true, details: { ok: true } });
  const since = f.service.get("self")!.waitingOnAgents!.since;
  expect(await execute("wait", input)).toMatchObject({ terminate: true });
  expect(f.service.get("self")!.waitingOnAgents!.since).toBe(since);
  expect(await execute("wait", { ...input, reason: "changed input" })).toMatchObject({ isError: true, details: { error: { code: "conflict" } } });
  expect(await execute("clear", { action: "clear" })).not.toHaveProperty("terminate");
  expect(await execute("wait", input)).not.toHaveProperty("terminate");
  expect(f.service.get("self")?.waitingOnAgents).toBeUndefined();
  expect(f.service.pending("self")).toHaveLength(0); expect(f.sessions).toHaveLength(0);
});

it("normalizes only explicit legacy child waits, preserving raw receipt identity and ordinary settlements", async () => {
  const f = fixture(); await spawn(f, "self"); await spawn(f, "other");
  unwrap(await f.service.spawn({ requestId: "child", id: "child", parentId: "self", cwd: f.root, message: "work" }));
  unwrap(await f.service.start()); await until(() => f.sessions[0]?.commands.some(c => c.type === "prompt") === true);
  const legacy = { requestId: "legacy-wait", threadId: "self", action: "set", reason: "child", threadIds: ["child"] } as const;
  const waiting = unwrap(await f.service.agentWait(legacy as never));
  expect(waiting.waitingOnAgents).toMatchObject({ kind: "agents", threadIds: ["child"] });
  expect(unwrap(await f.service.agentWait(legacy as never)).waitingOnAgents).toEqual(waiting.waitingOnAgents);
  expect(await f.service.agentWait({ ...legacy, kind: "agents" } as never)).toMatchObject({ ok: false, error: { code: "conflict" } });
  expect(await f.service.agentWait({ ...legacy, requestId: "foreign", threadIds: ["missing"] } as never)).toMatchObject({ ok: false });
  expect(await f.service.agentWait({ ...legacy, requestId: "mixed", jobId: "guessed" } as never)).toMatchObject({ ok: false });
  f.sessions[0]!.settle(); await until(() => !!f.service.latestSettlement("child"));
  const settlement = f.service.latestSettlement("child")!;
  expect(settlement).toMatchObject({ outcome: "complete" });
  await until(() => f.sessions[1]?.commands.some(c => c.type === "prompt") === true);
  expect(f.service.get("self")?.waitingOnAgents).toBeUndefined();
  expect(f.service.pending("self")).toHaveLength(1);
  expect(unwrap(await f.service.agentWait(legacy as never)).waitingOnAgents).toBeUndefined();
  f.service.reconcile(); await boundary();
  expect(f.service.latestSettlement("child")).toEqual(settlement);
  expect(f.service.pending("self")).toHaveLength(1);
});

it("native tools end dependency waits rather than asking a model to poll; transient await is an explicit observed phase", async () => {
  const f = fixture(); await spawn(f, "self");
  const tools = threadTools({ threadId: "self", cwd: f.root, sessionFile: "none", args: [], env: {}, threads: f.service });
  const wait = tools.find(t => t.name === "thread_wait")!;
  const result = await wait.execute("call", { action: "set", kind: "job", jobId: "external-job", reason: "external job" } as never, undefined, undefined, {} as never);
  expect(result).toMatchObject({ terminate: true, details: { ok: true } });
  const activity = createExecutionActivity(); observeExecutionActivity(activity, { type: "tool_execution_start", toolCallId: "await", toolName: "thread_await" }); expect(activity.activity).toBe("waiting_on_agents");
  observeExecutionActivity(activity, { type: "tool_execution_start", toolCallId: "shell", toolName: "bash" }); expect(activity.activity).toBe("waiting_on_tool");
  observeExecutionActivity(activity, { type: "tool_execution_end", toolCallId: "shell" }); expect(activity.activity).toBe("waiting_on_agents");
});

it("legacy child waits retain validation, retry identity and normalized custody across restart", async () => {
  const f = fixture(); await spawn(f, "parent"); await spawn(f, "unrelated");
  unwrap(await f.service.spawn({ requestId: "child", id: "child", parentId: "parent", cwd: f.root }));
  const request = { requestId: "legacy-call", threadId: "parent", action: "set" as const, reason: "Child result", threadIds: ["child"], after: { child: 0 } };
  const before = f.service.get("parent");
  for (const invalid of [
    { ...request, threadIds: [] },
    { ...request, threadIds: ["unrelated"] },
    { ...request, after: { foreign: 0 } },
    { ...request, jobId: "ambiguous" },
  ]) {
    expect(await f.service.agentWait(invalid)).toMatchObject({ ok: false, error: { code: "invalid_request" } });
    expect(f.service.get("parent")).toEqual(before);
    expect(f.service.pending("parent")).toEqual([]);
  }
  const accepted = unwrap(await f.service.agentWait(request));
  expect(accepted.metadata?.agentWait).toMatchObject({ kind: "agents", threadIds: ["child"], after: { child: 0 } });
  expect(unwrap(await f.service.agentWait(request))).toEqual(accepted);
  unwrap(await f.service.close());
  const next = fixture(f.root);
  expect(next.service.get("parent")?.metadata?.agentWait).toEqual(accepted.metadata?.agentWait);
  expect(unwrap(await next.service.agentWait(request)).metadata?.agentWait).toEqual(accepted.metadata?.agentWait);
  expect(next.service.pending("parent")).toEqual([]);
});

it("old wrapper shape crosses authenticated HTTP while new schema still advertises each typed kind", async () => {
  const f = fixture(); await spawn(f, "parent"); await spawn(f, "other");
  unwrap(await f.service.spawn({ requestId: "child", id: "child", parentId: "parent", cwd: f.root }));
  const key = threadCapability(join(f.root, "key"));
  const resolver = callerResolver({ capability: key });
  const transport = async (url: string | URL | Request, init?: RequestInit) => {
    const request = new Request(String(url), init);
    return (await threadHttp(f.service, request, "/v1/threads", admissionFor(resolver, { headers: request.headers })))!;
  };
  const own = createThreadClient("http://fixture/v1/threads", transport, { token: key.issue("parent") });
  const input = { requestId: "old-call", threadId: "parent", action: "set" as const, reason: "Child result", threadIds: ["child"], after: { child: 0 } };
  const denied = await own.agentWait({ ...input, threadId: "other" });
  expect(denied.ok).toBe(false);
  expect(f.service.get("other")?.metadata?.agentWait).toBeUndefined();
  const accepted = unwrap(await own.agentWait(input));
  expect(accepted.metadata?.agentWait).toMatchObject({ kind: "agents", threadIds: ["child"], after: { child: 0 } });
  expect(unwrap(await own.agentWait(input)).metadata?.agentWait).toEqual(accepted.metadata?.agentWait);
  const tool = threadTools({ threadId: "parent", cwd: f.root, sessionFile: "none", args: [], env: {}, threads: own }).find(t => t.name === "thread_wait")!;
  const schema = tool.parameters as { anyOf: Array<{ required: string[]; properties: { kind?: { const: string } } }> };
  expect(schema.anyOf.filter(branch => branch.properties.kind).map(branch => branch.properties.kind?.const)).toEqual(["agents", "job", "deployment", "message"]);
  for (const branch of schema.anyOf.filter(branch => branch.properties.kind)) expect(branch.required).toContain("kind");
});

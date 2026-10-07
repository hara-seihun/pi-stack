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
const spawn = (f: ReturnType<typeof fixture>, id: string) => f.service.spawn({ requestId: `spawn:${id}`, id, cwd: f.root });
const schedule = (f: ReturnType<typeof fixture>, threadId: string, requestId = "schedule") => f.service.wakeSchedule({ threadId, action: "set", requestId, reason: "Inspect durable job", cadenceMs: 60000, nextDueAt: 0 });

it("wakes an idle existing thread once, persists observability and coalesces overdue checks under admission", async () => {
  let now = 100000;
  vi.spyOn(Date, "now").mockImplementation(() => now);
  const admit = vi.fn(async () => ({ ok: false as const, error: { code: "unavailable" as const, message: "Capacity unavailable" } }));
  const f = fixture(undefined, { admit }); await spawn(f, "self"); unwrap(await schedule(f, "self"));
  unwrap(await f.service.start()); await until(() => admit.mock.calls.length > 0);
  const queued = f.service.pending("self"); expect(queued).toHaveLength(1); expect(queued[0]).toMatchObject({ source: "notification", threadId: "self" });
  expect(f.service.get("self")?.wakeSchedule).toMatchObject({ nextDueAt: 160000, lastDeliveredAt: 100000, lastMessageId: queued[0]!.id });
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

it.each([true, false])("dependency settlement resumes a durable waiter through the existing cross-owner result route (legacy=%s)", async legacy => {
  const parent = fixture(), child = fixture(undefined, { workersOnly: true });
  const directory = new ThreadDirectory({ id: "person", api: parent.service }, [{ id: "fleet", api: child.service }]);
  parent.service.setDirectory(directory); child.service.setDirectory(directory);
  await spawn(parent, "parent"); unwrap(await parent.service.start()); unwrap(await child.service.start());
  unwrap(await child.service.spawn({ requestId: "child", id: "child", parentId: "parent", cwd: child.root, message: "work" }));
  await until(() => child.sessions[0]?.commands.some(c => c.type === "prompt") === true);
  const wait = unwrap(await parent.service.agentWait({ requestId: "wait", threadId: "parent", action: "set", ...(legacy ? {} : { kind: "agents" as const }), reason: "Need child result", threadIds: ["child"] }));
  expect(wait).toMatchObject({ state: "idle", waitingOnAgents: { threadIds: ["child"], reason: "Need child result" } });
  expect(parent.sessions).toHaveLength(0);
  child.sessions[0]!.settle(); await until(() => parent.sessions[0]?.commands.some(c => c.type === "prompt") === true);
  expect(parent.service.get("parent")?.waitingOnAgents).toBeUndefined();
  expect(parent.service.pending("parent")).toHaveLength(1);
  expect(parent.service.pending("parent")[0]).toMatchObject({ senderId: "child", source: "notification" });
  parent.sessions[0]!.settle(); await until(() => parent.service.get("parent")?.state === "idle");
  expect(unwrap(await parent.service.agentWait({ requestId: "wait-after-result", threadId: "parent", action: "set", kind: "agents", reason: "Already arrived", threadIds: ["child"] })).waitingOnAgents).toBeUndefined();
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
  let release!: () => void, entered = false;
  const gate = new Promise<void>(resolve => { release = resolve; });
  if (kind === "agents") vi.spyOn(directory, "await").mockImplementationOnce(async input => {
    const result = f.service.await(input); entered = true; await gate; return result;
  });
  else vi.spyOn(directory, "list").mockImplementationOnce(async input => {
    const result = await f.service.list(input); entered = true; await gate; return result;
  });
  const request = { requestId: "racing-wait", threadId: "self", action: "set" as const, reason: "Dependency result",
    ...(kind === "agents" ? { kind, threadIds: ["child"] } : { kind, fromThreadId: "collaborator" }) };
  const registering = f.service.agentWait(request); await until(() => entered);
  unwrap(await f.service.send({ requestId: "human", threadId: "self", text: "Continue with my new instruction" }));
  if (completed) {
    unwrap(await f.service.start()); await until(() => f.sessions[0]?.commands.some(c => c.type === "prompt") === true);
    f.sessions[0]!.settle(); await until(() => f.service.get("self")?.state === "idle");
    expect(f.service.latestSettlement("self")?.outcome).toBe("complete");
    expect(f.service.pending("self")).toHaveLength(0);
  }
  release();
  expect(unwrap(await registering).waitingOnAgents).toBeUndefined();
  expect(unwrap(await f.service.agentWait(request)).waitingOnAgents).toBeUndefined();
  expect(f.service.get("self")?.metadata?.agentWait).toBeUndefined();
  if (!completed) expect(f.service.pending("self")).toMatchObject([{ id: "human", source: "explicit" }]);
  await boundary(); unwrap(await f.service.close());
  const next = fixture(f.root);
  expect(next.service.get("self")?.waitingOnAgents).toBeUndefined();
  expect(unwrap(await next.service.agentWait(request)).waitingOnAgents).toBeUndefined();
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
  const result = unwrap(await f.service.agentWait({ requestId: "wait", threadId: "self", action: "set", reason: "Dependency", ...dependency }));
  expect(result.waitingOnAgents).toBeUndefined();
  expect(f.service.pending("self")).toMatchObject([{ id: "human" }]);
  expect(f.sessions).toHaveLength(0);
});

it.each(["collaborator", "other"])("completed notification from %s during validation obeys the named message dependency", async senderId => {
  const f = fixture(); for (const id of ["self", "collaborator", "other"]) await spawn(f, id);
  const directory = new ThreadDirectory({ id: "person", api: f.service }); f.service.setDirectory(directory);
  let release!: () => void, entered = false;
  const gate = new Promise<void>(resolve => { release = resolve; });
  vi.spyOn(directory, "list").mockImplementationOnce(async input => {
    const result = await f.service.list(input); entered = true; await gate; return result;
  });
  const registering = f.service.agentWait({ requestId: "wait", threadId: "self", action: "set", kind: "message", reason: "Named result", fromThreadId: "collaborator" });
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
  await until(() => parentSession.commands.some(c => c.type === "steer"));
  parentSession.settle(); await until(() => f.service.get("parent")?.state === "idle");
  const settlement = f.service.latestSettlement("parent");
  const assertProjection = async (service: ThreadService) => {
    const parent = service.get("parent")!;
    expect(parent).toMatchObject({ state: "idle", held: false, pendingMessages: 0 });
    expect(parent.metadata?.agentWait).toBeUndefined(); expect(parent.waitingOnAgents).toBeUndefined();
    expect(unwrap(await service.list({ id: "parent" })).threads[0]?.waitingOnAgents).toBeUndefined();
    expect(unwrap(await service.inspect("parent")).thread.waitingOnAgents).toBeUndefined();
    expect(service.latestSettlement("parent")).toEqual(settlement);
    expect(service.get("cleanup")).toMatchObject({ state: "idle", held: false, pendingMessages: 0, waitingOnAgents: wait });
  };
  await assertProjection(f.service); await boundary(); unwrap(await f.service.close());
  const next = fixture(f.root); unwrap(await next.service.start()); next.service.reconcile(); await boundary();
  await assertProjection(next.service); expect(next.sessions).toHaveLength(0);
  unwrap(await next.service.control({ threadId: "parent", action: "stop", descendants: false }));
  expect(next.service.get("parent")?.waitingOnAgents).toBeUndefined();
  expect(next.service.get("cleanup")?.waitingOnAgents).toEqual(wait);
});

it("Stop and archive pause wakes across restart; restore alone never releases the hold", async () => {
  const f = fixture(); await spawn(f, "held"); await spawn(f, "archived");
  unwrap(await schedule(f, "held", "wake-held")); unwrap(await schedule(f, "archived", "wake-archived"));
  unwrap(await f.service.agentWait({ requestId: "wait-held", threadId: "held", action: "set", kind: "job", jobId: "external-job", reason: "External job" }));
  unwrap(await f.service.control({ threadId: "held", action: "stop", descendants: false }));
  unwrap(await f.service.control({ threadId: "archived", action: "update", archived: true })); unwrap(await f.service.close());
  const next = fixture(f.root); unwrap(await next.service.start()); next.service.reconcile(); await boundary();
  expect(next.sessions).toHaveLength(0); expect(next.service.pending("held")).toHaveLength(0);
  unwrap(await next.service.control({ threadId: "archived", action: "restore", descendants: false })); next.service.reconcile(); await boundary();
  expect(next.sessions).toHaveLength(0); expect(next.service.get("archived")?.held).toBe(true);
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
  const bad = await f.service.agentWait({ requestId: "bad", threadId: "self", action: "set", kind: "agents", reason: "x", threadIds: ["other"] }); expect(bad.ok).toBe(false);
  expect(f.service.get("self")?.waitingOnAgents).toBeUndefined();
  unwrap(await f.service.wakeSchedule({ threadId: "self", action: "cancel", requestId: "cancel" }));
  unwrap(await f.service.wakeSchedule({ threadId: "self", action: "cancel", requestId: "cancel" }));
  unwrap(await f.service.wakeSchedule(input)); expect(f.service.get("self")?.wakeSchedule).toBeUndefined();
  unwrap(await f.service.agentWait({ requestId: "wait", threadId: "self", action: "set", kind: "job", jobId: "external-job", reason: "external" }));
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
  expect((await own.agentWait({ threadId: "other", action: "set", kind: "job", jobId: "external-job", requestId: "forged-wait", reason: "x" })).ok).toBe(false);
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
  expect((await f.service.agentWait({ requestId: "empty", threadId: "self", action: "set", kind: "agents", reason: "available", threadIds: [] })).ok).toBe(false);
  unwrap(await f.service.agentWait({ requestId: "job", threadId: "self", action: "set", kind: "job", reason: "GPU assay", jobId: "assay-123" }));
  unwrap(await f.service.close()); const next = fixture(f.root);
  expect(next.service.get("self")?.waitingOnAgents).toMatchObject({ kind: "job", jobId: "assay-123" });
  unwrap(await next.service.agentWait({ requestId: "release", threadId: "self", action: "set", kind: "deployment", reason: "Release", publicationId: "PUB-123" }));
  expect(next.service.get("self")?.waitingOnAgents).toMatchObject({ kind: "deployment", publicationId: "PUB-123" });
  expect((await next.service.agentWait({ requestId: "foreign", threadId: "self", action: "set", kind: "message", reason: "Collaborator", fromThreadId: "inaccessible" })).ok).toBe(false);
  unwrap(await next.service.agentWait({ requestId: "message", threadId: "self", action: "set", kind: "message", reason: "Collaborator", fromThreadId: "collaborator" }));
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
  expect(await f.service.agentWait({ ...legacy, requestId: "foreign", threadIds: ["other"] } as never)).toMatchObject({ ok: false });
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

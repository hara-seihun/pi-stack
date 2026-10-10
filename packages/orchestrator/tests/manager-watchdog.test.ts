import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { ThreadService } from "../src/threads/service.js";
import { ThreadDirectory } from "../src/threads/directory.js";
import { hasManagedWork, MANAGER_INACTIVITY_MS, MANAGER_WATCHDOG_PREFIX } from "../src/threads/manager-watchdog.js";
import { admissionFor, callerResolver, threadCapability } from "../src/threads/caller.js";
import { createThreadClient, threadHttp } from "../src/threads/http.js";
import type { PiCommand, PiEvent, Result, Thread } from "../src/threads/contracts.js";

const roots: string[] = [], owners: ThreadService[] = [];
const unwrap = <T>(result: Result<T>): T => { if (!result.ok) throw new Error(result.error.message); return result.value; };
const boundary = () => new Promise<void>(resolve => setImmediate(resolve));
async function until(check: () => boolean) { for (let i = 0; i < 100; i++) { if (check()) return; await boundary(); } throw new Error("Expected lifecycle boundary"); }
function fixture(root = mkdtempSync(join(tmpdir(), "manager-watchdog-")), denied = false) {
  if (!roots.includes(root)) roots.push(root);
  const sessions: Array<{ commands: PiCommand[]; settle(): void; emit(event: PiEvent): void }> = [];
  const service = new ThreadService({ databasePath: join(root, "threads.sqlite"), sessionsDir: join(root, "sessions"), capacity: { mode: "unmanaged" },
    ...(denied ? { admit: async () => ({ ok: false as const, error: { code: "unavailable" as const, message: "Capacity unavailable" } }) } : {}),
    openSession: async (_options, output) => {
      let running = false;
      const accepted: string[] = [];
      const session = { commands: [] as PiCommand[], emit: output,
        settle() { running = false; output({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "done" }], stopReason: "stop" } }); output({ type: "agent_settled" }); },
        async command(command: PiCommand) {
          session.commands.push(command);
          if (command.type === "prompt" || command.type === "steer") { running = true; accepted.push(String(command.workId)); output({ type: "agent_start" }); }
          if (command.type === "abort") running = false;
          output({ type: "response", id: command.id, command: command.type, success: true, data: command.type === "get_state" ? { isStreaming: running, pendingMessageCount: 0, acceptedWorkIds: accepted } : {} });
        }, async close() {},
      }; sessions.push(session); return session;
    },
  });
  owners.push(service);
  const errors: Array<string | null> = [];
  const observe = new ThreadDirectory({ id: "person", api: service });
  service.setManagerWatchdog(async () => { const summary = await observe.managerWorkSummary(); return summary.ok ? { ok: true, value: { ...summary.value, managerThreadId: "manager" } } : summary; }, error => errors.push(error));
  return { root, service, sessions, errors, async tick() { await until(() => !(service as unknown as { managerWatchdogRunning: boolean }).managerWatchdogRunning); service.reconcile(); await until(() => !(service as unknown as { managerWatchdogRunning: boolean }).managerWatchdogRunning); await boundary(); } };
}
async function initialize(f: ReturnType<typeof fixture>) {
  unwrap(await f.service.spawn({ requestId: "manager-create", id: "manager", cwd: f.root, metadata: { manager: true }, createdBy: { kind: "person", via: "router" } }));
  unwrap(await f.service.spawn({ requestId: "worker-create", id: "worker", cwd: f.root }));
  unwrap(await f.service.control({ action: "placement", threadId: "worker", foreground: true }));
}
async function waitForJob(f: ReturnType<typeof fixture>) {
  unwrap(await f.service.agentWait({ requestId: "worker-job", action: "set", threadId: "worker", kind: "job", jobId: "durable-job" }));
}
afterEach(async () => { for (const owner of owners.splice(0)) await owner.detach(); vi.restoreAllMocks(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

it("idle schedules and the watchdog's own turn never create an endless manager loop", async () => {
  let now = 1_000_000; vi.spyOn(Date, "now").mockImplementation(() => now);
  const f = fixture(); await initialize(f); unwrap(await f.service.start()); await f.tick();
  now += 20 * MANAGER_INACTIVITY_MS; await f.tick(); expect(f.sessions).toHaveLength(0);
  unwrap(await f.service.wakeSchedule({ action: "set", threadId: "worker", requestId: "future", reason: "Future task", cadenceMs: MANAGER_INACTIVITY_MS, nextDueAt: now + 100 * MANAGER_INACTIVITY_MS }));
  await f.tick(); now += MANAGER_INACTIVITY_MS; await f.tick(); expect(f.sessions).toHaveLength(0);
  await waitForJob(f); await f.tick(); now += MANAGER_INACTIVITY_MS; await f.tick();
  await until(() => f.sessions.some(session => session.commands.some(command => String(command.workId).startsWith(MANAGER_WATCHDOG_PREFIX))));
  unwrap(await f.service.agentWait({ action: "clear", threadId: "worker", requestId: "job-done" }));
  expect(unwrap(await f.service.managerWorkSummary()).activeWork).toBe(false);
  f.sessions[0]!.settle(); await until(() => f.service.get("manager")?.lifecycle.kind === "idle");
  now += 10 * MANAGER_INACTIVITY_MS; await f.tick();
  expect(f.sessions.flatMap(session => session.commands).filter(command => command.type === "prompt")).toHaveLength(1);
});

it("worker messages and tool events cannot postpone silence; a human message on any owned surface does", async () => {
  let now = 1_000_000; vi.spyOn(Date, "now").mockImplementation(() => now);
  const f = fixture(); await initialize(f); await waitForJob(f);
  unwrap(await f.service.send({ threadId: "manager", requestId: "human", text: "Manage this" }));
  unwrap(await f.service.start()); await until(() => f.sessions[0]?.commands.some(command => command.workId === "human") === true);
  f.sessions[0]!.settle(); await until(() => f.service.get("manager")?.lifecycle.kind === "idle"); await f.tick();
  now += MANAGER_INACTIVITY_MS - 1;
  unwrap(await f.service.send({ threadId: "worker", senderId: "other-agent", requestId: "worker-traffic", source: "notification", text: "Progress" }));
  await f.tick(); expect(f.service.pending("manager")).toHaveLength(0);
  await until(() => f.sessions.some(session => session.commands.some(command => command.workId === "worker-traffic")));
  const traffic = f.sessions.find(session => session.commands.some(command => command.workId === "worker-traffic"))!;
  traffic.emit({ type: "tool_execution_start", toolCallId: "busy-tool", toolName: "bash" });
  traffic.emit({ type: "tool_execution_end", toolCallId: "busy-tool", toolName: "bash", result: { content: [] }, isError: false });
  now++; await f.tick(); await until(() => f.service.pending("manager").some(message => message.id.startsWith(MANAGER_WATCHDOG_PREFIX)));
  expect(unwrap(await f.service.managerWorkSummary()).lastHumanMessageAt).toBe(1_000_000);
  const checkSession = f.sessions.find(session => session.commands.some(command => String(command.workId).startsWith(MANAGER_WATCHDOG_PREFIX)))!;
  checkSession.settle(); await until(() => f.service.get("manager")?.lifecycle.kind === "idle");
  now += MANAGER_INACTIVITY_MS - 1;
  unwrap(await f.service.send({ threadId: "worker", requestId: "another-human", text: "New instruction on another surface" }));
  await f.tick(); now++; await f.tick(); expect(f.service.pending("manager")).toHaveLength(0);
  now += MANAGER_INACTIVITY_MS - 1; await f.tick(); await until(() => f.service.pending("manager").length === 1);
  expect(unwrap(await f.service.managerWorkSummary()).lastHumanMessageAt).toBe(1_000_000 + 2 * MANAGER_INACTIVITY_MS - 1);
});

it("busy managers coalesce overdue checks through restart and never get overlapping or queued duplicates", async () => {
  let now = 1_000_000; vi.spyOn(Date, "now").mockImplementation(() => now);
  const f = fixture(); await initialize(f); await waitForJob(f);
  unwrap(await f.service.send({ threadId: "manager", requestId: "human", text: "Long task" })); unwrap(await f.service.start());
  await until(() => f.sessions[0]?.commands.some(command => command.workId === "human") === true); await f.tick();
  now += 10 * MANAGER_INACTIVITY_MS; await f.tick(); await f.tick();
  expect(f.service.pending("manager").map(message => message.id)).toEqual(["human"]);
  f.sessions[0]!.settle(); await until(() => f.service.get("manager")?.lifecycle.kind === "idle"); await f.tick();
  await until(() => f.service.pending("manager").some(message => message.id.startsWith(MANAGER_WATCHDOG_PREFIX)));
  const id = f.service.pending("manager")[0]!.id;
  f.sessions.find(session => session.commands.some(command => command.workId === id))!.settle(); await until(() => f.service.get("manager")?.lifecycle.kind === "idle");
  await boundary(); unwrap(await f.service.close());
  const restarted = fixture(f.root); unwrap(await restarted.service.start()); await restarted.tick(); expect(restarted.sessions).toHaveLength(0);
  now += MANAGER_INACTIVITY_MS; await restarted.tick(); await until(() => restarted.service.pending("manager").length === 1);
  expect(restarted.service.pending("manager")[0]!.id).not.toBe(id);
  now += 20 * MANAGER_INACTIVITY_MS; await restarted.tick(); await restarted.tick(); expect(restarted.service.pending("manager")).toHaveLength(1);
});

it.each(["human", "idle"])("withdraws unadmitted conditional checks when %s supersedes them, including restart", async cause => {
  let now = 1_000_000; vi.spyOn(Date, "now").mockImplementation(() => now);
  const f = fixture(undefined, true); await initialize(f); await waitForJob(f); unwrap(await f.service.start()); await f.tick();
  now += MANAGER_INACTIVITY_MS; await f.tick(); await until(() => f.service.pending("manager").length === 1);
  unwrap(await f.service.close()); const next = fixture(f.root);
  if (cause === "human") unwrap(await next.service.send({ threadId: "worker", requestId: "human", text: "Continue" }));
  else unwrap(await next.service.agentWait({ action: "clear", threadId: "worker", requestId: "idle" }));
  unwrap(await next.service.start()); await next.tick(); expect(next.service.pending("manager")).toHaveLength(0);
  expect(next.sessions.some(session => session.commands.some(command => String(command.workId).startsWith(MANAGER_WATCHDOG_PREFIX)))).toBe(false);
});

it("parentless automatic watch checks are not human messages; canonical unresolved waits are work", async () => {
  const f = fixture(); await initialize(f);
  unwrap(await f.service.spawn({ requestId: "watch", id: "watch", cwd: f.root, message: "Check due item", metadata: { watchList: true } }));
  unwrap(await f.service.spawn({ requestId: "runtime", id: "runtime", cwd: f.root, message: "Automatic task", createdBy: { kind: "runtime" } }));
  expect(unwrap(await f.service.managerWorkSummary()).lastHumanMessageAt).toBeNull();
  for (const lifecycle of [{ kind: "working", phase: "thinking", since: 1 }, { kind: "waiting", target: "job", since: 1 }, { kind: "failed", reason: "Owner failed", control: "cancel_wait" }] as const)
    expect(hasManagedWork({ lifecycle } as Thread)).toBe(true);
  expect(hasManagedWork({ lifecycle: { kind: "idle" }, wakeSchedule: { reason: "future", cadenceMs: 60000, nextDueAt: 1 } } as Thread)).toBe(false);
});

it("restart before the deadline preserves the original silence clock and explicit Stop", async () => {
  let now = 1_000_000; vi.spyOn(Date, "now").mockImplementation(() => now);
  const first = fixture(); await initialize(first); await waitForJob(first); unwrap(await first.service.start()); await first.tick();
  now += MANAGER_INACTIVITY_MS - 1; unwrap(await first.service.close());
  const next = fixture(first.root); unwrap(await next.service.start()); await next.tick(); expect(next.sessions).toHaveLength(0);
  now++; await next.tick(); await until(() => next.service.pending("manager").length === 1);
  unwrap(await next.service.control({ action: "stop", threadId: "manager", descendants: false }));
  now += 10 * MANAGER_INACTIVITY_MS; await next.tick();
  expect(next.service.pending("manager")).toHaveLength(0);
  unwrap(await next.service.send({ threadId: "worker", requestId: "human-resumes", text: "Resume managing" }));
  await next.tick(); now += MANAGER_INACTIVITY_MS; await next.tick();
  await until(() => next.service.pending("manager").length === 1);
});

it("replaces the unmodified creation heartbeat but preserves an explicitly changed wake", async () => {
  const first = fixture(); await initialize(first);
  unwrap(await first.service.wakeSchedule({ action: "set", threadId: "manager", requestId: "heartbeat", cadenceMs: 14400000,
    reason: "Managing Kenan heartbeat: consider the person's current needs and held questions; speak only when there is something useful to say." }));
  unwrap(await first.service.close()); const next = fixture(first.root);
  expect(next.service.get("manager")?.wakeSchedule).toBeUndefined();
  unwrap(await next.service.wakeSchedule({ action: "set", threadId: "manager", requestId: "explicit", cadenceMs: 60000, reason: "Check my actual deadline" }));
  unwrap(await next.service.close()); const final = fixture(first.root);
  expect(final.service.get("manager")?.wakeSchedule?.reason).toBe("Check my actual deadline");
});

it("an unavailable summary cannot manufacture idle or launch an unchecked restored wake", async () => {
  let now = 1_000_000; vi.spyOn(Date, "now").mockImplementation(() => now);
  const first = fixture(undefined, true); await initialize(first); await waitForJob(first); unwrap(await first.service.start()); await first.tick();
  now += MANAGER_INACTIVITY_MS; await first.tick(); await until(() => first.service.pending("manager").length === 1); unwrap(await first.service.close());
  const next = fixture(first.root); next.service.setManagerWatchdog(async () => ({ ok: false, error: { code: "unavailable", message: "Granted owner unavailable" } }), message => next.errors.push(message));
  unwrap(await next.service.start()); await next.tick(); expect(next.errors).toContain("Granted owner unavailable"); expect(next.sessions).toHaveLength(0);
  expect(next.service.pending("manager")).toHaveLength(1);
});

it("summary capability rejects a foreign person and unauthenticated process", async () => {
  const f = fixture(); await initialize(f); const key = threadCapability(join(f.root, "key")), foreign = threadCapability(join(f.root, "foreign"));
  const resolver = callerResolver({ capability: key });
  const transport = async (url: string | URL | Request, init?: RequestInit) => { const req = new Request(String(url), init); return (await threadHttp(f.service, req, "/threads", admissionFor(resolver, { headers: req.headers })))!; };
  expect((await createThreadClient("http://fixture/threads", transport, { token: key.issue("manager") }).managerWorkSummary()).ok).toBe(true);
  expect((await createThreadClient("http://fixture/threads", transport, { token: foreign.issue("manager") }).managerWorkSummary()).ok).toBe(false);
  expect((await createThreadClient("http://fixture/threads", transport).managerWorkSummary()).ok).toBe(false);
});

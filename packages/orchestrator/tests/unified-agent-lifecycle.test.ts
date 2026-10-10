import { afterEach, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PiCommand, PiEvent, PiSession, PiSessionOptions, Result } from "../src/threads/contracts.js";
import { ThreadService } from "../src/threads/service.js";
import { ThreadDirectory } from "../src/threads/directory.js";
import { threadTools } from "../src/threads/pi-tools.js";
import { modeConversation } from "../src/threads/pi-mode.js";
import { callerResolver } from "../src/threads/caller.js";
import { openSqlite } from "../src/sqlite.js";

function value<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
}
async function until(check: () => boolean) {
  for (let i = 0; i < 100; i++) { if (check()) return; await new Promise<void>(resolve => setImmediate(resolve)); }
  throw new Error("Expected lifecycle transition did not arrive");
}
class Native implements PiSession {
  active = false;
  accepted = new Set<string>();
  completed = new Set<string>();
  lastAssistantMessage?: Record<string, unknown>;
  constructor(readonly options: PiSessionOptions, private output: (event: PiEvent) => void) { writeFileSync(options.sessionFile, ""); }
  async command(command: PiCommand) {
    if (command.type === "prompt" || command.type === "steer") {
      this.accepted.add(String(command.workId)); this.active = true;
      this.output({ type: "agent_start" });
      this.output({ type: "message_start", message: { role: "user", content: [{ type: "text", text: command.message }] } });
    }
    if (command.type === "abort") this.active = false;
    this.output({ type: "response", id: command.id, command: command.type, success: true,
      data: command.type === "get_state" ? { isStreaming: this.active, pendingMessageCount: 0, acceptedWorkIds: [...this.accepted], completedWorkIds: [...this.completed], sessionFile: this.options.sessionFile, lastAssistantMessage: this.lastAssistantMessage } : {} });
  }
  settle(text: string) {
    for (const id of this.accepted) this.completed.add(id);
    this.active = false;
    this.lastAssistantMessage = { role: "assistant", content: [{ type: "text", text }], stopReason: "stop", timestamp: Date.now() };
    this.output({ type: "message_end", message: this.lastAssistantMessage }); this.output({ type: "agent_settled" });
  }
  async close() {}
}
const roots: string[] = [], services: ThreadService[] = [];
function fixture(workersOnly = false) {
  const root = mkdtempSync(join(tmpdir(), "unified-agent-")); roots.push(root);
  const sessions = new Map<string, Native>();
  const options = { workersOnly, capacity: { mode: "unmanaged" } as const, databasePath: join(root, "threads.sqlite"), sessionsDir: root,
    openSession: async (input: PiSessionOptions, output: (event: PiEvent) => void) => { const session = new Native(input, output); sessions.set(input.threadId, session); return session; } };
  const service = new ThreadService(options); services.push(service);
  return { service, root, sessions, options };
}
afterEach(async () => {
  for (const service of services.splice(0).reverse()) {
    for (const thread of service.snapshot()) await service.control({ threadId: thread.id, action: "cancel" });
    await service.close();
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

it("any peer can launch peers, with immutable identity and placement independent of ancestry/model", async () => {
  const f = fixture();
  const person = value(await f.service.spawn({ requestId: "person", id: "person", cwd: f.root, createdBy: { kind: "person", via: "router" } }));
  const first = value(await f.service.spawn({ requestId: "first", id: "first", parentId: person.id, cwd: f.root, title: "Topic", settings: { model: "astra" } }));
  const second = value(await f.service.spawn({ requestId: "second", parentId: first.id, cwd: f.root, settings: { model: "fable" } }));
  expect([person.role, first.role, second.role]).toEqual(["agent", "agent", "agent"]);
  expect(person.metadata?.foreground).toBe(true); expect(first.metadata?.foreground).toBe(false);
  expect(first.agentName).toBeTruthy(); expect(second.agentName).toBeTruthy();
  value(await f.service.control({ action: "rename", threadId: first.id, title: "Another topic" }));
  expect(f.service.get(first.id)?.agentName).toBe(first.agentName);
  expect(f.service.update(first.id, { metadata: { agentName: "Forged" } })).toMatchObject({ ok: false, error: { code: "conflict" } });
  value(await f.service.attention({ threadId: first.id, requestId: "notice", summary: "Appointment moved", foreground: true }));
  expect(f.service.get(first.id)?.metadata?.foreground).toBe(false);
  value(await f.service.control({ action: "open", threadId: first.id }));
  expect(f.service.get(first.id)?.metadata?.foreground).toBe(true);
  value(await f.service.control({ action: "placement", threadId: first.id, foreground: false }));
  expect(f.service.get(first.id)?.metadata?.foreground).toBe(false);
  expect(threadTools({ threadId: second.id, cwd: f.root, sessionFile: second.sessionFile, args: [], env: { PI_THREAD_CAN_SPAWN: "1" }, threads: f.service }).some(tool => tool.name === "thread_spawn")).toBe(true);
});

it("close and historical recursive controls cancel only the selected agent; reopen never replays", async () => {
  const f = fixture(); value(await f.service.start());
  value(await f.service.spawn({ requestId: "a", id: "a", cwd: f.root, message: "work" }));
  value(await f.service.spawn({ requestId: "b", id: "b", parentId: "a", cwd: f.root, message: "independent work" }));
  await until(() => !!f.sessions.get("a")?.active && !!f.sessions.get("b")?.active);
  value(await f.service.send({ requestId: "queued", threadId: "a", text: "discard this", delivery: "queue" }));
  value(await f.service.control({ action: "stop", threadId: "a", descendants: true, reason: "archive" }));
  expect(f.service.get("a")).toMatchObject({ state: "idle", held: false, pendingMessages: 0, metadata: { archived: true } });
  expect(f.sessions.get("b")?.active).toBe(true); expect(f.service.get("b")?.metadata?.archived).not.toBe(true);
  value(await f.service.control({ action: "restore", threadId: "a", descendants: true, resume: true }));
  expect(f.service.get("a")).toMatchObject({ state: "idle", held: false, pendingMessages: 0 });
  f.sessions.get("b")!.settle("done after requester closed");
  await until(() => f.service.get("b")?.state === "idle");
  expect(f.service.pending("a").some(message => message.text.includes("Continue the interrupted"))).toBe(false);
});

it("mutual subscriptions do not veto Close and a cancelled idle waiter durably resumes its subscriber", async () => {
  const a = fixture(), b = fixture();
  const directory = new ThreadDirectory({ id: "left", api: a.service }, [{ id: "right", api: b.service }]);
  a.service.setDirectory(directory); b.service.setDirectory(directory);
  value(await a.service.spawn({ requestId: "a", id: "a", cwd: a.root }));
  value(await b.service.spawn({ requestId: "b", id: "b", cwd: b.root }));
  value(await a.service.agentWait({ action: "set", kind: "message", requestId: "wait", threadId: "a", fromThreadId: "b" }));
  value(await b.service.control({ action: "dependencies", threadId: "b", threadIds: ["a"] }));
  value(await directory.control({ action: "close", threadId: "b" }));
  await until(() => a.service.pending("a").length === 1);
  expect(b.service.get("b")).toMatchObject({ state: "idle", dependencies: [], metadata: { archived: true } });
  expect(a.service.get("a")?.waitingOnAgents).toBeUndefined();
  expect(a.service.get("a")?.dependencies).toEqual([]);
  expect(JSON.parse(a.service.pending("a")[0]!.text)).toMatchObject({ outcome: "cancelled", finalText: null });
  expect(value(await directory.await({ parentId: "a", threadIds: ["b"], timeoutMs: 0 })).settlement).toMatchObject({ outcome: "cancelled" });
});

it("a subscription racing explicit Close receives one terminal cancellation without reopening the producer", async () => {
  const a = fixture(), b = fixture();
  const directory = new ThreadDirectory({ id: "left", api: a.service }, [{ id: "right", api: b.service }]);
  a.service.setDirectory(directory); b.service.setDirectory(directory);
  value(await a.service.spawn({ requestId: "a", id: "a", cwd: a.root }));
  value(await b.service.spawn({ requestId: "b", id: "b", cwd: b.root }));
  const closing = b.service.control({ action: "close", threadId: "b" });
  value(await a.service.agentWait({ action: "set", kind: "message", requestId: "late-wait", threadId: "a", fromThreadId: "b" }));
  value(await closing);
  await until(() => a.service.pending("a").length === 1);
  expect(a.service.get("a")?.waitingOnAgents).toBeUndefined();
  expect(a.service.get("a")?.dependencies).toEqual([]);
  expect(b.service.get("b")?.metadata?.archived).toBe(true);
  expect(JSON.parse(a.service.pending("a")[0]!.text).outcome).toBe("cancelled");
});

it("closing a subscriber clears its subscriptions without closing the producer", async () => {
  const a = fixture(), b = fixture();
  const directory = new ThreadDirectory({ id: "left", api: a.service }, [{ id: "right", api: b.service }]);
  a.service.setDirectory(directory); b.service.setDirectory(directory);
  value(await a.service.spawn({ requestId: "a", id: "a", cwd: a.root }));
  value(await b.service.spawn({ requestId: "b", id: "b", cwd: b.root }));
  value(await a.service.control({ action: "dependencies", threadId: "a", threadIds: ["b"] }));
  expect(a.service.get("a")).toMatchObject({ state: "waiting", dependencies: ["b"] });
  expect(a.service.get("a")?.waitingOnAgents).toBeUndefined();
  value(await directory.control({ action: "close", threadId: "a" }));
  expect(a.service.get("a")?.dependencies).toEqual([]);
  expect(b.service.get("b")?.metadata?.peerDependents).toEqual([]);
  value(await directory.control({ action: "close", threadId: "b" }));
});

it("closing an idle producer delivers cancellation and releases the subscriber across owners", async () => {
  const a = fixture(), b = fixture();
  const directory = new ThreadDirectory({ id: "left", api: a.service }, [{ id: "right", api: b.service }]);
  a.service.setDirectory(directory); b.service.setDirectory(directory);
  value(await a.service.spawn({ requestId: "a", id: "a", cwd: a.root }));
  value(await b.service.spawn({ requestId: "b", id: "b", cwd: b.root }));
  value(await a.service.control({ action: "dependencies", threadId: "a", threadIds: ["b"] }));
  value(await directory.control({ action: "close", threadId: "b" }));
  await until(() => a.service.get("a")?.dependencies?.length === 0);
  expect(b.service.get("b")?.metadata?.peerDependents).toEqual([]);
  expect(a.service.pending("a")).toHaveLength(1);
});

it("result cursors survive subscriptions and do not replay a previously settled assignment", async () => {
  const f = fixture(); value(await f.service.start());
  value(await f.service.spawn({ requestId: "a", id: "a", cwd: f.root }));
  value(await f.service.spawn({ requestId: "b", id: "b", cwd: f.root, message: "first", createdBy: { kind: "person", via: "router" } }));
  await until(() => !!f.sessions.get("b")?.active);
  f.sessions.get("b")!.settle("first result");
  await until(() => f.service.get("b")?.state === "idle");
  const after = f.service.latestSettlement("b")!.seq;
  value(await f.service.agentWait({ action: "set", kind: "agents", requestId: "next-b", threadId: "a", threadIds: ["b"], after: { b: after } }));
  expect(f.service.get("a")?.state).toBe("waiting");
  expect(f.service.pending("a")).toHaveLength(0);
  value(await f.service.send({ requestId: "second", threadId: "b", text: "second" }));
  await until(() => !!f.sessions.get("b")?.active);
  f.sessions.get("b")!.settle("second result");
  await until(() => f.service.get("a")?.dependencies?.length === 0);
  const result = f.service.pending("a")[0];
  expect(result?.text).toContain("second result");
  expect(f.service.pending("a")).toHaveLength(1);
  expect(f.service.get("a")?.waitingOnAgents).toBeUndefined();
});

it("turn settlement while waiting or questioning is not an assignment result or ephemeral completion", async () => {
  const f = fixture(); value(await f.service.start());
  value(await f.service.spawn({ requestId: "requester", id: "requester", cwd: f.root }));
  value(await f.service.spawn({ requestId: "assigned", id: "assigned", parentId: "requester", cwd: f.root, message: "work", ephemeral: true }));
  await until(() => !!f.sessions.get("assigned")?.active);
  value(await f.service.agentWait({ action: "set", kind: "job", threadId: "assigned", requestId: "job", jobId: "job-id" }));
  f.sessions.get("assigned")!.settle("waiting, not finished");
  await until(() => f.service.get("assigned")?.state === "waiting");
  expect(f.service.latestSettlement("assigned")?.assignmentPending).toBe(true);
  expect(value(await f.service.await({ parentId: "requester", threadIds: ["assigned"], timeoutMs: 0 })).settlement).toBeNull();
  expect(f.service.pending("requester")).toEqual([]); expect(f.service.get("assigned")?.metadata?.archived).not.toBe(true);
  value(await f.service.agentWait({ action: "clear", threadId: "assigned", requestId: "clear" }));
  value(await f.service.send({ threadId: "assigned", requestId: "continue", text: "finish" }));
  await until(() => !!f.sessions.get("assigned")?.active);
  value(await f.service.ask({ threadId: "assigned", requestId: "question", questions: [{ question: "Choose?" }] }));
  f.sessions.get("assigned")!.settle("question pending");
  await until(() => !!f.service.latestSettlement("assigned")?.assignmentPending);
  expect(f.service.get("assigned")?.metadata?.archived).not.toBe(true); expect(f.service.pending("requester")).toEqual([]);
});

it("a later final turn discharges the original assignment reply exactly once without creator authority", async () => {
  const f = fixture(); value(await f.service.start());
  value(await f.service.spawn({ requestId: "requester", id: "requester", cwd: f.root }));
  const assigned = value(await f.service.spawn({ requestId: "assigned", id: "assigned", parentId: "requester", cwd: f.root, message: "work" }));
  await until(() => !!f.sessions.get("assigned")?.active);
  value(await f.service.agentWait({ action: "set", kind: "job", threadId: "assigned", requestId: "job", jobId: "job" }));
  f.sessions.get("assigned")!.settle("waiting");
  await until(() => f.service.get("assigned")?.state === "waiting");
  expect(f.service.pending("requester")).toHaveLength(0);
  value(await f.service.agentWait({ action: "clear", threadId: "assigned", requestId: "release" }));
  value(await f.service.send({ requestId: "continue", threadId: "assigned", text: "Finish now" }));
  await until(() => !!f.sessions.get("assigned")?.active);
  f.sessions.get("assigned")!.settle("actual final result");
  await until(() => f.service.pending("requester").some(message => message.text.includes("actual final result")));
  const replies = f.service.pending("requester").filter(message => message.senderId === "assigned");
  expect(replies).toHaveLength(1); expect(replies[0]?.senderName).toBe(assigned.agentName);
  expect(f.service.latestSettlement("assigned")?.assignmentPending).toBeUndefined();
  expect(f.service.get("assigned")?.metadata?.archived).toBe(true);
  value(await f.service.control({ threadId: "assigned", action: "open" }));
  value(await f.service.send({ requestId: "unrelated", threadId: "assigned", text: "Independent task" }));
  await until(() => !!f.sessions.get("assigned")?.active);
  f.sessions.get("assigned")!.settle("independent result");
  await until(() => f.service.get("assigned")?.state === "idle");
  expect(f.service.pending("requester").filter(message => message.senderId === "assigned")).toHaveLength(1);
});

it("accepted subscriptions survive producer replacement and Close delivers cancellation", async () => {
  const a = fixture(), b = fixture();
  let directory = new ThreadDirectory({ id: "left", api: a.service }, [{ id: "right", api: b.service }]);
  a.service.setDirectory(directory); b.service.setDirectory(directory);
  value(await a.service.spawn({ requestId: "a", id: "a", cwd: a.root }));
  value(await b.service.spawn({ requestId: "b", id: "b", cwd: b.root }));
  value(await a.service.agentWait({ action: "set", kind: "message", requestId: "wait-b", threadId: "a", fromThreadId: "b" }));
  value(await b.service.close()); services.splice(services.indexOf(b.service), 1);
  const replacement = new ThreadService(b.options); services.push(replacement);
  directory = new ThreadDirectory({ id: "left", api: a.service }, [{ id: "right", api: replacement }]);
  a.service.setDirectory(directory); replacement.setDirectory(directory);
  expect(replacement.get("b")?.metadata?.peerDependents).toEqual(["a"]);
  value(await replacement.control({ action: "close", threadId: "b" }));
  await until(() => a.service.pending("a").length === 1);
  expect(a.service.get("a")?.dependencies).toEqual([]);
  expect(a.service.get("a")?.waitingOnAgents).toBeUndefined();
  expect(JSON.parse(a.service.pending("a")[0]!.text).outcome).toBe("cancelled");
});

it("offline result delivery survives restart and acknowledges once without recreating a wait", async () => {
  const a = fixture(), b = fixture();
  let directory = new ThreadDirectory({ id: "left", api: a.service }, [{ id: "right", api: b.service }]);
  a.service.setDirectory(directory); b.service.setDirectory(directory);
  value(await a.service.spawn({ requestId: "a", id: "a", cwd: a.root }));
  value(await b.service.spawn({ requestId: "b", id: "b", cwd: b.root }));
  value(await a.service.agentWait({ action: "set", kind: "message", requestId: "wait-b", threadId: "a", fromThreadId: "b" }));
  const send = a.service.send.bind(a.service);
  a.service.send = async input => input.source === "notification" ? { ok: false, error: { code: "unavailable", message: "Recipient offline" } } : send(input);
  value(await b.service.control({ action: "close", threadId: "b" }));
  expect(a.service.get("a")?.state).toBe("waiting");
  expect(b.service.pending("a")).toHaveLength(1);
  value(await b.service.close()); services.splice(services.indexOf(b.service), 1);
  const replacement = new ThreadService(b.options); services.push(replacement);
  a.service.send = send;
  directory = new ThreadDirectory({ id: "left", api: a.service }, [{ id: "right", api: replacement }]);
  a.service.setDirectory(directory); replacement.setDirectory(directory);
  value(await replacement.start());
  await until(() => a.service.pending("a").length === 1);
  replacement.reconcile();
  await until(() => replacement.pending("a").length === 0);
  expect(a.service.get("a")?.waitingOnAgents).toBeUndefined();
  expect(a.service.get("a")?.dependencies).toEqual([]);
  expect(a.service.pending("a")).toHaveLength(1);
  expect(JSON.parse(a.service.pending("a")[0]!.text)).toMatchObject({ outcome: "cancelled", finalText: null });
});

it("closing a subscriber succeeds while its producer owner is unavailable", async () => {
  const a = fixture(), b = fixture();
  const directory = new ThreadDirectory({ id: "left", api: a.service }, [{ id: "right", api: b.service }]);
  a.service.setDirectory(directory); b.service.setDirectory(directory);
  value(await a.service.spawn({ requestId: "a", id: "a", cwd: a.root }));
  value(await b.service.spawn({ requestId: "b", id: "b", cwd: b.root }));
  value(await a.service.agentWait({ action: "set", kind: "message", requestId: "wait-b", threadId: "a", fromThreadId: "b" }));
  b.service.list = async () => ({ ok: false, error: { code: "unavailable", message: "Producer offline" } });
  value(await a.service.control({ action: "close", threadId: "a" }));
  expect(a.service.get("a")).toMatchObject({ state: "idle", dependencies: [], metadata: { archived: true } });
  expect(a.service.get("a")?.waitingOnAgents).toBeUndefined();
  expect(a.service.get("a")?.metadata?.dependencyUpdate).toMatchObject({ desired: [] });
  expect(b.service.get("b")?.metadata?.archived).not.toBe(true);
});

it("an unrelated unavailable owner cannot prevent local native settlement", async () => {
  const f = fixture(), unavailable = fixture();
  unavailable.service.list = async () => ({ ok: false, error: { code: "unavailable", message: "Peer offline" } });
  const directory = new ThreadDirectory({ id: "local", api: f.service }, [{ id: "offline", api: unavailable.service }]);
  f.service.setDirectory(directory);
  value(await f.service.start());
  value(await f.service.spawn({ requestId: "local", id: "local", cwd: f.root, message: "Local assignment" }));
  await until(() => !!f.sessions.get("local")?.active);
  f.sessions.get("local")!.settle("local completed");
  await until(() => f.service.get("local")?.state === "idle");
  expect(f.service.latestSettlement("local")).toMatchObject({ outcome: "complete", finalMessage: { role: "assistant" } });
  expect(f.service.pending("local")).toEqual([]);
});

it("recovers local subscriptions without graph reads while an unrelated personal owner is locked", async () => {
  const f = fixture(), locked = fixture();
  let lockedReads = 0;
  locked.service.list = async () => { lockedReads++; return { ok: false, error: { code: "unavailable", message: "Personal supervisor locked" } }; };
  const directory = new ThreadDirectory({ id: "fleet", api: f.service }, [{ id: "person", api: locked.service }]);
  f.service.setDirectory(directory);
  value(await f.service.spawn({ requestId: "parent", id: "parent", cwd: f.root }));
  value(await f.service.spawn({ requestId: "child", id: "child", parentId: "parent", cwd: f.root }));
  const db = openSqlite(f.options.databasePath);
  db.prepare("UPDATE thread SET metadata=json_set(metadata,'$.peerDependencies',json(?),'$.dependencyUpdate',json(?)) WHERE id='parent'")
    .run(JSON.stringify(["child"]), JSON.stringify({ previous: [], desired: ["child"], phase: "claim" }));
  db.close();
  value(await f.service.start());
  await until(() => !f.service.get("parent")?.metadata?.dependencyUpdate);
  expect(f.service.get("parent")?.dependencies).toEqual(["child"]);
  expect(f.service.get("child")?.metadata?.peerDependents).toEqual(["parent"]);
  value(await f.service.agentWait({ action: "set", kind: "agents", threadId: "parent", requestId: "wait", threadIds: ["child"] }));
  value(await f.service.control({ action: "dependencies", threadId: "child", threadIds: ["parent"] }));
  expect(lockedReads).toBe(0);
  expect(await f.service.control({ action: "dependencies", threadId: "child", threadIds: ["foreign"] })).toMatchObject({ ok: false, error: { code: "unavailable" } });
  expect(lockedReads).toBeGreaterThan(0);
  value(await f.service.agentWait({ action: "clear", threadId: "parent", requestId: "clear" }));
  value(await f.service.control({ action: "close", threadId: "child" }));
});

it("historical holds and resume inputs reopen without replaying their discarded queue", async () => {
  const f = fixture();
  for (const id of ["opened", "resumed"]) {
    value(f.service.importThread({ id, title: "Historical title", cwd: f.root, sessionFile: join(f.root, `${id}.jsonl`), held: true,
      settings: { model: "openai-codex/gpt-6.1-sol", thinkingLevel: "high", speed: "standard" } }));
    value(f.service.importMessage({ id: `pending:${id}`, threadId: id, text: "Do not replay", state: "queued" }));
  }
  value(await f.service.control({ action: "open", threadId: "opened" }));
  value(await f.service.control({ action: "resume", threadId: "resumed" }));
  for (const id of ["opened", "resumed"]) {
    expect(f.service.get(id)).toMatchObject({ title: "Historical title", state: "idle", held: false, pendingMessages: 0 });
    expect(f.service.get(id)?.agentName).toBeTruthy();
  }
  expect(f.sessions.size).toBe(0);
});

it("projects historical placement from original owner custody without renaming old titles", () => {
  const person = fixture(), fleet = fixture(true);
  const settings = { model: "openai-codex/gpt-6.1-sol", thinkingLevel: "high", speed: "standard" } as const;
  const root = value(person.service.importThread({ id: "legacy-person", title: "Existing topic", cwd: person.root, sessionFile: join(person.root, "person.jsonl"), settings }));
  const child = value(person.service.importThread({ id: "legacy-child", parentId: root.id, title: "Existing child", cwd: person.root, sessionFile: join(person.root, "child.jsonl"), settings }));
  const watch = value(person.service.importThread({ id: "legacy-watch", title: "Watch", cwd: person.root, sessionFile: join(person.root, "watch.jsonl"), metadata: { watchList: true }, settings }));
  const worker = value(fleet.service.importThread({ id: "legacy-fleet", title: "Existing fleet", cwd: fleet.root, sessionFile: join(fleet.root, "fleet.jsonl"), settings }));
  expect(root.metadata?.foreground).toBe(true);
  for (const thread of [child, watch, worker]) expect(thread.metadata?.foreground).toBe(false);
  expect(root.title).toBe("Existing topic"); expect(worker.title).toBe("Existing fleet");
  for (const thread of [root, child, watch, worker]) expect(thread.agentName).toBeTruthy();
});

it("imports keep names and startup migration durably names historical threads", async () => {
  const f = fixture();
  const imported = value(f.service.importThread({ id: "imported", title: "Imported", cwd: f.root, sessionFile: join(f.root, "imported.jsonl"),
    settings: { model: "openai-codex/gpt-6.1-sol", thinkingLevel: "high", speed: "standard" }, metadata: { agentName: "Preserved Nebulani" } }));
  expect(imported.agentName).toBe("Preserved Nebulani");
  const legacy = value(f.service.importThread({ id: "legacy", title: "Legacy", cwd: f.root, sessionFile: join(f.root, "legacy.jsonl"),
    settings: { model: "openai-codex/gpt-6.1-sol", thinkingLevel: "high", speed: "standard" } }));
  expect(legacy.agentName).toBeTruthy();
  const db = openSqlite(f.options.databasePath);
  db.prepare("UPDATE thread SET metadata=json_remove(metadata,'$.agentName') WHERE id=?").run("legacy");
  db.close();
  services.splice(services.indexOf(f.service), 1);
  await f.service.close();
  const reopened = new ThreadService(f.options); services.push(reopened);
  const migratedName = reopened.get("legacy")?.agentName;
  expect(migratedName).toBeTruthy();
  expect(reopened.get("imported")?.agentName).toBe("Preserved Nebulani");
  services.splice(services.indexOf(reopened), 1);
  await reopened.close();
  const restarted = new ThreadService(f.options); services.push(restarted);
  expect(restarted.get("legacy")?.agentName).toBe(migratedName);
});

it("caller identity protects human placement and another agent's dependency ownership", async () => {
  const resolver = callerResolver({ capability: { issue: id => id, verify: token => token } });
  const caller = { kind: "thread", threadId: "a" } as const;
  for (const action of ["open", "placement", "view"]) expect(await resolver.admit("control", { action, threadId: "a", foreground: true }, caller)).toMatchObject({ ok: false, status: 403 });
  expect(await resolver.admit("control", { action: "dependencies", threadId: "b", threadIds: [] }, caller)).toMatchObject({ ok: false, status: 403 });
  expect(await resolver.admit("control", { action: "resultSubscribe", threadId: "b", dependentId: "a", active: false }, caller)).toMatchObject({ ok: false, status: 403 });
  expect(await resolver.admit("control", { action: "dependencies", threadId: "a", threadIds: [] }, caller)).toMatchObject({ ok: true });
  expect(await resolver.admit("spawn", { requestId: "launch", cwd: "/work" }, caller)).toMatchObject({ ok: true, input: { parentId: "a", createdBy: { kind: "thread", threadId: "a" } } });
});

it("dispatcher tool boundaries are explicit and independent of peer spawning", () => {
  expect(modeConversation({ PI_THREAD_MODE: "live", PI_THREAD_CAN_SPAWN: "1", PI_THREAD_LIVE_DISPATCHER: "0" })).toBeUndefined();
  expect(modeConversation({ PI_THREAD_MODE: "live", PI_THREAD_CAN_SPAWN: "1", PI_THREAD_LIVE_DISPATCHER: "1" })?.bashTimeoutSeconds).toBe(10);
});

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runnerHostEntry } from "../src/threads/runner-transport.js";
import { DatabaseSync } from "node:sqlite";
import { importRemoteThreads } from "../src/threads/import.js";
import type { OpenPiSession, PiCommand, PiEvent, PiSession, PiSessionOptions, Result } from "../src/threads/contracts.js";
import { ThreadService } from "../src/threads/service.js";
import { ThreadDirectory } from "../src/threads/directory.js";
import { threadTools } from "../src/threads/pi-tools.js";

const roots: string[] = [];
const services: ThreadService[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const service of services.splice(0).reverse()) await service.close();
  for (const root of roots.splice(0).reverse()) rmSync(root, { recursive: true, force: true });
});

const turn = () => new Promise<void>(resolve => setImmediate(resolve));

async function waitFor(check: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt++) {
    if (check()) return;
    await turn();
  }
  throw new Error("Thread service did not reach the expected state");
}

function value<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
}

class FakePiSession implements PiSession {
  readonly commands: PiCommand[] = [];
  readonly acceptedWorkIds = new Set<string>();
  readonly completedWorkIds = new Set<string>();
  isStreaming = false;
  pendingMessageCount = 0;
  lastAssistantMessage?: Record<string, unknown>;
  closed = false;

  constructor(readonly options: PiSessionOptions, private readonly output: (event: PiEvent) => void) {}

  async command(command: PiCommand): Promise<void> {
    this.commands.push(command);
    if (command.type === "prompt" || command.type === "steer") {
      if (typeof command.workId === "string") this.acceptedWorkIds.add(command.workId);
      this.isStreaming = true;
      this.output({ type: "agent_start" });
    }
    if (command.type === "abort") {
      this.isStreaming = false;
      this.pendingMessageCount = 0;
    }
    const data = command.type === "get_state" ? {
      isStreaming: this.isStreaming,
      pendingMessageCount: this.pendingMessageCount,
      sessionFile: this.options.sessionFile,
      acceptedWorkIds: [...this.acceptedWorkIds],
      completedWorkIds: [...this.completedWorkIds],
      lastAssistantMessage: this.lastAssistantMessage,
    } : {};
    this.output({ type: "response", id: command.id, command: command.type, success: true, data });
  }

  settle(text: string, stopReason = "stop"): void {
    const message = { role: "assistant", content: [{ type: "text", text }], stopReason, timestamp: Date.now() };
    this.lastAssistantMessage = message;
    const workId = [...this.acceptedWorkIds].at(-1);
    if (workId) this.completedWorkIds.add(workId);
    this.isStreaming = false;
    this.pendingMessageCount = 0;
    this.output({ type: "message_end", message });
    this.output({ type: "agent_settled" });
  }

  async close(): Promise<void> { this.closed = true; }
}

function fixture(root?: string, workersOnly = false) {
  const directory = root ?? mkdtempSync(join(tmpdir(), "thread-service-"));
  if (!root) roots.push(directory);
  const sessions: FakePiSession[] = [];
  const openSession: OpenPiSession = async (options, output) => {
    const session = new FakePiSession(options, output);
    sessions.push(session);
    return session;
  };
  const service = new ThreadService({
    workersOnly,
    databasePath: join(directory, "threads.sqlite"),
    sessionsDir: join(directory, "sessions"),
    openSession,
  });
  services.push(service);
  return { directory, service, sessions };
}

it("preserves the running account and model when future settings change", async () => {
  const f = fixture();
  await f.service.start();
  const thread = value(await f.service.spawn({ requestId: "settings-attribution", cwd: f.directory, message: "active" }));
  await waitFor(() => f.sessions.some(session => session.isStreaming));
  const db = new DatabaseSync(join(f.directory, "threads.sqlite"));
  try {
    db.prepare("UPDATE thread_execution SET settings=json_set(settings,'$.model','openai-codex-8/gpt-6-astra') WHERE thread_id=?").run(thread.id);
    value(await f.service.control({ threadId: thread.id, action: "settings", settings: { thinkingLevel: "low" } }));
    const active = () => JSON.parse((db.prepare("SELECT settings FROM thread_execution WHERE thread_id=?").get(thread.id) as { settings: string }).settings);
    expect(active()).toMatchObject({ model: "openai-codex-8/gpt-6-astra", thinkingLevel: "low" });
    const count = f.sessions[0].commands.length;
    value(await f.service.control({ threadId: thread.id, action: "settings", settings: { model: "fable" } }));
    value(await f.service.control({ threadId: thread.id, action: "settings", settings: { thinkingLevel: "high", speed: "priority" } }));
    expect(f.service.get(thread.id)!.settings).toEqual({ model: "anthropic/claude-fable-5-1", thinkingLevel: "high", speed: "priority" });
    expect(active()).toEqual({ model: "openai-codex-8/gpt-6-astra", thinkingLevel: "low", speed: "standard" });
    expect(f.sessions[0].commands).toHaveLength(count);
  } finally { db.close(); }
});

it("reports persisted settings when the running session rejects their application", async () => {
  const f = fixture();
  await f.service.start();
  const thread = value(await f.service.spawn({ requestId: "settings-partial", cwd: f.directory, message: "active" }));
  await waitFor(() => f.sessions.some(session => session.isStreaming));
  const session = f.sessions[0], command = session.command.bind(session);
  vi.spyOn(session, "command").mockImplementation(async input => {
    if (input.type === "set_thinking_level") throw new Error("Native session unavailable");
    return command(input);
  });
  expect(await f.service.control({ threadId: thread.id, action: "settings", settings: { thinkingLevel: "low" } })).toMatchObject({
    ok: false, error: { message: expect.stringContaining("Thread settings were saved, but the running session did not confirm") },
  });
  expect(f.service.get(thread.id)!.settings.thinkingLevel).toBe("low");
});

describe("leaf Orchestrator workers", () => {
  it("routes children to fleet, rejects recursion in both owners, and retains creation receipts", async () => {
    const person = fixture(), fleet = fixture(undefined, true);
    const root = value(await person.service.spawn({ requestId: "root", cwd: person.directory }));
    const existingInput = { requestId: "existing-child", parentId: root.id, cwd: person.directory };
    const existing = value(await person.service.spawn(existingInput));
    const directory = new ThreadDirectory({ id: "person", api: person.service }, [{ id: "fleet", api: fleet.service }]);
    person.service.setDirectory(directory, () => fleet.service);
    fleet.service.setDirectory(directory);
    expect(value(await directory.spawn(existingInput)).id).toBe(existing.id);
    const input = { requestId: "fleet-child", parentId: root.id, cwd: person.directory, message: "Do bounded work" };
    const child = value(await directory.spawn(input));
    expect(person.service.get(child.id)).toBeNull();
    expect(fleet.service.get(child.id)?.role).toBe("worker");
    expect(value(await directory.spawn(input)).id).toBe(child.id);
    for (const parentId of [existing.id, child.id]) {
      for (const api of [directory, person.service, fleet.service]) {
        const result = await api.spawn({ requestId: `recursive-${parentId}`, parentId, cwd: person.directory });
        expect(result).toMatchObject({ ok: false, error: { code: "invalid_request" } });
      }
    }
    const lane = value(await fleet.service.spawn({ requestId: "lane", cwd: fleet.directory }));
    expect(lane.role).toBe("worker");
    expect(await fleet.service.spawn({ requestId: "lane-child", parentId: lane.id, cwd: fleet.directory })).toMatchObject({ ok: false, error: { code: "invalid_request" } });
    value(await directory.control({ threadId: root.id, action: "stop", descendants: true }));
    expect(person.service.get(existing.id)?.state).toBe("stopped");
    expect(fleet.service.get(child.id)?.state).toBe("stopped");
    expect(fleet.service.pending(child.id)[0]?.state).toBe("held");
    expect(await directory.spawn({ requestId: "stopped-child", parentId: root.id, cwd: person.directory })).toMatchObject({ ok: false, error: { code: "unavailable" } });
    expect(fleet.service.snapshot()).toHaveLength(2);
  });

  it("removes the spawn tool per session and relays completion to a cross-owner parent", async () => {
    const person = fixture(), fleet = fixture(undefined, true);
    const directory = new ThreadDirectory({ id: "person", api: person.service }, [{ id: "fleet", api: fleet.service }]);
    person.service.setDirectory(directory, () => fleet.service);
    fleet.service.setDirectory(directory);
    const root = value(await directory.spawn({ requestId: "parent", cwd: person.directory, message: "Coordinate" }));
    const child = value(await directory.spawn({ requestId: "child", parentId: root.id, cwd: person.directory, message: "Work" }));
    value(await person.service.start()); value(await fleet.service.start());
    await waitFor(() => person.sessions[0]?.isStreaming === true && fleet.sessions[0]?.isStreaming === true);
    expect(person.sessions[0]!.options.env.PI_THREAD_CAN_SPAWN).toBe("1");
    expect(fleet.sessions[0]!.options.env.PI_THREAD_CAN_SPAWN).toBe("0");
    expect(fleet.sessions[0]!.options.env.PI_THREAD_DATABASE).toBe(join(fleet.directory, "threads.sqlite"));
    expect(person.sessions[0]!.options.env.PI_THREAD_DATABASE).toBe(join(person.directory, "threads.sqlite"));
    expect(threadTools(person.sessions[0]!.options).some(tool => tool.name === "thread_spawn")).toBe(true);
    expect(threadTools(fleet.sessions[0]!.options).some(tool => tool.name === "thread_spawn")).toBe(false);
    expect(person.sessions[0]!.commands.find(command => command.type === "prompt")?.message).toBe("Coordinate");
    const assignment = String(fleet.sessions[0]!.commands.find(command => command.type === "prompt")?.message);
    expect(assignment).toContain("<agent_message>");
    expect(assignment).toContain(JSON.stringify(root.id));
    value(await directory.send({ requestId: "progress", threadId: root.id, senderId: child.id, text: "Still working", delivery: "steer" }));
    await waitFor(() => person.sessions[0]!.commands.some(command => command.workId === "progress"));
    const progress = String(person.sessions[0]!.commands.find(command => command.workId === "progress")?.message);
    fleet.sessions[0]!.settle("Worker result");
    await waitFor(() => person.sessions[0]!.commands.some(command => command.type === "steer" && JSON.stringify(command).includes("Worker result")));
    const completion = String(person.sessions[0]!.commands.find(command => command.type === "steer" && String(command.message).includes("Worker result"))?.message);
    for (const text of [progress, completion]) {
      expect(text.split("\n").slice(0, 2)).toEqual(assignment.split("\n").slice(0, 2));
      expect(JSON.parse(text.split("\n")[2]!)).toMatchObject({ senderThreadId: child.id, recipientThreadId: root.id });
      expect(text).toMatch(/<\/agent_message>$/);
    }
    expect(JSON.parse(completion.split("\n")[2]!)).toMatchObject({ source: "notification", replyTo: "child" });
    expect(fleet.service.get(child.id)?.state).toBe("idle");
  });
});

async function settle(session: FakePiSession, service: ThreadService, threadId: string, text = "done") {
  session.settle(text);
  await waitFor(() => service.get(threadId)?.state === "idle");
}

describe("ThreadService", () => {
  it("applies import provenance without treating retained archive metadata as a new archive request", async () => {
    const { service, directory } = fixture();
    const thread = value(await service.spawn({ requestId: "provenance", cwd: directory, metadata: { importedFrom: { nativeStateDirectory: directory } } }));
    writeFileSync(thread.sessionFile, JSON.stringify({ type: "session", version: 3, id: thread.id, cwd: directory, timestamp: new Date().toISOString() }) + "\n");
    value(await service.control({ threadId: thread.id, action: "update", archived: true }));
    writeFileSync(join(directory, "transfer.json"), JSON.stringify({ version: 1, sourceCore: "pi", messages: [], agents: [] }));
    const db = new DatabaseSync(":memory:");
    try { value(importRemoteThreads(service, db, { sessionsDir: directory })); }
    finally { db.close(); }
    expect(service.get(thread.id)?.metadata).toMatchObject({ archived: true, importProvenance: { stateDirs: [directory] } });
  });
  it("resolves the compiled Node runner from both Bun source and Node builds", () => {
    expect(runnerHostEntry("file:///release/src/threads/runner-transport.ts")).toBe("/release/dist/threads/runner-host.js");
    expect(runnerHostEntry("file:///release/dist/threads/runner-transport.js")).toBe("/release/dist/threads/runner-host.js");
  });

  it("archives only strictly stale settled threads and gives restores a new grace period", async () => {
    const { service, directory } = fixture();
    const clock = vi.spyOn(Date, "now").mockReturnValue(10_000);
    const thread = value(await service.spawn({ requestId: "idle", cwd: directory }));
    clock.mockReturnValue(3_610_000);
    expect(value(await service.control({ threadId: thread.id, action: "archiveInactive", inactiveBefore: 10_000 })).metadata?.archived).not.toBe(true);
    clock.mockReturnValue(3_610_001);
    expect(value(await service.control({ threadId: thread.id, action: "archiveInactive", inactiveBefore: 10_001 })).metadata?.archived).toBe(true);
    value(await service.control({ threadId: thread.id, action: "update", archived: false }));
    expect(value(await service.control({ threadId: thread.id, action: "archiveInactive", inactiveBefore: 10_001 })).metadata?.archived).toBe(false);
    expect(await service.control({ threadId: thread.id, action: "archiveInactive", inactiveBefore: Date.now() + 1 })).toMatchObject({ ok: false });
  });

  it("does not archive pending work or a parent of pending work, even when held", async () => {
    const { service, directory } = fixture();
    const clock = vi.spyOn(Date, "now").mockReturnValue(10_000);
    const parent = value(await service.spawn({ requestId: "parent-idle", cwd: directory }));
    const child = value(await service.spawn({ requestId: "child-held", parentId: parent.id, cwd: directory, message: "preserve this" }));
    value(await service.control({ threadId: child.id, action: "stop", descendants: false }));
    clock.mockReturnValue(3_620_000);
    for (const id of [parent.id, child.id]) expect(value(await service.control({ threadId: id, action: "archiveInactive", inactiveBefore: 20_000 })).metadata?.archived).not.toBe(true);
    expect(service.pending(child.id)).toHaveLength(1);
  });

  it("rechecks activity after a stale sweep snapshot and never stops a running model", async () => {
    const { service, directory, sessions } = fixture();
    await service.start();
    const clock = vi.spyOn(Date, "now").mockReturnValue(10_000);
    const thread = value(await service.spawn({ requestId: "race", cwd: directory }));
    clock.mockReturnValue(3_620_000);
    value(await service.send({ requestId: "new-work", threadId: thread.id, text: "new work", delivery: "queue" }));
    await waitFor(() => sessions[0]?.isStreaming === true);
    clock.mockReturnValue(7_240_000);
    expect(value(await service.control({ threadId: thread.id, action: "archiveInactive", inactiveBefore: 3_640_000 })).metadata?.archived).not.toBe(true);
    expect(sessions[0]?.commands.some(command => command.type === "abort")).toBe(false);
    await settle(sessions[0]!, service, thread.id);
  });

  it("opens every child with a fresh session and resolves default and Luna settings centrally", async () => {
    const { directory, service, sessions } = fixture();
    await service.start();
    const parent = value(await service.spawn({ requestId: "parent", id: "parent", cwd: directory, settings: { model: "luna" }, metadata: { meetingId: "room", profileId: "personal", nativeHistoryRequired: true } }));
    expect(parent.settings).toEqual({ model: "openai-codex/gpt-5.6-luna", thinkingLevel: "max", speed: "standard" });
    const defaultChild = value(await service.spawn({ requestId: "default-child", id: "default-child", parentId: parent.id, cwd: directory, message: "first assignment" }));
    const lunaChild = value(await service.spawn({ requestId: "luna-child", id: "luna-child", parentId: parent.id, cwd: directory, message: "second assignment", settings: { model: "luna" }, admission: "background" }));
    value(await service.control({ threadId: parent.id, action: "stop", descendants: false }));
    await waitFor(() => sessions.length === 2 && sessions.every(session => session.commands.some(command => command.type === "prompt")));

    expect(defaultChild.settings).toEqual({ model: "openai-codex/gpt-6-astra", thinkingLevel: "high", speed: "standard" });
    expect(lunaChild.settings).toEqual({ model: "openai-codex/gpt-5.6-luna", thinkingLevel: "max", speed: "standard" });
    expect([defaultChild.admission, lunaChild.admission]).toEqual(["force", "force"]);
    expect(defaultChild.metadata).toMatchObject({ meetingId: "room", profileId: "personal" });
    expect(defaultChild.metadata?.nativeHistoryRequired).toBeUndefined();
    expect(new Set(sessions.map(session => session.options.sessionFile)).size).toBe(2);
    expect(sessions.map(session => session.options.env.PI_THREAD_REQUIRE_SESSION)).toEqual(["0", "0"]);
    expect(sessions.map(session => session.options.args)).toEqual(expect.arrayContaining([
      ["--provider", "openai-codex", "--model", "gpt-6-astra", "--thinking", "high", "--name", defaultChild.title],
      ["--provider", "openai-codex", "--model", "gpt-5.6-luna", "--thinking", "max", "--name", lunaChild.title],
    ]));

    for (const session of sessions) session.settle(`complete ${session.options.threadId}`);
    await waitFor(() => [defaultChild.id, lunaChild.id].every(id => service.get(id)?.state === "idle"));
  });

  it("persists a held queue across restart and reports an empty resume", async () => {
    const first = fixture();
    const thread = value(await first.service.spawn({ requestId: "thread", id: "thread", cwd: first.directory }));
    value(await first.service.send({ requestId: "queued", threadId: thread.id, text: "durable input", delivery: "queue" }));
    value(await first.service.control({ threadId: thread.id, action: "stop", descendants: false }));
    expect(first.service.pending(thread.id)).toMatchObject([{ id: "queued", state: "held" }]);
    value(await first.service.close());

    const second = fixture(first.directory);
    expect(second.service.pending(thread.id)).toMatchObject([{ id: "queued", text: "durable input", state: "held" }]);
    value(await second.service.control({ threadId: thread.id, action: "resume" }));
    await second.service.start();
    await waitFor(() => second.sessions[0]?.commands.some(command => command.type === "prompt"));
    await settle(second.sessions[0]!, second.service, thread.id);
    const empty = await second.service.control({ threadId: thread.id, action: "resume" });
    expect(empty).toMatchObject({ ok: false, error: { code: "no_pending_messages" } });
  });

  it("holds child notification for a stopped parent and puts an explicit message first", async () => {
    const first = fixture();
    await first.service.start();
    const parent = value(await first.service.spawn({ requestId: "parent", id: "parent", cwd: first.directory }));
    const child = value(await first.service.spawn({ requestId: "child-work", id: "child", parentId: parent.id, cwd: first.directory, message: "child task" }));
    value(await first.service.control({ threadId: parent.id, action: "stop", descendants: false }));
    await waitFor(() => first.sessions[0]?.commands.some(command => command.type === "prompt"));
    await settle(first.sessions[0]!, first.service, child.id, "child result");
    await waitFor(() => first.service.pending(parent.id).length === 1);
    expect(first.service.get(parent.id)?.state).toBe("stopped");
    expect(first.service.pending(parent.id)).toMatchObject([{ source: "notification", state: "held", senderId: child.id }]);
    value(await first.service.close());

    const second = fixture(first.directory);
    value(await second.service.send({ requestId: "explicit", threadId: parent.id, text: "new instruction", delivery: "queue" }));
    expect(second.service.get(parent.id)?.state).toBe("running");
    expect(second.service.pending(parent.id).map(message => ({ id: message.id, source: message.source, text: message.text }))).toEqual([
      { id: "explicit", source: "explicit", text: "new instruction" },
      expect.objectContaining({ source: "notification" }),
    ]);
  });

  it("normalizes stored phases without losing active execution or held input", async () => {
    const first = fixture();
    value(first.service.importThread({ id: "active", title: "active", cwd: first.directory, sessionFile: join(first.directory, "active.jsonl"), settings: { model: "openai-codex/gpt-6-astra", thinkingLevel: "high", speed: "standard" } }));
    value(first.service.importMessage({ id: "accepted", threadId: "active", text: "accepted", state: "dispatched" }));
    value(first.service.importMessage({ id: "held", threadId: "active", text: "preserve", state: "queued" }));
    value(await first.service.detach());
    const db = new DatabaseSync(join(first.directory, "threads.sqlite"));
    db.exec("UPDATE thread SET held=1,state='interrupted'"); db.close();
    const second = fixture(first.directory);
    expect(second.service.get("active")?.state).toBe("running");
    expect(second.service.pending("active").map(message => message.id)).toEqual(["accepted", "held"]);
    expect(await second.service.list({ state: "interrupted" as never })).toMatchObject({ ok: false, error: { code: "invalid_request" } });
    expect(second.sessions).toHaveLength(0);
    value(await second.service.control({ threadId: "active", action: "stop", descendants: false }));
    expect(second.service.get("active")?.state).toBe("stopped");
    expect(second.service.pending("active")).toMatchObject([{ id: "held", state: "held" }]);
    expect(second.sessions).toHaveLength(0);
  });

  it("halts retained execution without cwd, credentials, admission or session initialization", async () => {
    const directory = mkdtempSync(join(tmpdir(), "thread-cold-halt-")); roots.push(directory);
    const openSession = vi.fn(async () => { throw new Error("Stop must not initialize a session"); });
    const admit = vi.fn(async () => { throw new Error("Stop must not request admission"); });
    const attachSession = vi.fn(async () => null);
    const service = new ThreadService({ databasePath: join(directory, "threads.sqlite"), sessionsDir: directory, openSession, admit, attachSession }); services.push(service);
    const reference = { control: "/absent/runner.sock", socketPath: "/absent/session.sock" };
    value(service.importThread({ id: "gone", title: "gone", cwd: "/reclaimed/checkout", sessionFile: "/missing/session.jsonl", metadata: { runnerReference: reference }, settings: { model: "openai-codex/gpt-6-astra", thinkingLevel: "high", speed: "standard" } }));
    value(service.importMessage({ id: "accepted", threadId: "gone", text: "work", state: "dispatched" }));
    value(service.importMessage({ id: "next", threadId: "gone", text: "keep", state: "queued" }));
    expect(value(await service.control({ threadId: "gone", action: "stop", descendants: false })).state).toBe("stopped");
    expect(attachSession).toHaveBeenCalledWith(reference, expect.any(Function), expect.any(Function));
    expect(openSession).not.toHaveBeenCalled(); expect(admit).not.toHaveBeenCalled();
    expect(service.latestSettlement("gone")?.outcome).toBe("cancelled");
    expect(service.pending("gone")).toMatchObject([{ id: "next", state: "held" }]);
  });

  it("deduplicates halt, holds pending input, and does not confirm stopped before native acknowledgement", async () => {
    const { service, directory, sessions } = fixture();
    await service.start();
    const thread = value(await service.spawn({ requestId: "active", cwd: directory, message: "work" }));
    await waitFor(() => sessions[0]?.isStreaming === true);
    const native = sessions[0]!, command = native.command.bind(native);
    let release!: () => void, aborts = 0;
    const gate = new Promise<void>(resolve => { release = resolve; });
    native.command = async input => { if (input.type === "abort") { aborts++; await gate; } await command(input); };
    value(await service.send({ requestId: "pending", threadId: thread.id, text: "next", delivery: "queue" }));
    const first = service.control({ threadId: thread.id, action: "stop", descendants: false });
    const second = service.control({ threadId: thread.id, action: "stop", descendants: false });
    await waitFor(() => aborts === 1);
    expect(service.get(thread.id)?.state).toBe("running");
    expect(service.pending(thread.id).find(message => message.id === "pending")?.state).toBe("held");
    expect(native.closed).toBe(false);
    release();
    expect(value(await first).state).toBe("stopped");
    expect(value(await second).state).toBe("stopped");
    expect(aborts).toBe(1);
    expect(native.closed).toBe(true);
    value(await service.control({ threadId: thread.id, action: "resume" }));
    await waitFor(() => sessions[1]?.commands.some(input => input.workId === "pending") === true);
    await settle(sessions[1]!, service, thread.id);
  });

  it("uses the same halt before hard steering and preserves the rest of the queue", async () => {
    const { service, directory, sessions } = fixture();
    await service.start();
    const thread = value(await service.spawn({ requestId: "active", cwd: directory, message: "work" }));
    await waitFor(() => sessions[0]?.isStreaming === true);
    value(await service.send({ requestId: "later", threadId: thread.id, text: "later", delivery: "queue" }));
    value(await service.send({ requestId: "now", threadId: thread.id, text: "now", delivery: "hardSteer" }));
    await waitFor(() => sessions[1]?.commands.some(input => input.workId === "now") === true);
    expect(sessions[0]!.commands.filter(input => input.type === "abort")).toHaveLength(1);
    expect(sessions[0]!.closed).toBe(true);
    expect(service.pending(thread.id).some(message => message.id === "later")).toBe(true);
    expect(service.latestSettlement(thread.id)?.outcome).toBe("cancelled");
    sessions[1]!.settle("now done");
    await waitFor(() => sessions[2]?.commands.some(input => input.workId === "later") === true);
    await settle(sessions[2]!, service, thread.id);
  });

  it("reconciles an unconfirmed halt instead of stranding its held queue", async () => {
    const { service, directory, sessions } = fixture();
    await service.start();
    const thread = value(await service.spawn({ requestId: "active", cwd: directory, message: "work" }));
    await waitFor(() => sessions[0]?.isStreaming === true);
    const native = sessions[0]!, command = native.command.bind(native);
    let failed = false;
    native.command = async input => {
      if (input.type === "abort" && !failed) { failed = true; throw new Error("Tool has not stopped"); }
      await command(input);
    };
    value(await service.send({ requestId: "pending", threadId: thread.id, text: "next", delivery: "queue" }));
    expect(await service.control({ threadId: thread.id, action: "stop", descendants: false })).toMatchObject({ ok: false });
    expect(service.get(thread.id)).toMatchObject({ state: "running", metadata: { executionError: "Tool has not stopped" } });
    service.reconcile();
    await waitFor(() => service.get(thread.id)?.state === "stopped");
    expect(service.pending(thread.id)).toMatchObject([{ id: "pending", state: "held" }]);
    expect(service.get(thread.id)?.metadata?.executionError).toBeUndefined();
  });

  it("hard steers a native command without waiting behind that command's serial operation", async () => {
    const directory = mkdtempSync(join(tmpdir(), "thread-command-halt-")); roots.push(directory);
    let native: FakePiSession | undefined, release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const sessions: FakePiSession[] = [];
    const service = new ThreadService({ databasePath: join(directory, "threads.sqlite"), sessionsDir: join(directory, "sessions"),
      openSession: async (options, output) => {
        const session = new FakePiSession(options, output), command = session.command.bind(session);
        sessions.push(session);
        session.command = async input => {
          if (input.type === "bash") { native = session; session.isStreaming = true; await gate; }
          if (input.type === "abort") release();
          await command(input);
        };
        return session;
      } });
    services.push(service); await service.start();
    const thread = value(await service.spawn({ requestId: "thread", cwd: directory }));
    const shell = service.command(thread.id, { id: "shell", type: "bash", command: "sleep 600" });
    await waitFor(() => !!native);
    expect(service.get(thread.id)?.state).toBe("running");
    value(await service.send({ requestId: "new", threadId: thread.id, text: "new work", delivery: "hardSteer" }));
    value(await shell);
    await waitFor(() => sessions[1]?.commands.some(input => input.workId === "new") === true);
    expect(native!.commands.filter(input => input.type === "abort")).toHaveLength(1);
    expect(native!.closed).toBe(true);
    await settle(sessions[1]!, service, thread.id);
  });

  it("halts an opening session without submitting its queued input", async () => {
    const directory = mkdtempSync(join(tmpdir(), "thread-opening-")); roots.push(directory);
    let release!: () => void, native: FakePiSession | undefined;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const service = new ThreadService({ databasePath: join(directory, "threads.sqlite"), sessionsDir: join(directory, "sessions"),
      openSession: async (options, output) => { native = new FakePiSession(options, output); await gate; return native; } });
    services.push(service); await service.start();
    const thread = value(await service.spawn({ requestId: "pending", cwd: directory, message: "work" }));
    await waitFor(() => !!native);
    const stopped = service.control({ threadId: thread.id, action: "stop", descendants: false });
    release();
    expect(value(await stopped).state).toBe("stopped");
    expect(native!.commands.some(input => input.type === "prompt")).toBe(false);
    expect(service.pending(thread.id)).toMatchObject([{ id: "pending", state: "held" }]);
  });

  it("reads native history without activating a runtime", async () => {
    const { directory, service, sessions } = fixture();
    const transcript = join(directory, "existing.jsonl");
    writeFileSync(transcript, [
      { type: "session", id: "session" },
      { type: "message", id: "user", message: { role: "user", content: "hello" } },
      { type: "message", id: "assistant", parentId: "user", message: { role: "assistant", content: "hi" } },
    ].map(entry => JSON.stringify(entry)).join("\n") + "\n");
    value(service.importThread({ id: "imported", title: "Imported", cwd: directory, sessionFile: transcript, settings: { model: "astra", thinkingLevel: "high", speed: "standard" } }));

    const history = value(await service.read({ threadId: "imported" }));
    expect(history.entries.map(entry => entry.id)).toEqual(["user", "assistant"]);
    expect(sessions).toHaveLength(0);
  });

  it("defaults agent inputs to steer while retaining human queues and explicit choices", async () => {
    const { directory, service } = fixture();
    const parent = value(await service.spawn({ requestId: "parent", cwd: directory, message: "Coordinate" }));
    const child = value(await service.spawn({ requestId: "child", cwd: directory, parentId: parent.id, message: "Assignment" }));
    expect(service.pending(parent.id)[0]?.delivery).toBe("queue");
    expect(service.pending(child.id)[0]?.delivery).toBe("steer");
    const agent = { requestId: "agent", threadId: parent.id, senderId: child.id, text: "Progress" };
    expect(value(await service.send(agent)).delivery).toBe("steer");
    expect(value(await service.send({ ...agent, delivery: "steer" })).id).toBe("agent");
    expect(value(await service.send({ requestId: "human", threadId: parent.id, text: "More work" })).delivery).toBe("queue");
    for (const delivery of ["queue", "steer", "hardSteer"] as const) {
      expect(value(await service.send({ ...agent, requestId: delivery, delivery })).delivery).toBe(delivery);
    }
  });

  it("deduplicates request receipts and rejects changed reuse", async () => {
    const { directory, service } = fixture();
    const spawn = { requestId: "spawn-request", id: "same-thread", cwd: directory } as const;
    expect(value(await service.spawn(spawn)).id).toBe("same-thread");
    expect(value(await service.spawn(spawn)).id).toBe("same-thread");
    const message = { requestId: "send-request", threadId: "same-thread", text: "once", delivery: "queue" as const };
    expect(value(await service.send(message)).id).toBe("send-request");
    expect(value(await service.send(message)).id).toBe("send-request");
    expect(service.pending("same-thread")).toHaveLength(1);
    expect(await service.send({ ...message, text: "different" })).toMatchObject({ ok: false, error: { code: "conflict" } });
  });

  it("keeps sender attribution when recovering previously prepared agent input", async () => {
    const first = fixture();
    value(first.service.importThread({ id: "recipient", title: "Recipient", cwd: first.directory, sessionFile: join(first.directory, "recipient.jsonl"), settings: { model: "astra", thinkingLevel: "high", speed: "standard" } }));
    value(first.service.importMessage({ id: "accepted-agent-input", threadId: "recipient", senderId: "sender", text: "Keep working", state: "dispatched", insertedAt: Date.now() }));
    value(await first.service.detach());
    const db = new DatabaseSync(join(first.directory, "threads.sqlite"));
    db.prepare("UPDATE thread_work SET prepared=? WHERE id=?").run(JSON.stringify({ text: "Keep working\nPrepared context", images: [] }), "accepted-agent-input");
    db.close();
    const second = fixture(first.directory);
    value(await second.service.start());
    await waitFor(() => second.sessions[0]?.commands.some(command => command.workId === "accepted-agent-input") === true);
    const command = second.sessions[0]!.commands.find(command => command.workId === "accepted-agent-input")!;
    const text = String(command.message);
    expect(command.resume).toBe(true);
    expect(JSON.parse(text.split("\n")[2]!)).toMatchObject({ senderThreadId: "sender", messageId: "accepted-agent-input" });
    expect(text).toContain("Keep working\nPrepared context");
    expect(text.match(/<agent_message>/g)).toHaveLength(1);
    await settle(second.sessions[0]!, second.service, "recipient");
  });

  it("does not replay an imported completed message", async () => {
    const { directory, service, sessions } = fixture();
    value(service.importThread({ id: "complete-thread", title: "Complete", cwd: directory, sessionFile: join(directory, "complete.jsonl"), settings: { model: "astra", thinkingLevel: "high", speed: "standard" } }));
    value(service.importMessage({ id: "completed-work", threadId: "complete-thread", text: "already handled", state: "complete", outcome: "complete", finalMessage: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "finished" }] } }));

    await service.start();
    await turn();
    await turn();
    expect(service.pending("complete-thread")).toHaveLength(0);
    expect(service.get("complete-thread")?.state).toBe("idle");
    expect(sessions).toHaveLength(0);
  });
});

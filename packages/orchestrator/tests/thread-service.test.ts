import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runnerHostEntry } from "../src/threads/runner-transport.js";
import { DatabaseSync } from "node:sqlite";
import { importRemoteThreads } from "../src/threads/import.js";
import type { OpenPiSession, PiCommand, PiEvent, PiSession, PiSessionOptions, Result } from "../src/threads/contracts.js";
import { ThreadService, type ThreadServiceOptions } from "../src/threads/service.js";
import * as routing from "../src/extension/routing.js";
import { ThreadDirectory } from "../src/threads/directory.js";
import { threadTools } from "../src/threads/pi-tools.js";
import { createThreadClient, threadHttp } from "../src/threads/http.js";

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
  setActive?: (active: boolean) => Promise<void>;

  constructor(readonly options: PiSessionOptions, private readonly output: (event: PiEvent) => void) {}

  async command(command: PiCommand): Promise<void> {
    this.commands.push(command);
    if (command.type === "prompt" || command.type === "steer") {
      if (typeof command.workId === "string") this.acceptedWorkIds.add(command.workId);
      if (!this.isStreaming) {
        this.isStreaming = true;
        this.output({ type: "agent_start" });
      }
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
    this.settleMessage({ role: "assistant", content: [{ type: "text", text }], stopReason, timestamp: Date.now() });
  }

  settleMessage(message: Record<string, unknown>): void {
    this.lastAssistantMessage = message;
    const workId = [...this.acceptedWorkIds].at(-1);
    if (workId) this.completedWorkIds.add(workId);
    this.isStreaming = false;
    this.pendingMessageCount = 0;
    this.output({ type: "message_end", message });
    this.output({ type: "agent_settled" });
  }

  emit(event: PiEvent): void { this.output(event); }

  async close(): Promise<void> { this.closed = true; }
}

describe("delayed native input acknowledgements", () => {
  async function delayed() {
    const directory = mkdtempSync(join(tmpdir(), "thread-late-ack-")); roots.push(directory);
    let session!: FakePiSession, input!: PiCommand;
    const service = new ThreadService({ capacity: { mode: "unmanaged" }, databasePath: join(directory, "threads.sqlite"), sessionsDir: directory,
      openSession: async (options, output) => {
        session = new FakePiSession(options, output);
        const command = session.command.bind(session);
        session.command = async next => {
          if (next.type !== "steer") return command(next);
          input = next; session.commands.push(next);
          session.acceptedWorkIds.add(String(next.workId));
          session.emit({ type: "auto_compaction_start" });
        };
        return session;
      } });
    services.push(service); value(await service.start());
    const thread = value(await service.spawn({ requestId: "initial", cwd: directory, message: "initial" }));
    await waitFor(() => !!service.pending(thread.id)[0]?.insertedAt);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    value(await service.send({ requestId: "delayed", threadId: thread.id, text: "retain this", delivery: "steer" }));
    await waitFor(() => !!input);
    await vi.advanceTimersByTimeAsync(30_001); await turn();
    return { service, session, input, thread };
  }

  it("treats 170-second automatic compaction as pending and reconciles its late acknowledgement exactly once", async () => {
    try {
      const { service, session, input, thread } = await delayed();
      expect(service.get(thread.id)?.metadata?.executionError).toBeUndefined();
      expect(service.get(thread.id)?.metadata?.acknowledgementWait).toMatchObject({ workId: "delayed" });
      expect(service.get(thread.id)?.executionActivity?.activityDetail).toContain("acknowledgement pending");
      expect(service.pending(thread.id).find(work => work.id === "delayed")).toMatchObject({ state: "dispatched", insertedAt: null });
      await vi.advanceTimersByTimeAsync(140_000);
      session.emit({ type: "auto_compaction_end" });
      session.emit({ type: "response", id: input.id, command: "prompt", success: true });
      await turn();
      expect(service.get(thread.id)?.metadata?.acknowledgementWait).toBeUndefined();
      expect(service.get(thread.id)?.metadata?.executionError).toBeUndefined();
      expect(service.pending(thread.id).find(work => work.id === "delayed")).toMatchObject({ insertedAt: expect.any(Number), landedAt: null });
      service.reconcile(); await turn();
      expect(session.commands.filter(command => command.workId === "delayed")).toHaveLength(1);
      session.emit({ type: "message_start", inputWorkId: "delayed", message: { role: "user", content: "retain this" } });
      expect(service.pending(thread.id).find(work => work.id === "delayed")?.landedAt).toEqual(expect.any(Number));
      await settle(session, service, thread.id);
      expect(value(service.settlements(0)).items[0]?.outcome).toBe("complete");
    } finally { vi.useRealTimers(); }
  });

  it("bounds observation with read-only custody probes rather than replay after four minutes", async () => {
    try {
      const { service, session, thread } = await delayed();
      // No receipt is visible yet: remain uncertain instead of inventing acceptance or failure.
      session.acceptedWorkIds.delete("delayed");
      await vi.advanceTimersByTimeAsync(210_000); service.reconcile(); await turn(); await turn();
      expect(service.get(thread.id)?.metadata?.acknowledgementWait).toMatchObject({ overdue: true });
      expect(service.get(thread.id)?.metadata?.executionError).toBeUndefined();
      expect(service.get(thread.id)?.executionActivity?.activityDetail).toContain("without replay");
      session.acceptedWorkIds.add("delayed");
      await vi.advanceTimersByTimeAsync(30_000); service.reconcile(); await turn(); await turn();
      expect(service.get(thread.id)?.metadata?.acknowledgementWait).toBeUndefined();
      expect(service.pending(thread.id).find(work => work.id === "delayed")?.insertedAt).toEqual(expect.any(Number));
      expect(session.commands.filter(command => command.workId === "delayed")).toHaveLength(1);
    } finally { vi.useRealTimers(); }
  });

  it("retains pending acknowledgement across controller handoff and adopts late receipt without dispatch", async () => {
    try {
      const { service, session, input, thread } = await delayed();
      const wait = service.get(thread.id)?.metadata?.acknowledgementWait;
      await service.suspend();
      let recovered!: FakePiSession;
      const replacement = new ThreadService({ capacity: { mode: "unmanaged" }, databasePath: join(thread.cwd, "threads.sqlite"), sessionsDir: thread.cwd,
        openSession: async (options, output) => {
          recovered = new FakePiSession(options, output);
          recovered.isStreaming = true;
          recovered.acceptedWorkIds.add("initial");
          return recovered;
        } });
      services.push(replacement); value(await replacement.start());
      await waitFor(() => !!recovered?.commands.some(command => command.type === "get_state"));
      expect(replacement.get(thread.id)?.metadata?.acknowledgementWait).toEqual(wait);
      recovered.emit({ type: "response", id: input.id, command: "prompt", success: true });
      await turn();
      expect(replacement.get(thread.id)?.metadata?.acknowledgementWait).toBeUndefined();
      expect(replacement.pending(thread.id).find(work => work.id === "delayed")?.insertedAt).toEqual(expect.any(Number));
      expect(recovered.commands.some(command => command.workId === "delayed")).toBe(false);
      expect(session.commands.filter(command => command.workId === "delayed")).toHaveLength(1);
    } finally { vi.useRealTimers(); }
  });

  it("keeps explicit late rejection terminal rather than calling every timeout a success", async () => {
    try {
      const { service, session, input, thread } = await delayed();
      session.emit({ type: "response", id: input.id, command: "prompt", success: false, error: "Preflight rejected input" });
      await waitFor(() => value(service.settlements(0)).items.length > 0);
      expect(value(service.settlements(0)).items[0]).toMatchObject({ outcome: "failed", error: "Preflight rejected input" });
      expect(service.get(thread.id)?.metadata?.acknowledgementWait).toBeUndefined();
      expect(session.commands.filter(command => command.workId === "delayed")).toHaveLength(1);
    } finally { vi.useRealTimers(); }
  });

  it("Stop fences late receipts from reviving cancelled work", async () => {
    try {
      const { service, session, input, thread } = await delayed();
      value(await service.control({ threadId: thread.id, action: "stop", descendants: false }));
      const before = service.pending(thread.id);
      session.emit({ type: "response", id: input.id, command: "prompt", success: true });
      await turn();
      expect(service.get(thread.id)?.held).toBe(false);
      expect(service.get(thread.id)?.metadata?.archived).toBe(true);
      expect(service.pending(thread.id)).toEqual(before);
      expect(value(service.settlements(0)).items[0]?.outcome).toBe("cancelled");
      expect(service.get(thread.id)?.metadata?.acknowledgementWait).toBeUndefined();
    } finally { vi.useRealTimers(); }
  });
});

describe("warm execution residency", () => {
  it("reuses idle native context but reacquires and releases admission for every assignment", async () => {
    const directory = mkdtempSync(join(tmpdir(), "thread-warm-")); roots.push(directory);
    const sessions: FakePiSession[] = [], release = vi.fn(), activity = vi.fn(async (_active: boolean) => {});
    let admitted = true;
    const admit = vi.fn(async () => admitted ? { ok: true as const, value: { env: { PI_ORCHESTRATOR_ACCOUNT_ID: "account-one" }, release } }
      : { ok: false as const, error: { code: "unavailable" as const, message: "Capacity is occupied" } });
    const service = new ThreadService({ capacity: { mode: "unmanaged" }, databasePath: join(directory, "threads.sqlite"), sessionsDir: directory, admit,
      openSession: async (options, output) => { const session = new FakePiSession(options, output); session.setActive = activity; sessions.push(session); return session; } });
    services.push(service); value(await service.start());
    const thread = value(await service.spawn({ requestId: "first", cwd: directory, message: "first" }));
    await waitFor(() => sessions[0]?.isStreaming === true);
    await settle(sessions[0]!, service, thread.id);
    await waitFor(() => activity.mock.calls.some(([active]) => !active));
    expect(release).toHaveBeenCalledOnce(); expect(sessions[0]!.closed).toBe(false);
    service.reconcile(); await turn(); expect(sessions).toHaveLength(1);
    admitted = false;
    value(await service.send({ requestId: "second", threadId: thread.id, text: "second" }));
    await waitFor(() => !!service.get(thread.id)?.metadata?.admissionWait);
    expect(sessions[0]!.commands.some(command => command.workId === "second")).toBe(false);
    const phases: string[] = [];
    service.subscribe(() => { const phase = service.get(thread.id)?.executionActivity?.activity; if (phase) phases.push(phase); });
    admitted = true; service.reconcile();
    await waitFor(() => sessions[0]!.commands.some(command => command.workId === "second"));
    expect(phases).not.toContain("starting"); expect(sessions).toHaveLength(1);
    expect(admit).toHaveBeenCalledTimes(3);
    expect(activity.mock.calls.filter(([active]) => active)).toHaveLength(2);
    await settle(sessions[0]!, service, thread.id);
    expect(release).toHaveBeenCalledTimes(2);
    value(await service.control({ threadId: thread.id, action: "view" }));
    expect(service.get(thread.id)?.metadata?.autoArchiveViewedAt).toBeTypeOf("number");
  });

  it.each(["admission", "activation"])("recovers reclamation racing %s before dispatch without losing accepted input", async stage => {
    const directory = mkdtempSync(join(tmpdir(), "thread-reclaim-")); roots.push(directory);
    const sessions: FakePiSession[] = [], release = vi.fn();
    let nativeExit!: (code?: number) => void, reclaimed = false, admissions = 0, activations = 0;
    const service = new ThreadService({ capacity: { mode: "unmanaged" }, databasePath: join(directory, "threads.sqlite"), sessionsDir: directory,
      admit: async () => {
        if (++admissions === 2 && stage === "admission") { reclaimed = true; nativeExit(0); await turn(); }
        return { ok: true, value: { release } };
      },
      openSession: async (options, output, exit) => {
        const session = new FakePiSession(options, output); nativeExit = exit;
        session.setActive = async active => {
          if (active && ++activations === 2 && stage === "activation") {
            reclaimed = true; exit(0);
            throw new Error("Runner capacity busy: idle session was reclaimed; work remains queued");
          }
        };
        sessions.push(session); return session;
      } });
    services.push(service); value(await service.start());
    const thread = value(await service.spawn({ requestId: "first", cwd: directory, message: "first" }));
    await waitFor(() => sessions[0]?.isStreaming === true); await settle(sessions[0]!, service, thread.id);
    value(await service.send({ requestId: "second", threadId: thread.id, text: "second" }));
    await waitFor(() => sessions[1]?.isStreaming === true);
    expect(reclaimed).toBe(true); expect(admissions).toBe(2);
    expect(sessions[0]!.commands.some(command => command.workId === "second")).toBe(false);
    expect(sessions[1]!.commands.filter(command => command.workId === "second")).toHaveLength(1);
    expect(service.latestSettlement(thread.id)?.workId).toBe("first");
    await settle(sessions[1]!, service, thread.id); expect(release).toHaveBeenCalledTimes(2);
  });

  it.each(["account", "broker", "environment", "model"])("reopens an idle session when its admitted %s changes", async change => {
    const directory = mkdtempSync(join(tmpdir(), "thread-reopen-")); roots.push(directory);
    const sessions: FakePiSession[] = [], release = vi.fn();
    let admissionEnv = { PI_ORCHESTRATOR_ACCOUNT_ID: "one" } as Record<string, string>, environment = { HOME: directory };
    const service = new ThreadService({ capacity: { mode: "unmanaged" }, databasePath: join(directory, "threads.sqlite"), sessionsDir: directory,
      environment: () => environment, admit: async () => ({ ok: true, value: { env: admissionEnv, release } }),
      openSession: async (options, output) => { const session = new FakePiSession(options, output); sessions.push(session); return session; } });
    services.push(service); value(await service.start());
    const thread = value(await service.spawn({ requestId: "first", cwd: directory, message: "first", settings: { model: "sol" } }));
    await waitFor(() => sessions[0]?.isStreaming === true); await settle(sessions[0]!, service, thread.id);
    if (change === "account") admissionEnv = { PI_ORCHESTRATOR_ACCOUNT_ID: "two" };
    if (change === "broker") admissionEnv = { PI_MODEL_BROKER_URL: "http://127.0.0.1:2461" };
    if (change === "environment") environment = { HOME: join(directory, "new-home") };
    if (change === "model") value(await service.control({ threadId: thread.id, action: "settings", settings: { model: "astra" } }));
    value(await service.send({ requestId: "second", threadId: thread.id, text: "second" }));
    await waitFor(() => sessions[1]?.isStreaming === true);
    expect(sessions[0]!.closed).toBe(true);
    expect(sessions[1]!.options.env).toMatchObject(admissionEnv);
    expect(sessions[1]!.options.sessionFile).toBe(sessions[0]!.options.sessionFile);
    expect(sessions[1]!.options.env.PI_THREAD_REQUIRE_SESSION).toBe("1");
    await settle(sessions[1]!, service, thread.id); expect(release).toHaveBeenCalledTimes(2);
  });
});

function signedFinalMessage() {
  return {
    role: "assistant", stopReason: "stop", timestamp: 1234,
    content: [
      { type: "thinking", thinking: "Readable child reasoning", thinkingSignature: "opaque-thinking-signature" },
      { type: "text", text: "Readable child result", textSignature: "opaque-text-signature" },
      { type: "reasoning", summary: [{ type: "summary_text", text: "Readable reasoning summary" }], encrypted_content: "opaque-encrypted-snake" },
      { type: "thinking", thinking: "More readable reasoning", encryptedContent: "opaque-encrypted-camel", thoughtSignature: "opaque-thought-signature", signature: "opaque-signature" },
      { type: "redacted_thinking", data: "opaque-redacted-thinking" },
      { type: "toolCall", id: "child-tool", name: "inspect", arguments: { signature: "application-signature", encrypted_content: "application-value" } },
    ],
  };
}

function expectReadableCompletion(text: string): void {
  expect(text).toContain("Readable child result");
  for (const excluded of ["Readable child reasoning", "Readable reasoning summary", "More readable reasoning", "application-signature", "application-value", "opaque-", "thinkingSignature", "textSignature", "thoughtSignature", "encryptedContent", "redacted_thinking", "stopReason", "usage", "\"provider\"", "\"model\""]) {
    expect(text).not.toContain(excluded);
  }
}

function fixture(root?: string, workersOnly = false, prepareMessage?: ThreadServiceOptions["prepareMessage"]) {
  const directory = root ?? mkdtempSync(join(tmpdir(), "thread-service-"));
  if (!root) roots.push(directory);
  const sessions: FakePiSession[] = [];
  const openSession: OpenPiSession = async (options, output) => {
    const session = new FakePiSession(options, output);
    sessions.push(session);
    return session;
  };
  const service = new ThreadService({ capacity: { mode: "unmanaged" },
    workersOnly,
    prepareMessage,
    databasePath: join(directory, "threads.sqlite"),
    sessionsDir: join(directory, "sessions"),
    openSession,
  });
  services.push(service);
  return { directory, service, sessions };
}

it("projects durable person-input recency without agent sends, notifications or edits", async () => {
  const { service, directory } = fixture();
  const thread = value(service.importThread({ id: "recency", title: "Recency", cwd: directory,
    sessionFile: join(directory, "recency.jsonl"), settings: { model: "sol", thinkingLevel: "high", speed: "standard" },
    createdAt: 1, updatedAt: 2 }));
  expect(thread.lastUserMessageAt).toBeUndefined();
  value(service.importMessage({ id: "person-old", threadId: thread.id, text: "first", createdAt: 10, state: "done" }));
  value(service.importMessage({ id: "person-new", threadId: thread.id, text: "next", createdAt: 20, state: "done" }));
  value(service.importMessage({ id: "agent", threadId: thread.id, senderId: "child", text: "agent send", createdAt: 30, state: "done" }));
  value(service.importMessage({ id: "notice", threadId: thread.id, source: "notification", text: "notice", createdAt: 40, state: "done" }));
  value(service.importMessage({ id: "person-new", threadId: thread.id, text: "next", createdAt: 50, state: "done" }));
  expect(service.get(thread.id)?.lastUserMessageAt).toBe(20);
  expect(service.snapshot()[0]?.lastUserMessageAt).toBe(20);
  expect(value(await service.list({ id: thread.id })).threads[0]?.lastUserMessageAt).toBe(20);
  await service.close();
  const restored = fixture(directory).service;
  expect(restored.get(thread.id)?.lastUserMessageAt).toBe(20);
});

describe("controller resource handoff", () => {
  it.each(["queued", "dispatched"] as const)("preserves %s work when its opener rejects after suspension", async state => {
    const directory = mkdtempSync(join(tmpdir(), "thread-handoff-rejection-")); roots.push(directory);
    let entered = false, release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const leaseRelease = vi.fn();
    const service = new ThreadService({ capacity: { mode: "unmanaged" }, databasePath: join(directory, "threads.sqlite"), sessionsDir: directory,
      admit: async () => ({ ok: true, value: { release: leaseRelease } }),
      openSession: async () => { entered = true; await gate; throw new Error("Session initialization interrupted by handoff"); } });
    services.push(service);
    value(service.importThread({ id: "opening", title: "opening", cwd: directory, sessionFile: join(directory, "opening.jsonl"),
      settings: { model: "sol", thinkingLevel: "high", speed: "standard" } }));
    value(service.importMessage({ id: "opening-work", threadId: "opening", text: "work", state, insertedAt: state === "dispatched" ? 123 : undefined }));
    const pending = service.pending("opening");
    value(await service.start()); await waitFor(() => entered);
    service.suspend(); const handoff = service.detach(); release(); value(await handoff);
    expect(leaseRelease).toHaveBeenCalledTimes(state === "queued" ? 1 : 0);
    const successor = fixture(directory);
    expect(successor.service.pending("opening")).toEqual(pending);
    expect(successor.service.latestSettlement("opening")).toBeNull();
    value(await successor.service.detach());
  });

  it("waits for an opener returning after suspension without disposing unknown native custody", async () => {
    const directory = mkdtempSync(join(tmpdir(), "thread-handoff-opening-")); roots.push(directory);
    let release!: () => void, native: FakePiSession | undefined;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const leaseRelease = vi.fn();
    const service = new ThreadService({ capacity: { mode: "unmanaged" }, databasePath: join(directory, "threads.sqlite"), sessionsDir: join(directory, "sessions"),
      admit: async () => ({ ok: true, value: { release: leaseRelease } }),
      openSession: async (options, output) => {
        native = new FakePiSession(options, output);
        await gate;
        return native;
      } });
    services.push(service); value(await service.start());
    const thread = value(await service.spawn({ requestId: "opening", cwd: directory, message: "work" }));
    await waitFor(() => !!native);
    expect(await service.close()).toMatchObject({ ok: false, error: { code: "conflict" } });
    service.suspend();
    let detached = false;
    const handoff = service.detach().then(result => { detached = true; return result; });
    await turn(); expect(detached).toBe(false);
    release(); value(await handoff);
    expect(native!.commands).toEqual([]);
    expect(native!.closed).toBe(false);
    expect(leaseRelease).toHaveBeenCalledOnce();
    const successor = fixture(directory);
    expect(successor.service.pending(thread.id)).toMatchObject([{ id: "opening", state: "queued", insertedAt: null, landedAt: null }]);
    expect(successor.service.latestSettlement(thread.id)).toBeNull();
    expect(successor.sessions).toHaveLength(0);
  });

  it.each(["preparing", "admitting"])("leaves %s work queued and releases only unassigned admission", async phase => {
    const directory = mkdtempSync(join(tmpdir(), "thread-handoff-hooks-")); roots.push(directory);
    let entered = false, release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const leaseRelease = vi.fn(), openSession = vi.fn();
    const service = new ThreadService({ capacity: { mode: "unmanaged" }, databasePath: join(directory, "threads.sqlite"), sessionsDir: directory, openSession,
      ...(phase === "preparing" ? { prepareMessage: async (_thread, message) => { entered = true; await gate; return { ok: true, value: { text: message.text } }; } } :
        { admit: async () => { entered = true; await gate; return { ok: true, value: { release: leaseRelease } }; } }) });
    services.push(service); value(await service.start());
    const thread = value(await service.spawn({ requestId: "hook", cwd: directory, message: "work" }));
    await waitFor(() => entered);
    service.suspend(); const handoff = service.detach(); release(); value(await handoff);
    expect(openSession).not.toHaveBeenCalled();
    expect(leaseRelease).toHaveBeenCalledTimes(phase === "admitting" ? 1 : 0);
    const successor = fixture(directory);
    expect(successor.service.pending(thread.id)).toMatchObject([{ id: "hook", state: "queued", insertedAt: null, landedAt: null }]);
    expect(successor.service.latestSettlement(thread.id)).toBeNull();
  });

  it("retains busy execution receipts, leases and held/archived input across detach", async () => {
    const directory = mkdtempSync(join(tmpdir(), "thread-handoff-active-")); roots.push(directory);
    const sessions: FakePiSession[] = [], leaseRelease = vi.fn();
    const service = new ThreadService({ capacity: { mode: "unmanaged" }, databasePath: join(directory, "threads.sqlite"), sessionsDir: directory,
      admit: async () => ({ ok: true, value: { release: leaseRelease } }),
      openSession: async (options, output) => { const session = new FakePiSession(options, output); sessions.push(session); return session; } });
    services.push(service);
    for (const id of ["held", "archived"]) {
      value(service.importThread({ id, title: id, cwd: directory, sessionFile: join(directory, `${id}.jsonl`),
        settings: { model: "sol", thinkingLevel: "high", speed: "standard" }, held: true, metadata: id === "archived" ? { archived: true } : {} }));
      value(service.importMessage({ id: `${id}-input`, threadId: id, text: "remain held" }));
    }
    value(await service.start());
    const active = value(await service.spawn({ requestId: "active", cwd: directory, message: "keep working" }));
    await waitFor(() => sessions[0]?.isStreaming === true);
    const pending = service.pending(active.id);
    value(await service.detach());
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.closed).toBe(false);
    expect(sessions[0]!.commands.some(command => command.type === "abort")).toBe(false);
    expect(leaseRelease).not.toHaveBeenCalled();
    const successor = fixture(directory);
    expect(successor.service.pending(active.id)).toEqual(pending);
    expect(successor.service.latestSettlement(active.id)).toBeNull();
    for (const id of ["held", "archived"]) {
      expect(successor.service.get(id)).toMatchObject({ held: true });
      expect(successor.service.pending(id)).toMatchObject([{ id: `${id}-input`, state: "queued" }]);
    }
    expect(successor.service.get("archived")?.metadata?.archived).toBe(true);
    expect(successor.sessions).toHaveLength(0);
    value(await successor.service.detach());
  });

  it.each(["close", "detach"] as const)("keeps failed idle disposal owned so %s can retry it", async operation => {
    const directory = mkdtempSync(join(tmpdir(), "thread-handoff-disposal-")); roots.push(directory);
    let refuses = true, native!: FakePiSession;
    const disposal = vi.fn(async () => { if (refuses) throw new Error("Native disposal refused"); native.closed = true; });
    const service = new ThreadService({ capacity: { mode: "unmanaged" }, databasePath: join(directory, "threads.sqlite"), sessionsDir: directory,
      openSession: async (options, output) => { native = new FakePiSession(options, output); native.close = disposal; return native; } });
    services.push(service);
    const thread = value(service.importThread({ id: "idle", title: "idle", cwd: directory, sessionFile: join(directory, "idle.jsonl"),
      settings: { model: "sol", thinkingLevel: "high", speed: "standard" } }));
    expect(await service.command(thread.id, { type: "get_context" })).toMatchObject({ ok: true });
    expect(await service[operation]()).toMatchObject({ ok: false, error: { message: "Native disposal refused" } });
    refuses = false; value(await service[operation]());
    expect(disposal).toHaveBeenCalledTimes(2);
    expect(native.closed).toBe(true);
  });
});

it("projects phase timestamps to list and reconnect snapshots without stale thinking or tools", async () => {
  const { service, directory, sessions } = fixture();
  value(await service.start());
  const thread = value(await service.spawn({ requestId: "activity", id: "activity", cwd: directory }));
  value(await service.send({ requestId: "work", threadId: thread.id, text: "work" }));
  await waitFor(() => sessions[0]?.commands.some(command => command.type === "prompt") === true);
  const session = sessions[0]!;
  session.emit({ type: "message_update", emittedAt: 10, assistantMessageEvent: { type: "thinking_delta", delta: "reason" } });
  session.emit({ type: "message_update", emittedAt: 20, assistantMessageEvent: { type: "text_delta", delta: "answer" } });
  expect(service.live(thread.id)).toMatchObject({ activity: "responding", isThinking: false, activitySince: 20 });
  expect(service.snapshot().find(row => row.id === thread.id)?.executionActivity).toMatchObject({ activity: "responding", activitySince: 20 });
  const before = value(await service.inspect(thread.id)).live;
  await service.command(thread.id, { type: "get_state" });
  expect(value(await service.inspect(thread.id)).live).toEqual(before);
  session.emit({ type: "tool_execution_start", emittedAt: 30, toolCallId: "tool", toolName: "bash" });
  expect(service.get(thread.id)?.executionActivity).toMatchObject({ activity: "waiting_on_tool", activeTools: ["bash"] });
  session.emit({ type: "message_end", emittedAt: 35, message: { role: "toolResult", content: [] } });
  expect(service.live(thread.id)?.activity).toBe("waiting_on_tool");
  session.emit({ type: "tool_execution_end", emittedAt: 40, toolCallId: "tool" });
  expect(service.live(thread.id)).toMatchObject({ activity: "preparing", activityDetail: "Integrating tool results", isThinking: false, tools: [] });
  session.emit({ type: "message_update", emittedAt: 50, assistantMessageEvent: { type: "toolcall_delta" } });
  expect(value(await service.inspect(thread.id)).live).toMatchObject({ activity: "preparing_tool", lastActivityAt: expect.any(Number) });
  session.settle("done");
  await waitFor(() => service.get(thread.id)?.state === "idle");
  expect(service.get(thread.id)?.executionActivity?.activity).toBeUndefined();
});

it("reports queue, preparation, admission, runtime startup, model wait and cancellation at the owned await boundaries", async () => {
  const directory = mkdtempSync(join(tmpdir(), "thread-phases-")); roots.push(directory);
  const deferred = <T>() => { let resolve!: (value: T) => void; return { promise: new Promise<T>(done => { resolve = done; }), resolve: (value: T) => resolve(value) }; };
  const prepared = deferred<Result<{ text: string; images: unknown[] }>>();
  const admitted = deferred<Result<{ release(): void }>>();
  const opened = deferred<void>();
  const aborted = deferred<void>();
  let session!: FakePiSession;
  const service = new ThreadService({ capacity: { mode: "unmanaged" }, databasePath: join(directory, "threads.sqlite"), sessionsDir: join(directory, "sessions"),
    prepareMessage: () => prepared.promise, admit: () => admitted.promise,
    openSession: async (options, output) => {
      await opened.promise;
      session = new FakePiSession(options, output);
      const command = session.command.bind(session);
      session.command = async input => { if (input.type === "abort") await aborted.promise; await command(input); };
      return session;
    },
  }); services.push(service);
  const thread = value(await service.spawn({ requestId: "phase-thread", id: "phase-thread", cwd: directory }));
  value(await service.send({ requestId: "phase-work", threadId: thread.id, text: "work" }));
  expect(service.get(thread.id)?.executionActivity?.activity).toBe("queued");
  value(await service.start());
  await waitFor(() => service.get(thread.id)?.executionActivity?.activity === "preparing");
  prepared.resolve({ ok: true, value: { text: "work", images: [] } });
  await waitFor(() => service.get(thread.id)?.executionActivity?.activity === "admitting");
  const admissionClock = service.get(thread.id)?.executionActivity?.activitySince;
  expect(service.get(thread.id)?.executionActivity?.activitySince).toBe(admissionClock);
  admitted.resolve({ ok: true, value: { release() {} } });
  await waitFor(() => service.get(thread.id)?.executionActivity?.activity === "starting");
  opened.resolve();
  await waitFor(() => !!session?.commands.some(command => command.type === "prompt"));
  expect(service.get(thread.id)?.executionActivity?.activity).toBe("preparing");
  session.emit({ type: "model_request_start", emittedAt: Date.now() });
  const waiting = service.get(thread.id)?.executionActivity;
  session.emit({ type: "message_start", message: { role: "assistant" } });
  await service.command(thread.id, { type: "get_state" });
  expect(service.get(thread.id)?.executionActivity).toEqual(waiting);
  const stopping = service.control({ threadId: thread.id, action: "stop", descendants: false });
  await waitFor(() => service.get(thread.id)?.executionActivity?.activity === "cancelling");
  expect(service.get(thread.id)?.state).toBe("running");
  aborted.resolve();
  expect(value(await stopping)).toMatchObject({ state: "idle", held: false, metadata: { archived: true } });
});

it("the thread's own agent names it with thread_title; a person's rename pins it across restarts", async () => {
  const { service, directory, sessions } = fixture();
  value(await service.start());
  const thread = value(await service.spawn({ requestId: "rename-self", cwd: directory, message: "Work" }));
  await waitFor(() => sessions.length === 1 && sessions[0]!.isStreaming);
  const tools = threadTools({ threadId: thread.id, cwd: directory, sessionFile: thread.sessionFile, args: [], env: {}, threads: service });
  expect(tools.find(item => item.name === "thread_control")!.parameters.anyOf.some((variant: { properties: { action: { const?: string } } }) => variant.properties.action.const === "rename")).toBe(false);
  const title = tools.find(item => item.name === "thread_title")!;
  const first = await title.execute("title-1", { title: "  First topic  " }, undefined, undefined, undefined as never);
  expect(first.details).toMatchObject({ ok: true, value: { id: thread.id, title: "First topic", metadata: { titleSource: "agent" } } });
  await waitFor(() => sessions[0]!.commands.some(command => command.type === "set_session_name" && command.name === "First topic"));
  expect((await title.execute("title-2", { title: "Changed topic" }, undefined, undefined, undefined as never)).details).toMatchObject({ ok: true, value: { title: "Changed topic" } });
  value(await service.control({ threadId: thread.id, action: "rename", title: "My chosen title" }));
  const pinned = await title.execute("title-3", { title: "Agent override" }, undefined, undefined, undefined as never);
  expect(pinned.details).toMatchObject({ ok: false, error: { code: "conflict" } });
  expect(service.get(thread.id)).toMatchObject({ title: "My chosen title", metadata: { titleSource: "manual" } });
  expect(await service.control({ threadId: thread.id, action: "title", title: " " })).toMatchObject({ ok: false, error: { code: "invalid_request" } });
  expect(service.update(thread.id, { metadata: { titleSource: "agent" } })).toMatchObject({ ok: false, error: { code: "conflict" } });
  sessions[0]!.settle("Done");
  await waitFor(() => service.get(thread.id)?.state === "idle");
  await service.close();
  const restored = fixture(directory).service;
  value(await restored.start());
  expect(await restored.control({ threadId: thread.id, action: "title", title: "After restart" })).toMatchObject({ ok: false, error: { code: "conflict" } });
  expect(value(await restored.control({ threadId: thread.id, action: "rename", title: "Next chosen title" })).title).toBe("Next chosen title");
});

it("a person accepting the agent's title through update pins it", async () => {
  const { service, directory } = fixture();
  const thread = value(await service.spawn({ requestId: "rename-human", cwd: directory }));
  value(await service.control({ threadId: thread.id, action: "title", title: "Agent topic" }));
  expect(value(await service.control({ threadId: thread.id, action: "update", title: "Agent topic" })).metadata?.titleSource).toBe("manual");
  expect(await service.control({ threadId: thread.id, action: "title", title: "New agent topic" })).toMatchObject({ ok: false, error: { code: "conflict" } });
});

it.each(["yes", "no", "dismiss"])("records a root consent %s without dispatch and retains its visible receipt across restart", async choice => {
  const { service, directory, sessions } = fixture();
  value(await service.start());
  const thread = value(await service.spawn({ requestId: "inbox", id: "inbox", cwd: directory, metadata: { rootConsent: true } }));
  const questionId = value(await service.ask({ requestId: "consent:fixture:question", threadId: thread.id,
    questions: [{ question: "May I share the meeting time?", suggestions: ["Yes, for this request", "No"] }] })).questionIds[0]!;
  const answer = { threadId: thread.id, questionId, selectedSuggestionIds: choice === "dismiss" ? [] : [`${questionId}:${choice === "yes" ? 0 : 1}`],
    text: choice === "yes" ? "Only the time." : "", ...(choice === "dismiss" ? { dismissed: true } : {}) };
  const receipt = value(await service.answer(answer));
  service.reconcile(); await turn(); await turn();
  expect(sessions).toHaveLength(0);
  expect(service.pending(thread.id)).toEqual([]);
  expect(service.get(thread.id)).toMatchObject({ state: "idle", held: false, pendingMessages: 0 });
  const state = value(await service.questionState(thread.id, questionId));
  expect(state.answer).toMatchObject({ text: answer.text, dismissed: choice === "dismiss", acceptedAt: expect.any(Number) });
  const history = value(await service.read({ threadId: thread.id })).entries;
  expect(history).toMatchObject([{ id: `question-answer:${questionId}`, source: "question-receipt", message: { role: "user", questionId, rootConsent: true } }]);
  if (choice === "dismiss") expect(JSON.stringify(history)).toContain("without selecting or authorizing any suggestion");
  expect(value(await service.read({ threadId: thread.id, entryId: `question-answer:${questionId}` })).entries).toEqual(history);
  const context = value(await service.inspect(thread.id)).context!;
  const messages = context.messages as Record<string, any>[];
  expect(messages).toHaveLength(1);
  expect(service.projectQuestionAnswers(thread.id, messages)).toEqual(messages);
  const conversation = [{ role: "user", timestamp: state.answer!.acceptedAt - 1, content: "Before" }, { role: "user", timestamp: state.answer!.acceptedAt + 1, content: "After" }];
  expect(service.projectQuestionAnswers(thread.id, conversation)).toEqual([conversation[0], messages[0], conversation[1]]);
  expect(conversation).toHaveLength(2);
  await service.close();
  const restored = fixture(directory);
  value(await restored.service.start());
  expect(value(await restored.service.answer(answer))).toEqual(receipt);
  expect(value(await restored.service.questionState(thread.id, questionId))).toEqual(state);
  expect(value(await restored.service.read({ threadId: thread.id })).entries).toEqual(history);
  expect(await restored.service.answer({ ...answer, selectedSuggestionIds: [], dismissed: false, text: "Changed" })).toMatchObject({ ok: false, error: { code: "conflict" } });
  restored.service.reconcile(); await turn(); await turn();
  expect(restored.sessions).toHaveLength(0);
  expect(value(await restored.service.questions(thread.id))).toEqual([]);
});

it("does not project historical consent answers already owned by native message delivery", async () => {
  const { service, directory } = fixture();
  const thread = value(await service.spawn({ requestId: "inbox", id: "inbox", cwd: directory, metadata: { rootConsent: true } }));
  const oldQuestion = value(await service.ask({ requestId: "consent:previous:question", threadId: thread.id, questions: [{ question: "Share the time?" }] })).questionIds[0]!;
  value(await service.answer({ threadId: thread.id, questionId: oldQuestion, selectedSuggestionIds: [], text: "Only the time." }));
  const oldState = value(await service.questionState(thread.id, oldQuestion));
  const oldText = `Answer to question ${oldQuestion}: Share the time?\nOnly the time.`;
  value(service.importMessage({ id: `question-answer:${oldQuestion}`, threadId: thread.id, replyTo: oldQuestion,
    text: oldText, state: "done", insertedAt: oldState.answer!.acceptedAt, outcome: "complete" }));
  const nativeMessage = { role: "user", timestamp: oldState.answer!.acceptedAt, content: [{ type: "text", text: oldText }] };
  const nativeEntry = { type: "message", id: "native-old-answer", parentId: null, timestamp: new Date(nativeMessage.timestamp).toISOString(), message: nativeMessage };
  writeFileSync(thread.sessionFile, JSON.stringify(nativeEntry) + "\n");
  const nextQuestion = value(await service.ask({ requestId: "consent:next:question", threadId: thread.id, questions: [{ question: "Share the location?" }] })).questionIds[0]!;
  value(await service.answer({ threadId: thread.id, questionId: nextQuestion, selectedSuggestionIds: [], text: "No location." }));
  const history = value(await service.read({ threadId: thread.id })).entries;
  expect(history).toHaveLength(2);
  expect(history[0]).toEqual(nativeEntry);
  expect(history[1]).toMatchObject({ id: `question-answer:${nextQuestion}`, source: "question-receipt" });
  expect(service.projectQuestionAnswers(thread.id, [nativeMessage])).toMatchObject([nativeMessage, { questionId: nextQuestion }]);
  expect((value(await service.inspect(thread.id)).context!.messages as Record<string, unknown>[])).toHaveLength(2);
  expect(value(await service.questionState(thread.id, oldQuestion))).toEqual(oldState);
  await service.close();
  const restored = fixture(directory);
  expect(value(await restored.service.read({ threadId: thread.id })).entries).toEqual(history);
});

it("keeps ordinary inbox conversation and async questions working without steering root answers into their run", async () => {
  const { service, directory, sessions } = fixture();
  value(await service.start());
  const thread = value(await service.spawn({ requestId: "inbox", id: "inbox", cwd: directory, metadata: { rootConsent: true } }));
  const rootQuestion = value(await service.ask({ requestId: "consent:fixture:question", threadId: thread.id, questions: [{ question: "Share the time?" }] })).questionIds[0]!;
  value(await service.send({ requestId: "conversation", threadId: thread.id, text: "Ordinary conversation" }));
  await waitFor(() => sessions[0]?.commands.some(command => command.type === "prompt") === true);
  const inputs = () => sessions.flatMap(session => session.commands.filter(command => ["prompt", "steer", "follow_up"].includes(command.type)));
  expect(inputs()).toHaveLength(1);
  value(await service.answer({ threadId: thread.id, questionId: rootQuestion, selectedSuggestionIds: [], text: "Only the time." }));
  service.reconcile(); await turn(); await turn();
  expect(sessions).toHaveLength(1);
  expect(inputs()).toHaveLength(1);
  const ordinaryQuestion = value(await service.ask({ requestId: "ordinary-question", threadId: thread.id, questions: [{ question: "What next?" }] })).questionIds[0]!;
  value(await service.answer({ threadId: thread.id, questionId: ordinaryQuestion, selectedSuggestionIds: [], text: "Continue." }));
  await waitFor(() => inputs().length === 2);
  expect(inputs()[1]).toMatchObject({ workId: `question-answer:${ordinaryQuestion}`, message: expect.stringContaining("Continue.") });
  expect(service.pending(thread.id).map(message => message.id)).not.toContain(`question-answer:${rootQuestion}`);
  expect(value(await service.inspect(thread.id)).context?.messages).toContainEqual(expect.objectContaining({ questionId: rootQuestion, rootConsent: true }));
  const read = threadTools({ threadId: thread.id, cwd: directory, sessionFile: thread.sessionFile, args: [], env: {}, threads: service }).find(tool => tool.name === "thread_read")!;
  const recalled = await read.execute("own-permission", { threadId: thread.id }, new AbortController().signal, () => {}, {} as never);
  expect(JSON.stringify(recalled)).toContain("Only the time.");
  expect(JSON.stringify(recalled)).toContain(`question-answer:${rootQuestion}`);
  expect(inputs()).toHaveLength(2);
});

it("does not release held or archived inbox work when a root consent answer is recorded", async () => {
  const { service, directory, sessions } = fixture();
  value(await service.spawn({ requestId: "inbox", id: "inbox", cwd: directory, metadata: { rootConsent: true } }));
  const questionId = value(await service.ask({ requestId: "consent:fixture:question", threadId: "inbox", questions: [{ question: "Share?" }] })).questionIds[0]!;
  value(await service.send({ requestId: "held", threadId: "inbox", text: "Unrelated work" }));
  value(await service.control({ threadId: "inbox", action: "stop", descendants: false }));
  value(await service.control({ threadId: "inbox", action: "update", archived: true }));
  value(await service.start());
  value(await service.answer({ threadId: "inbox", questionId, selectedSuggestionIds: [], text: "No" }));
  service.reconcile(); await turn(); await turn();
  expect(sessions).toHaveLength(0);
  expect(service.get("inbox")).toMatchObject({ held: false, state: "idle", metadata: { archived: true } });
  expect(service.pending("inbox").map(message => message.id)).toEqual([]);
});

it("rejects nonexistent built-in models before creating a thread or saving settings", async () => {
  const { service, directory, sessions } = fixture();
  const settings = { model: "openai-codex/missing-model" };
  expect(await service.spawn({ requestId: "invalid", cwd: directory, message: "assignment", settings })).toMatchObject({ ok: false, error: { code: "invalid_request" } });
  expect(service.snapshot()).toEqual([]);
  const thread = value(await service.spawn({ requestId: "invalid", cwd: directory, settings: { model: "sol" } }));
  expect(await service.control({ threadId: thread.id, action: "settings", settings })).toMatchObject({ ok: false, error: { code: "invalid_request" } });
  expect(service.get(thread.id)!.settings.model).toBe("openai-codex/gpt-6.1-sol");
  expect(sessions).toEqual([]);
});

it("repairs only invalid undispatched model snapshots and retains their provenance without resuming", async () => {
  const { service, directory } = fixture();
  const thread = value(await service.spawn({ requestId: "initial", cwd: directory, message: "bad model", settings: { model: "sol", thinkingLevel: "low", speed: "priority" } }));
  value(await service.send({ requestId: "valid", threadId: thread.id, text: "valid selection" }));
  const db = new DatabaseSync(join(directory, "threads.sqlite"));
  try {
    // A retained historical hold is not a new close request.
    db.prepare("UPDATE thread SET held=1,state='idle' WHERE id=?").run(thread.id);
    db.prepare("UPDATE thread_work SET settings=json_set(settings,'$.model','openai-codex/missing-model') WHERE id='initial'").run();
    const pending = service.pending(thread.id);
    const repaired = value(await service.control({ threadId: thread.id, action: "settings", settings: { model: "astra" } }));
    expect(repaired).toMatchObject({ state: "idle", held: true });
    expect(service.pending(thread.id)).toEqual(pending);
    const settings = (id: string) => JSON.parse((db.prepare("SELECT settings FROM thread_work WHERE id=?").get(id) as { settings: string }).settings);
    expect(settings("initial")).toEqual({ model: "openai-codex/gpt-6-astra", thinkingLevel: "low", speed: "priority" });
    expect(settings("valid").model).toBe("openai-codex/gpt-6.1-sol");
    expect(repaired.metadata?.modelSettingsRepairs).toEqual([{ workId: "initial", previousModel: "openai-codex/missing-model", model: "openai-codex/gpt-6-astra", time: expect.any(Number) }]);
    const repeated = value(await service.control({ threadId: thread.id, action: "settings", settings: { model: "astra" } }));
    expect(repeated.metadata?.modelSettingsRepairs).toEqual(repaired.metadata?.modelSettingsRepairs);
  } finally { db.close(); }
});

it.each([
  [false, "Error: Model not found: private/removed-model"],
  [true, "Error: Model not found: private/removed-model"],
  [false, "Error: Pi cwd admission rejected thread.cwd: cwd_unavailable: Session cwd cannot be opened"],
  [true, "Error: Pi cwd admission rejected thread.cwd: cwd_unavailable: Session cwd cannot be opened"],
])("settles permanent startup failure once and informs parent across restart, recovering=%s error=%s", async (recovering, error) => {
  const directory = mkdtempSync(join(tmpdir(), "thread-startup-failure-")); roots.push(directory);
  const openSession = vi.fn<OpenPiSession>(async (_options, output) => {
    output({ type: "runner_attached", control: "control.sock", socketPath: "session.sock" });
    throw new Error(error);
  });
  const attachSession = vi.fn(async () => null);
  const release = vi.fn();
  const service = new ThreadService({ capacity: { mode: "unmanaged" }, databasePath: join(directory, "threads.sqlite"), sessionsDir: directory, openSession, attachSession, admit: async () => ({ ok: true, value: { release } }) }); services.push(service);
  const parent = value(service.importThread({ id: "requester", title: "Requester", cwd: directory, sessionFile: join(directory, "requester.jsonl"), held: true,
    settings: { model: "sol", thinkingLevel: "high", speed: "standard" } }));
  value(service.importThread({ id: "child", parentId: parent.id, title: "Child", cwd: directory, sessionFile: join(directory, "child.jsonl"), settings: { model: "private/removed-model", thinkingLevel: "high", speed: "standard" } }));
  value(service.importMessage({ id: "assignment", threadId: "child", senderId: parent.id, text: "first", state: recovering ? "dispatched" : "queued", ...(recovering ? { executionId: "retained-execution" } : {}) }));
  value(service.importMessage({ id: "later", threadId: "child", text: "second", state: "queued" }));
  attachSession.mockClear();
  await service.start();
  await waitFor(() => service.get("child")?.state === "idle" && service.get("child")?.held === true && service.get("child")?.metadata?.executionError === error);
  expect(openSession).toHaveBeenCalledTimes(1);
  expect(attachSession).toHaveBeenCalledTimes(1);
  expect(release).toHaveBeenCalledTimes(1);
  expect(service.pending("child")).toMatchObject([{ id: "later", state: "queued" }]);
  expect(service.latestSettlement("child")).toMatchObject({ outcome: "failed", workId: "assignment", finalMessage: null });
  expect(value(await service.await({ parentId: parent.id, threadIds: ["child"], timeoutMs: 0 })).settlement)
    .toEqual(service.latestSettlement("child"));
  const notification = service.pending(parent.id)[0];
  expect(JSON.parse(notification.text)).toEqual({ type: "thread_idle", title: "Child", outcome: "failed", finalText: null, error });
  expect(notification).toMatchObject({ senderId: "child", threadId: parent.id, replyTo: "assignment" });
  service.reconcile(); await turn();
  expect(openSession).toHaveBeenCalledTimes(1);
  await service.close();
  const restored = new ThreadService({ capacity: { mode: "unmanaged" }, databasePath: join(directory, "threads.sqlite"), sessionsDir: directory, openSession, attachSession }); services.push(restored);
  await restored.start(); await turn();
  expect(openSession).toHaveBeenCalledTimes(1);
  expect(restored.get("child")).toMatchObject({ state: "idle", held: true, metadata: { executionError: error } });
  expect(restored.pending(parent.id)).toEqual([notification]);
});

it("does not invent a failed settlement when retained runner absence is uncertain", async () => {
  const directory = mkdtempSync(join(tmpdir(), "thread-startup-uncertain-")); roots.push(directory);
  const openSession: OpenPiSession = async () => { throw new Error("Pi cwd admission rejected thread.cwd: cwd_unavailable"); };
  const attachSession = vi.fn(async () => { throw new Error("runner status timed out"); });
  const service = new ThreadService({ capacity: { mode: "unmanaged" }, databasePath: join(directory, "threads.sqlite"), sessionsDir: directory, openSession, attachSession }); services.push(service);
  value(service.importThread({ id: "child", title: "Child", cwd: directory, sessionFile: join(directory, "child.jsonl"), settings: { model: "astra", thinkingLevel: "high", speed: "standard" }, metadata: { runnerReference: { control: "control.sock", socketPath: "session.sock" } } }));
  value(service.importMessage({ id: "assignment", threadId: "child", text: "work", state: "dispatched", executionId: "retained" }));
  await service.start();
  await waitFor(() => service.get("child")?.metadata?.executionError === "runner status timed out");
  expect(service.get("child")).toMatchObject({ held: true, state: "running" });
  expect(service.latestSettlement("child")).toBeNull();
  expect(service.pending("child")).toMatchObject([{ id: "assignment", state: "dispatched" }]);
});

it.each([false, true])("retains runner-capacity custody beyond three refusals and restart, recovering=%s", async (recovering) => {
  const directory = mkdtempSync(join(tmpdir(), "thread-runner-capacity-")); roots.push(directory);
  const sessions: FakePiSession[] = [];
  let available = false;
  const release = vi.fn();
  const admit = vi.fn(async () => ({ ok: true as const, value: { release } }));
  const openSession = vi.fn<OpenPiSession>(async (options, output) => {
    if (!available) throw new Error("Error: Runner capacity busy; work remains queued");
    const session = new FakePiSession(options, output); sessions.push(session); return session;
  });
  const options = { databasePath: join(directory, "threads.sqlite"), sessionsDir: directory, openSession, admit };
  const first = new ThreadService({ ...options, capacity: { mode: "unmanaged" } }); services.push(first);
  value(first.importThread({ id: "capacity-child", title: "Child", cwd: directory, sessionFile: join(directory, "child.jsonl"), settings: { model: "astra", thinkingLevel: "high", speed: "standard" } }));
  value(await first.agentWait({ requestId: "wait", threadId: "capacity-child", action: "set", kind: "deployment", publicationId: "publication-fixture", reason: "Awaiting delegated release" }));
  value(first.importMessage({ id: "assignment", threadId: "capacity-child", text: "Unrelated result", source: "notification", state: recovering ? "dispatched" : "queued", ...(recovering ? { executionId: "retained-execution" } : {}) }));
  const schedule = value(await first.wakeSchedule({ requestId: "wake", threadId: "capacity-child", action: "set", reason: "Fallback", cadenceMs: 600_000 }));
  await first.start();
  await waitFor(() => (first.get("capacity-child")?.metadata?.startupFailure as { attempts: number })?.attempts === 1);
  first.reconcile(); first.reconcile(); await turn();
  expect(openSession).toHaveBeenCalledTimes(1);
  await first.close();
  const second = new ThreadService({ ...options, capacity: { mode: "unmanaged" } }); services.push(second);
  await second.start(); await turn();
  expect(openSession).toHaveBeenCalledTimes(1);
  const db = new DatabaseSync(options.databasePath);
  try {
    for (const attempts of [2, 3, 4]) {
      db.prepare("UPDATE thread SET metadata=json_set(metadata,'$.startupFailure.retryAt',0) WHERE id='capacity-child'").run();
      second.reconcile(); second.reconcile();
      await waitFor(() => (second.get("capacity-child")?.metadata?.startupFailure as { attempts: number })?.attempts === attempts);
      expect(second.get("capacity-child")).toMatchObject({ held: false });
      expect(second.latestSettlement("capacity-child")).toBeNull();
      expect(second.get("capacity-child")?.metadata?.agentWait).toMatchObject({ reason: "Awaiting delegated release" });
      expect(second.get("capacity-child")?.wakeSchedule).toEqual(schedule);
      expect(second.pending("capacity-child")).toMatchObject([{ id: "assignment", state: recovering ? "dispatched" : "queued" }]);
    }
    expect(release).toHaveBeenCalledTimes(4);
    expect(admit).toHaveBeenCalledTimes(4);
    available = true;
    db.prepare("UPDATE thread SET metadata=json_set(metadata,'$.startupFailure.retryAt',0) WHERE id='capacity-child'").run();
    second.reconcile(); second.reconcile();
    await waitFor(() => sessions.length === 1 && sessions[0]!.commands.some(c => c.type === "prompt"));
    expect(openSession).toHaveBeenCalledTimes(5);
    expect(admit).toHaveBeenCalledTimes(5);
    expect(release).toHaveBeenCalledTimes(4);
    expect(sessions[0]!.commands.filter(c => c.type === "prompt")).toMatchObject([{ workId: "assignment" }]);
    expect(second.get("capacity-child")?.metadata?.startupFailure).toBeUndefined();
    sessions[0]!.settle("done");
    await waitFor(() => second.latestSettlement("capacity-child")?.outcome === "complete");
    expect(second.latestSettlement("capacity-child")).toMatchObject({ workId: "assignment", ...(recovering ? { executionId: "retained-execution" } : {}) });
  } finally { db.close(); }
});

it.each((["stop", "archive"] as const).flatMap(action => ["Runner capacity busy: memory pressure", "No eligible pooled account for anthropic/claude-opus-5-5."].map(error => ({ action, error }))))("never auto-resumes an explicit $action during backpressure: $error", async ({ action, error }) => {
  const directory = mkdtempSync(join(tmpdir(), "thread-capacity-stop-")); roots.push(directory);
  const openSession = vi.fn<OpenPiSession>(async () => { throw new Error(error); });
  const options = { databasePath: join(directory, "threads.sqlite"), sessionsDir: directory, openSession };
  const first = new ThreadService({ ...options, capacity: { mode: "unmanaged" } }); services.push(first);
  const thread = value(await first.spawn({ requestId: "assignment", cwd: directory, message: "work" }));
  await first.start();
  await waitFor(() => first.get(thread.id)?.metadata?.startupFailure !== undefined || first.get(thread.id)?.metadata?.admissionWait !== undefined);
  value(await first.control(action === "archive" ? { threadId: thread.id, action: "update", archived: true } : { threadId: thread.id, action: "stop", descendants: false }));
  await first.close();
  const second = new ThreadService({ ...options, capacity: { mode: "unmanaged" } }); services.push(second);
  await second.start(); second.reconcile(); await turn();
  expect(openSession).toHaveBeenCalledTimes(1);
  expect(second.get(thread.id)).toMatchObject({ held: false, pendingMessages: 0, metadata: { archived: true } });
});

it("persists a bounded startup retry budget across owner restart", async () => {
  const directory = mkdtempSync(join(tmpdir(), "thread-startup-retry-")); roots.push(directory);
  const openSession = vi.fn<OpenPiSession>(async () => { throw new Error("temporary runner failure"); });
  const options = { databasePath: join(directory, "threads.sqlite"), sessionsDir: directory, openSession };
  const first = new ThreadService({ ...options, capacity: { mode: "unmanaged" } }); services.push(first);
  const thread = value(await first.spawn({ requestId: "assignment", cwd: directory, message: "work" }));
  await first.start();
  await waitFor(() => (first.get(thread.id)?.metadata?.startupFailure as { attempts: number })?.attempts === 1);
  first.reconcile(); await turn();
  expect(openSession).toHaveBeenCalledTimes(1);
  await first.close();
  const second = new ThreadService({ ...options, capacity: { mode: "unmanaged" } }); services.push(second);
  await second.start(); await turn();
  expect(openSession).toHaveBeenCalledTimes(1);
  const db = new DatabaseSync(options.databasePath);
  try {
    for (const attempts of [2, 3]) {
      db.prepare("UPDATE thread SET metadata=json_set(metadata,'$.startupFailure.retryAt',0) WHERE id=?").run(thread.id);
      second.reconcile();
      await waitFor(() => (second.get(thread.id)?.metadata?.startupFailure as { attempts: number })?.attempts === attempts);
      await turn();
    }
    await waitFor(() => second.get(thread.id)?.held === true);
    expect(openSession).toHaveBeenCalledTimes(3);
    expect(second.latestSettlement(thread.id)).toMatchObject({ outcome: "failed", workId: "assignment" });
    second.reconcile(); await turn();
    expect(openSession).toHaveBeenCalledTimes(3);
  } finally { db.close(); }
});

it("stops even when the in-flight opening rejects", async () => {
  const directory = mkdtempSync(join(tmpdir(), "thread-stop-opening-")); roots.push(directory);
  let rejectOpen!: (error: Error) => void;
  const openSession = vi.fn<OpenPiSession>(() => new Promise((_resolve, reject) => { rejectOpen = reject; }));
  const attachSession = vi.fn(async () => null);
  const service = new ThreadService({ capacity: { mode: "unmanaged" }, databasePath: join(directory, "threads.sqlite"), sessionsDir: directory, openSession, attachSession }); services.push(service);
  const thread = value(await service.spawn({ requestId: "assignment", cwd: directory, message: "work" }));
  await service.start(); await waitFor(() => !!rejectOpen);
  const stopped = service.control({ threadId: thread.id, action: "stop", descendants: false });
  await turn();
  rejectOpen(new Error("Pi cwd admission rejected thread.cwd: cwd_unavailable"));
  expect(value(await stopped)).toMatchObject({ held: false, state: "idle", metadata: { archived: true } });
  expect(attachSession).toHaveBeenCalledTimes(1);
  expect(service.pending(thread.id)).toEqual([]);
  expect(service.latestSettlement(thread.id)).toBeNull();
});

it("records why a capacity refusal is waiting, keeps the work queued, and clears the reason once admitted", async () => {
  const directory = mkdtempSync(join(tmpdir(), "thread-admission-wait-")); roots.push(directory);
  const sessions: FakePiSession[] = [];
  const openSession: OpenPiSession = async (options, output) => { const session = new FakePiSession(options, output); sessions.push(session); return session; };
  const refusal = "openai-codex-8: weekly quota exhausted; openai-codex-11: cooling until 19:44";
  let admitted = false;
  const service = new ThreadService({ capacity: { mode: "unmanaged" }, databasePath: join(directory, "threads.sqlite"), sessionsDir: directory, openSession,
    admit: async () => admitted ? { ok: true, value: { release() {} } } : { ok: false, error: { code: "unavailable", message: refusal } } });
  services.push(service);
  await service.start();
  const thread = value(await service.spawn({ requestId: "waiting", cwd: directory, message: "work" }));
  await waitFor(() => service.get(thread.id)?.metadata?.admissionWait !== undefined);
  const wait = service.get(thread.id)!.metadata!.admissionWait as Record<string, unknown>;
  expect(wait).toMatchObject({ code: "unavailable", message: refusal });
  expect(wait.since).toEqual(expect.any(Number));
  expect(sessions).toHaveLength(0);
  expect(service.pending(thread.id)).toMatchObject([{ state: "queued" }]);

  const revision = service.get(thread.id)!.revision;
  service.reconcile(); await turn(); service.reconcile(); await turn();
  expect(service.get(thread.id)!.revision).toBe(revision);
  expect((service.get(thread.id)!.metadata!.admissionWait as Record<string, unknown>).since).toBe(wait.since);

  admitted = true;
  service.reconcile();
  await waitFor(() => sessions.length === 1);
  expect(service.get(thread.id)?.metadata?.admissionWait).toBeUndefined();
});

it("keeps provider-exhausted accepted work unsettled across restart and resumes the same work after capacity recovery",async()=>{
  const directory=mkdtempSync(join(tmpdir(),"thread-provider-wait-"));roots.push(directory);
  const sessions:FakePiSession[]=[],release=vi.fn();
  let available=true;
  const admit=vi.fn(async(..._args:unknown[])=>available?{ok:true as const,value:{release}}:{ok:false as const,error:{code:"unavailable" as const,message:"anthropic-2: cooling until reset"}});
  const openSession:OpenPiSession=async(options,output)=>{
    const session=new FakePiSession(options,output);
    if(sessions.length){session.acceptedWorkIds.add("accepted");session.completedWorkIds.add("accepted");session.lastAssistantMessage={role:"assistant",stopReason:"error",errorMessage:"429 account rate limit"};}
    sessions.push(session);return session;
  };
  const options={databasePath:join(directory,"threads.sqlite"),sessionsDir:directory,openSession,admit};
  const service=new ThreadService({ ...options, capacity: { mode: "unmanaged" } });services.push(service);
  value(service.importThread({id:"child",parentId:"parent",title:"child",cwd:directory,sessionFile:join(directory,"child.jsonl"),settings:{model:"anthropic/claude-opus-5-5",thinkingLevel:"high",speed:"standard"}}));
  value(service.importMessage({id:"accepted",threadId:"child",text:"finish the real work"}));
  await service.start();await waitFor(()=>sessions[0]?.isStreaming===true);
  available=false;
  sessions[0]!.settleMessage({role:"assistant",stopReason:"error",errorMessage:"429 account rate limit"});
  await waitFor(()=>sessions[0]!.closed&&service.get("child")?.metadata?.providerWait!==undefined);
  expect(release).toHaveBeenCalledOnce();
  expect(service.latestSettlement("child")).toBeNull();
  expect(service.pending("child")).toMatchObject([{id:"accepted",state:"dispatched"}]);
  expect(await service.command("child",{type:"get_state"})).toMatchObject({ok:true,value:{source:"thread-owner",isStreaming:false,threadState:"running",pendingWorkCount:1,providerWait:{workId:"accepted"}}});
  expect(sessions).toHaveLength(1);
  const db=new DatabaseSync(options.databasePath);
  const executionId=db.prepare("SELECT id FROM thread_execution WHERE ended_at IS NULL").get()!.id;
  expect(db.prepare("SELECT id FROM thread_work WHERE source='notification'").all()).toEqual([]);db.close();
  service.reconcile();await turn();expect(sessions).toHaveLength(1);
  value(await service.detach());
  const reopened=new ThreadService({ ...options, capacity: { mode: "unmanaged" } });services.push(reopened);await reopened.start();await turn();
  expect(sessions).toHaveLength(1);
  expect(reopened.get("child")?.metadata?.providerWait).toBeDefined();
  available=true;reopened.reconcile();await waitFor(()=>sessions[1]?.isStreaming===true);
  expect(sessions[1]!.commands.find(command=>command.type==="prompt")).toMatchObject({workId:"accepted",resume:true,resumeProviderWait:true});
  expect(sessions[1]!.options.args).toEqual(expect.arrayContaining(["anthropic","claude-opus-5-5","high"]));
  expect(reopened.get("child")?.metadata?.providerWait).toBeUndefined();
  sessions[1]!.settle("artifact delivered");await waitFor(()=>reopened.latestSettlement("child")!==null);
  expect(reopened.latestSettlement("child")).toMatchObject({executionId,workId:"accepted",outcome:"complete"});
  expect(admit.mock.calls.at(-1)?.[2]).toBe(false);
  expect(admit.mock.calls.at(-1)?.[3]).toBe(executionId);
});

it("re-admits accepted work at once when one Codex account's plan refuses the model, instead of failing the thread",async()=>{
  const directory=mkdtempSync(join(tmpdir(),"thread-model-refusal-"));roots.push(directory);
  const sessions:FakePiSession[]=[];
  const refusal="Codex error: The 'gpt-6.1-sol' model is not supported when using Codex with a ChatGPT account.";
  const admit=vi.fn(async(..._args:unknown[])=>({ok:true as const,value:{release(){},env:{PI_ORCHESTRATOR_ACCOUNT_ID:`openai-codex-${admit.mock.calls.length}`}}}));
  const openSession:OpenPiSession=async(options,output)=>{
    const session=new FakePiSession(options,output);
    if(sessions.length){session.acceptedWorkIds.add("accepted");session.completedWorkIds.add("accepted");session.lastAssistantMessage={role:"assistant",stopReason:"error",errorMessage:refusal};}
    sessions.push(session);return session;
  };
  const service=new ThreadService({databasePath:join(directory,"threads.sqlite"),sessionsDir:directory,openSession,admit,capacity:{mode:"unmanaged"}});services.push(service);
  value(service.importThread({id:"sol",parentId:"parent",title:"sol",cwd:directory,sessionFile:join(directory,"sol.jsonl"),settings:{model:"openai-codex/gpt-6.1-sol",thinkingLevel:"high",speed:"standard"}}));
  value(service.importMessage({id:"accepted",threadId:"sol",text:"finish the real work"}));
  await service.start();await waitFor(()=>sessions[0]?.isStreaming===true);
  sessions[0]!.settleMessage({role:"assistant",stopReason:"error",errorMessage:refusal});
  // The refusing account is already excluded, so the zero-length provider wait re-admits immediately.
  await waitFor(()=>sessions[0]!.closed&&sessions[1]?.isStreaming===true);
  expect(service.get("sol")?.metadata?.providerRetry).toMatchObject({attempts:1});
  expect(service.latestSettlement("sol")).toBeNull();
  expect(sessions[1]!.commands.find(command=>command.type==="prompt")).toMatchObject({workId:"accepted",resume:true,resumeProviderWait:true});
  expect(admit).toHaveBeenCalledTimes(2);
  expect(admit.mock.calls[1]?.[2]).toBe(false);
  sessions[1]!.settle("artifact delivered");await waitFor(()=>service.latestSettlement("sol")!==null);
  expect(service.latestSettlement("sol")).toMatchObject({workId:"accepted",outcome:"complete"});
});

it.each([
  ["stop", undefined, "complete"],
  ["aborted", undefined, "cancelled"],
  ["error", "400 invalid request", "failed"],
])("reconciles a native terminal %s after a crash with stale provider waiting without replay", async (stopReason, errorMessage, outcome) => {
  const directory = mkdtempSync(join(tmpdir(), "thread-provider-terminal-crash-")); roots.push(directory);
  const sessions: FakePiSession[] = [];
  const finalMessage = { role: "assistant", content: [{ type: "text", text: "durable native result" }], stopReason, ...(errorMessage ? { errorMessage } : {}) };
  const service = new ThreadService({ capacity: { mode: "unmanaged" }, databasePath: join(directory, "threads.sqlite"), sessionsDir: directory,
    admit: async () => ({ ok: true, value: { release() {} } }),
    openSession: async (options, output) => {
      const session = new FakePiSession(options, output);
      session.acceptedWorkIds.add("accepted-crash");
      session.completedWorkIds.add("accepted-crash");
      session.lastAssistantMessage = finalMessage;
      sessions.push(session); return session;
    } }); services.push(service);
  value(service.importThread({ id: "crashed", title: "crashed", cwd: directory,
    sessionFile: join(directory, "crashed.jsonl"), settings: { model: "anthropic/claude-opus-5-5", thinkingLevel: "high", speed: "standard" },
    metadata: { providerWait: { executionId: "original-execution", workId: "accepted-crash", retryAt: 0, broker: false } } }));
  value(service.importMessage({ id: "accepted-crash", threadId: "crashed", text: "execute once",
    state: "dispatched", executionId: "original-execution" }));
  await service.start(); await waitFor(() => service.latestSettlement("crashed") !== null);
  expect(service.latestSettlement("crashed")).toMatchObject({ executionId: "original-execution", workId: "accepted-crash", outcome, finalMessage });
  expect(sessions).toHaveLength(1);
  expect(sessions[0]!.commands.filter(command => command.type === "prompt")).toEqual([]);
  expect(service.get("crashed")?.metadata?.providerWait).toBeUndefined();
  expect(service.get("crashed")?.metadata?.admissionWait).toBeUndefined();
  service.reconcile(); await turn(); expect(sessions).toHaveLength(1);
});

it.each([false, true])("preserves pooled startup refusal and the same queued/accepted work across retries and restart, accepted=%s", async accepted => {
  const directory = mkdtempSync(join(tmpdir(), "thread-pool-start-")); roots.push(directory);
  const sessions: FakePiSession[] = []; let available = false;
  const openSession = vi.fn<OpenPiSession>(async (options, output) => {
    if (!available) throw new Error("Error: No eligible pooled account for anthropic/claude-opus-5-5.");
    const session = new FakePiSession(options, output); sessions.push(session); return session;
  });
  const options = { databasePath: join(directory, "threads.sqlite"), sessionsDir: directory, openSession,
    admit: async () => ({ ok: true as const, value: { release() {} } }) };
  const first = new ThreadService({ ...options, capacity: { mode: "unmanaged" } }); services.push(first);
  value(first.importThread({ id: "watch", title: "Synthetic watch", cwd: directory, sessionFile: join(directory, "watch.jsonl"),
    settings: { model: "astra", thinkingLevel: "high", speed: "standard" }, metadata: { watchList: true } }));
  value(first.importMessage({ id: "work", threadId: "watch", text: "check", state: accepted ? "dispatched" : "queued", ...(accepted ? { executionId: "execution" } : {}) }));
  await first.start(); await waitFor(() => first.get("watch")?.metadata?.admissionWait !== undefined);
  expect(first.get("watch")?.metadata?.admissionWait).toMatchObject({ message: expect.stringContaining("No eligible pooled account") });
  await first.close();
  const second = new ThreadService({ ...options, capacity: { mode: "unmanaged" } }); services.push(second); await second.start(); await turn();
  expect(openSession).toHaveBeenCalledTimes(1);
  const db = new DatabaseSync(options.databasePath);
  try {
    for (let attempt = 2; attempt <= 4; attempt++) {
      db.prepare(accepted ? "UPDATE thread SET metadata=json_set(metadata,'$.admissionWait.retryAt',0,'$.providerWait.retryAt',0) WHERE id='watch'" : "UPDATE thread SET metadata=json_set(metadata,'$.admissionWait.retryAt',0) WHERE id='watch'").run();
      second.reconcile(); await waitFor(() => openSession.mock.calls.length === attempt); await turn();
      expect(second.latestSettlement("watch")).toBeNull();
      expect(second.get("watch")).toMatchObject({ held: false });
      expect(second.get("watch")?.metadata?.startupFailure).toBeUndefined();
      expect(second.pending("watch")).toMatchObject([{ id: "work", state: accepted ? "dispatched" : "queued" }]);
    }
    available = true;
    db.prepare(accepted ? "UPDATE thread SET metadata=json_set(metadata,'$.admissionWait.retryAt',0,'$.providerWait.retryAt',0) WHERE id='watch'" : "UPDATE thread SET metadata=json_set(metadata,'$.admissionWait.retryAt',0) WHERE id='watch'").run();
    second.reconcile(); await waitFor(() => sessions[0]?.isStreaming === true);
    expect(sessions[0]!.commands.filter(command => command.type === "prompt")).toMatchObject([{ workId: "work" }]);
    sessions[0]!.settle("checked"); await waitFor(() => second.latestSettlement("watch") !== null);
    expect(second.latestSettlement("watch")).toMatchObject({ workId: "work", outcome: "complete", ...(accepted ? { executionId: "execution" } : {}) });
  } finally { db.close(); }
});

it("cold pooled startup without quota waits without consuming the startup failure budget",async()=>{
  const directory=mkdtempSync(join(tmpdir(),"thread-cold-capacity-"));roots.push(directory);
  const sessions:FakePiSession[]=[];let available=false;
  const service=new ThreadService({ capacity: { mode: "unmanaged" },databasePath:join(directory,"threads.sqlite"),sessionsDir:directory,
    openSession:async(options,output)=>{if(!available)throw new Error("No eligible pooled account for anthropic/claude-opus-5-5");const session=new FakePiSession(options,output);sessions.push(session);return session;}});services.push(service);
  await service.start();const thread=value(await service.spawn({requestId:"cold-capacity",cwd:directory,message:"work"}));
  await waitFor(()=>service.get(thread.id)?.metadata?.admissionWait!==undefined);
  for(let i=0;i<4;i++){service.reconcile();await turn();}
  expect(service.get(thread.id)?.metadata?.startupFailure).toBeUndefined();expect(service.latestSettlement(thread.id)).toBeNull();
  expect(service.pending(thread.id)).toMatchObject([{state:"queued"}]);
  const db = new DatabaseSync(join(directory, "threads.sqlite"));
  db.prepare("UPDATE thread SET metadata=json_set(metadata,'$.admissionWait.retryAt',0) WHERE id=?").run(thread.id); db.close();
  available=true;service.reconcile();await waitFor(()=>sessions[0]?.isStreaming===true);
  sessions[0]!.settle("done");await waitFor(()=>service.latestSettlement(thread.id)!==null);
});

it("model-broker capacity waits respect a durable retry schedule rather than immediate re-admission",async()=>{
  const directory=mkdtempSync(join(tmpdir(),"thread-broker-wait-"));roots.push(directory);
  const sessions:FakePiSession[]=[];
  const service=new ThreadService({ capacity: { mode: "unmanaged" },databasePath:join(directory,"threads.sqlite"),sessionsDir:directory,
    openSession:async(options,output)=>{const session=new FakePiSession(options,output);sessions.push(session);return session;},
    admit:async()=>({ok:true,value:{env:{PI_MODEL_BROKER_URL:"http://127.0.0.1:2461"},release(){}}})});services.push(service);
  await service.start();const thread=value(await service.spawn({requestId:"broker-wait",cwd:directory,message:"work"}));
  await waitFor(()=>sessions[0]?.isStreaming===true);
  sessions[0]!.settleMessage({role:"assistant",stopReason:"error",errorMessage:"429 rate limit"});
  await waitFor(()=>sessions[0]!.closed);
  const wait=service.get(thread.id)!.metadata!.providerWait as {retryAt:number;broker:boolean};expect(wait.broker).toBe(true);
  service.reconcile();await turn();service.reconcile();await turn();expect(sessions).toHaveLength(1);
  vi.spyOn(Date,"now").mockReturnValue(wait.retryAt+1);service.reconcile();await waitFor(()=>sessions[1]?.isStreaming===true);
  expect(sessions[1]!.commands.find(command=>command.type==="prompt")).toMatchObject({resumeProviderWait:true});
  sessions[1]!.settle("done");await waitFor(()=>service.latestSettlement(thread.id)!==null);
});

it("keeps the effective model and timed activity through transient retry backoff and warm reuse", async () => {
  const directory = mkdtempSync(join(tmpdir(), "thread-model-backoff-")); roots.push(directory);
  const sessions: FakePiSession[] = [];
  const service = new ThreadService({ capacity: { mode: "unmanaged" }, databasePath: join(directory, "threads.sqlite"), sessionsDir: directory,
    admit: async (_thread, settings) => ({ ok: true, value: { release() {}, env: { PI_MODEL_BROKER_URL: "http://127.0.0.1:2461" },
      settings: { ...settings, model: "anthropic-2/claude-opus-5-5" } } }),
    openSession: async (options, output) => { const session = new FakePiSession(options, output); sessions.push(session); return session; } });
  services.push(service); value(await service.start());
  const thread = value(await service.spawn({ requestId: "model-backoff", cwd: directory, message: "work", settings: { model: "opus" } }));
  await waitFor(() => sessions[0]?.isStreaming === true);
  value(await service.control({ threadId: thread.id, action: "settings", settings: { model: "sol" } }));
  const db = new DatabaseSync(join(directory, "threads.sqlite"));
  try {
    for (let attempt = 1; attempt <= 2; attempt++) {
      const failedAt = Date.now();
      sessions[attempt - 1]!.settleMessage({ role: "assistant", stopReason: "error", errorMessage: "503 service unavailable" });
      await waitFor(() => sessions[attempt - 1]!.closed);
      const waiting = service.get(thread.id)!;
      expect(waiting.settings.model).toBe("openai-codex/gpt-6.1-sol");
      expect(waiting.effectiveSettings?.model).toBe("anthropic-2/claude-opus-5-5");
      const providerWait = waiting.metadata?.providerWait as { retryAt: number; lastActivityAt: number };
      expect(providerWait).toMatchObject({ model: waiting.effectiveSettings?.model, attempts: attempt });
      expect(providerWait.retryAt).toBeGreaterThanOrEqual(failedAt + 30_000 * 2 ** (attempt - 1));
      expect(waiting.executionActivity).toMatchObject({ activity: "waiting_to_retry", activeTools: [] });
      expect(waiting.executionActivity?.lastActivityAt).toBe(providerWait.lastActivityAt);
      expect(service.latestSettlement(thread.id)).toBeNull();
      await service.reconcile(); await turn();
      expect(service.get(thread.id)?.executionActivity).toEqual(waiting.executionActivity);
      expect(sessions).toHaveLength(attempt);
      db.prepare("UPDATE thread SET metadata=json_set(metadata,'$.providerWait.retryAt',0) WHERE id=?").run(thread.id);
      await service.reconcile(); await waitFor(() => sessions[attempt]?.isStreaming === true);
      expect(sessions[attempt]!.commands.find(command => command.type === "prompt")).toMatchObject({ workId: "model-backoff", resume: true, resumeProviderWait: true });
    }
    await settle(sessions[2]!, service, thread.id);
    value(await service.send({ requestId: "warm-backoff", threadId: thread.id, text: "next", delivery: "queue" }));
    await waitFor(() => sessions[2]!.isStreaming);
    expect(sessions).toHaveLength(3);
    expect(service.get(thread.id)?.effectiveSettings?.model).toBe("anthropic-2/claude-opus-5-5");
    await settle(sessions[2]!, service, thread.id);
  } finally { db.close(); }
});

it.each([false, true])("switches dormant provider waiting Opus -> Sol with original custody and attribution, broker=%s", async broker => {
  const directory = mkdtempSync(join(tmpdir(), "thread-model-retry-")); roots.push(directory);
  const sessions: FakePiSession[] = [], release = vi.fn();
  const original = "anthropic-2/claude-opus-5-5", selected = "openai-codex/gpt-6.1-sol", assigned = "openai-codex-8/gpt-6.1-sol";
  const failure = { role: "assistant", stopReason: "error", errorMessage: "429 account rate limit" };
  let allowSol = false;
  const admit = vi.fn(async (_thread: unknown, settings: { model: string }, _recovering: boolean, _executionId: string) => {
    if (settings.model.startsWith("anthropic") && sessions.length || !settings.model.startsWith("anthropic") && !allowSol) return { ok: false as const, error: { code: "unavailable" as const, message: "quota exhausted" } };
    return { ok: true as const, value: { release, settings: { model: settings.model.startsWith("anthropic") ? original : assigned, thinkingLevel: "high" as const, speed: "standard" as const }, ...(broker ? { env: { PI_MODEL_BROKER_URL: "http://127.0.0.1:2461" } } : {}) } };
  });
  const options = { databasePath: join(directory, "threads.sqlite"), sessionsDir: directory, admit,
    openSession: async (options: PiSessionOptions, output: (event: PiEvent) => void) => {
      const session = new FakePiSession(options, output);
      if (sessions.length) { session.acceptedWorkIds.add("same-work"); session.completedWorkIds.add("same-work"); session.lastAssistantMessage = failure; }
      sessions.push(session); return session;
    } };
  const first = new ThreadService({ ...options, capacity: { mode: "unmanaged" } }); services.push(first);
  value(first.importThread({ id: "retry", title: "Retry", cwd: directory, sessionFile: join(directory, "retry.jsonl"), settings: { model: "anthropic/claude-opus-5-5", thinkingLevel: "high", speed: "standard" } }));
  value(first.importMessage({ id: "same-work", threadId: "retry", text: "accepted assignment" }));
  await first.start(); await waitFor(() => sessions[0]?.isStreaming === true);
  sessions[0]!.settleMessage(failure); await waitFor(() => sessions[0]!.closed);
  expect(release).toHaveBeenCalledOnce();
  const saved = value(await first.control({ threadId: "retry", action: "settings", settings: { model: "sol" } }));
  expect(saved.settings.model).toBe(selected); expect(saved.effectiveSettings?.model).toBe(original);
  expect(saved.executionActivity).toMatchObject({ activity: "waiting_for_capacity", activeTools: [] });
  expect(saved.metadata?.providerWait).toMatchObject({ model: original, attempts: 1 });
  expect((value(await first.command("retry", { type: "get_state" }))).model).toMatchObject({ provider: "anthropic", id: "claude-opus-5-5" });
  const db = new DatabaseSync(options.databasePath);
  const before = db.prepare("SELECT id,settings FROM thread_execution WHERE ended_at IS NULL").get()!;
  // Queue a second assignment; switching the retained work must not retarget it.
  value(await first.send({ requestId: "later-work", threadId: "retry", text: "later", delivery: "queue" }));
  const pendingBefore = first.pending("retry");
  const queuedSettings = db.prepare("SELECT settings FROM thread_work WHERE id='later-work'").get()!.settings;
  value(await first.detach());
  const second = new ThreadService({ ...options, capacity: { mode: "unmanaged" } }); services.push(second);
  value(await second.control({ threadId: "retry", action: "retryWaiting" }));
  expect(second.pending("retry")).toEqual(pendingBefore);
  expect(second.get("retry")?.metadata?.admissionWait).toBeUndefined();
  expect(second.get("retry")?.metadata?.modelRetryHistory).toMatchObject([{ executionId: before.id, previous: { model: original }, selected: { model: selected } }]);
  expect(db.prepare("SELECT settings FROM thread_execution WHERE id=?").get(before.id)!.settings).toBe(before.settings);
  expect(db.prepare("SELECT settings FROM thread_work WHERE id='later-work'").get()!.settings).toBe(queuedSettings);
  // Persist the retry selection through another owner restart, before admission succeeds.
  value(await second.detach());
  const third = new ThreadService({ ...options, capacity: { mode: "unmanaged" } }); services.push(third); allowSol = true;
  await third.start(); await waitFor(() => sessions[1]?.isStreaming === true);
  expect(sessions[1]!.options.args).toEqual(expect.arrayContaining(["openai-codex-8", "gpt-6.1-sol"]));
  expect(sessions[1]!.commands.filter(command => command.type === "prompt")).toMatchObject([{ workId: "same-work", resume: true, resumeProviderWait: true }]);
  expect(admit.mock.calls.at(-1)?.slice(2)).toEqual([false, before.id]);
  expect(third.get("retry")?.effectiveSettings?.model).toBe(assigned);
  expect(third.get("retry")?.metadata?.providerWait).toBeUndefined();
  expect(db.prepare("SELECT settings,retry_settings FROM thread_execution WHERE id=?").get(before.id)).toMatchObject({ settings: before.settings, retry_settings: JSON.stringify({ model: assigned, thinkingLevel: "high", speed: "standard" }) });
  sessions[1]!.settle("delivered"); await waitFor(() => third.latestSettlement("retry") !== null);
  expect(value(third.settlements()).items).toMatchObject([{ executionId: before.id, workId: "same-work", outcome: "complete" }]);
  db.close();
});

it("retries queued admission waiting work explicitly, without changing future-only receipt snapshots", async () => {
  const directory = mkdtempSync(join(tmpdir(), "thread-queued-model-retry-")); roots.push(directory);
  const sessions: FakePiSession[] = [];
  const service = new ThreadService({ capacity: { mode: "unmanaged" }, databasePath: join(directory, "threads.sqlite"), sessionsDir: directory,
    admit: async (_thread, settings) => settings.model.startsWith("anthropic") ? { ok: false, error: { code: "unavailable", message: "Opus capacity exhausted" } } : { ok: true, value: { release() {} } },
    openSession: async (options, output) => { const session = new FakePiSession(options, output); sessions.push(session); return session; } }); services.push(service);
  const thread = value(await service.spawn({ requestId: "queued-retry", cwd: directory, message: "work", settings: { model: "opus" } }));
  await service.start(); await waitFor(() => Boolean(service.get(thread.id)?.metadata?.admissionWait));
  value(await service.control({ threadId: thread.id, action: "settings", settings: { model: "sol" } }));
  expect(service.get(thread.id)?.effectiveSettings?.model).toBe("anthropic/claude-opus-5-5");
  value(await service.control({ threadId: thread.id, action: "retryWaiting" }));
  await waitFor(() => sessions[0]?.isStreaming === true);
  expect(sessions[0]!.options.args).toEqual(expect.arrayContaining(["openai-codex", "gpt-6.1-sol"]));
  expect(service.get(thread.id)?.metadata?.admissionWait).toBeUndefined();
  expect(service.pending(thread.id)).toMatchObject([{ id: "queued-retry", state: "dispatched" }]);
});

it("checks the selected pooled family rather than obsolete Opus capacity on explicit retry", async () => {
  const directory = mkdtempSync(join(tmpdir(), "thread-pooled-model-retry-")); roots.push(directory);
  const availability = vi.spyOn(routing, "pooledRetryAvailability").mockImplementation(model => ({ available: model.startsWith("openai-codex"), retryAt: Date.now() + 3_600_000 }));
  const sessions: FakePiSession[] = [];
  const service = new ThreadService({ capacity: { mode: "unmanaged" }, databasePath: join(directory, "threads.sqlite"), sessionsDir: directory,
    openSession: async (options, output) => { const session = new FakePiSession(options, output); sessions.push(session); return session; } }); services.push(service);
  value(service.importThread({ id: "pooled", title: "Pooled", cwd: directory, sessionFile: join(directory, "pooled.jsonl"), settings: { model: "anthropic/claude-opus-5-5", thinkingLevel: "high", speed: "standard" },
    metadata: { providerWait: { executionId: "pooled-execution", workId: "pooled-work", retryAt: Date.now() + 3_600_000, broker: false } } }));
  value(service.importMessage({ id: "pooled-work", threadId: "pooled", text: "work", state: "dispatched", executionId: "pooled-execution", insertedAt: 1 }));
  value(await service.control({ threadId: "pooled", action: "settings", settings: { model: "sol" } }));
  value(await service.control({ threadId: "pooled", action: "retryWaiting" }));
  await service.start(); await waitFor(() => sessions[0]?.isStreaming === true);
  expect(availability).toHaveBeenCalledWith("openai-codex/gpt-6.1-sol", expect.any(Object));
  expect(availability.mock.calls.some(([model]) => model.startsWith("anthropic"))).toBe(false);
  expect(sessions[0]!.commands.find(command => command.type === "prompt")).toMatchObject({ workId: "pooled-work", resume: true, resumeProviderWait: true });
});

it.each(["admission", "opening"])("cancellation wins a waiting model retry during %s", async phase => {
  const directory = mkdtempSync(join(tmpdir(), "thread-model-retry-cancel-")); roots.push(directory);
  const sessions: FakePiSession[] = [], releaseLease = vi.fn();
  let unblock!: () => void, reached!: () => void;
  const gate = new Promise<void>(resolve => { unblock = resolve; }), entered = new Promise<void>(resolve => { reached = resolve; });
  const service = new ThreadService({ capacity: { mode: "unmanaged" }, databasePath: join(directory, "threads.sqlite"), sessionsDir: directory,
    admit: async () => { if (phase === "admission") { reached(); await gate; } return { ok: true, value: { env: { PI_MODEL_BROKER_URL: "http://127.0.0.1:2461" }, release: releaseLease } }; },
    openSession: async (options, output) => { if (phase === "opening") { reached(); await gate; } const session = new FakePiSession(options, output); sessions.push(session); return session; } }); services.push(service);
  value(service.importThread({ id: "cancel", title: "Cancel", cwd: directory, sessionFile: join(directory, "cancel.jsonl"), settings: { model: "anthropic/claude-opus-5-5", thinkingLevel: "high", speed: "standard" },
    metadata: { providerWait: { executionId: "cancel-execution", workId: "cancel-work", retryAt: Date.now() + 3_600_000, broker: true } } }));
  value(service.importMessage({ id: "cancel-work", threadId: "cancel", text: "work", state: "dispatched", executionId: "cancel-execution" }));
  value(await service.control({ threadId: "cancel", action: "settings", settings: { model: "sol" } }));
  value(await service.control({ threadId: "cancel", action: "retryWaiting" }));
  await service.start(); await entered;
  const switched = service.control({ threadId: "cancel", action: "retryWaiting" });
  const stopped = service.control({ threadId: "cancel", action: "stop", descendants: false });
  unblock(); value(await stopped);
  expect(await switched).toMatchObject({ ok: false, error: { code: "conflict" } });
  expect(releaseLease).toHaveBeenCalledOnce();
  expect(sessions.flatMap(session => session.commands).filter(command => command.type === "prompt")).toEqual([]);
  expect(service.latestSettlement("cancel")).toMatchObject({ executionId: "cancel-execution", outcome: "cancelled" });
  expect(service.get("cancel")?.metadata?.providerWait).toBeUndefined();
});

it("does not bypass same-model broker backoff or switch genuinely live work", async () => {
  const directory = mkdtempSync(join(tmpdir(), "thread-same-model-retry-")); roots.push(directory);
  const sessions: FakePiSession[] = [];
  const service = new ThreadService({ capacity: { mode: "unmanaged" }, databasePath: join(directory, "threads.sqlite"), sessionsDir: directory,
    admit: async () => ({ ok: true, value: { env: { PI_MODEL_BROKER_URL: "http://127.0.0.1:2461" }, release() {} } }),
    openSession: async (options, output) => { const session = new FakePiSession(options, output); sessions.push(session); return session; } }); services.push(service);
  await service.start(); const thread = value(await service.spawn({ requestId: "same-model", cwd: directory, message: "work", settings: { model: "opus" } }));
  await waitFor(() => sessions[0]?.isStreaming === true);
  value(await service.control({ threadId: thread.id, action: "settings", settings: { model: "sol" } }));
  expect(await service.control({ threadId: thread.id, action: "retryWaiting" })).toMatchObject({ ok: false, error: { code: "conflict" } });
  expect(sessions[0]!.commands.some(command => command.type === "abort" || command.type === "set_model")).toBe(false);
  value(await service.control({ threadId: thread.id, action: "settings", settings: { model: "opus" } }));
  sessions[0]!.settleMessage({ role: "assistant", stopReason: "error", errorMessage: "429 rate limit" }); await waitFor(() => sessions[0]!.closed);
  const wait = service.get(thread.id)!.metadata!.providerWait;
  value(await service.control({ threadId: thread.id, action: "retryWaiting" }));
  expect(service.get(thread.id)!.metadata!.providerWait).toEqual(wait);
  await turn(); expect(sessions).toHaveLength(1);
});

it("stop cancels provider waiting without reopening or retrying a model",async()=>{
  const directory=mkdtempSync(join(tmpdir(),"thread-provider-stop-"));roots.push(directory);
  const sessions:FakePiSession[]=[];let available=true;
  const service=new ThreadService({ capacity: { mode: "unmanaged" },databasePath:join(directory,"threads.sqlite"),sessionsDir:directory,
    openSession:async(options,output)=>{const session=new FakePiSession(options,output);sessions.push(session);return session;},
    admit:async()=>available?{ok:true,value:{release(){}}}:{ok:false,error:{code:"unavailable",message:"quota exhausted"}}});services.push(service);
  await service.start();const thread=value(await service.spawn({requestId:"stop-wait",cwd:directory,message:"work"}));
  await waitFor(()=>sessions[0]?.isStreaming===true);available=false;
  sessions[0]!.settleMessage({role:"assistant",stopReason:"error",errorMessage:"429 quota exhausted"});
  await waitFor(()=>sessions[0]!.closed);
  value(await service.control({threadId:thread.id,action:"stop",descendants:false}));
  available=true;service.reconcile();await turn();
  expect(sessions).toHaveLength(1);expect(service.latestSettlement(thread.id)?.outcome).toBe("cancelled");
  expect(service.get(thread.id)?.metadata?.providerWait).toBeUndefined();
});

it("settles a thread whose admission refusal can never succeed instead of waiting on it", async () => {
  const directory = mkdtempSync(join(tmpdir(), "thread-admission-reject-")); roots.push(directory);
  const sessions: FakePiSession[] = [];
  const openSession: OpenPiSession = async (options, output) => { const session = new FakePiSession(options, output); sessions.push(session); return session; };
  const error = "Root repair cannot use an isolated application context";
  const service = new ThreadService({ capacity: { mode: "unmanaged" }, databasePath: join(directory, "threads.sqlite"), sessionsDir: directory, openSession,
    admit: async () => ({ ok: false, error: { code: "invalid_request", message: error } }) });
  services.push(service);
  await service.start();
  const thread = value(await service.spawn({ requestId: "rejected", cwd: directory, message: "work" }));
  await waitFor(() => service.get(thread.id)?.state === "idle" && service.get(thread.id)?.held === true);
  expect(service.get(thread.id)?.metadata?.executionError).toBe(error);
  expect(service.latestSettlement(thread.id)).toMatchObject({ outcome: "failed", error });
  expect(sessions).toHaveLength(0);
});

it("waits out a transient compaction failure and resumes the same accepted work at its retry time", async () => {
  const directory=mkdtempSync(join(tmpdir(),"thread-transient-wait-"));roots.push(directory);
  const sessions:FakePiSession[]=[];
  const failure="Context rejected: Native compaction failed: Codex error: Our servers are currently overloaded. Context is unchanged. Automatic compaction retries after 2026-10-03T16:00:00.000Z; /compact or the compact RPC command retries now.";
  const openSession:OpenPiSession=async(options,output)=>{
    const session=new FakePiSession(options,output);
    if(sessions.length){session.acceptedWorkIds.add("accepted");session.completedWorkIds.add("accepted");session.lastAssistantMessage={role:"assistant",stopReason:"error",errorMessage:failure};}
    sessions.push(session);return session;
  };
  const options={databasePath:join(directory,"threads.sqlite"),sessionsDir:directory,openSession,admit:async()=>({ok:true as const,value:{release(){}}})};
  const service=new ThreadService({ ...options, capacity: { mode: "unmanaged" } });services.push(service);
  value(service.importThread({id:"integrator",title:"integrator",cwd:directory,sessionFile:join(directory,"integrator.jsonl"),settings:{model:"openai-codex/gpt-6.1-sol",thinkingLevel:"high",speed:"standard"}}));
  value(service.importMessage({id:"accepted",threadId:"integrator",text:"integrate the train"}));
  let now=Date.parse("2026-10-03T15:53:00.000Z");vi.spyOn(Date,"now").mockImplementation(()=>now);
  await service.start();await waitFor(()=>sessions[0]?.isStreaming===true);
  sessions[0]!.settleMessage({role:"assistant",stopReason:"error",errorMessage:failure});
  await waitFor(()=>sessions[0]!.closed&&service.get("integrator")?.metadata?.providerWait!==undefined);
  expect(service.latestSettlement("integrator")).toBeNull();
  expect(service.get("integrator")?.metadata?.providerWait).toMatchObject({attempts:1,retryAt:Date.parse("2026-10-03T16:00:00.000Z")});
  service.reconcile();await turn();expect(sessions).toHaveLength(1);
  now=Date.parse("2026-10-03T16:00:01.000Z");service.reconcile();
  await waitFor(()=>sessions[1]?.isStreaming===true);
  expect(sessions[1]!.commands.find(command=>command.type==="prompt")).toMatchObject({workId:"accepted",resume:true,resumeProviderWait:true});
  sessions[1]!.settleMessage({role:"assistant",stopReason:"error",errorMessage:failure.replace("16:00:00","16:00:30")});
  await waitFor(()=>sessions[1]!.closed&&service.get("integrator")?.metadata?.providerWait!==undefined);
  expect(service.get("integrator")?.metadata?.providerWait).toMatchObject({attempts:2,retryAt:now+60_000});
  now+=60_000;service.reconcile();await waitFor(()=>sessions[2]?.isStreaming===true);
  sessions[2]!.settle("integrated");await waitFor(()=>service.latestSettlement("integrator")!==null);
  expect(service.latestSettlement("integrator")).toMatchObject({workId:"accepted",outcome:"complete"});
  expect(service.get("integrator")?.metadata?.providerRetry).toBeUndefined();
});

it("retains native failure causes in settlement receipts without treating cancellation as failure", async () => {
  const f = fixture();
  await f.service.start();
  for (const [stopReason, errorMessage] of [
    ["error", "Context rejected: An extension changed the Codex checkpoint's retained message boundary"],
    ["aborted", "This operation was aborted"],
  ]) {
    const thread = value(await f.service.spawn({ requestId: errorMessage, cwd: f.directory, message: "work" }));
    await waitFor(() => f.sessions.some(session => session.options.threadId === thread.id && session.isStreaming));
    const session = f.sessions.find(session => session.options.threadId === thread.id)!;
    session.settleMessage({ role: "assistant", content: [], stopReason, errorMessage, timestamp: Date.now() });
    await waitFor(() => f.service.latestSettlement(thread.id) !== null);
    const receipt = f.service.latestSettlement(thread.id)!;
    expect(receipt.outcome).toBe(stopReason === "error" ? "failed" : "cancelled");
    expect(receipt.error).toBe(stopReason === "error" ? errorMessage : undefined);
    expect(receipt.finalMessage?.errorMessage).toBe(errorMessage);
    expect(value(f.service.settlements()).items.find(item => item.threadId === thread.id)).toEqual(receipt);
    const db = new DatabaseSync(join(f.directory, "threads.sqlite"));
    try { expect(db.prepare("SELECT error FROM thread_execution WHERE id=?").get(receipt.executionId)?.error).toBe(stopReason === "error" ? errorMessage : null); }
    finally { db.close(); }
    value(await f.service.control({ threadId: thread.id, action: "stop", descendants: false }));
    f.service.reconcile();
    await turn();
    expect(f.service.get(thread.id)).toMatchObject({ state: "idle", held: false, metadata: { archived: true } });
    expect(f.service.pending(thread.id)).toEqual([]);
  }
});

it.each([
  { model: "anthropic/claude-fable-5-1", speed: "standard" as const },
  { model: "openai-codex/gpt-6.1-sol", speed: "priority" as const },
])("preserves the running account and model when future settings change to $model at $speed", async ({ model, speed }) => {
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
    const beforeRejected = f.service.get(thread.id);
    expect(await f.service.control({ threadId: thread.id, action: "settings", settings: { model: "fable", thinkingLevel: "high", speed: "priority" } })).toMatchObject({
      ok: false, error: { code: "invalid_request", message: "Priority speed is unavailable for anthropic/claude-fable-5-1" },
    });
    expect(f.service.get(thread.id)).toEqual(beforeRejected);
    expect(active()).toEqual({ model: "openai-codex-8/gpt-6-astra", thinkingLevel: "low", speed: "standard" });
    expect(f.sessions[0].commands).toHaveLength(count);
    value(await f.service.control({ threadId: thread.id, action: "settings", settings: { model } }));
    value(await f.service.control({ threadId: thread.id, action: "settings", settings: { thinkingLevel: "high", speed } }));
    expect(f.service.get(thread.id)!.settings).toEqual({ model, thinkingLevel: "high", speed });
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

it("applies settings changed while the thread's session is still opening", async () => {
  const directory = mkdtempSync(join(tmpdir(), "thread-service-")); roots.push(directory);
  const sessions: FakePiSession[] = [];
  let release!: () => void, opened!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; }), opening = new Promise<void>(resolve => { opened = resolve; });
  const service = new ThreadService({ capacity: { mode: "unmanaged" }, databasePath: join(directory, "threads.sqlite"), sessionsDir: join(directory, "sessions"),
    openSession: async (options, output) => { opened(); await gate; const session = new FakePiSession(options, output); sessions.push(session); return session; } });
  services.push(service);
  await service.start();
  const thread = value(await service.spawn({ requestId: "settings-while-opening", cwd: directory, message: "mention" }));
  await opening;
  const applied = service.control({ threadId: thread.id, action: "settings", settings: { thinkingLevel: "off" } });
  release();
  expect(await applied).toMatchObject({ ok: true });
  expect(sessions[0]!.commands.some(command => command.type === "set_thinking_level" && command.level === "off")).toBe(true);
  expect(service.get(thread.id)!.settings.thinkingLevel).toBe("off");
});

describe("await child settlements", () => {
  async function children() {
    const f = fixture();
    const parent = value(await f.service.spawn({ requestId: "await-parent", cwd: f.directory }));
    const a = value(await f.service.spawn({ requestId: "await-a", cwd: f.directory, parentId: parent.id, message: "A" }));
    const b = value(await f.service.spawn({ requestId: "await-b", cwd: f.directory, parentId: parent.id, message: "B" }));
    value(await f.service.control({ threadId: parent.id, action: "stop", descendants: false }));
    value(await f.service.start());
    await waitFor(() => f.sessions.filter(session => session.isStreaming).length === 2);
    return { ...f, parent, a, b, session: (id: string) => f.sessions.find(session => session.options.threadId === id)! };
  }

  it("returns the first child and keeps a simultaneous second completion available across restart", async () => {
    const f = await children();
    const input = { parentId: f.parent.id, threadIds: [f.a.id, f.b.id] };
    const waiting = f.service.await(input);
    f.session(f.b.id).settle("B returned first");
    const first = value(await waiting);
    expect(first).toMatchObject({ settlement: { threadId: f.b.id, outcome: "complete", finalMessage: { content: [{ text: "B returned first" }] } }, remainingThreadIds: [f.a.id] });
    expect(f.session(f.a.id).isStreaming).toBe(true);
    f.session(f.a.id).settle("A returned too");
    await waitFor(() => f.service.latestSettlement(f.a.id) !== null);
    value(await f.service.detach());
    const next = fixture(f.directory);
    const second = value(await next.service.await({ ...input, threadIds: first.remainingThreadIds, after: first.after }));
    expect(second).toMatchObject({ settlement: { threadId: f.a.id, outcome: "complete" }, remainingThreadIds: [] });
    expect(second.after[f.b.id]).toBe(first.settlement!.seq);
    expect(value(await next.service.await({ ...input, after: second.after, timeoutMs: 0 })).settlement).toBeNull();
    expect(next.sessions).toHaveLength(0);
  });

  it("reports failed and cancelled executions without treating idle as success", async () => {
    const f = await children();
    const input = { parentId: f.parent.id, threadIds: [f.a.id, f.b.id] };
    const waiting = f.service.await(input);
    f.session(f.a.id).settleMessage({ role: "assistant", content: [], stopReason: "error", errorMessage: "Provider failed" });
    const first = value(await waiting);
    expect(first.settlement).toMatchObject({ threadId: f.a.id, outcome: "failed", error: "Provider failed" });
    expect(first.settlement).toEqual(f.service.latestSettlement(f.a.id));
    const next = f.service.await({ ...input, threadIds: first.remainingThreadIds });
    value(await f.service.control({ threadId: f.b.id, action: "stop", descendants: false }));
    expect(value(await next).settlement).toMatchObject({ threadId: f.b.id, outcome: "cancelled" });
  });

  it("cleans up waits on cancellation, timeout and controller handoff without stopping children", async () => {
    const f = await children();
    const input = { parentId: f.parent.id, threadIds: [f.a.id] };
    const subscriptionCount = () => (f.service as any).listeners.size;
    const before = subscriptionCount();
    const controller = new AbortController();
    const cancelled = f.service.await(input, controller.signal);
    expect(subscriptionCount()).toBe(before + 1);
    controller.abort();
    expect(await cancelled).toMatchObject({ ok: false, error: { message: "Thread await cancelled" } });
    expect(subscriptionCount()).toBe(before);
    expect(value(await f.service.await({ ...input, timeoutMs: 0 }))).toMatchObject({ settlement: null, remainingThreadIds: input.threadIds });
    expect(subscriptionCount()).toBe(before);
    expect(f.session(f.a.id).commands.some(command => command.type === "abort")).toBe(false);
    const handoff = f.service.await(input);
    f.service.suspend();
    expect(await handoff).toMatchObject({ ok: false, error: { code: "unavailable" } });
    expect(subscriptionCount()).toBe(before);
    value(await f.service.detach());
  });

  it("validates the whole accessible peer group before returning a stored result", async () => {
    const f = await children();
    f.session(f.a.id).settle("done");
    await waitFor(() => f.service.latestSettlement(f.a.id) !== null);
    const input = { parentId: f.parent.id, threadIds: [f.a.id] };
    for (const patch of [{ threadIds: [] }, { threadIds: [f.a.id, f.a.id] }, { threadIds: [f.parent.id] },
      { threadIds: Array.from({ length: 101 }, (_, i) => String(i)) }, { after: { [f.a.id]: -1 } },
      { timeoutMs: 30_001 }]) {
      expect(await f.service.await({ ...input, ...patch })).toMatchObject({ ok: false, error: { code: "invalid_request" } });
    }
    expect(await f.service.await({ ...input, threadIds: [f.a.id, "missing"] })).toMatchObject({ ok: false, error: { code: "not_found" } });
    value(await f.service.control({ threadId: f.b.id, action: "stop", descendants: false }));
  });
});

describe("unified Orchestrator peers", () => {
  it("routes launched peers to fleet, allows peer spawning, and retains creation receipts", async () => {
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
    expect(fleet.service.get(child.id)?.role).toBe("agent");
    expect(value(await directory.spawn(input)).id).toBe(child.id);
    for (const parentId of [existing.id, child.id]) {
      for (const api of [directory, person.service, fleet.service]) {
        const result = await api.spawn({ requestId: `recursive-${parentId}`, parentId, cwd: person.directory });
        expect(result).toMatchObject({ ok: true });
      }
    }
    const lane = value(await fleet.service.spawn({ requestId: "lane", cwd: fleet.directory }));
    expect(lane.role).toBe("agent");
    expect(await fleet.service.spawn({ requestId: "lane-child", parentId: lane.id, cwd: fleet.directory })).toMatchObject({ ok: true });
    value(await directory.control({ threadId: root.id, action: "stop", descendants: true }));
    expect(person.service.get(existing.id)).toMatchObject({ state: "idle", held: false });
    expect(fleet.service.get(child.id)).toMatchObject({ state: "running", held: false });
    expect(fleet.service.pending(child.id)[0]?.state).toBe("queued");
    expect(await directory.spawn({ requestId: "stopped-child", parentId: root.id, cwd: person.directory })).toMatchObject({ ok: false, error: { code: "unavailable" } });
    expect(fleet.service.snapshot().length).toBeGreaterThanOrEqual(4);
  });

  it("keeps the spawn tool for every peer and relays replies to a cross-owner assignment requester", async () => {
    const person = fixture(), fleet = fixture(undefined, true);
    const directory = new ThreadDirectory({ id: "person", api: person.service }, [{ id: "fleet", api: fleet.service }]);
    person.service.setDirectory(directory, () => fleet.service);
    fleet.service.setDirectory(directory);
    const root = value(await directory.spawn({ requestId: "parent", cwd: person.directory, message: "Coordinate" }));
    const child = value(await directory.spawn({ requestId: "child", parentId: root.id, cwd: person.directory, message: "Work", ephemeral: true }));
    value(await person.service.start()); value(await fleet.service.start());
    await waitFor(() => person.sessions[0]?.isStreaming === true && fleet.sessions[0]?.isStreaming === true);
    expect(person.sessions[0]!.options.env.PI_THREAD_CAN_SPAWN).toBe("1");
    expect(fleet.sessions[0]!.options.env.PI_THREAD_CAN_SPAWN).toBe("1");
    expect(fleet.sessions[0]!.options.env.PI_THREAD_DATABASE).toBe(join(fleet.directory, "threads.sqlite"));
    expect(person.sessions[0]!.options.env.PI_THREAD_DATABASE).toBe(join(person.directory, "threads.sqlite"));
    expect(threadTools(person.sessions[0]!.options).some(tool => tool.name === "thread_spawn")).toBe(true);
    expect(threadTools(fleet.sessions[0]!.options).some(tool => tool.name === "thread_spawn")).toBe(true);
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
      expect(JSON.parse(text.split("\n")[2]!)).toMatchObject({ senderThreadId: child.id });
      expect(text).toMatch(/<\/agent_message>$/);
    }
    expect(JSON.parse(progress.split("\n")[2]!)).toMatchObject({ recipientThreadId: root.id, source: "explicit", messageId: "progress" });
    expect(JSON.parse(completion.split("\n")[2]!)).toEqual({ senderThreadId: child.id, senderName: child.agentName });
    expect(JSON.parse(completion.split("\n")[4]!)).toEqual({ type: "thread_idle", title: child.title, outcome: "complete", finalText: "Worker result" });
    await waitFor(() => fleet.service.get(child.id)?.metadata?.archived === true);
    expect(fleet.service.get(child.id)).toMatchObject({ state: "idle", held: false, metadata: { ephemeral: true, archived: true, archivedAt: expect.any(String) } });
    expect(fleet.service.latestSettlement(child.id)?.finalMessage).toMatchObject({ content: [{ text: "Worker result" }] });
    expect(value(await directory.read({ threadId: child.id })).entries.length).toBeGreaterThanOrEqual(0);
    expect(await directory.send({ requestId: "late", threadId: child.id, senderId: root.id, text: "Follow up" })).toMatchObject({ ok: false, error: { code: "unavailable" } });
  });
});

async function settle(session: FakePiSession, service: ThreadService, threadId: string, text = "done") {
  session.settle(text);
  await waitFor(() => service.get(threadId)?.state === "idle");
}

describe("ThreadService", () => {
  it("archives an ephemeral worker only after its final queued assignment, retaining its result even when both settlements share a millisecond", async () => {
    vi.spyOn(Date, "now").mockReturnValue(Date.now());
    const { service, directory, sessions } = fixture();
    const root = value(await service.spawn({ requestId: "root", cwd: directory }));
    expect(await service.spawn({ requestId: "invalid-root", cwd: directory, ephemeral: true })).toMatchObject({ ok: false, error: { code: "invalid_request" } });
    expect(await service.spawn({ requestId: "invalid-metadata", cwd: directory, parentId: root.id, metadata: { ephemeral: true } })).toMatchObject({ ok: false, error: { code: "invalid_request" } });
    const child = value(await service.spawn({ requestId: "ephemeral", cwd: directory, parentId: root.id, message: "Write the result", ephemeral: true }));
    expect(child.metadata).toMatchObject({ ephemeral: true });
    expect(await service.update(child.id, { metadata: { ephemeral: false } })).toMatchObject({ ok: false, error: { code: "conflict" } });
    value(await service.control({ threadId: root.id, action: "stop", descendants: false }));
    await service.start();
    await waitFor(() => sessions.some(session => session.options.threadId === child.id && session.isStreaming));
    value(await service.send({ requestId: "follow-up", threadId: child.id, text: "Include the references", delivery: "queue" }));
    sessions.find(session => session.options.threadId === child.id)!.settle("First draft");
    await waitFor(() => sessions.some(session => session.options.threadId === child.id && session.commands.some(command => command.workId === "follow-up")));
    expect(service.get(child.id)?.metadata?.archived).not.toBe(true);
    [...sessions].reverse().find(session => session.options.threadId === child.id)!.settle("Finished artifact");
    await waitFor(() => service.get(child.id)?.metadata?.archived === true);
    expect(service.get(child.id)).toMatchObject({ held: false, metadata: { ephemeral: true, archivedAt: expect.any(String) } });
    expect(service.latestSettlement(child.id)?.finalMessage).toMatchObject({ content: [{ text: "Finished artifact" }] });
    const archivedAt = service.get(child.id)?.metadata?.archivedAt;
    service.reconcile();
    expect(service.get(child.id)?.metadata?.archivedAt).toBe(archivedAt);
    expect(await service.send({ requestId: "after", threadId: child.id, senderId: root.id, text: "More" })).toMatchObject({ ok: false, error: { code: "unavailable" } });
    const ids = async (archived?: boolean) => value(await service.list({ parentId: root.id, archived })).threads.map(thread => thread.id);
    expect(await ids()).toContain(child.id);
    expect(await ids(false)).not.toContain(child.id);
    expect(await ids(true)).toEqual([child.id]);
  });

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

  it("keeps unseen idle conversations and archives only strictly stale idle views", async () => {
    const { service, directory } = fixture();
    const clock = vi.spyOn(Date, "now").mockReturnValue(10_000);
    const thread = value(await service.spawn({ requestId: "idle", cwd: directory }));
    clock.mockReturnValue(3_610_001);
    expect(value(await service.control({ threadId: thread.id, action: "archiveInactive", inactiveBefore: 10_001 })).metadata?.archived).not.toBe(true);
    const changed = vi.fn(); service.subscribe(changed);
    const viewed = value(await service.control({ threadId: thread.id, action: "view" }));
    expect(viewed).toEqual({ ...thread, metadata: { ...thread.metadata, autoArchiveViewedAt: 3_610_001 } });
    expect(changed).not.toHaveBeenCalled();
    expect(value(await service.control({ threadId: thread.id, action: "archiveInactive", inactiveBefore: 10_001 })).metadata?.archived).not.toBe(true);
    clock.mockReturnValue(7_210_001);
    expect(value(await service.control({ threadId: thread.id, action: "archiveInactive", inactiveBefore: 3_610_001 })).metadata?.archived).not.toBe(true);
    clock.mockReturnValue(7_210_002);
    expect(value(await service.control({ threadId: thread.id, action: "archiveInactive", inactiveBefore: 3_610_002 })).metadata?.archived).toBe(true);
    const archived = service.get(thread.id)!;
    expect(value(await service.control({ threadId: thread.id, action: "view" }))).toEqual(archived);
    value(await service.control({ threadId: thread.id, action: "update", archived: false }));
    clock.mockReturnValue(10_810_003);
    expect(value(await service.control({ threadId: thread.id, action: "archiveInactive", inactiveBefore: 7_210_003 })).metadata?.archived).not.toBe(true);
    expect(await service.control({ threadId: thread.id, action: "archiveInactive", inactiveBefore: Date.now() + 1 })).toMatchObject({ ok: false });
  });

  it("rechecks a re-view after a stale sweep snapshot without refreshing activity clocks", async () => {
    const { service, directory } = fixture();
    const clock = vi.spyOn(Date, "now").mockReturnValue(10_000);
    const thread = value(await service.spawn({ requestId: "view-race", cwd: directory }));
    value(await service.control({ threadId: thread.id, action: "view" }));
    const sweep = service.snapshot()[0]!;
    clock.mockReturnValue(3_620_000);
    const fresh = value(await service.control({ threadId: thread.id, action: "view" }));
    expect(sweep.metadata?.autoArchiveViewedAt).toBe(10_000);
    expect(fresh.metadata?.autoArchiveViewedAt).toBe(3_620_000);
    expect(fresh.updatedAt).toBe(thread.updatedAt);
    expect(fresh.revision).toBe(thread.revision);
    expect(value(await service.control({ threadId: sweep.id, action: "archiveInactive", inactiveBefore: 20_000 })).metadata?.archived).not.toBe(true);
  });

  it("requires a new idle view after work, even work completed in the same millisecond", async () => {
    const { service, directory } = fixture();
    const clock = vi.spyOn(Date, "now").mockReturnValue(10_000);
    const thread = value(await service.spawn({ requestId: "same-ms", cwd: directory }));
    value(await service.control({ threadId: thread.id, action: "view" }));
    value(await service.send({ requestId: "new-work", threadId: thread.id, text: "work" }));
    expect(value(await service.control({ threadId: thread.id, action: "view" })).metadata?.autoArchiveViewedAt).toBeUndefined();
    value(await service.cancelMessage(thread.id, "new-work"));
    expect(service.get(thread.id)?.state).toBe("idle");
    clock.mockReturnValue(3_620_000);
    expect(value(await service.control({ threadId: thread.id, action: "archiveInactive", inactiveBefore: 20_000 })).metadata?.archived).not.toBe(true);
    value(await service.control({ threadId: thread.id, action: "view" }));
    clock.mockReturnValue(7_240_000);
    expect(value(await service.control({ threadId: thread.id, action: "archiveInactive", inactiveBefore: 3_640_000 })).metadata?.archived).toBe(true);
  });

  it("persists idle views across owner restart and retains unviewed peers", async () => {
    const first = fixture(), workers = fixture(undefined, true);
    const clock = vi.spyOn(Date, "now").mockReturnValue(10_000);
    const thread = value(await first.service.spawn({ requestId: "durable-view", cwd: first.directory }));
    const worker = value(await workers.service.spawn({ requestId: "worker", cwd: workers.directory }));
    clock.mockReturnValue(20_000);
    const viewed = value(await first.service.control({ threadId: thread.id, action: "view" }));
    value(await first.service.close());
    const second = fixture(first.directory);
    value(await second.service.start());
    expect(second.service.get(thread.id)).toEqual(viewed);
    clock.mockReturnValue(3_630_000);
    expect(value(await second.service.control({ threadId: thread.id, action: "archiveInactive", inactiveBefore: 30_000 })).metadata?.archived).toBe(true);
    expect(value(await workers.service.control({ threadId: worker.id, action: "archiveInactive", inactiveBefore: 30_000 })).metadata?.archived).not.toBe(true);
  });

  it("uses each agent's own human view rather than its creator's view", async () => {
    const { service, directory } = fixture();
    const clock = vi.spyOn(Date, "now").mockReturnValue(10_000);
    const root = value(await service.spawn({ requestId: "root", cwd: directory }));
    const worker = value(await service.spawn({ requestId: "worker", parentId: root.id, cwd: directory }));
    value(await service.control({ threadId: root.id, action: "view" }));
    clock.mockReturnValue(3_620_000);
    value(await service.control({ threadId: worker.id, action: "view" }));
    expect(value(await service.control({ threadId: root.id, action: "archiveInactive", inactiveBefore: 20_000 })).metadata?.archived).toBe(true);
    expect(value(await service.control({ threadId: worker.id, action: "archiveInactive", inactiveBefore: 20_000 })).metadata?.archived).not.toBe(true);
    clock.mockReturnValue(7_240_000);
    expect(value(await service.control({ threadId: root.id, action: "archiveInactive", inactiveBefore: 3_640_000 })).metadata?.archived).toBe(true);
    expect(service.get(worker.id)?.metadata?.archived).not.toBe(true);
    expect(value(await service.control({ threadId: worker.id, action: "archiveInactive", inactiveBefore: 3_640_000 })).metadata?.archived).toBe(true);
  });

  it("rejects invalid or pre-activity view timestamps retained in imported metadata", async () => {
    const { service, directory } = fixture();
    vi.spyOn(Date, "now").mockReturnValue(3_620_000);
    for (const [index, viewedAt] of [undefined, null, "10000", 0, -1, 9999, 10000.5, Number.MAX_SAFE_INTEGER + 1].entries()) {
      const id = `invalid-view-${index}`;
      value(service.importThread({ id, title: id, cwd: directory, sessionFile: join(directory, `${id}.jsonl`),
        settings: { model: "openai-codex/gpt-6.1-sol", thinkingLevel: "high", speed: "standard" },
        createdAt: 10_000, updatedAt: 10_000, metadata: { autoArchiveViewedAt: viewedAt } }));
      expect(value(await service.control({ threadId: id, action: "archiveInactive", inactiveBefore: 20_000 })).metadata?.archived).not.toBe(true);
    }
  });

  it("rejects client-supplied view clocks and generic metadata tampering", async () => {
    const { service, directory } = fixture();
    expect(await service.spawn({ requestId: "forged", cwd: directory, metadata: { autoArchiveViewedAt: 1 } })).toMatchObject({ ok: false, error: { code: "invalid_request" } });
    const thread = value(await service.spawn({ requestId: "owned-view", cwd: directory }));
    expect(service.update(thread.id, { metadata: { autoArchiveViewedAt: 1 } })).toMatchObject({ ok: false, error: { code: "conflict" } });
    expect(await service.control({ threadId: thread.id, action: "view", autoArchiveViewedAt: 1 } as never)).toMatchObject({ ok: false, error: { code: "invalid_request" } });
    value(await service.control({ threadId: thread.id, action: "view" }));
    expect(await service.control({ threadId: thread.id, action: "update", metadata: { autoArchiveViewedAt: null } })).toMatchObject({ ok: false, error: { code: "conflict" } });
  });

  it("does not arm views during queued or running work, or pending owner operations", async () => {
    const { service, directory, sessions } = fixture();
    const thread = value(await service.spawn({ requestId: "busy-view", cwd: directory, message: "work" }));
    expect(value(await service.control({ threadId: thread.id, action: "view" })).metadata?.autoArchiveViewedAt).toBeUndefined();
    value(await service.start());
    await waitFor(() => sessions[0]?.isStreaming === true);
    const before = service.get(thread.id)!;
    expect(value(await service.control({ threadId: thread.id, action: "view" }))).toEqual(before);
    await settle(sessions[0]!, service, thread.id);
    await turn();
    const command = service.command(thread.id, { type: "get_state" });
    expect(value(await service.control({ threadId: thread.id, action: "view" })).metadata?.autoArchiveViewedAt).toBeUndefined();
    value(await command);
    await turn();
    const viewedAt = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(viewedAt);
    expect(value(await service.control({ threadId: thread.id, action: "view" })).metadata?.autoArchiveViewedAt).toBe(viewedAt);
  });

  it("does not arm idle views with held messages, questions, agent waits or scheduled wakes", async () => {
    const { service, directory } = fixture();
    const pending = value(await service.spawn({ requestId: "held", cwd: directory, message: "queued" }));
    value(await service.control({ threadId: pending.id, action: "stop", descendants: false }));
    const question = value(await service.spawn({ requestId: "question", cwd: directory }));
    value(await service.ask({ requestId: "ask", threadId: question.id, questions: [{ question: "Continue?" }] }));
    const waiting = value(await service.spawn({ requestId: "waiting", cwd: directory }));
    value(await service.agentWait({ requestId: "wait", threadId: waiting.id, action: "set", kind: "job", jobId: "external-result", reason: "External result" }));
    const waking = value(await service.spawn({ requestId: "waking", cwd: directory }));
    value(await service.wakeSchedule({ requestId: "wake", threadId: waking.id, action: "set", reason: "Check", cadenceMs: 60_000 }));
    for (const thread of [pending, question, waiting, waking]) {
      expect(service.get(thread.id)?.state).toBe(thread.id === waiting.id ? "waiting" : "idle");
      expect(value(await service.control({ threadId: thread.id, action: "view" })).metadata?.autoArchiveViewedAt).toBeUndefined();
    }
  });

  it("does not archive pending work or either explicit dependency endpoint", async () => {
    const { service, directory } = fixture();
    const clock = vi.spyOn(Date, "now").mockReturnValue(10_000);
    const parent = value(await service.spawn({ requestId: "parent-idle", cwd: directory }));
    const child = value(await service.spawn({ requestId: "child-held", parentId: parent.id, cwd: directory, message: "preserve this" }));
    value(await service.control({ threadId: parent.id, action: "dependencies", threadIds: [child.id] }));
    value(await service.control({ threadId: parent.id, action: "view" }));
    clock.mockReturnValue(3_620_000);
    for (const id of [parent.id, child.id]) expect(value(await service.control({ threadId: id, action: "archiveInactive", inactiveBefore: 20_000 })).metadata?.archived).not.toBe(true);
    expect(service.pending(child.id)).toHaveLength(1);
  });

  it("archives only the selected agent across owners and keeps launch provenance unchanged", async () => {
    const person = fixture(), fleet = fixture(undefined, true);
    const directory = new ThreadDirectory({ id: "person", api: person.service }, [{ id: "fleet", api: fleet.service }]);
    person.service.setDirectory(directory, (_parent, input) => input.requestId === "remote" ? fleet.service : undefined);
    fleet.service.setDirectory(directory);
    const clock = vi.spyOn(Date, "now").mockReturnValue(10_000);
    const root = value(await person.service.spawn({ requestId: "root", cwd: person.directory }));
    const local = value(await person.service.spawn({ requestId: "local", parentId: root.id, cwd: person.directory }));
    const remote = value(await directory.spawn({ requestId: "remote", parentId: root.id, cwd: person.directory }));
    expect(fleet.service.get(remote.id)).not.toBeNull();
    value(await directory.control({ threadId: root.id, action: "update", archived: true }));
    expect(person.service.get(root.id)?.metadata).toMatchObject({ archived: true, archivedAt: expect.any(String) });
    expect(person.service.get(local.id)?.metadata?.archived).not.toBe(true);
    expect(fleet.service.get(remote.id)?.metadata?.archived).not.toBe(true);
    const archivedAt = person.service.get(local.id)?.metadata?.archivedAt;
    await new Promise(resolve => setTimeout(resolve, 5));
    value(await directory.control({ threadId: root.id, action: "update", archived: true }));
    expect(person.service.get(local.id)?.metadata?.archivedAt).toBe(archivedAt);
    value(await directory.control({ threadId: root.id, action: "update", archived: false }));
    expect(person.service.get(root.id)?.metadata?.archived).not.toBe(true);
    expect(person.service.get(local.id)?.metadata?.archived).not.toBe(true);
    clock.mockReturnValue(3_700_000);
    const other = value(await person.service.spawn({ requestId: "other", cwd: person.directory }));
    const worker = value(await person.service.spawn({ requestId: "other-worker", parentId: other.id, cwd: person.directory }));
    value(await person.service.control({ threadId: other.id, action: "view" }));
    clock.mockReturnValue(7_400_000);
    expect(value(await person.service.control({ threadId: other.id, action: "archiveInactive", inactiveBefore: 7_300_000 })).metadata?.archived).toBe(true);
    expect(person.service.get(worker.id)?.metadata?.archived).not.toBe(true);
  });

  it("reopens only the closed agent without replaying or controlling other running peers", async () => {
    const person = fixture(), fleet = fixture(undefined, true);
    const directory = new ThreadDirectory({ id: "person", api: person.service }, [{ id: "fleet", api: fleet.service }]);
    person.service.setDirectory(directory, (_parent, input) => input.requestId === "remote" ? fleet.service : undefined);
    fleet.service.setDirectory(directory);
    const root = value(await person.service.spawn({ requestId: "root", cwd: person.directory, message: "Coordinate" }));
    const local = value(await person.service.spawn({ requestId: "local", parentId: root.id, cwd: person.directory, message: "Local work" }));
    const remote = value(await directory.spawn({ requestId: "remote", parentId: root.id, cwd: person.directory, message: "Remote work" }));
    const stopped = value(await person.service.spawn({ requestId: "stopped", parentId: root.id, cwd: person.directory, message: "Deliberately stopped" }));
    value(await person.service.control({ threadId: stopped.id, action: "stop", descendants: false }));
    value(await person.service.start()); value(await fleet.service.start());
    const streaming = (sessions: FakePiSession[], id: string) => sessions.some(session => session.options.threadId === id && session.isStreaming);
    await waitFor(() => streaming(person.sessions, root.id) && streaming(person.sessions, local.id) && streaming(fleet.sessions, remote.id));

    value(await directory.control({ threadId: root.id, action: "update", archived: true }));
    const owners = [[person.service, root.id], [person.service, local.id], [fleet.service, remote.id]] as const;
    expect(person.service.get(root.id)).toMatchObject({ state: "idle", held: false, metadata: { archived: true } });
    for (const [service, id] of owners.slice(1)) expect(service.get(id)).toMatchObject({ state: "running", held: false });
    expect(person.service.get(stopped.id)?.metadata?.archiveInterruption).toBeUndefined();
    expect(await directory.send({ requestId: "peer-message", threadId: local.id, senderId: remote.id, text: "More" })).toMatchObject({ ok: true });

    value(await directory.control({ threadId: root.id, action: "restore", descendants: true, resume: true }));
    expect(person.service.get(root.id)).toMatchObject({ held: false, state: "idle", pendingMessages: 0 });
    for (const [service, id] of owners.slice(1)) expect(service.get(id)).toMatchObject({ held: false, state: "running" });
    for (const native of [...person.sessions, ...fleet.sessions]) expect(native.commands.some(command => String(command.message ?? "").includes("archived while it was working"))).toBe(false);
    expect(person.service.get(stopped.id)).toMatchObject({ held: false, metadata: { archived: true } });
    expect(person.service.pending(stopped.id)).toHaveLength(0);
  });

  it("requires explicit reopen before any peer sends to a closed agent", async () => {
    const { service, directory } = fixture();
    const root = value(await service.spawn({ requestId: "root", cwd: directory }));
    const other = value(await service.spawn({ requestId: "other", cwd: directory }));
    const child = value(await service.spawn({ requestId: "child", parentId: root.id, cwd: directory, message: "queued work" }));
    value(await service.control({ threadId: root.id, action: "update", archived: true }));
    expect(service.get(child.id)?.metadata?.archived).not.toBe(true);
    value(await service.control({ threadId: child.id, action: "close" }));
    value(await service.control({ threadId: root.id, action: "restore", descendants: false }));
    expect(service.get(root.id)?.metadata?.archived).not.toBe(true);
    expect(service.get(child.id)).toMatchObject({ held: false, metadata: { archived: true } });

    const tool = (threadId: string) => threadTools({ threadId, cwd: directory, sessionFile: join(directory, `${threadId}.jsonl`), args: [], env: {}, threads: service }).find(item => item.name === "thread_send")!;
    const refused = await tool(other.id).execute("call-other", { threadId: child.id, text: "Not yours" }, undefined, undefined, undefined as never);
    expect(refused.details).toMatchObject({ ok: false, error: { code: "unavailable", message: expect.stringContaining("Reopen") } });
    expect(service.get(child.id)?.metadata?.archived).toBe(true);
    expect((await tool(root.id).execute("call-root", { threadId: child.id, text: "Carry on" }, undefined, undefined, undefined as never)).details).toMatchObject({ ok: false });
    value(await service.control({ threadId: child.id, action: "reopen" }));
    const sent = await tool(root.id).execute("call-fresh", { threadId: child.id, text: "Fresh work" }, undefined, undefined, undefined as never);
    expect(sent.details).toMatchObject({ ok: true, value: { threadId: child.id, senderId: root.id } });
    expect(service.get(child.id)).toMatchObject({ held: false, state: "running", pendingMessages: 1 });
    expect(service.get(child.id)?.metadata?.archiveInterruption).toBeUndefined();

    // A deliberate stop after an archive is final: resume must not undo it.
    value(await service.control({ threadId: root.id, action: "update", archived: true }));
    value(await service.control({ threadId: child.id, action: "stop", descendants: false }));
    value(await service.control({ threadId: root.id, action: "restore", descendants: true, resume: true }));
    expect(service.get(child.id)).toMatchObject({ held: false, metadata: { archived: true } });
  });

  it("rechecks activity after a stale sweep snapshot and never stops a running model", async () => {
    const { service, directory, sessions } = fixture();
    await service.start();
    const clock = vi.spyOn(Date, "now").mockReturnValue(10_000);
    const thread = value(await service.spawn({ requestId: "race", cwd: directory }));
    value(await service.control({ threadId: thread.id, action: "view" }));
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
    expect(parent.settings).toEqual({ model: "openai-codex/gpt-6-luna", thinkingLevel: "max", speed: "standard" });
    const defaultChild = value(await service.spawn({ requestId: "default-child", id: "default-child", parentId: parent.id, cwd: directory, message: "first assignment" }));
    const lunaChild = value(await service.spawn({ requestId: "luna-child", id: "luna-child", parentId: parent.id, cwd: directory, message: "second assignment", settings: { model: "luna" }, admission: "background" }));
    value(await service.control({ threadId: parent.id, action: "stop", descendants: false }));
    await waitFor(() => sessions.length === 2 && sessions.every(session => session.commands.some(command => command.type === "prompt")));

    expect(defaultChild.settings).toEqual({ model: "openai-codex/gpt-6.1-sol", thinkingLevel: "high", speed: "standard" });
    expect(lunaChild.settings).toEqual({ model: "openai-codex/gpt-6-luna", thinkingLevel: "max", speed: "standard" });
    expect([defaultChild.admission, lunaChild.admission]).toEqual(["force", "force"]);
    expect(defaultChild.metadata).toMatchObject({ meetingId: "room", profileId: "personal" });
    expect(defaultChild.metadata?.nativeHistoryRequired).toBeUndefined();
    expect(new Set(sessions.map(session => session.options.sessionFile)).size).toBe(2);
    expect(sessions.map(session => session.options.env.PI_THREAD_REQUIRE_SESSION)).toEqual(["0", "0"]);
    expect(sessions.map(session => session.options.args)).toEqual(expect.arrayContaining([
      ["--provider", "openai-codex", "--model", "gpt-6.1-sol", "--thinking", "high", "--name", defaultChild.title],
      ["--provider", "openai-codex", "--model", "gpt-6-luna", "--thinking", "max", "--name", lunaChild.title],
    ]));

    for (const session of sessions) session.settle(`complete ${session.options.threadId}`);
    await waitFor(() => [defaultChild.id, lunaChild.id].every(id => service.get(id)?.state === "idle"));
  });

  it("keeps discarded input receipts across restart without replay on legacy resume", async () => {
    const first = fixture();
    const thread = value(await first.service.spawn({ requestId: "thread", id: "thread", cwd: first.directory }));
    const input = { requestId: "queued", threadId: thread.id, text: "durable input", delivery: "queue" as const };
    value(await first.service.send(input));
    value(await first.service.control({ threadId: thread.id, action: "close" }));
    expect(first.service.pending(thread.id)).toEqual([]);
    value(await first.service.close());
    const second = fixture(first.directory);
    expect(value(await second.service.send(input))).toMatchObject({ state: "done", outcome: "cancelled" });
    value(await second.service.control({ threadId: thread.id, action: "resume" }));
    value(await second.service.start()); await turn();
    expect(second.sessions).toHaveLength(0);
    expect(second.service.get(thread.id)).toMatchObject({ state: "idle", held: false, pendingMessages: 0 });
  });

  it("retains readable replies to a closed requester without replay or native final-message mutation", async () => {
    const first = fixture();
    await first.service.start();
    const parent = value(await first.service.spawn({ requestId: "parent", id: "parent", cwd: first.directory }));
    const child = value(await first.service.spawn({ requestId: "child-work", id: "child", parentId: parent.id, cwd: first.directory, message: "child task" }));
    value(await first.service.control({ threadId: parent.id, action: "stop", descendants: false }));
    await waitFor(() => first.sessions[0]?.commands.some(command => command.type === "prompt"));
    const finalMessage = signedFinalMessage();
    const nativeFinalMessage = structuredClone(finalMessage);
    first.sessions[0]!.settleMessage(finalMessage);
    await waitFor(() => first.service.latestSettlement(child.id) !== null);
    const settlement = first.service.latestSettlement(child.id)!;
    expect(settlement.finalMessage).toEqual(nativeFinalMessage);
    expect(finalMessage).toEqual(nativeFinalMessage);
    const receiptDb = new DatabaseSync(join(first.directory, "threads.sqlite"));
    const notification = receiptDb.prepare("SELECT id,text,status FROM thread_work WHERE thread_id=? AND sender_id=? AND source='notification'").get(parent.id, child.id) as { id: string; text: string; status: string };
    receiptDb.close();
    expect(notification.status).toBe("done");
    expectReadableCompletion(notification.text);
    expect(JSON.parse(notification.text)).toEqual({
      type: "thread_idle", title: child.title, outcome: "complete", finalText: "Readable child result",
    });
    const db = new DatabaseSync(join(first.directory, "threads.sqlite"));
    try {
      const work = db.prepare("SELECT final_message FROM thread_work WHERE id=?").get("child-work") as { final_message: string };
      expect(JSON.parse(work.final_message)).toEqual(nativeFinalMessage);
    } finally { db.close(); }
    expect(first.service.get(parent.id)).toMatchObject({ state: "idle", held: false, metadata: { archived: true } });
    expect(first.service.pending(parent.id)).toEqual([]);
    value(await first.service.close());
    const reopened = fixture(first.directory);
    value(await reopened.service.control({ action: "reopen", threadId: parent.id }));
    value(await reopened.service.start()); await turn();
    expect(reopened.service.pending(parent.id)).toEqual([]);
    expect(reopened.sessions).toHaveLength(0);
    expect(reopened.service.latestSettlement(child.id)?.finalMessage).toEqual(nativeFinalMessage);
  });

  it("migrates collapsed thread, message, and execution state without disturbing active work", async () => {
    const first = fixture();
    const settings = { model: "openai-codex/gpt-6-astra", thinkingLevel: "high" as const, speed: "standard" as const };
    value(first.service.importThread({ id: "active", title: "active", cwd: first.directory, sessionFile: join(first.directory, "active.jsonl"), settings }));
    value(first.service.importMessage({ id: "dispatching", threadId: "active", text: "accepted", state: "dispatched", executionId: "active-execution" }));
    value(first.service.importThread({ id: "inserted", title: "inserted", cwd: first.directory, sessionFile: join(first.directory, "inserted.jsonl"), settings }));
    value(first.service.importMessage({ id: "inserted-work", threadId: "inserted", text: "accepted", state: "dispatched", executionId: "inserted-execution", insertedAt: 123 }));
    value(first.service.importThread({ id: "held", title: "held", cwd: first.directory, sessionFile: join(first.directory, "held.jsonl"), settings, held: true }));
    value(first.service.importMessage({ id: "queued", threadId: "held", text: "preserve", state: "queued" }));
    value(await first.service.detach());

    const databasePath = join(first.directory, "threads.sqlite");
    const old = new DatabaseSync(databasePath);
    old.exec(`DROP INDEX thread_execution_active;
      ALTER TABLE thread_execution ADD COLUMN state TEXT NOT NULL DEFAULT 'running';
      CREATE UNIQUE INDEX thread_execution_active ON thread_execution(thread_id) WHERE state='running';
      UPDATE thread SET state='stopped' WHERE id='held';
      UPDATE thread_work SET status='dispatching' WHERE id='dispatching';
      UPDATE thread_work SET status='inserted' WHERE id='inserted-work'`);
    old.close();

    const migrated = fixture(first.directory);
    expect(migrated.service.get("held")).toMatchObject({ state: "idle", held: true });
    expect(migrated.service.get("active")?.state).toBe("running");
    const db = new DatabaseSync(databasePath);
    try {
      expect((db.prepare("PRAGMA table_info(thread_execution)").all() as { name: string }[]).map(column => column.name)).not.toContain("state");
      expect(db.prepare("SELECT id,status,inserted_at FROM thread_work WHERE id IN ('dispatching','inserted-work') ORDER BY id").all()).toEqual([
        { id: "dispatching", status: "dispatched", inserted_at: null },
        { id: "inserted-work", status: "dispatched", inserted_at: 123 },
      ]);
      expect(db.prepare("SELECT ended_at FROM thread_execution WHERE id='active-execution'").get()).toEqual({ ended_at: null });
      expect(() => db.prepare("INSERT INTO thread_execution(id,thread_id,work_id,settings,created_at) VALUES('duplicate','active','duplicate','{}',0)").run()).toThrow();
    } finally { db.close(); }
    value(await migrated.service.detach());
    const reopened = fixture(first.directory);
    expect(reopened.service.get("held")).toMatchObject({ state: "idle", held: true });
  });

  it("normalizes unknown stored phases without losing active execution or held input", async () => {
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
    expect(second.service.get("active")).toMatchObject({ state: "idle", held: false, metadata: { archived: true } });
    expect(second.service.pending("active")).toEqual([]);
    expect(second.sessions).toHaveLength(0);
  });

  it("halts retained execution without cwd, credentials, admission or session initialization", async () => {
    const directory = mkdtempSync(join(tmpdir(), "thread-cold-halt-")); roots.push(directory);
    const openSession = vi.fn(async () => { throw new Error("Stop must not initialize a session"); });
    const admit = vi.fn(async () => { throw new Error("Stop must not request admission"); });
    const attachSession = vi.fn(async () => null);
    const service = new ThreadService({ capacity: { mode: "unmanaged" }, databasePath: join(directory, "threads.sqlite"), sessionsDir: directory, openSession, admit, attachSession }); services.push(service);
    const reference = { control: "/absent/runner.sock", socketPath: "/absent/session.sock" };
    value(service.importThread({ id: "gone", title: "gone", cwd: "/reclaimed/checkout", sessionFile: "/missing/session.jsonl", metadata: { runnerReference: reference }, settings: { model: "openai-codex/gpt-6-astra", thinkingLevel: "high", speed: "standard" } }));
    value(service.importMessage({ id: "accepted", threadId: "gone", text: "work", state: "dispatched" }));
    value(service.importMessage({ id: "next", threadId: "gone", text: "keep", state: "queued" }));
    expect(value(await service.control({ threadId: "gone", action: "stop", descendants: false }))).toMatchObject({ state: "idle", held: false, metadata: { archived: true } });
    expect(attachSession).toHaveBeenCalledWith(reference, expect.any(Function), expect.any(Function));
    expect(openSession).not.toHaveBeenCalled(); expect(admit).not.toHaveBeenCalled();
    expect(service.latestSettlement("gone")?.outcome).toBe("cancelled");
    expect(service.pending("gone")).toEqual([]);
  });

  it("uses active-branch native landing receipts during cold Stop after owner crash", async () => {
    const directory = mkdtempSync(join(tmpdir(), "thread-cold-receipts-")); roots.push(directory);
    const openSession = vi.fn(async () => { throw new Error("Cold Stop must not initialize a session"); });
    const admit = vi.fn(async () => { throw new Error("Cold Stop must not request admission"); });
    const attachSession = vi.fn(async () => null);
    const service = new ThreadService({ capacity: { mode: "unmanaged" }, databasePath: join(directory, "threads.sqlite"), sessionsDir: directory, openSession, admit, attachSession }); services.push(service);
    const reference = { control: "/absent/runner.sock", socketPath: "/absent/session.sock" };
    const sessionFile = join(directory, "crashed.jsonl");
    value(service.importThread({ id: "crashed", title: "crashed", cwd: "/reclaimed/checkout", sessionFile, metadata: { runnerReference: reference }, settings: { model: "astra", thinkingLevel: "high", speed: "standard" } }));
    for (const id of ["active", "landed", "unlanded"]) value(service.importMessage({
      id, threadId: "crashed", text: `Input ${id}`, state: "dispatched", executionId: "crashed-execution", insertedAt: 123,
    }));
    writeFileSync(sessionFile, [
      { type: "session", id: "native-session", version: 3, timestamp: "2026-10-04T00:00:00.000Z", cwd: directory },
      { type: "custom", id: "active-input", parentId: null, customType: "thread_input", data: { workId: "active", receiptVersion: 2 } },
      { type: "custom", id: "active-landed", parentId: "active-input", customType: "thread_landed", data: { workId: "active" } },
      { type: "custom", id: "steer-input", parentId: "active-landed", customType: "thread_input", data: { workId: "landed", receiptVersion: 2 } },
      { type: "message", id: "steer-message", parentId: "steer-input", message: { role: "user", content: [{ type: "text", text: "Input landed" }], timestamp: 123 } },
      { type: "custom", id: "steer-landed", parentId: "steer-message", customType: "thread_landed", data: { workId: "landed" } },
      { type: "custom", id: "other-branch-landed", parentId: "active-landed", customType: "thread_landed", data: { workId: "unlanded" } },
      { type: "custom", id: "undelivered-input", parentId: "steer-landed", customType: "thread_input", data: { workId: "unlanded", receiptVersion: 2 } },
    ].map(entry => JSON.stringify(entry)).join("\n") + "\n");
    expect(service.pending("crashed")).toMatchObject([
      { id: "active", state: "dispatched", landedAt: null },
      { id: "landed", state: "dispatched", insertedAt: 123, landedAt: null },
      { id: "unlanded", state: "dispatched", insertedAt: 123, landedAt: null },
    ]);

    expect(value(await service.control({ threadId: "crashed", action: "stop", descendants: false }))).toMatchObject({ state: "idle", held: false, metadata: { archived: true } });
    expect(attachSession).toHaveBeenCalledWith(reference, expect.any(Function), expect.any(Function));
    expect(openSession).not.toHaveBeenCalled(); expect(admit).not.toHaveBeenCalled();
    expect(service.latestSettlement("crashed")?.outcome).toBe("cancelled");
    expect(service.pending("crashed")).toEqual([]);
    const db = new DatabaseSync(join(directory, "threads.sqlite"));
    try {
      expect(db.prepare("SELECT id,status,outcome,landed_at FROM thread_work ORDER BY ordinal").all()).toEqual([
        { id: "active", status: "done", outcome: "cancelled", landed_at: expect.any(Number) },
        { id: "landed", status: "done", outcome: "cancelled", landed_at: expect.any(Number) },
        { id: "unlanded", status: "done", outcome: "cancelled", landed_at: null },
      ]);
    } finally { db.close(); }
  });

  it("deduplicates halt and does not mark the thread idle before native acknowledgement", async () => {
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
    expect(service.pending(thread.id).find(message => message.id === "pending")?.state).toBe("queued");
    expect(native.closed).toBe(false);
    release();
    expect(value(await first)).toMatchObject({ state: "idle", held: false, pendingMessages: 0, metadata: { archived: true } });
    expect(value(await second)).toMatchObject({ state: "idle", held: false, pendingMessages: 0, metadata: { archived: true } });
    expect(aborts).toBe(1);
    expect(native.closed).toBe(true);
    value(await service.control({ threadId: thread.id, action: "reopen" })); await turn();
    expect(sessions).toHaveLength(1);
    value(await service.send({ requestId: "fresh", threadId: thread.id, text: "Fresh work" }));
    await waitFor(() => sessions[1]?.commands.some(input => input.workId === "fresh") === true);
    expect(sessions[1]!.commands.some(input => input.workId === "pending")).toBe(false);
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
    await waitFor(() => sessions[1]?.commands.some(input => input.workId === "later") === true);
    expect(sessions).toHaveLength(2);
    await settle(sessions[1]!, service, thread.id);
  });

  it.each(["send", "promoteMessage"] as const)("preserves accepted but unlanded steers when %s hard steers the thread", async action => {
    let preparations = 0;
    const prepareMessage = vi.fn<NonNullable<ThreadServiceOptions["prepareMessage"]>>(async (_thread, message) => ({
      ok: true,
      value: { text: `${message.text}\nPrepared context ${++preparations}`, images: [{ type: "image", data: `prepared-${message.id}`, mimeType: "image/png" }] },
    }));
    const { service, directory, sessions } = fixture(undefined, false, prepareMessage);
    value(await service.start());
    const thread = value(await service.spawn({ requestId: "active", cwd: directory, message: "Already running" }));
    await waitFor(() => service.pending(thread.id)[0]?.landedAt != null);
    value(await service.send({ requestId: "landed", threadId: thread.id, text: "Already delivered" }));
    await waitFor(() => service.pending(thread.id).find(message => message.id === "landed")?.insertedAt != null);
    const native = sessions[0]!;
    const landed = native.commands.find(command => command.workId === "landed")!;
    native.emit({ type: "message_start", ...(action === "send" ? { inputWorkId: "landed" } : {}),
      message: { role: "user", content: [{ type: "text", text: action === "send" ? "Input transformed by an extension" : String(landed.message) }] } });
    expect(service.pending(thread.id).find(message => message.id === "landed")?.landedAt).toEqual(expect.any(Number));

    const accepted = new Map<string, PiCommand>();
    for (const id of ["first", "second"]) {
      value(await service.send({ requestId: id, threadId: thread.id, senderId: "worker", text: `Undelivered ${id}` }));
      await waitFor(() => service.pending(thread.id).find(message => message.id === id)?.insertedAt != null);
      expect(service.pending(thread.id).find(message => message.id === id)).toMatchObject({ state: "dispatched", insertedAt: expect.any(Number), landedAt: null });
      accepted.set(id, native.commands.find(command => command.workId === id)!);
      if (id === "first") value(await service.send({ requestId: "later", threadId: thread.id, text: "Ordinary queued input", delivery: "queue" }));
    }
    if (action === "send") {
      value(await service.send({ requestId: "now", threadId: thread.id, text: "Urgent replacement", delivery: "hardSteer" }));
    } else {
      value(await service.send({ requestId: "now", threadId: thread.id, text: "Urgent replacement", delivery: "queue" }));
      value(await service.control({ threadId: thread.id, action: "promoteMessage", messageId: "now", delivery: "hardSteer" }));
    }
    await waitFor(() => sessions[1]?.commands.some(command => command.workId === "now") === true);
    expect(native.closed).toBe(true);
    expect(native.commands.filter(command => command.type === "abort")).toHaveLength(1);
    expect(service.latestSettlement(thread.id)?.outcome).toBe("cancelled");
    expect(service.pending(thread.id).map(message => message.id)).toEqual(["now", "first", "later", "second"]);
    await waitFor(() => sessions[1]!.commands.some(command => command.workId === "second"));
    const replayed = sessions[1]!.commands.filter(command => ["prompt", "steer"].includes(command.type));
    expect(replayed.map(command => command.workId)).toEqual(["now", "first", "second"]);
    for (const id of accepted.keys()) {
      const replay = replayed.find(command => command.workId === id)!;
      expect(replay).toMatchObject({ type: "steer", workId: id, message: accepted.get(id)!.message, images: accepted.get(id)!.images });
      expect(prepareMessage.mock.calls.filter(([, message]) => message.id === id)).toHaveLength(1);
      sessions[1]!.emit({ type: "message_start", message: { role: "user", content: [{ type: "text", text: String(replay.message) }] } });
    }
    sessions[1]!.settle("Urgent work and retained steers handled");
    await waitFor(() => sessions[1]?.commands.some(command => command.workId === "later") === true);
    expect(sessions).toHaveLength(2);
    await settle(sessions[1]!, service, thread.id);
    const inputs = sessions.flatMap(session => session.commands.filter(command => ["prompt", "steer"].includes(command.type)));
    expect(inputs.map(command => command.workId)).toEqual(["active", "landed", "first", "second", "now", "first", "second", "later"]);
    expect(service.pending(thread.id)).toEqual([]);
  });

  it("lets hard-steer halt own settlement when abort rejects an in-flight steer acknowledgement", async () => {
    const { service, directory, sessions } = fixture();
    value(await service.start());
    const thread = value(await service.spawn({ requestId: "active", cwd: directory, message: "Already running" }));
    await waitFor(() => service.pending(thread.id)[0]?.landedAt != null);
    const native = sessions[0]!, command = native.command.bind(native);
    let waiting: PiCommand | undefined;
    native.command = async input => {
      if (input.type === "steer") {
        native.commands.push(input);
        native.acceptedWorkIds.add(String(input.workId));
        native.pendingMessageCount = 1;
        waiting = input;
        return;
      }
      if (input.type === "abort" && waiting) {
        native.emit({ type: "response", id: waiting.id, command: "steer", success: false, error: "Input acknowledgement cancelled by abort" });
        await turn();
      }
      await command(input);
    };
    value(await service.send({ requestId: "waiting", threadId: thread.id, text: "Accepted input awaiting acknowledgement" }));
    await waitFor(() => !!waiting);
    expect(service.pending(thread.id).find(message => message.id === "waiting")).toMatchObject({ state: "dispatched", insertedAt: null, landedAt: null });
    value(await service.send({ requestId: "now", threadId: thread.id, text: "Urgent replacement", delivery: "hardSteer" }));
    await waitFor(() => sessions[1]?.commands.some(input => input.workId === "waiting") === true);
    expect(native.closed).toBe(true);
    expect(native.commands.filter(input => input.type === "abort")).toHaveLength(1);
    expect(service.latestSettlement(thread.id)?.outcome).toBe("cancelled");
    expect(service.get(thread.id)?.metadata?.executionError).toBeUndefined();
    const replayed = sessions[1]!.commands.filter(input => ["prompt", "steer"].includes(input.type));
    expect(replayed.map(input => input.workId)).toEqual(["now", "waiting"]);
    expect(replayed[1]).toMatchObject({ type: "steer", workId: "waiting", message: waiting!.message, images: waiting!.images });
    sessions[1]!.emit({ type: "message_start", message: { role: "user", content: [{ type: "text", text: String(replayed[1]!.message) }] } });
    await settle(sessions[1]!, service, thread.id);
    expect(service.pending(thread.id)).toEqual([]);
    const db = new DatabaseSync(join(directory, "threads.sqlite"));
    try {
      expect(db.prepare("SELECT outcome FROM thread_execution ORDER BY created_at,rowid").all()).toEqual([{ outcome: "cancelled" }, { outcome: "complete" }]);
    } finally { db.close(); }
  });

  it("discards accepted but unlanded steers on close without losing receipts or replaying after restart", async () => {
    let preparations = 0;
    const prepareMessage = vi.fn<NonNullable<ThreadServiceOptions["prepareMessage"]>>(async (_thread, message) => ({
      ok: true,
      value: { text: `${message.text}\nPrepared context ${++preparations}`, images: [{ type: "image", data: `prepared-${message.id}`, mimeType: "image/png" }] },
    }));
    const first = fixture(undefined, false, prepareMessage);
    value(await first.service.start());
    const thread = value(await first.service.spawn({ requestId: "active", cwd: first.directory, message: "Already running" }));
    await waitFor(() => first.service.pending(thread.id)[0]?.landedAt != null);
    const native = first.sessions[0]!;
    native.emit({ type: "message_update", emittedAt: 10, assistantMessageEvent: { type: "thinking_delta", delta: "reason" } });
    const accepted = new Map<string, PiCommand>();
    for (const id of ["landed", "first", "second"]) {
      value(await first.service.send({ requestId: id, threadId: thread.id, senderId: "worker", text: `Input ${id}` }));
      await waitFor(() => first.service.pending(thread.id).find(message => message.id === id)?.insertedAt != null);
      const command = native.commands.find(command => command.workId === id)!;
      if (id === "landed") {
        native.emit({ type: "message_start", inputWorkId: id, message: { role: "user", content: [{ type: "text", text: "Transformed by an input extension" }] } });
        expect(first.service.pending(thread.id).find(message => message.id === id)?.landedAt).toEqual(expect.any(Number));
      } else {
        expect(first.service.pending(thread.id).find(message => message.id === id)).toMatchObject({ state: "dispatched", insertedAt: expect.any(Number), landedAt: null });
        accepted.set(id, command);
      }
    }
    expect(first.service.live(thread.id)).toMatchObject({ activity: "thinking", activitySince: 10, isThinking: true });
    expect(value(await first.service.control({ threadId: thread.id, action: "stop", descendants: false }))).toMatchObject({ state: "idle", held: false, metadata: { archived: true } });
    expect(first.service.get(thread.id)?.executionActivity?.activity).toBeUndefined();
    expect(native.closed).toBe(true);
    expect(native.commands.filter(command => command.type === "abort")).toHaveLength(1);
    expect(first.service.pending(thread.id)).toEqual([]);
    const receiptDb = new DatabaseSync(join(first.directory, "threads.sqlite"));
    try {
      for (const id of accepted.keys()) {
        const work = receiptDb.prepare("SELECT status,outcome,prepared,landed_at FROM thread_work WHERE id=?").get(id) as { status: string; outcome: string; prepared: string; landed_at: number | null };
        expect(work).toMatchObject({ status: "done", outcome: "cancelled", landed_at: null });
        const prepared = JSON.parse(work.prepared);
        expect(accepted.get(id)!.message).toContain(prepared.text);
        expect(prepared.images).toEqual(accepted.get(id)!.images);
      }
    } finally { receiptDb.close(); }
    first.service.reconcile(); await turn(); await turn();
    expect(first.sessions).toHaveLength(1);
    value(await first.service.close());

    const restored = fixture(first.directory, false, prepareMessage);
    value(await restored.service.start());
    restored.service.reconcile(); await turn(); await turn();
    expect(restored.service.get(thread.id)).toMatchObject({ state: "idle", held: false, pendingMessages: 0, metadata: { archived: true } });
    expect(restored.service.get(thread.id)?.executionActivity?.activity).toBeUndefined();
    value(await restored.service.control({ threadId: thread.id, action: "resume" }));
    restored.service.reconcile(); await turn(); await turn();
    expect(restored.sessions).toHaveLength(0);
    for (const id of accepted.keys()) expect(prepareMessage.mock.calls.filter(([, message]) => message.id === id)).toHaveLength(1);
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
    await waitFor(() => service.get(thread.id)?.state === "idle" && service.get(thread.id)?.metadata?.archived === true);
    expect(service.pending(thread.id)).toEqual([]);
    expect(service.get(thread.id)?.metadata?.executionError).toBeUndefined();
  });

  it("hard steers a native command without waiting behind that command's serial operation", async () => {
    const directory = mkdtempSync(join(tmpdir(), "thread-command-halt-")); roots.push(directory);
    let native: FakePiSession | undefined, release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const sessions: FakePiSession[] = [];
    const service = new ThreadService({ capacity: { mode: "unmanaged" }, databasePath: join(directory, "threads.sqlite"), sessionsDir: join(directory, "sessions"),
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
    const service = new ThreadService({ capacity: { mode: "unmanaged" }, databasePath: join(directory, "threads.sqlite"), sessionsDir: join(directory, "sessions"),
      openSession: async (options, output) => { native = new FakePiSession(options, output); await gate; return native; } });
    services.push(service); await service.start();
    const thread = value(await service.spawn({ requestId: "pending", cwd: directory, message: "work" }));
    await waitFor(() => !!native);
    const stopped = service.control({ threadId: thread.id, action: "stop", descendants: false });
    release();
    expect(value(await stopped)).toMatchObject({ state: "idle", held: false, metadata: { archived: true } });
    expect(native!.commands.some(input => input.type === "prompt")).toBe(false);
    expect(service.pending(thread.id)).toEqual([]);
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

  it("defaults all inputs to steer while retaining explicit human queues and agent choices", async () => {
    const { directory, service } = fixture();
    const parent = value(await service.spawn({ requestId: "parent", cwd: directory, message: "Coordinate" }));
    const child = value(await service.spawn({ requestId: "child", cwd: directory, parentId: parent.id, message: "Assignment" }));
    expect(service.pending(parent.id)[0]?.delivery).toBe("steer");
    expect(service.pending(child.id)[0]?.delivery).toBe("steer");
    const agent = { requestId: "agent", threadId: parent.id, senderId: child.id, text: "Progress" };
    expect(value(await service.send(agent)).delivery).toBe("steer");
    expect(value(await service.send({ ...agent, delivery: "steer" })).id).toBe("agent");
    expect(value(await service.send({ requestId: "human", threadId: parent.id, text: "More work" })).delivery).toBe("steer");
    expect(value(await service.send({ requestId: "human-queue", threadId: parent.id, text: "Later work", delivery: "queue" })).delivery).toBe("queue");
    expect(await service.send({ ...agent, requestId: "queue", delivery: "queue" })).toMatchObject({ ok: false, error: { code: "invalid_request", message: expect.stringContaining("steer or hard steer") } });
    for (const delivery of ["steer", "hardSteer"] as const) {
      expect(value(await service.send({ ...agent, requestId: delivery, delivery })).delivery).toBe(delivery);
    }
  });

  it("steers a running thread by default and records landing only when Pi starts the user message", async () => {
    const { directory, service, sessions } = fixture();
    const thread = value(await service.spawn({ requestId: "root", cwd: directory, message: "Coordinate" }));
    await service.start();
    await waitFor(() => sessions[0]?.commands.some(command => command.type === "prompt") ?? false);
    expect(service.pending(thread.id)[0]?.landedAt).toEqual(expect.any(Number));
    value(await service.send({ requestId: "steer", threadId: thread.id, text: "Result" }));
    await waitFor(() => sessions[0]!.commands.some(command => command.type === "steer"));
    const steer = service.pending(thread.id).find(message => message.id === "steer")!;
    expect(steer).toMatchObject({ state: "dispatched", insertedAt: expect.any(Number), landedAt: null });
    const message = String(sessions[0]!.commands.find(command => command.type === "steer")!.message);
    sessions[0]!.emit({ type: "message_start", message: { role: "user", content: [{ type: "text", text: message }] } });
    expect(service.pending(thread.id).find(message => message.id === "steer")?.landedAt).toEqual(expect.any(Number));
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

  it.each(["queued", "dispatched"] as const)("projects a persisted %s completion with prepared meeting context on recovery", async state => {
    const first = fixture();
    const parent = value(await first.service.spawn({ requestId: "parent", cwd: first.directory }));
    const finalMessage = signedFinalMessage();
    const error = "Model not found: private/removed-model";
    const report = { type: "thread_idle", threadId: "child", workId: "child-work", executionId: "child-execution", outcome: "failed", finalMessage, error };
    const rawText = JSON.stringify(report);
    const meetingContext = "\n\nMeeting context: keep this appended context.";
    value(first.service.importMessage({
      id: "persisted-completion", threadId: parent.id, senderId: "child", source: "notification", replyTo: "child-work",
      text: rawText, state, ...(state === "dispatched" ? { insertedAt: Date.now() } : {}),
    }));
    value(await first.service.detach());
    const db = new DatabaseSync(join(first.directory, "threads.sqlite"));
    try {
      db.prepare("UPDATE thread_work SET prepared=? WHERE id=?").run(JSON.stringify({ text: rawText + meetingContext, images: [] }), "persisted-completion");
    } finally { db.close(); }

    const second = fixture(first.directory);
    value(await second.service.start());
    await waitFor(() => second.sessions[0]?.commands.some(command => command.workId === "persisted-completion") === true);
    const command = second.sessions[0]!.commands.find(command => command.workId === "persisted-completion")!;
    if (state === "dispatched") expect(command.resume).toBe(true);
    const text = String(command.message);
    expectReadableCompletion(text);
    expect(text).toContain(meetingContext);
    expect(text.match(/<agent_message>/g)).toHaveLength(1);
    expect(JSON.parse(text.split("\n")[2]!)).toEqual({ senderThreadId: "child" });
    const body = JSON.parse(text.split("\n")[4]!);
    expect(body).toEqual({ type: "thread_idle", outcome: "failed", finalText: "Readable child result", error });
    await settle(second.sessions[0]!, second.service, parent.id);
  });

  it("does not replay an imported completed message", async () => {
    const { directory, service, sessions } = fixture();
    value(service.importThread({ id: "complete-thread", title: "Complete", cwd: directory, sessionFile: join(directory, "complete.jsonl"), settings: { model: "astra", thinkingLevel: "high", speed: "standard" } }));
    value(service.importMessage({ id: "completed-work", threadId: "complete-thread", text: "already handled", state: "done", outcome: "complete", finalMessage: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "finished" }] } }));

    await service.start();
    await turn();
    await turn();
    expect(service.pending("complete-thread")).toHaveLength(0);
    expect(service.get("complete-thread")?.state).toBe("idle");
    expect(sessions).toHaveLength(0);
  });
});

it("passes a raw thread to its Pi session as --raw and rejects incompatible raw metadata", async () => {
  const { service, directory, sessions } = fixture();
  await service.start();
  const raw = value(await service.spawn({ requestId: "raw", cwd: directory, message: "hello", settings: { model: "sol" }, metadata: { raw: true } }));
  await waitFor(() => sessions.length === 1);
  expect(sessions[0]!.options.args).toContain("--raw");
  expect(raw.metadata).toMatchObject({ raw: true });
  const plain = value(await service.spawn({ requestId: "plain", cwd: directory, message: "hello", settings: { model: "sol" } }));
  await waitFor(() => sessions.length === 2);
  expect(sessions[1]!.options.args).not.toContain("--raw");
  expect(plain.metadata?.raw).toBeUndefined();
  expect(await service.spawn({ requestId: "raw-false", cwd: directory, metadata: { raw: false } })).toMatchObject({ ok: false, error: { code: "invalid_request" } });
  expect(await service.spawn({ requestId: "raw-isolated", cwd: directory, metadata: { raw: true, context: { tools: [] } } })).toMatchObject({ ok: false, error: { code: "invalid_request" } });
  expect(await service.spawn({ requestId: "raw-repair", cwd: directory, metadata: { raw: true, execution: "root-repair" } })).toMatchObject({ ok: false, error: { code: "invalid_request" } });
  expect(service.importThread({ id: "imported-raw", title: "Raw", cwd: directory, sessionFile: join(directory, "imported-raw.jsonl"), settings: { model: "openai-codex/gpt-6-sol", thinkingLevel: "high", speed: "standard" }, metadata: { raw: "yes" } }))
    .toMatchObject({ ok: false, error: { code: "invalid_request" } });
});

it("allocates separate workspaces, launches sandbox sessions, and refuses boundary changes", async () => {
  const { service, directory, sessions } = fixture();
  await service.start();
  const sandbox = value(await service.spawn({ requestId: "sandbox", cwd: directory, message: "hello", metadata: { raw: true, sandbox: true } }));
  await waitFor(() => sessions.length === 1);
  expect(sandbox.cwd).toBe(join(directory, "sessions", "sandboxes", sandbox.id));
  expect(sessions[0]!.options).toMatchObject({ cwd: sandbox.cwd, env: { PI_THREAD_CAN_SPAWN: "0" } });
  expect(sessions[0]!.options.args).toEqual(expect.arrayContaining(["--raw", "--sandbox"]));
  const second = value(await service.spawn({ requestId: "second-sandbox", cwd: directory, metadata: { raw: true, sandbox: true } }));
  expect(second.cwd).not.toBe(sandbox.cwd);
  for (const metadata of [{ sandbox: false }, { raw: false }, { sandboxProfile: "benchmark" }, { sandboxGateway: { socketPath: "/host.sock" } }, { mode: "live" }, { execution: "root-repair" }]) {
    expect(service.update(sandbox.id, { metadata })).toMatchObject({ ok: false, error: { code: "conflict" } });
  }
  expect(await service.spawn({ requestId: "sandbox-child", parentId: sandbox.id, cwd: directory })).toMatchObject({ ok: false, error: { code: "invalid_request" } });
  for (const metadata of [{ sandboxProfile: "benchmark" }, { sandbox: true }, { raw: true, sandbox: "yes" }, { raw: true, sandbox: true, context: { tools: [] } },
    { raw: true, sandbox: true, sandboxProfile: "unknown" }, { raw: true, sandbox: true, sandboxProfile: "benchmark" },
    { raw: true, sandbox: true, sandboxProfile: "benchmark", sandboxGateway: { socketPath: "relative.sock" } }]) {
    expect(await service.spawn({ requestId: JSON.stringify(metadata), cwd: directory, metadata })).toMatchObject({ ok: false, error: { code: "invalid_request" } });
  }
  expect(service.importThread({ id: "escape-sandbox", title: "Escape", cwd: directory, sessionFile: join(directory, "native.jsonl"), settings: sandbox.settings,
    metadata: { raw: true, sandbox: true } })).toMatchObject({ ok: false, error: { code: "invalid_request" } });
});

it("passes the immutable benchmark gateway policy to its runner without granting host tools", async () => {
  const { service, directory, sessions } = fixture();
  await service.start();
  const metadata = { raw: true, sandbox: true, sandboxProfile: "benchmark", sandboxGateway: { socketPath: "/host/gateways/case.sock" } };
  const thread = value(await service.spawn({ requestId: "benchmark", cwd: directory, message: "hello", metadata }));
  await waitFor(() => sessions.length === 1);
  const args = sessions[0]!.options.args;
  expect(JSON.parse(args[args.indexOf("--sandbox-policy") + 1]!)).toEqual({ profile: "benchmark", gatewaySocket: metadata.sandboxGateway.socketPath });
  for (const patch of [{ sandboxProfile: null }, { sandboxGateway: { socketPath: "/other.sock" } }])
    expect(service.update(thread.id, { metadata: patch })).toMatchObject({ ok: false, error: { code: "conflict" } });
});

describe("thread inspection", () => {
  it("omits an idle thread's context when the caller already holds its revision, through a directory over HTTP", async () => {
    const { service, directory } = fixture();
    const thread = value(await service.spawn({ requestId: "inspected", cwd: directory }));
    writeFileSync(thread.sessionFile, [
      { type: "session", version: 3, id: thread.id, cwd: directory, timestamp: new Date().toISOString() },
      { type: "message", id: "m1", parentId: null, timestamp: new Date().toISOString(), message: { role: "user", content: "hello", timestamp: 1 } },
    ].map(entry => JSON.stringify(entry)).join("\n") + "\n");
    const owner = new ThreadDirectory({ id: "owner", api: service });
    const client = createThreadClient("http://owner/v1/threads", (async (url: RequestInfo | URL, init?: RequestInit) => (await threadHttp(owner, new Request(url, init)))!) as typeof fetch);
    const full = value(await client.inspect(thread.id));
    expect(full.context).toMatchObject({ source: "native-history", messages: [{ role: "user", content: "hello" }] });
    const held = value(await client.inspect(thread.id, { contextRevision: full.thread.revision }));
    expect(held.context).toBeUndefined();
    expect(held.thread.revision).toBe(full.thread.revision);
    expect(held.pending).toEqual(full.pending);
    expect(value(await client.inspect(thread.id, { contextRevision: full.thread.revision - 1 })).context).toMatchObject({ source: "native-history" });
  });
});

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
  expect(service.get("inbox")).toMatchObject({ held: true, state: "idle", metadata: { archived: true } });
  expect(service.pending("inbox").map(message => message.id)).toEqual(["held"]);
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
  value(await service.control({ threadId: thread.id, action: "stop", descendants: false }));
  const db = new DatabaseSync(join(directory, "threads.sqlite"));
  try {
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
  const service = new ThreadService({ databasePath: join(directory, "threads.sqlite"), sessionsDir: directory, openSession, attachSession, admit: async () => ({ ok: true, value: { release } }) }); services.push(service);
  const parent = value(await service.spawn({ requestId: "parent", cwd: directory }));
  value(await service.control({ threadId: parent.id, action: "stop", descendants: false }));
  value(service.importThread({ id: "child", parentId: parent.id, title: "Child", cwd: directory, sessionFile: join(directory, "child.jsonl"), settings: { model: "private/removed-model", thinkingLevel: "high", speed: "standard" } }));
  value(service.importMessage({ id: "assignment", threadId: "child", text: "first", state: recovering ? "dispatched" : "queued", ...(recovering ? { executionId: "retained-execution" } : {}) }));
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
  const restored = new ThreadService({ databasePath: join(directory, "threads.sqlite"), sessionsDir: directory, openSession, attachSession }); services.push(restored);
  await restored.start(); await turn();
  expect(openSession).toHaveBeenCalledTimes(1);
  expect(restored.get("child")).toMatchObject({ state: "idle", held: true, metadata: { executionError: error } });
  expect(restored.pending(parent.id)).toEqual([notification]);
});

it("does not invent a failed settlement when retained runner absence is uncertain", async () => {
  const directory = mkdtempSync(join(tmpdir(), "thread-startup-uncertain-")); roots.push(directory);
  const openSession: OpenPiSession = async () => { throw new Error("Pi cwd admission rejected thread.cwd: cwd_unavailable"); };
  const attachSession = vi.fn(async () => { throw new Error("runner status timed out"); });
  const service = new ThreadService({ databasePath: join(directory, "threads.sqlite"), sessionsDir: directory, openSession, attachSession }); services.push(service);
  value(service.importThread({ id: "child", title: "Child", cwd: directory, sessionFile: join(directory, "child.jsonl"), settings: { model: "astra", thinkingLevel: "high", speed: "standard" }, metadata: { runnerReference: { control: "control.sock", socketPath: "session.sock" } } }));
  value(service.importMessage({ id: "assignment", threadId: "child", text: "work", state: "dispatched", executionId: "retained" }));
  await service.start();
  await waitFor(() => service.get("child")?.metadata?.executionError === "runner status timed out");
  expect(service.get("child")).toMatchObject({ held: true, state: "running" });
  expect(service.latestSettlement("child")).toBeNull();
  expect(service.pending("child")).toMatchObject([{ id: "assignment", state: "dispatched" }]);
});

it("persists a bounded startup retry budget across owner restart", async () => {
  const directory = mkdtempSync(join(tmpdir(), "thread-startup-retry-")); roots.push(directory);
  const openSession = vi.fn<OpenPiSession>(async () => { throw new Error("temporary runner failure"); });
  const options = { databasePath: join(directory, "threads.sqlite"), sessionsDir: directory, openSession };
  const first = new ThreadService(options); services.push(first);
  const thread = value(await first.spawn({ requestId: "assignment", cwd: directory, message: "work" }));
  await first.start();
  await waitFor(() => (first.get(thread.id)?.metadata?.startupFailure as { attempts: number })?.attempts === 1);
  first.reconcile(); await turn();
  expect(openSession).toHaveBeenCalledTimes(1);
  await first.close();
  const second = new ThreadService(options); services.push(second);
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
  const service = new ThreadService({ databasePath: join(directory, "threads.sqlite"), sessionsDir: directory, openSession, attachSession }); services.push(service);
  const thread = value(await service.spawn({ requestId: "assignment", cwd: directory, message: "work" }));
  await service.start(); await waitFor(() => !!rejectOpen);
  const stopped = service.control({ threadId: thread.id, action: "stop", descendants: false });
  await turn();
  rejectOpen(new Error("Pi cwd admission rejected thread.cwd: cwd_unavailable"));
  expect(value(await stopped)).toMatchObject({ held: true, state: "idle" });
  expect(attachSession).toHaveBeenCalledTimes(1);
  expect(service.pending(thread.id)).toMatchObject([{ id: "assignment", state: "queued" }]);
  expect(service.latestSettlement(thread.id)).toBeNull();
});

it("records why a capacity refusal is waiting, keeps the work queued, and clears the reason once admitted", async () => {
  const directory = mkdtempSync(join(tmpdir(), "thread-admission-wait-")); roots.push(directory);
  const sessions: FakePiSession[] = [];
  const openSession: OpenPiSession = async (options, output) => { const session = new FakePiSession(options, output); sessions.push(session); return session; };
  const refusal = "openai-codex-8: weekly quota exhausted; openai-codex-11: cooling until 19:44";
  let admitted = false;
  const service = new ThreadService({ databasePath: join(directory, "threads.sqlite"), sessionsDir: directory, openSession,
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
  const service=new ThreadService(options);services.push(service);
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
  const reopened=new ThreadService(options);services.push(reopened);await reopened.start();await turn();
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

it.each([
  ["stop", undefined, "complete"],
  ["aborted", undefined, "cancelled"],
  ["error", "400 invalid request", "failed"],
])("reconciles a native terminal %s after a crash with stale provider waiting without replay", async (stopReason, errorMessage, outcome) => {
  const directory = mkdtempSync(join(tmpdir(), "thread-provider-terminal-crash-")); roots.push(directory);
  const sessions: FakePiSession[] = [];
  const finalMessage = { role: "assistant", content: [{ type: "text", text: "durable native result" }], stopReason, ...(errorMessage ? { errorMessage } : {}) };
  const service = new ThreadService({ databasePath: join(directory, "threads.sqlite"), sessionsDir: directory,
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

it("cold pooled startup without quota waits without consuming the startup failure budget",async()=>{
  const directory=mkdtempSync(join(tmpdir(),"thread-cold-capacity-"));roots.push(directory);
  const sessions:FakePiSession[]=[];let available=false;
  const service=new ThreadService({databasePath:join(directory,"threads.sqlite"),sessionsDir:directory,
    openSession:async(options,output)=>{if(!available)throw new Error("No eligible pooled account for anthropic/claude-opus-5-5");const session=new FakePiSession(options,output);sessions.push(session);return session;}});services.push(service);
  await service.start();const thread=value(await service.spawn({requestId:"cold-capacity",cwd:directory,message:"work"}));
  await waitFor(()=>service.get(thread.id)?.metadata?.admissionWait!==undefined);
  for(let i=0;i<4;i++){service.reconcile();await turn();}
  expect(service.get(thread.id)?.metadata?.startupFailure).toBeUndefined();expect(service.latestSettlement(thread.id)).toBeNull();
  expect(service.pending(thread.id)).toMatchObject([{state:"queued"}]);
  available=true;service.reconcile();await waitFor(()=>sessions[0]?.isStreaming===true);
  sessions[0]!.settle("done");await waitFor(()=>service.latestSettlement(thread.id)!==null);
});

it("model-broker capacity waits respect a durable retry schedule rather than immediate re-admission",async()=>{
  const directory=mkdtempSync(join(tmpdir(),"thread-broker-wait-"));roots.push(directory);
  const sessions:FakePiSession[]=[];
  const service=new ThreadService({databasePath:join(directory,"threads.sqlite"),sessionsDir:directory,
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

it("stop cancels provider waiting without reopening or retrying a model",async()=>{
  const directory=mkdtempSync(join(tmpdir(),"thread-provider-stop-"));roots.push(directory);
  const sessions:FakePiSession[]=[];let available=true;
  const service=new ThreadService({databasePath:join(directory,"threads.sqlite"),sessionsDir:directory,
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
  const service = new ThreadService({ databasePath: join(directory, "threads.sqlite"), sessionsDir: directory, openSession,
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
  const service=new ThreadService(options);services.push(service);
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
    expect(f.service.get(thread.id)).toMatchObject({ state: "idle", held: true });
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
  const service = new ThreadService({ databasePath: join(directory, "threads.sqlite"), sessionsDir: join(directory, "sessions"),
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

  it("validates the whole group and child relationship before returning a stored result", async () => {
    const f = await children();
    f.session(f.a.id).settle("done");
    await waitFor(() => f.service.latestSettlement(f.a.id) !== null);
    const input = { parentId: f.parent.id, threadIds: [f.a.id] };
    for (const patch of [{ threadIds: [] }, { threadIds: [f.a.id, f.a.id] }, { threadIds: [f.parent.id] },
      { threadIds: Array.from({ length: 101 }, (_, i) => String(i)) }, { after: { [f.a.id]: -1 } },
      { timeoutMs: 30_001 }, { parentId: "another-parent" }]) {
      expect(await f.service.await({ ...input, ...patch })).toMatchObject({ ok: false, error: { code: "invalid_request" } });
    }
    expect(await f.service.await({ ...input, threadIds: [f.a.id, "missing"] })).toMatchObject({ ok: false, error: { code: "not_found" } });
    value(await f.service.control({ threadId: f.b.id, action: "stop", descendants: false }));
  });
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
    expect(person.service.get(existing.id)).toMatchObject({ state: "idle", held: true });
    expect(fleet.service.get(child.id)).toMatchObject({ state: "idle", held: true });
    expect(fleet.service.pending(child.id)[0]?.state).toBe("queued");
    expect(await directory.spawn({ requestId: "stopped-child", parentId: root.id, cwd: person.directory })).toMatchObject({ ok: false, error: { code: "unavailable" } });
    expect(fleet.service.snapshot()).toHaveLength(2);
  });

  it("removes the spawn tool per session and relays completion to a cross-owner parent", async () => {
    const person = fixture(), fleet = fixture(undefined, true);
    const directory = new ThreadDirectory({ id: "person", api: person.service }, [{ id: "fleet", api: fleet.service }]);
    person.service.setDirectory(directory, () => fleet.service);
    fleet.service.setDirectory(directory);
    const root = value(await directory.spawn({ requestId: "parent", cwd: person.directory, message: "Coordinate" }));
    const child = value(await directory.spawn({ requestId: "child", parentId: root.id, cwd: person.directory, message: "Work", ephemeral: true }));
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
      expect(JSON.parse(text.split("\n")[2]!)).toMatchObject({ senderThreadId: child.id });
      expect(text).toMatch(/<\/agent_message>$/);
    }
    expect(JSON.parse(progress.split("\n")[2]!)).toMatchObject({ recipientThreadId: root.id, source: "explicit", messageId: "progress" });
    expect(JSON.parse(completion.split("\n")[2]!)).toEqual({ senderThreadId: child.id });
    expect(JSON.parse(completion.split("\n")[4]!)).toEqual({ type: "thread_idle", title: child.title, outcome: "complete", finalText: "Worker result" });
    expect(fleet.service.get(child.id)).toMatchObject({ state: "idle", held: true, metadata: { ephemeral: true, archived: true, archivedAt: expect.any(String) } });
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
    expect(service.get(child.id)).toMatchObject({ held: true, metadata: { ephemeral: true, archivedAt: expect.any(String) } });
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

  it("archives a conversation's workers with it, across owners, and once only", async () => {
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
    for (const [service, id] of [[person.service, root.id], [person.service, local.id], [fleet.service, remote.id]] as const) {
      expect(service.get(id)?.metadata).toMatchObject({ archived: true, archivedAt: expect.any(String) });
    }
    const archivedAt = person.service.get(local.id)?.metadata?.archivedAt;
    await new Promise(resolve => setTimeout(resolve, 5));
    value(await directory.control({ threadId: root.id, action: "update", archived: true }));
    expect(person.service.get(local.id)?.metadata?.archivedAt).toBe(archivedAt);
    value(await directory.control({ threadId: root.id, action: "update", archived: false }));
    expect(person.service.get(root.id)?.metadata?.archived).toBe(false);
    expect(person.service.get(local.id)?.metadata?.archived).toBe(true);
    clock.mockReturnValue(3_700_000);
    const other = value(await person.service.spawn({ requestId: "other", cwd: person.directory }));
    const worker = value(await person.service.spawn({ requestId: "other-worker", parentId: other.id, cwd: person.directory }));
    clock.mockReturnValue(7_400_000);
    expect(value(await person.service.control({ threadId: other.id, action: "archiveInactive", inactiveBefore: 7_300_000 })).metadata?.archived).toBe(true);
    expect(person.service.get(worker.id)?.metadata?.archived).toBe(true);
  });

  it("restores an accidentally archived conversation and its running workers across owners and continues their turns", async () => {
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
    for (const [service, id] of owners) {
      expect(service.get(id)).toMatchObject({ held: true, metadata: { archived: true, archiveInterruption: { executionId: expect.any(String) } } });
    }
    expect(person.service.get(stopped.id)?.metadata?.archiveInterruption).toBeUndefined();
    expect(await directory.send({ requestId: "blocked", threadId: local.id, senderId: root.id, text: "More" })).toMatchObject({ ok: false, error: { code: "unavailable" } });

    value(await directory.control({ threadId: root.id, action: "restore", descendants: true, resume: true }));
    const continued = (sessions: FakePiSession[], id: string) => sessions.some(session => session.options.threadId === id
      && session.commands.some(command => String(command.message ?? "").includes("archived while it was working")));
    await waitFor(() => owners.every(([service, id]) => continued(service === fleet.service ? fleet.sessions : person.sessions, id)));
    for (const [service, id] of owners) {
      expect(service.get(id)).toMatchObject({ held: false, state: "running" });
      expect(service.get(id)?.metadata).toMatchObject({ archived: false });
      expect(service.get(id)?.metadata?.archiveInterruption).toBeUndefined();
    }
    // The workers continue, so the conversation never hears they were cancelled.
    expect(person.service.pending(root.id).filter(message => message.id.startsWith("thread-result:"))).toEqual([]);
    expect(person.service.get(stopped.id)).toMatchObject({ held: true, metadata: { archived: false } });
    expect(person.service.pending(stopped.id)).toHaveLength(1);
  });

  it("restores only on request, leaves deliberately stopped work alone, and lets thread_send restore a caller's own worker", async () => {
    const { service, directory } = fixture();
    const root = value(await service.spawn({ requestId: "root", cwd: directory }));
    const other = value(await service.spawn({ requestId: "other", cwd: directory }));
    const child = value(await service.spawn({ requestId: "child", parentId: root.id, cwd: directory, message: "queued work" }));
    value(await service.control({ threadId: root.id, action: "update", archived: true }));
    expect(service.get(child.id)?.metadata).toMatchObject({ archived: true, archiveInterruption: { at: expect.any(String) } });
    expect(await service.control({ threadId: root.id, action: "restore" } as never)).toMatchObject({ ok: false, error: { code: "invalid_request" } });
    value(await service.control({ threadId: root.id, action: "restore", descendants: false }));
    expect(service.get(root.id)?.metadata?.archived).toBe(false);
    expect(service.get(child.id)).toMatchObject({ held: true, metadata: { archived: true } });

    const tool = (threadId: string) => threadTools({ threadId, cwd: directory, sessionFile: join(directory, `${threadId}.jsonl`), args: [], env: {}, threads: service }).find(item => item.name === "thread_send")!;
    const refused = await tool(other.id).execute("call-other", { threadId: child.id, text: "Not yours" }, undefined, undefined, undefined as never);
    expect(refused.details).toMatchObject({ ok: false, error: { code: "unavailable", message: expect.stringContaining("action \"restore\"") } });
    expect(service.get(child.id)?.metadata?.archived).toBe(true);
    const sent = await tool(root.id).execute("call-root", { threadId: child.id, text: "Carry on" }, undefined, undefined, undefined as never);
    expect(sent.details).toMatchObject({ ok: true, value: { threadId: child.id, senderId: root.id } });
    expect(service.get(child.id)).toMatchObject({ held: false, state: "running", metadata: { archived: false } });
    expect(service.get(child.id)?.metadata?.archiveInterruption).toBeUndefined();

    // A deliberate stop after an archive is final: resume must not undo it.
    value(await service.control({ threadId: root.id, action: "update", archived: true }));
    value(await service.control({ threadId: child.id, action: "stop", descendants: false }));
    value(await service.control({ threadId: root.id, action: "restore", descendants: true, resume: true }));
    expect(service.get(child.id)).toMatchObject({ held: true, metadata: { archived: false } });
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

  it("persists a held queue across restart and reports an empty resume", async () => {
    const first = fixture();
    const thread = value(await first.service.spawn({ requestId: "thread", id: "thread", cwd: first.directory }));
    value(await first.service.send({ requestId: "queued", threadId: thread.id, text: "durable input", delivery: "queue" }));
    value(await first.service.control({ threadId: thread.id, action: "stop", descendants: false }));
    expect(first.service.pending(thread.id)).toMatchObject([{ id: "queued", state: "queued" }]);
    value(await first.service.close());

    const second = fixture(first.directory);
    expect(second.service.pending(thread.id)).toMatchObject([{ id: "queued", text: "durable input", state: "queued" }]);
    value(await second.service.control({ threadId: thread.id, action: "resume" }));
    await second.service.start();
    await waitFor(() => second.sessions[0]?.commands.some(command => command.type === "prompt"));
    await settle(second.sessions[0]!, second.service, thread.id);
    const empty = await second.service.control({ threadId: thread.id, action: "resume" });
    expect(empty).toMatchObject({ ok: false, error: { code: "no_pending_messages" } });
  });

  it("holds readable child completion across restart without changing native final-message storage", async () => {
    const first = fixture();
    await first.service.start();
    const parent = value(await first.service.spawn({ requestId: "parent", id: "parent", cwd: first.directory }));
    const child = value(await first.service.spawn({ requestId: "child-work", id: "child", parentId: parent.id, cwd: first.directory, message: "child task" }));
    value(await first.service.control({ threadId: parent.id, action: "stop", descendants: false }));
    await waitFor(() => first.sessions[0]?.commands.some(command => command.type === "prompt"));
    const finalMessage = signedFinalMessage();
    const nativeFinalMessage = structuredClone(finalMessage);
    first.sessions[0]!.settleMessage(finalMessage);
    await waitFor(() => first.service.pending(parent.id).length === 1);
    const settlement = first.service.latestSettlement(child.id)!;
    expect(settlement.finalMessage).toEqual(nativeFinalMessage);
    expect(finalMessage).toEqual(nativeFinalMessage);
    const notification = first.service.pending(parent.id)[0]!;
    expectReadableCompletion(notification.text);
    expect(JSON.parse(notification.text)).toEqual({
      type: "thread_idle", title: child.title, outcome: "complete", finalText: "Readable child result",
    });
    const db = new DatabaseSync(join(first.directory, "threads.sqlite"));
    try {
      const work = db.prepare("SELECT final_message FROM thread_work WHERE id=?").get("child-work") as { final_message: string };
      expect(JSON.parse(work.final_message)).toEqual(nativeFinalMessage);
    } finally { db.close(); }
    expect(first.service.get(parent.id)).toMatchObject({ state: "idle", held: true });
    expect(first.service.pending(parent.id)).toMatchObject([{ source: "notification", state: "queued", senderId: child.id }]);
    value(await first.service.close());

    const reopened = fixture(first.directory);
    await reopened.service.start();
    expect(reopened.service.pending(parent.id)).toEqual([notification]);
    expect(reopened.sessions).toHaveLength(0);
    value(await reopened.service.close());

    const second = fixture(first.directory);
    expect(second.service.pending(parent.id)).toEqual([notification]);
    value(await second.service.send({ requestId: "explicit", threadId: parent.id, text: "new instruction", delivery: "queue" }));
    expect(second.service.get(parent.id)?.state).toBe("running");
    expect(second.service.pending(parent.id).map(message => ({ id: message.id, source: message.source, text: message.text }))).toEqual([
      { id: "explicit", source: "explicit", text: "new instruction" },
      expect.objectContaining({ source: "notification" }),
    ]);
    expect(second.service.latestSettlement(child.id)?.finalMessage).toEqual(nativeFinalMessage);
    value(await second.service.start());
    await waitFor(() => second.sessions[0]?.commands.some(command => command.workId === "explicit") === true);
    second.sessions[0]!.settle("instruction handled");
    await waitFor(() => second.sessions.some(session => session.commands.some(command => command.workId === notification.id)));
    const command = second.sessions.flatMap(session => session.commands).find(command => command.workId === notification.id)!;
    const text = String(command.message);
    expectReadableCompletion(text);
    expect(JSON.parse(text.split("\n")[2]!)).toEqual({ senderThreadId: child.id });
    expect(text).toContain(notification.text);
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
    expect(second.service.get("active")).toMatchObject({ state: "idle", held: true });
    expect(second.service.pending("active")).toMatchObject([{ id: "held", state: "queued" }]);
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
    expect(value(await service.control({ threadId: "gone", action: "stop", descendants: false }))).toMatchObject({ state: "idle", held: true });
    expect(attachSession).toHaveBeenCalledWith(reference, expect.any(Function), expect.any(Function));
    expect(openSession).not.toHaveBeenCalled(); expect(admit).not.toHaveBeenCalled();
    expect(service.latestSettlement("gone")?.outcome).toBe("cancelled");
    expect(service.pending("gone")).toMatchObject([{ id: "next", state: "queued" }]);
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
    expect(value(await first)).toMatchObject({ state: "idle", held: true });
    expect(value(await second)).toMatchObject({ state: "idle", held: true });
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
    await waitFor(() => service.get(thread.id)?.state === "idle" && service.get(thread.id)?.held === true);
    expect(service.pending(thread.id)).toMatchObject([{ id: "pending", state: "queued" }]);
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
    expect(value(await stopped)).toMatchObject({ state: "idle", held: true });
    expect(native!.commands.some(input => input.type === "prompt")).toBe(false);
    expect(service.pending(thread.id)).toMatchObject([{ id: "pending", state: "queued" }]);
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
    expect(await service.send({ ...agent, requestId: "queue", delivery: "queue" })).toMatchObject({ ok: false, error: { code: "invalid_request", message: expect.stringContaining("steer or hard steer") } });
    for (const delivery of ["steer", "hardSteer"] as const) {
      expect(value(await service.send({ ...agent, requestId: delivery, delivery })).delivery).toBe(delivery);
    }
  });

  it("records a steer as landed only when Pi starts it as a user message", async () => {
    const { directory, service, sessions } = fixture();
    const thread = value(await service.spawn({ requestId: "root", cwd: directory, message: "Coordinate" }));
    await service.start();
    await waitFor(() => sessions[0]?.commands.some(command => command.type === "prompt") ?? false);
    expect(service.pending(thread.id)[0]?.landedAt).toEqual(expect.any(Number));
    value(await service.send({ requestId: "steer", threadId: thread.id, text: "Result", delivery: "steer" }));
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

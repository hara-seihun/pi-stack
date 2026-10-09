import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { ThreadService, type ThreadServiceOptions } from "../src/threads/service.js";
import { ThreadDirectory } from "../src/threads/directory.js";
import { formatThreadMessage } from "../src/threads/message-format.js";
import { appendFileSync, writeFileSync } from "node:fs";
import type { Result, ManagerQuestionsResponse } from "../src/threads/contracts.js";

const roots: string[] = [], services: ThreadService[] = [];
const unwrap = <T>(result: Result<T>): T => { if (!result.ok) throw Error(result.error.message); return result.value; };
function fixture(root = mkdtempSync(join(tmpdir(), "manager-custody-")), options: Partial<ThreadServiceOptions> = {}) {
  if (!roots.includes(root)) roots.push(root);
  const service = new ThreadService({ databasePath: join(root, "threads.sqlite"), sessionsDir: join(root, "sessions"), capacity: { mode: "unmanaged" },
    openSession: async () => { throw Error("Unexpected native session"); }, ...options });
  services.push(service); return { service, root };
}
afterEach(async () => { vi.restoreAllMocks(); for (const service of services.splice(0)) await service.close(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
async function setup() {
  const f = fixture();
  unwrap(await f.service.spawn({ requestId: "manager", id: "manager", cwd: f.root, metadata: { manager: true, contextFiles: ["HARA.md", "KENAN.md"] } }));
  for (const id of ["one", "two"]) unwrap(await f.service.spawn({ requestId: id, id, cwd: f.root }));
  return f;
}
async function ask(service: ThreadService, threadId: string, requestId = threadId) {
  return unwrap(await service.ask({ threadId, requestId: `ask:${requestId}`, questions: [{ question: `Proceed ${threadId}?`, suggestions: ["Yes", "No"] }] })).questionIds[0]!;
}
const inbox = async (service: ThreadService) => {
  const result = unwrap(await service.managerQuestions({ action: "list", threadId: "manager" }));
  if (result.action !== "list") throw Error("Wrong response"); return result.questions;
};
const forwarded = (result: ManagerQuestionsResponse) => { if (result.action !== "forward") throw Error("Wrong response"); return result.receipt.questionId; };

it("journals singleton spawns, protects manager identity and custody while preserving cancel and full context", async () => {
  const { service, root } = await setup();
  const request = { requestId: "other-manager", id: "other", cwd: root, metadata: { manager: true } };
  expect(unwrap(await service.spawn(request)).id).toBe("manager");
  expect(unwrap(await service.spawn(request)).id).toBe("manager");
  expect(unwrap(await service.list()).threads.filter(t => t.metadata?.manager)).toHaveLength(1);
  for (const control of [{ action: "close" }, { action: "update", archived: true }, { action: "stop", descendants: false, reason: "archive" }] as const)
    expect(await service.control({ ...control, threadId: "manager" })).toMatchObject({ ok: false, error: { code: "conflict" } });
  expect(service.update("manager", { archived: true }).ok).toBe(false);
  expect(service.update("manager", { metadata: { manager: false } }).ok).toBe(false);
  expect(service.update("one", { metadata: { manager: true } }).ok).toBe(false);
  expect(unwrap(await service.control({ threadId: "manager", action: "archiveInactive", inactiveBefore: Date.now() - 1 })).metadata?.archived).not.toBe(true);
  unwrap(await service.wakeSchedule({ action: "set", threadId: "manager", requestId: "wake", reason: "Manager heartbeat", cadenceMs: 4 * 60 * 60_000 }));
  unwrap(await service.control({ threadId: "manager", action: "cancel" }));
  expect(service.get("manager")?.wakeSchedule).toBeDefined();
  expect(service.get("manager")?.metadata?.archived).not.toBe(true);
  unwrap(await service.control({ threadId: "manager", action: "stop", descendants: false }));
  expect(service.get("manager")?.metadata?.archived).not.toBe(true);
  expect(service.get("manager")?.wakeSchedule).toBeDefined();
  await service.close(); const restored = fixture(root).service;
  expect(unwrap(await restored.spawn({ ...request, requestId: "third" })).id).toBe("manager");
});

it("holds questions across restart, hides every human inbox and delivers one correlated manager decision", async () => {
  const { service, root } = await setup();
  const id = await ask(service, "one");
  expect(unwrap(await service.questions("one"))).toEqual([]);
  expect(unwrap(service.pendingQuestions({ locationThreadIds: [] })).questions).toEqual([]);
  expect(unwrap(service.questionEvents()).items).toEqual([]);
  expect(await service.answer({ threadId: "one", questionId: id, text: "Human", selectedSuggestionIds: [] })).toMatchObject({ ok: false, error: { code: "conflict" } });
  expect(await service.managerQuestions({ action: "list", threadId: "one" })).toMatchObject({ ok: false });
  await service.close(); const restored = fixture(root).service;
  expect(await inbox(restored)).toMatchObject([{ id, routing: "held", managerId: "manager", deadlineAt: expect.any(Number) }]);
  const answer = { action: "answer" as const, requestId: "manager-answer", threadId: "manager", questionId: id, text: "Within the policy", selectedSuggestionIds: [`${id}:0`] };
  unwrap(await restored.managerQuestions(answer));
  unwrap(await restored.managerQuestions(answer));
  expect(await inbox(restored)).toEqual([]);
  expect(restored.pending("one")).toMatchObject([{ id: `question-answer:${id}`, senderId: "manager", source: "notification", replyTo: id, text: expect.stringContaining("not human input") }]);
  expect(unwrap(await restored.questionState("one", id)).answer).toMatchObject({ answeredBy: { kind: "manager", threadId: "manager" }, selectedSuggestions: ["Yes"] });
  expect(restored.get("one")?.lastUserMessageAt).toBeUndefined();
});

it.each(["manager", "classic"])("a rewritten question and classic originals fan out exactly once, first answer wins (%s)", async first => {
  const { service, root } = await setup();
  const one = await ask(service, "one"), two = await ask(service, "two");
  const request = { action: "forward" as const, threadId: "manager", requestId: "forward", questionIds: [one, two], question: { question: "**Proceed with both?**", suggestions: ["Proceed", "Wait"], recommendedSuggestionIndex: 1 } };
  const combined = forwarded(unwrap(await service.managerQuestions(request)));
  expect(forwarded(unwrap(await service.managerQuestions(request)))).toBe(combined);
  expect(unwrap(await service.questions("one"))).toMatchObject([{ id: one }]);
  expect(unwrap(await service.questions("manager"))).toMatchObject([{ id: combined, question: request.question.question }]);
  expect(unwrap(service.pendingQuestions({ locationThreadIds: [] })).questions).toHaveLength(3);
  expect(await inbox(service)).toMatchObject([{ routing: "forwarded" }, { routing: "forwarded" }]);
  await service.close(); const restored = fixture(root).service;
  const answer = first === "manager" ? { threadId: "manager", questionId: combined, selectedSuggestionIds: [`${combined}:0`], text: "Today" }
    : { threadId: "one", questionId: one, selectedSuggestionIds: [`${one}:1`], text: "Not today" };
  unwrap(await restored.answer(answer));
  unwrap(await restored.answer({ threadId: "two", questionId: two, selectedSuggestionIds: [], text: "Losing answer" }));
  const expected = first === "manager" ? "Today" : "Not today";
  for (const [threadId, questionId] of [["one", one], ["two", two], ["manager", combined]]) {
    expect(unwrap(await restored.questionState(threadId!, questionId!)).answer?.text).toContain(expected);
    expect(restored.pending(threadId!).filter(work => work.replyTo === questionId)).toHaveLength(1);
    expect(unwrap(await restored.questions(threadId!))).toEqual([]);
  }
});

it("releases held questions at the original two-hour deadline with new visible event cursors after restart", async () => {
  let now = 1_000_000; vi.spyOn(Date, "now").mockImplementation(() => now);
  const { service, root } = await setup(); const id = await ask(service, "one");
  const managerQuestion = unwrap(await service.ask({ requestId: "direct", threadId: "manager", questions: [{ question: "Manager's own question" }] })).questionIds[0]!;
  expect(unwrap(service.questionEvents()).items.map(q => q.questionId)).toEqual([managerQuestion]);
  await service.close(); const restored = fixture(root).service;
  now += 2 * 60 * 60_000 - 1;
  expect(unwrap(await restored.questions("one"))).toEqual([]);
  now += 1;
  const released = unwrap(restored.questionEvents(1));
  expect(released.items).toMatchObject([{ questionId: id }]);
  expect(unwrap(await restored.questions("one"))).toMatchObject([{ id }]);
  expect(await inbox(restored)).toEqual([]);
  expect(unwrap(restored.questionEvents(released.cursor)).items).toEqual([]);
});

const boundary = () => new Promise<void>(resolve => setImmediate(resolve));
async function until(check: () => boolean) { for (let n = 0; n < 200; n++) { if (check()) return; await boundary(); } throw Error("Custody did not reach expected boundary"); }

it.each(["manager", "classic"])("routes own-person local fleet questions through restart-safe manager custody (%s answers first)", async first => {
  const person = await setup(), fleet = fixture(undefined, { workersOnly: true });
  const directory = new ThreadDirectory({ id: "person", api: person.service }, [{ id: "fleet", api: fleet.service }]);
  person.service.setDirectory(directory); fleet.service.setDirectory(directory);
  unwrap(await fleet.service.spawn({ requestId: "worker", id: "worker", cwd: fleet.root }));
  const workerId = await ask(fleet.service, "worker");
  await until(() => person.service.pending("manager").some(work => work.id.startsWith("manager-custody:")));
  expect(await inbox(person.service)).toMatchObject([{ id: workerId, threadId: "worker", routing: "held" }]);
  expect(unwrap(fleet.service.pendingQuestions({ locationThreadIds: [] })).questions).toEqual([]);
  const localId = await ask(person.service, "one");
  const combined = forwarded(unwrap(await person.service.managerQuestions({ action: "forward", requestId: "mixed-forward", threadId: "manager", questionIds: [workerId, localId], question: { question: "Proceed with both environments?", suggestions: ["Yes", "No"] } })));
  await until(() => unwrap(fleet.service.questionEvents()).items.some(q => q.questionId === workerId));
  expect(unwrap(await fleet.service.questions("worker"))).toMatchObject([{ id: workerId }]);
  await person.service.close(); await fleet.service.close();
  const p = fixture(person.root).service, f = fixture(fleet.root, { workersOnly: true }).service;
  const restored = new ThreadDirectory({ id: "person", api: p }, [{ id: "fleet", api: f }]); p.setDirectory(restored); f.setDirectory(restored);
  expect(await inbox(p)).toMatchObject([{ id: workerId, threadId: "worker", routing: "forwarded" }, { id: localId }]);
  if (first === "manager") unwrap(await p.managerQuestions({ action: "answer", requestId: "decide", threadId: "manager", questionId: workerId, selectedSuggestionIds: [], text: "Manager first" }));
  else unwrap(await f.answer({ threadId: "worker", questionId: workerId, selectedSuggestionIds: [`${workerId}:1`], text: "Classic first" }));
  await until(() => f.pending("worker").some(work => work.replyTo === workerId));
  unwrap(await p.answer({ threadId: "manager", questionId: combined, selectedSuggestionIds: [], text: "Losing answer" }));
  const expected = first === "manager" ? "Manager first" : "Classic first";
  expect(unwrap(await f.questionState("worker", workerId)).answer?.text).toContain(expected);
  expect(f.pending("worker").filter(work => work.replyTo === workerId)).toHaveLength(1);
  expect(unwrap(await p.questionState("one", localId)).answer?.text).toContain(expected);
  expect(unwrap(await p.questionState("manager", combined)).answer?.text).toContain(expected);
  expect(unwrap(p.pendingQuestions({ locationThreadIds: [] })).questions).toEqual([]);
  expect(f.pending("worker")[0]?.senderId).toBe(first === "manager" ? "manager" : null);
});

it.each(["manager", "none", "deadline"])("accepts fleet questions durably before unavailable manager resolution and recovers across restart (%s)", async resolution => {
  let now = 10_000_000; vi.spyOn(Date, "now").mockImplementation(() => now);
  const person = await setup(), fleet = fixture(undefined, { workersOnly: true });
  const directory = new ThreadDirectory({ id: "person", api: person.service }, [{ id: "fleet", api: fleet.service }]);
  fleet.service.setDirectory(directory); person.service.setDirectory(directory);
  let finish!: (value: Result<import("../src/threads/contracts.js").Thread | null>) => void;
  const unavailable = vi.spyOn(directory, "managerThread").mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  unwrap(await fleet.service.spawn({ requestId: "worker", id: "worker", cwd: fleet.root }));
  const id = await ask(fleet.service, "worker");
  expect(unwrap(await fleet.service.ask({ threadId: "worker", requestId: "ask:worker", questions: [{ question: "Proceed worker?", suggestions: ["Yes", "No"] }] })).questionIds).toEqual([id]);
  expect(unwrap(await fleet.service.questions("worker"))).toEqual([]);
  expect(unwrap(fleet.service.pendingQuestions({ locationThreadIds: [] })).questions).toEqual([]);
  expect(unwrap(fleet.service.questionEvents()).items).toEqual([]);
  expect(await fleet.service.answer({ threadId: "worker", questionId: id, selectedSuggestionIds: [], text: "Too early" })).toMatchObject({ ok: false, error: { code: "conflict" } });
  finish({ ok: false, error: { code: "unavailable", message: "Person supervisor unavailable" } }); await boundary();
  await fleet.service.close(); unavailable.mockRestore();
  now += 60_000;
  const recovered = fixture(fleet.root, { workersOnly: true }).service;
  const restored = new ThreadDirectory({ id: "person", api: person.service }, [{ id: "fleet", api: recovered }]); recovered.setDirectory(restored); person.service.setDirectory(restored);
  if (resolution === "none") vi.spyOn(restored, "managerThread").mockResolvedValue({ ok: true, value: null });
  if (resolution === "deadline") vi.spyOn(restored, "managerThread").mockResolvedValue({ ok: false, error: { code: "unavailable", message: "Still unavailable" } });
  unwrap(await recovered.start()); await boundary();
  if (resolution === "manager") {
    await until(() => person.service.pending("manager").some(work => work.id.startsWith("manager-custody:")));
    expect(await inbox(person.service)).toMatchObject([{ id, deadlineAt: 10_000_000 + 2 * 60 * 60_000 }]);
    expect(unwrap(await recovered.questions("worker"))).toEqual([]);
    unwrap(await person.service.managerQuestions({ action: "answer", requestId: "recovered-answer", threadId: "manager", questionId: id, selectedSuggestionIds: [], text: "Recovered" }));
    await until(() => recovered.pending("worker").some(work => work.replyTo === id));
  } else {
    if (resolution === "deadline") {
      expect(unwrap(await recovered.questions("worker"))).toEqual([]);
      now = 10_000_000 + 2 * 60 * 60_000 - 1;
      expect(unwrap(recovered.questionEvents()).items).toEqual([]);
      now += 1; recovered.reconcile();
    }
    expect(unwrap(await recovered.questions("worker"))).toMatchObject([{ id }]);
    const visible = unwrap(recovered.questionEvents()); expect(visible.items).toMatchObject([{ questionId: id }]);
    expect(unwrap(recovered.questionEvents(visible.cursor)).items).toEqual([]);
    expect(await inbox(person.service)).toEqual([]);
    unwrap(await recovered.answer({ threadId: "worker", questionId: id, selectedSuggestionIds: [], text: "Now visible" }));
    expect(recovered.pending("worker")).toHaveLength(1);
  }
});

it("recovers fleet receive and manager fanout outboxes across unavailable transport and restart", async () => {
  const person = await setup(), fleet = fixture(undefined, { workersOnly: true });
  let directory = new ThreadDirectory({ id: "person", api: person.service }, [{ id: "fleet", api: fleet.service }]);
  person.service.setDirectory(directory); fleet.service.setDirectory(directory);
  unwrap(await fleet.service.spawn({ requestId: "worker", id: "worker", cwd: fleet.root }));
  const failure = vi.spyOn(directory, "managerQuestionCustody").mockResolvedValue({ ok: false, error: { code: "unavailable", message: "Transport lost" } });
  const id = await ask(fleet.service, "worker"); await boundary();
  expect(await inbox(person.service)).toEqual([]);
  await fleet.service.close(); failure.mockRestore();
  const f = fixture(fleet.root, { workersOnly: true, admit: async () => ({ ok: false, error: { code: "unavailable", message: "Test wait" } }) }).service;
  directory = new ThreadDirectory({ id: "person", api: person.service }, [{ id: "fleet", api: f }]); person.service.setDirectory(directory); f.setDirectory(directory);
  unwrap(await f.start()); await until(() => person.service.pending("manager").some(work => work.id.startsWith("manager-custody:")));
  expect(await inbox(person.service)).toMatchObject([{ id }]);
  const drop = vi.spyOn(directory, "managerQuestionCustody").mockResolvedValue({ ok: false, error: { code: "unavailable", message: "Fanout transport lost" } });
  unwrap(await person.service.managerQuestions({ action: "answer", requestId: "decide", threadId: "manager", questionId: id, selectedSuggestionIds: [], text: "Accepted before restart" })); await boundary();
  expect(f.pending("worker")).toEqual([]);
  await person.service.close(); drop.mockRestore();
  const p = fixture(person.root, { admit: async () => ({ ok: false, error: { code: "unavailable", message: "Test wait" } }) }).service;
  directory = new ThreadDirectory({ id: "person", api: p }, [{ id: "fleet", api: f }]); p.setDirectory(directory); f.setDirectory(directory);
  unwrap(await p.start()); await until(() => f.pending("worker").some(work => work.replyTo === id));
  expect(f.pending("worker")[0]?.text).toContain("Accepted before restart");
  expect(f.pending("worker")).toHaveLength(1);
});

it.each(["thread-wake:g:0", "manager-questions:child:call", "manager-custody:child:call"])("changes indexed window generation when a quiet manager background turn becomes human-facing (%s)", async workId => {
  const { service } = await setup(); const path = service.get("manager")!.sessionFile;
  const entry = (id: string, parentId: string | null, message: object) => JSON.stringify({ type: "message", id, parentId, message }) + "\n";
  const wake = formatThreadMessage({ id: workId, threadId: "manager", senderId: "manager", source: "notification", text: "Scheduled heartbeat", delivery: "steer", createdAt: 1, state: "done" }, "Scheduled heartbeat");
  writeFileSync(path, entry("wake", null, { role: "user", content: [{ type: "text", text: wake }], timestamp: 1 }) + entry("thinking", "wake", { role: "assistant", content: [{ type: "thinking", thinking: "Inspect tasks" }], timestamp: 2 }));
  const initial = unwrap(await service.inspect("manager", { contextWindow: { limit: 20 } })).contextWindow!;
  expect(initial.monoLiveVisibility).toBe("hidden"); expect(initial.records.every(record => record.monoVisibility === "hidden")).toBe(true);
  appendFileSync(path, entry("text", "thinking", { role: "assistant", content: [{ type: "text", text: "Your appointment is at noon." }], timestamp: 3 }));
  const revealed = unwrap(await service.inspect("manager", { contextWindow: { limit: 20 } })).contextWindow!;
  expect(revealed.monoLiveVisibility).toBe("visible");
  expect(revealed.records.find(r => r.entryId === "wake")?.monoVisibility).toBe("hidden");
  expect(revealed.records.find(r => r.entryId === "thinking")?.monoVisibility).toBe("visible");
  expect(revealed.source.generation).not.toBe(initial.source.generation);
});

it("defers due manager heartbeats during person activity and emits distinct notification wakes after fifteen minutes", async () => {
  let now = 1_000_000; vi.spyOn(Date, "now").mockImplementation(() => now);
  const { service, root } = await setup();
  unwrap(service.importMessage({ id: "person", threadId: "manager", text: "Hello", state: "done", createdAt: now }));
  unwrap(await service.wakeSchedule({ action: "set", requestId: "heartbeat", threadId: "manager", cadenceMs: 4 * 60 * 60_000, reason: "Manager heartbeat", nextDueAt: now }));
  await service.close();
  const restored = fixture(root, { admit: async () => ({ ok: false, error: { code: "unavailable", message: "Test capacity wait" } }) }).service;
  unwrap(await restored.start());
  expect(restored.pending("manager")).toEqual([]);
  now += 15 * 60_000 - 1; restored.reconcile(); expect(restored.pending("manager")).toEqual([]);
  now += 1; restored.reconcile();
  expect(restored.pending("manager")).toMatchObject([{ senderId: "manager", source: "notification", id: expect.stringMatching(/^thread-wake:/) }]);
  expect(restored.get("manager")?.lastUserMessageAt).toBe(1_000_000);
  now += 4 * 60 * 60_000; restored.reconcile(); expect(restored.pending("manager")).toHaveLength(1);
});

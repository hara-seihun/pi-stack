import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { ThreadService } from "../src/threads/service.js";
import { ThreadDirectory } from "../src/threads/directory.js";
import { threadTools } from "../src/threads/pi-tools.js";
import { createThreadClient, threadHttp } from "../src/threads/http.js";
import type { ThreadApi } from "../src/threads/contracts.js";

const roots: string[] = [];
const services: ThreadService[] = [];
afterEach(async () => {
  for (const service of services.reverse()) await service.close();
  services.length = 0;
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots.length = 0;
});
function owner(root: string) {
  const service = new ThreadService({ databasePath: join(root, "owner.sqlite"), sessionsDir: join(root, "sessions"), openSession: async () => {
    throw new Error("Question creation must not open Pi");
  } });
  services.push(service);
  return service;
}
async function setup() {
  const root = mkdtempSync(join(tmpdir(), "thread-question-")); roots.push(root);
  const service = owner(root);
  const spawned = await service.spawn({ requestId: "spawn", id: "thread", cwd: root });
  expect(spawned.ok).toBe(true);
  return { root, service };
}

it("acknowledges immediately, persists across owner restart, and atomically queues one correlated human steer", async () => {
  const { root, service } = await setup();
  const api = new ThreadDirectory({ id: "local", api: service });
  const tool = threadTools({ threadId: "thread", cwd: root, sessionFile: join(root, "sessions/thread.jsonl"), args: [], env: {}, threads: api })
    .find(tool => tool.name === "request_user_input_async")!;
  const input = { questions: [
    { question: "Which direction?", suggestions: ["North", "South", "East"], recommendedSuggestionIndex: 1 },
    { question: "When?", suggestions: ["Morning", "Evening"], recommendedSuggestionIndex: 0 },
    { question: "Who is coming?" }, { question: "How will you travel?" },
    { question: "What is the budget?" }, { question: "Where will you stay?" },
  ] };
  const receipt = await tool.execute("call-1", input, new AbortController().signal, () => {}, {} as never);
  const result = JSON.parse((receipt.content[0] as { text: string }).text);
  expect(result).toMatchObject({ accepted: true, questionIds: input.questions.map(() => expect.any(String)) });
  const [id, secondId] = result.questionIds as string[];
  expect(await api.ask({ ...input, threadId: "thread", requestId: "thread:call-1" })).toEqual({ ok: true, value: result });
  const pending = await api.questions("thread");
  if (!pending.ok) throw Error(pending.error.message);
  expect(pending.value.map(question => question.question)).toEqual(input.questions.map(question => question.question));
  expect(pending.value[0]).toMatchObject({ id, recommendedSuggestionId: `${id}:1` });
  expect(pending.value[1]).toMatchObject({ id: secondId, recommendedSuggestionId: `${secondId}:0` });
  await service.close();
  const restored = owner(root);
  const questions = await restored.questions("thread");
  if (!questions.ok) throw Error(questions.error.message);
  expect(questions.value.map(question => question.id)).toEqual(result.questionIds);
  expect(await restored.ask({ ...input, threadId: "thread", requestId: "thread:call-1" })).toEqual({ ok: true, value: result });
  const answer = { threadId: "thread", questionId: id!, selectedSuggestionIds: [`${id}:2`, `${id}:0`], text: "For the morning" };
  expect(await restored.answer(answer)).toEqual({ ok: true, value: { accepted: true, questionId: id } });
  expect(await restored.answer(answer)).toEqual({ ok: true, value: { accepted: true, questionId: id } });
  const remaining = await restored.questions("thread");
  if (!remaining.ok) throw Error(remaining.error.message);
  expect(remaining.value.map(question => question.id)).toEqual(result.questionIds.slice(1));
  expect(await restored.ask({ ...input, threadId: "thread", requestId: "thread:call-1" })).toEqual({ ok: true, value: result });
  expect(await restored.ask({ ...input, questions: [{ question: "Different?" }], threadId: "thread", requestId: "thread:call-1" })).toMatchObject({ ok: false, error: { code: "conflict" } });
  expect(restored.pending("thread")).toMatchObject([{ id: `question-answer:${id}`, delivery: "steer", senderId: null, replyTo: id }]);
  expect(restored.pending("thread")[0]?.text).toContain("East\n- North\nFor the morning");
  expect(await restored.answer({ ...answer, text: "changed" })).toMatchObject({ ok: false, error: { code: "conflict" } });
  expect(restored.pending("thread")).toHaveLength(1);
  const events = restored.questionEvents(0, 1);
  expect(events).toEqual({ ok: true, value: { cursor: 1, items: [] } });
  expect(restored.questionEvents(1, 1)).toMatchObject({ ok: true, value: { cursor: 2, items: [{ questionId: secondId, threadId: "thread" }] } });
});

it("dismissal settles one question with an explicit correlated non-authorization and survives retries", async () => {
  const { root, service } = await setup();
  const asked = await service.ask({ requestId: "dismiss", threadId: "thread", questions: [{ question: "Spend money?", suggestions: ["Yes"] }, { question: "Next?" }] });
  if (!asked.ok) throw Error(asked.error.message);
  const id = asked.value.questionIds[0]!;
  const dismiss = { threadId: "thread", questionId: id, selectedSuggestionIds: [], text: "", dismissed: true };
  expect(await service.answer({ ...dismiss, selectedSuggestionIds: [`${id}:0`] })).toMatchObject({ ok: false, error: { code: "invalid_request" } });
  expect(await service.answer(dismiss)).toMatchObject({ ok: true });
  await service.close();
  const restored = owner(root);
  expect(await restored.answer(dismiss)).toMatchObject({ ok: true });
  expect(await restored.questions("thread")).toMatchObject({ ok: true, value: [{ id: asked.value.questionIds[1] }] });
  expect(restored.pending("thread")).toMatchObject([{ replyTo: id, text: `Dismissed question ${id}: Spend money?\nThe user skipped this question without selecting or authorizing any suggestion.` }]);
  expect(await restored.answer({ ...dismiss, dismissed: false, text: "Yes" })).toMatchObject({ ok: false, error: { code: "conflict" } });
});

it("rejects invalid recommendations and answers without consuming the question", async () => {
  const { service } = await setup();
  const question = { question: "Proceed?", suggestions: ["Yes", "No"] };
  const ask = { requestId: "ask", threadId: "thread", questions: [question] };
  for (const questions of [[], [question, { ...question, recommendedSuggestionIndex: 2 }], [question, { question: " " }], [question, { question: "Next?", suggestions: [""] }], [null]]) {
    expect(await service.ask({ ...ask, questions } as never)).toMatchObject({ ok: false, error: { code: "invalid_request" } });
    expect(await service.questions("thread")).toEqual({ ok: true, value: [] });
  }
  const created = await service.ask(ask);
  if (!created.ok) throw Error(created.error.message);
  const questionId = created.value.questionIds[0]!;
  for (const answer of [
    { selectedSuggestionIds: [], text: "  " },
    { selectedSuggestionIds: ["unknown"], text: "okay" },
    { selectedSuggestionIds: [`${questionId}:0`, `${questionId}:0`], text: "" },
  ]) expect(await service.answer({ threadId: "thread", questionId, ...answer })).toMatchObject({ ok: false, error: { code: "invalid_request" } });
  expect((await service.questions("thread"))).toMatchObject({ ok: true, value: [{ id: questionId }] });
});

it("prevents inactivity archiving and reopens an explicitly archived thread on answer", async () => {
  const { service } = await setup();
  const asked = await service.ask({ requestId: "plain", threadId: "thread", questions: [{ question: "Details?" }] });
  if (!asked.ok) throw Error(asked.error.message);
  const questionId = asked.value.questionIds[0]!;
  vi.useFakeTimers();
  try {
    vi.setSystemTime(Date.now() + 60_000);
    const inactive = await service.control({ threadId: "thread", action: "archiveInactive", inactiveBefore: Date.now() - 1 });
    expect(inactive).toMatchObject({ ok: true, value: { metadata: expect.not.objectContaining({ archived: true }) } });
  } finally { vi.useRealTimers(); }
  expect(await service.control({ threadId: "thread", action: "update", archived: true })).toMatchObject({ ok: true, value: { metadata: { archived: true } } });
  expect((await service.questions("thread"))).toMatchObject({ ok: true, value: [{ id: questionId, suggestions: [] }] });
  expect(await service.answer({ threadId: "thread", questionId, selectedSuggestionIds: [], text: "Here are the details" })).toMatchObject({ ok: true });
  expect(service.get("thread")?.metadata?.archived).toBeUndefined();
  expect(service.pending("thread")[0]).toMatchObject({ delivery: "steer", text: expect.stringContaining("Here are the details") });
});

it("places an explicit answer before previously held messages", async () => {
  const { service } = await setup();
  const asked = await service.ask({ requestId: "held-question", threadId: "thread", questions: [{ question: "What next?" }] });
  if (!asked.ok) throw Error(asked.error.message);
  await service.send({ requestId: "earlier", threadId: "thread", text: "Earlier queued work" });
  await service.control({ threadId: "thread", action: "stop", descendants: false });
  expect(service.get("thread")?.held).toBe(true);
  expect(await service.answer({ threadId: "thread", questionId: asked.value.questionIds[0]!, selectedSuggestionIds: [], text: "This decision first" })).toMatchObject({ ok: true });
  expect(service.pending("thread").map(message => message.id)).toEqual([`question-answer:${asked.value.questionIds[0]}`, "earlier"]);
  expect(service.get("thread")?.held).toBe(false);
});

it("routes owner HTTP requests and deduplicates a lost ask acknowledgement", async () => {
  const { service } = await setup();
  let dropped = false;
  const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const response = await threadHttp(service, new Request(String(url), init));
    if (!response) throw Error("unmatched route");
    if (String(url).endsWith("/ask") && !dropped) { dropped = true; throw Error("connection reset after commit"); }
    return response;
  });
  const client = createThreadClient("http://localhost/v1/threads", fetcher);
  const created = await client.ask({ requestId: "retry", threadId: "thread", questions: [{ question: "Why?" }, { question: "When?" }] });
  expect(created.ok).toBe(true);
  expect((await client.questions("thread"))).toMatchObject({ ok: true, value: [{ question: "Why?", suggestions: [] }, { question: "When?", suggestions: [] }] });
  expect((await service.questions("thread"))).toMatchObject({ ok: true, value: [expect.any(Object), expect.any(Object)] });
  expect(fetcher).toHaveBeenCalledTimes(3);
  expect(await client.questionEvents(0)).toMatchObject({ ok: true, value: { cursor: 2, items: [{ question: "Why?" }, { question: "When?" }] } });
});

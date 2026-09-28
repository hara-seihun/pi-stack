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
  const input = { question: "Which direction?", suggestions: ["North", "South", "East"], recommendedSuggestionIndex: 1 };
  const receipt = await tool.execute("call-1", input, new AbortController().signal, () => {}, {} as never);
  const result = JSON.parse((receipt.content[0] as { text: string }).text);
  expect(result).toMatchObject({ accepted: true, questionId: expect.any(String) });
  const id = result.questionId as string;
  expect(await api.ask({ ...input, threadId: "thread", requestId: "thread:call-1" })).toEqual({ ok: true, value: result });
  expect((await api.questions("thread"))).toMatchObject({ ok: true, value: [{ id, recommendedSuggestionId: `${id}:1` }] });
  await service.close();
  const restored = owner(root);
  const questions = await restored.questions("thread");
  if (!questions.ok) throw Error(questions.error.message);
  expect(questions.value).toHaveLength(1);
  const answer = { threadId: "thread", questionId: id, selectedSuggestionIds: [`${id}:2`, `${id}:0`], text: "For the morning" };
  expect(await restored.answer(answer)).toEqual({ ok: true, value: { accepted: true, questionId: id } });
  expect(await restored.answer(answer)).toEqual({ ok: true, value: { accepted: true, questionId: id } });
  expect((await restored.questions("thread"))).toEqual({ ok: true, value: [] });
  expect(restored.pending("thread")).toMatchObject([{ id: `question-answer:${id}`, delivery: "steer", senderId: null, replyTo: id }]);
  expect(restored.pending("thread")[0]?.text).toContain("East\n- North\nFor the morning");
  expect(await restored.answer({ ...answer, text: "changed" })).toMatchObject({ ok: false, error: { code: "conflict" } });
  expect(restored.pending("thread")).toHaveLength(1);
});

it("rejects invalid recommendations and answers without consuming the question", async () => {
  const { service } = await setup();
  const ask = { requestId: "ask", threadId: "thread", question: "Proceed?", suggestions: ["Yes", "No"] };
  expect(await service.ask({ ...ask, recommendedSuggestionIndex: 2 })).toMatchObject({ ok: false, error: { code: "invalid_request" } });
  const created = await service.ask(ask);
  if (!created.ok) throw Error(created.error.message);
  const questionId = created.value.questionId;
  for (const answer of [
    { selectedSuggestionIds: [], text: "  " },
    { selectedSuggestionIds: ["unknown"], text: "okay" },
    { selectedSuggestionIds: [`${questionId}:0`, `${questionId}:0`], text: "" },
  ]) expect(await service.answer({ threadId: "thread", questionId, ...answer })).toMatchObject({ ok: false, error: { code: "invalid_request" } });
  expect((await service.questions("thread"))).toMatchObject({ ok: true, value: [{ id: questionId }] });
});

it("keeps unanswered questions through turn completion and inactivity archiving, then reopens an explicitly archived thread on answer", async () => {
  const { service } = await setup();
  const asked = await service.ask({ requestId: "plain", threadId: "thread", question: "Details?" });
  if (!asked.ok) throw Error(asked.error.message);
  const questionId = asked.value.questionId;
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
  const created = await client.ask({ requestId: "retry", threadId: "thread", question: "Why?" });
  expect(created.ok).toBe(true);
  expect((await client.questions("thread"))).toMatchObject({ ok: true, value: [{ suggestions: [] }] });
  expect((await service.questions("thread"))).toMatchObject({ ok: true, value: [expect.any(Object)] });
  expect(fetcher).toHaveBeenCalledTimes(3);
});

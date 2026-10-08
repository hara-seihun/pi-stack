import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { ThreadService } from "../src/threads/service.js";
import { createThreadClient, threadHttp } from "../src/threads/http.js";
import { ThreadDirectory } from "../src/threads/directory.js";

const roots: string[] = [];
const services: ThreadService[] = [];
afterEach(async () => {
  for (const service of services.reverse()) await service.close();
  services.length = 0;
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots.length = 0;
});
function owner(root: string) {
  const service = new ThreadService({ capacity: { mode: "unmanaged" }, databasePath: join(root, "owner.sqlite"), sessionsDir: join(root, "sessions"), openSession: async () => { throw Error("Fixture must not open Pi"); } });
  services.push(service);
  return service;
}
async function setup() {
  const root = mkdtempSync(join(tmpdir(), "pending-questions-")); roots.push(root);
  const service = owner(root);
  for (const id of ["active", "archive", "location", "room", "unrelated"]) {
    expect(await service.spawn({ requestId: `spawn:${id}`, id, cwd: root, metadata: id === "room" ? { room: { id: "fixture" } } : {} })).toMatchObject({ ok: true });
  }
  const asked = await service.ask({ requestId: "ask", threadId: "active", questions: [{ question: "Pending?", suggestions: ["First", "Second"], recommendedSuggestionIndex: 1 }, { question: "Answered?" }, { question: "Dismissed?" }] });
  if (!asked.ok) throw Error(asked.error.message);
  expect(await service.answer({ threadId: "active", questionId: asked.value.questionIds[1]!, selectedSuggestionIds: [], text: "Settled" })).toMatchObject({ ok: true });
  expect(await service.answer({ threadId: "active", questionId: asked.value.questionIds[2]!, selectedSuggestionIds: [], text: "", dismissed: true })).toMatchObject({ ok: true });
  for (const id of ["archive", "room"]) expect(await service.ask({ requestId: `ask:${id}`, threadId: id, questions: [{ question: `${id}?` }] })).toMatchObject({ ok: true });
  expect(await service.control({ threadId: "archive", action: "update", archived: true })).toMatchObject({ ok: true });
  return { root, service, pendingId: asked.value.questionIds[0]! };
}

it("reads current pending rows and exact location owners without list, events, hydration or per-thread requests", async () => {
  const { root, service, pendingId } = await setup();
  for (const method of ["list", "questionEvents", "questions", "get"] as const) vi.spyOn(service, method).mockImplementation(() => { throw Error(`Unexpected ${method}`); });
  const pending = service.pendingQuestions({ locationThreadIds: ["location", "missing", "location"] });
  if (!pending.ok) throw Error(pending.error.message);
  expect(pending.value.questions.map(question => question.threadId)).toEqual(["active", "archive", "room"]);
  expect(pending.value.questions[0]).toMatchObject({ id: pendingId, recommendedSuggestionId: `${pendingId}:1`, suggestions: [{ id: `${pendingId}:0`, text: "First" }, { id: `${pendingId}:1`, text: "Second" }] });
  expect(pending.value.threads.map(thread => thread.id).sort()).toEqual(["active", "archive", "location", "room"]);
  expect(pending.value.threads.find(thread => thread.id === "archive")?.metadata?.archived).toBe(true);
  expect(pending.value.errors).toEqual([]);
  const db = new DatabaseSync(join(root, "owner.sqlite"));
  try {
    const plan = db.prepare("EXPLAIN QUERY PLAN SELECT q.* FROM thread_question q JOIN thread t ON t.id=q.thread_id WHERE q.accepted_at IS NULL ORDER BY q.thread_id,q.created_at,q.rowid").all();
    expect(plan.map(row => row.detail).join(" ")).toContain("thread_question_pending");
  } finally { db.close(); }
  vi.restoreAllMocks();
});

it("does not transport or decode settled history or unrelated thread rows", async () => {
  const { root, service } = await setup();
  const db = new DatabaseSync(join(root, "owner.sqlite"));
  try {
    db.exec(`BEGIN;
      WITH RECURSIVE n(i) AS (VALUES(1) UNION ALL SELECT i+1 FROM n WHERE i<10000)
      INSERT INTO thread(id,title,cwd,session_file,settings,admission,state,created_at,updated_at,metadata)
        SELECT 'history:'||i,t.title,t.cwd,t.session_file,t.settings,t.admission,t.state,t.created_at,t.updated_at,t.metadata FROM n,thread t WHERE t.id='unrelated';
      WITH RECURSIVE n(i) AS (VALUES(1) UNION ALL SELECT i+1 FROM n WHERE i<10000)
      INSERT INTO thread_question(id,thread_id,question,suggestions,created_at,answer,accepted_at)
        SELECT 'settled:'||i,'history:'||i,'Settled fixture','invalid-json',1,'{}',2 FROM n;
      INSERT INTO thread_question_event(question_id) SELECT id FROM thread_question WHERE id GLOB 'settled:*';
      COMMIT;`);
  } finally { db.close(); }
  expect(service.pendingQuestions({ locationThreadIds: ["location"] })).toMatchObject({ ok: true, value: {
    questions: [{ threadId: "active" }, { threadId: "archive" }, { threadId: "room" }],
    threads: [expect.objectContaining({ id: "active" }), expect.objectContaining({ id: "archive" }), expect.objectContaining({ id: "location" }), expect.objectContaining({ id: "room" })], errors: [],
  } });
});

it("is fresh after answer, dismissal, archive/restore and owner restart", async () => {
  const { root, service, pendingId } = await setup();
  expect(await service.answer({ threadId: "active", questionId: pendingId, selectedSuggestionIds: [], text: "", dismissed: true })).toMatchObject({ ok: true });
  expect(service.pendingQuestions({ locationThreadIds: [] })).toMatchObject({ ok: true, value: { questions: [{ threadId: "archive" }, { threadId: "room" }] } });
  await service.close();
  const restored = owner(root);
  const before = restored.pendingQuestions({ locationThreadIds: [] });
  if (!before.ok) throw Error(before.error.message);
  const archived = before.value.questions.find(question => question.threadId === "archive")!;
  expect(await restored.answer({ threadId: "archive", questionId: archived.id, selectedSuggestionIds: [], text: "Ready" })).toMatchObject({ ok: true });
  expect(restored.pendingQuestions({ locationThreadIds: ["archive"] })).toMatchObject({ ok: true, value: { questions: [{ threadId: "room" }], threads: [expect.objectContaining({ id: "archive", metadata: expect.not.objectContaining({ archived: true }) }), expect.objectContaining({ id: "room" })] } });
});

it("keeps healthy question owners while reporting a corrupt owner's read, and returns typed input/storage failures", async () => {
  const { root, service } = await setup();
  const db = new DatabaseSync(join(root, "owner.sqlite"));
  try { db.prepare("UPDATE thread_question SET suggestions='invalid-json' WHERE thread_id='active' AND accepted_at IS NULL").run(); }
  finally { db.close(); }
  const pending = service.pendingQuestions({ locationThreadIds: [] });
  expect(pending).toMatchObject({ ok: true, value: { questions: [{ threadId: "archive" }, { threadId: "room" }], errors: [{ threadId: "active", message: expect.any(String) }] } });
  for (const input of [undefined, {}, { locationThreadIds: [""] }, { locationThreadIds: [1] }, { locationThreadIds: [], other: true }]) {
    expect(service.pendingQuestions(input as never)).toMatchObject({ ok: false, error: { code: "invalid_request" } });
  }
  await service.close();
  expect(service.pendingQuestions({ locationThreadIds: [] })).toMatchObject({ ok: false, error: { code: "unavailable" } });
});

it("routes the owning query through HTTP and the directory without changing input or widening scope", async () => {
  const { service } = await setup();
  const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const response = await threadHttp(service, new Request(String(url), init));
    if (!response) throw Error("Unmatched route");
    return response;
  });
  const client = createThreadClient("http://localhost/v1/threads", fetcher);
  const directory = new ThreadDirectory({ id: "fixture", api: client });
  expect(await directory.pendingQuestions({ locationThreadIds: ["location"] })).toEqual(service.pendingQuestions({ locationThreadIds: ["location"] }));
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(fetcher.mock.calls[0]?.[0]).toBe("http://localhost/v1/threads/pendingQuestions");
  expect(await client.pendingQuestions({ locationThreadIds: [""] })).toMatchObject({ ok: false, error: { code: "invalid_request" } });
});

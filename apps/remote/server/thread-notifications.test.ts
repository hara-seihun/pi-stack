import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import type { ThreadApi, Thread, ThreadSettlement, ThreadQuestion, QuestionEvents } from "pi-orchestrator/api";
import { ensureSupervisorSchema } from "./database";
import { idleNotifications, notificationHistory } from "./notifications";
import { projectThreadNotifications, projectQuestionNotifications, projectAttentionNotifications } from "./thread-notifications";

type NotificationApi = Pick<ThreadApi, "settlements" | "questionEvents" | "attentionEvents" | "questions" | "list">;
function thread(id: string, overrides: Partial<Thread> = {}): Thread {
  return { id, title: id, parentId: null, role: "agent", cwd: "/tmp", sessionFile: `/tmp/${id}.jsonl`, settings: { model: "test", thinkingLevel: "off", speed: "standard" }, admission: "background", state: "idle", held: false, revision: 1, createdAt: 1, updatedAt: 1000, pendingMessages: 0, metadata: { foreground: true }, ...overrides };
}
function settlement(id: string, seq = 1, overrides: Partial<ThreadSettlement> = {}): ThreadSettlement {
  return { seq, executionId: `execution-${id}-${seq}`, threadId: id, workId: `work-${id}-${seq}`, outcome: "complete", time: seq * 1000, finalMessage: { role: "assistant", content: [{ type: "text", text: `Reply ${seq}` }] }, ...overrides };
}
function apiFor(threads: Thread[], receipts: ThreadSettlement[] = [], pending: ThreadQuestion[] = [], events: QuestionEvents["items"] = []): NotificationApi {
  return {
    attentionEvents: (after = 0) => ({ ok: true, value: { cursor: after, items: [] } }),
    questions: async id => ({ ok: true, value: pending.filter(q => q.threadId === id) }),
    questionEvents: (after = 0, limit = 100) => { const items = events.filter(event => event.seq > after).slice(0, limit); return { ok: true, value: { cursor: items.at(-1)?.seq ?? after, items } }; },
    settlements: (after = 0, limit = 100) => { const items = receipts.filter(receipt => receipt.seq > after).slice(0, limit); return { ok: true, value: { cursor: items.at(-1)?.seq ?? after, items } }; },
    list: async (input = {}) => ({ ok: true, value: { threads: threads.filter(t => input.id === undefined || t.id === input.id) } }),
  };
}
function database(): Database { const db = new Database(":memory:"); ensureSupervisorSchema(db); return db; }
function count(db: Database): number { return (db.query("SELECT count(*) n FROM idle_notifications").get() as { n: number }).n; }

test("attention from a running background agent publishes before failed settlement retrieval", async () => {
  const db = database();
  const agent = thread("child", { parentId: "parent", state: "running", metadata: { foreground: false } });
  const api = apiFor([agent]);
  api.attentionEvents = (after = 0) => ({ ok: true, value: { cursor: 1, items: after < 1 ? [{ accepted: true, seq: 1, threadId: agent.id, summary: "Review now", foreground: false, time: 1000 }] : [] } });
  let published = false;
  api.settlements = () => { expect(published).toBe(true); return { ok: false, error: { code: "unavailable", message: "Owner unavailable" } }; };
  await expect(projectThreadNotifications(db, "person", api, api, () => { published = true; })).rejects.toThrow("Owner unavailable");
  expect(idleNotifications(db, 0, () => agent).notifications).toMatchObject([{ kind: "attention", body: "Review now" }]);
  expect(agent.metadata?.foreground).toBe(false);
  db.close();
});

test("receipt cursors and unread acknowledgement survive replay and owners cannot collide", async () => {
  const db = database();
  const api = apiFor([thread("agent")], [settlement("agent")]);
  await projectThreadNotifications(db, "person", api);
  db.query("UPDATE thread_views SET idle_unread=0").run();
  ensureSupervisorSchema(db);
  await projectThreadNotifications(db, "person", api);
  expect(count(db)).toBe(1);
  expect(db.query("SELECT idle_unread FROM thread_views").get()).toEqual({ idle_unread: 0 });
  await projectThreadNotifications(db, "fleet", api);
  expect(count(db)).toBe(2);
  db.close();
});

test("launch provenance never gates another foreground agent's completion", async () => {
  const db = database();
  const child = thread("child", { parentId: "root", state: "running", pendingMessages: 1 });
  const api = apiFor([thread("root"), child], [settlement("root")]);
  await projectThreadNotifications(db, "person", api);
  expect(count(db)).toBe(1);
  db.close();
});

test("an explicit own wait defers completion and is rechecked without new settlements", async () => {
  const db = database();
  const agent = thread("agent", { state: "waiting", waitingOnAgents: { kind: "job", jobId: "job", reason: "Need result", since: 1 } });
  const api = apiFor([agent], [settlement("agent")]);
  await projectThreadNotifications(db, "person", api);
  expect(count(db)).toBe(0);
  delete agent.waitingOnAgents; agent.state = "idle";
  await projectThreadNotifications(db, "person", api);
  expect(count(db)).toBe(1);
  db.close();
});

test("background completion stays silent, promoted launched-agent completion notifies", async () => {
  const db = database();
  const rows = [thread("background", { metadata: { foreground: false } }), thread("foreground", { parentId: "background" })];
  await projectThreadNotifications(db, "person", apiFor(rows, [settlement("background"), settlement("foreground", 2)]));
  expect(db.query("SELECT session_id FROM idle_notifications").all()).toEqual([{ session_id: "foreground" }]);
  db.close();
});

test("questions are recorded immediately and retained after the agent archives", async () => {
  const db = database();
  const agent = thread("agent", { state: "running", metadata: { archived: true, foreground: false } });
  const api = apiFor([agent], [], [], [{ seq: 1, questionId: "q", threadId: "agent", question: "Which route?", time: 1000 }]);
  await projectQuestionNotifications(db, "person", api);
  await projectQuestionNotifications(db, "person", api);
  expect(notificationHistory(db, null, () => agent).notifications).toMatchObject([{ sessionId: "agent", kind: "question", body: "Which route?" }]);
  expect(count(db)).toBe(1);
  db.close();
});

test("failed attention projection never commits half a page or advances its cursor", async () => {
  const db = database();
  const api = apiFor([thread("known")]);
  api.attentionEvents = () => ({ ok: true, value: { cursor: 2, items: ["known", "missing"].map((threadId, i) => ({ accepted: true, seq: i + 1, threadId, summary: "Review", foreground: false, time: 1000 })) } });
  await expect(projectAttentionNotifications(db, "person", api)).rejects.toThrow("missing thread");
  expect(count(db)).toBe(0);
  expect(db.query("SELECT value FROM metadata WHERE key='thread-attention:person'").get()).toBeNull();
  db.close();
});

for (const [label, overrides] of [
  ["running", { state: "running" }], ["queued", { pendingMessages: 1 }], ["held", { held: true }], ["archived", { metadata: { archived: true } }],
] as Array<[string, Partial<Thread>]>) test(`${label} agent cannot produce a completion alert`, async () => {
  const db = database(); await projectThreadNotifications(db, "person", apiFor([thread("agent", overrides)], [settlement("agent")])); expect(count(db)).toBe(0); db.close();
});

for (const [label, overrides] of [
  ["no reply", { finalMessage: null }], ["whitespace", { finalMessage: { role: "assistant", content: [{ type: "text", text: " \n " }] } }], ["cancelled", { outcome: "cancelled" }], ["failed", { outcome: "failed" }],
] as Array<[string, Partial<ThreadSettlement>]>) test(`${label} supersedes an earlier deferred reply`, async () => {
  const db = database();
  const agent = thread("agent", { pendingMessages: 1 });
  const receipts = [settlement("agent")]; const api = apiFor([agent], receipts);
  await projectThreadNotifications(db, "person", api); expect(count(db)).toBe(0);
  receipts.push(settlement("agent", 2, overrides)); agent.pendingMessages = 0;
  await projectThreadNotifications(db, "person", api); expect(count(db)).toBe(0); db.close();
});

test("a pending question cannot be replaced with an idle notice", async () => {
  const db = database();
  const pending: ThreadQuestion[] = [{ id: "q", threadId: "agent", question: "Decision?", suggestions: [], createdAt: 1 }];
  await projectThreadNotifications(db, "person", apiFor([thread("agent")], [settlement("agent")], pending));
  expect(count(db)).toBe(0); db.close();
});

test("a later receipt page supersedes earlier replies", async () => {
  const db = database();
  const receipts = Array.from({ length: 101 }, (_, index) => settlement("agent", index + 1)); receipts[100]!.finalMessage = null;
  await projectThreadNotifications(db, "person", apiFor([thread("agent")], receipts)); expect(count(db)).toBe(0);
  expect(db.query("SELECT value FROM metadata WHERE key='thread-settlements:person'").get()).toEqual({ value: "101" }); db.close();
});

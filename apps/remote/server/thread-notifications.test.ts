import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ThreadApi, Thread, ThreadSettlement, ThreadQuestion, QuestionEvents } from "pi-orchestrator/api";
import { ensureSupervisorSchema } from "./database";
import { idleNotifications } from "./notifications";
import { projectThreadNotifications, projectQuestionNotifications, projectAttentionNotifications } from "./thread-notifications";

type NotificationApi = Pick<ThreadApi, "settlements" | "questionEvents" | "attentionEvents" | "questions" | "list">;

function thread(id: string, overrides: Partial<Thread> = {}): Thread {
  return { id, title: id, parentId: null, role: "conversation", cwd: "/tmp", sessionFile: `/tmp/${id}.jsonl`,
    settings: { model: "test", thinkingLevel: "off", speed: "standard" }, admission: "background",
    state: "idle", held: false, revision: 1, createdAt: 1, updatedAt: 1000, pendingMessages: 0, metadata: {}, ...overrides };
}

function settlement(id: string, seq = 1, overrides: Partial<ThreadSettlement> = {}): ThreadSettlement {
  return { seq, executionId: `execution-${id}-${seq}`, threadId: id, workId: `work-${id}-${seq}`,
    outcome: "complete", time: seq * 1000, finalMessage: { role: "assistant", content: [{ type: "text", text: `Reply ${seq}` }] }, ...overrides };
}

function question(threadId: string): ThreadQuestion {
  return { id: `q-${threadId}`, threadId, question: "Decision?", suggestions: [], createdAt: 1 };
}

function apiFor(threads: Thread[], receipts: ThreadSettlement[] = [], pending: ThreadQuestion[] = [], events: QuestionEvents["items"] = [], pageSize = 100): NotificationApi {
  return {
    attentionEvents: (after = 0) => ({ ok: true, value: { cursor: after, items: [] } }),
    questions: async id => ({ ok: true, value: pending.filter(q => q.threadId === id) }),
    questionEvents: (after = 0, limit = 100) => {
      const items = events.filter(event => event.seq > after).slice(0, limit);
      return { ok: true, value: { cursor: items.at(-1)?.seq ?? after, items } };
    },
    settlements: (after = 0, limit = 100) => {
      const items = receipts.filter(receipt => receipt.seq > after).slice(0, limit);
      return { ok: true, value: { cursor: items.at(-1)?.seq ?? after, items } };
    },
    list: async (input = {}) => {
      const matches = threads.filter(t => (input.id === undefined || t.id === input.id)
        && (input.parentId === undefined || t.parentId === input.parentId)
        && (input.state === undefined || t.state === input.state)
        && (input.archived === undefined || !!t.metadata?.archived === input.archived)
        && (input.cursor === undefined || t.id > input.cursor)).sort((a, b) => a.id.localeCompare(b.id));
      const limit = Math.min(input.limit ?? 100, pageSize);
      return { ok: true, value: { threads: matches.slice(0, limit),
        ...(matches.length > limit ? { nextCursor: matches[limit - 1]!.id } : {}) } };
    },
  };
}

function database(path = ":memory:"): Database {
  const db = new Database(path);
  ensureSupervisorSchema(db);
  return db;
}

function noticeCount(db: Database): number {
  return (db.query("SELECT count(*) n FROM idle_notifications").get() as { n: number }).n;
}

test("explicit attention notifies from a running worker without waiting for its tree or questions", async () => {
  const db = database();
  const worker = thread("child", { parentId: "parent", role: "worker", state: "running", metadata: { foreground: true, attentionSummary: "Please review — work continues." } });
  const api = apiFor([worker, thread("grandchild", { parentId: worker.id, state: "running" })], [], [question(worker.id)]);
  api.attentionEvents = (after = 0) => ({ ok: true, value: { cursor: 1, items: after < 1 ? [{ accepted: true, seq: 1, threadId: worker.id, summary: "Please review — work continues.", foreground: true, time: 1000 }] : [] } });
  await projectThreadNotifications(db, "person", api);
  expect(db.query("SELECT kind,body,receipt_id FROM idle_notifications").all()).toEqual([{ kind: "attention", body: "Please review — work continues.", receipt_id: "person:attention:1" }]);
  expect(idleNotifications(db, 0, id => id === worker.id ? worker : null).notifications).toMatchObject([{ sessionId: worker.id, body: "Please review — work continues.", kind: "attention" }]);
  expect(worker.state).toBe("running");
  db.close();
});

test("explicit attention publishes before a delayed or failed settlement scan", async () => {
  const db = database();
  const worker = thread("running", { role: "worker", state: "running" });
  const api = apiFor([worker]);
  api.attentionEvents = (after = 0) => ({ ok: true, value: { cursor: 1, items: after < 1 ? [{ accepted: true, seq: 1, threadId: worker.id, summary: "Review now", foreground: true, time: 1000 }] : [] } });
  let published = false;
  api.settlements = () => {
    expect(published).toBe(true);
    return { ok: false, error: { code: "unavailable", message: "Settlement owner unavailable" } };
  };
  await expect(projectThreadNotifications(db, "person", api, api, () => {
    expect(idleNotifications(db, 0, () => worker).notifications).toMatchObject([{ kind: "attention", body: "Review now" }]);
    published = true;
  })).rejects.toThrow("Settlement owner unavailable");
  expect(published).toBe(true);
  db.close();
});

test("attention cursors and unread acknowledgements survive restart and owner sequences cannot collide", async () => {
  const dir = mkdtempSync(join(tmpdir(), "thread-attention-"));
  try {
    const path = join(dir, "supervisor.sqlite");
    const api = apiFor([thread("watch", { metadata: { watchList: true }, state: "running" })]);
    api.attentionEvents = (after = 0) => ({ ok: true, value: { cursor: 1, items: after < 1 ? [{ accepted: true, seq: 1, threadId: "watch", summary: "A finding", foreground: false, time: 1000 }] : [] } });
    let db = database(path);
    await projectAttentionNotifications(db, "person", api);
    db.query("UPDATE thread_views SET idle_unread=0").run();
    db.close();
    db = database(path);
    await projectAttentionNotifications(db, "person", api);
    expect(noticeCount(db)).toBe(1);
    expect(db.query("SELECT idle_unread FROM thread_views WHERE id='watch'").get()).toEqual({ idle_unread: 0 });
    await projectAttentionNotifications(db, "fleet", api);
    expect(db.query("SELECT receipt_id FROM idle_notifications ORDER BY seq").all()).toEqual([{ receipt_id: "person:attention:1" }, { receipt_id: "fleet:attention:1" }]);
    db.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("failed attention projection cannot advance its cursor or commit half a page", async () => {
  const db = database();
  const api = apiFor([thread("known")]);
  api.attentionEvents = () => ({ ok: true, value: { cursor: 2, items: ["known", "missing"].map((threadId, i) => ({ accepted: true, seq: i + 1, threadId, summary: "Review", foreground: true, time: 1000 })) } });
  await expect(projectAttentionNotifications(db, "person", api)).rejects.toThrow("missing thread");
  expect(noticeCount(db)).toBe(0);
  expect(db.query("SELECT value FROM metadata WHERE key='thread-attention:person'").get()).toBeNull();
  db.close();
});

test("owner settlement cursors survive presentation replay and do not overlap", async () => {
  const db = database();
  const local = apiFor([thread("local")], [settlement("local")]);
  const fleet = apiFor([thread("fleet")], [settlement("fleet")]);
  await projectThreadNotifications(db, "person", local);
  await projectThreadNotifications(db, "fleet", fleet);
  expect(noticeCount(db)).toBe(2);
  db.query("UPDATE thread_views SET idle_unread=0").run();
  await projectThreadNotifications(db, "person", local);
  await projectThreadNotifications(db, "fleet", fleet);
  expect(noticeCount(db)).toBe(2);
  expect(db.query("SELECT sum(idle_unread) n FROM thread_views").get()).toEqual({ n: 0 });
  db.close();
});

test("a completion cannot replace a pending question notice with an idle notice", async () => {
  const db = database();
  const api = apiFor([thread("root")], [settlement("root")], [question("root")]);
  await projectThreadNotifications(db, "person", api);
  expect(noticeCount(db)).toBe(0);
  expect(db.query("SELECT value FROM metadata WHERE key='thread-settlements:person'").get()).toEqual({ value: "1" });
  db.close();
});

test("pending question occurrences project atomically, page past settled questions, and survive replay", async () => {
  const db = database();
  const api = apiFor([thread("child", { parentId: "parent", role: "worker", state: "running" })]);
  api.questionEvents = after => ({ ok: true, value: after === 0 ? { cursor: 100, items: [] } : after === 100 ? { cursor: 101, items: [{ seq: 101, questionId: "q", threadId: "child", question: "What next?", time: 1000 }] } : { cursor: 101, items: [] } });
  await projectQuestionNotifications(db, "person", api);
  await projectQuestionNotifications(db, "person", api);
  expect(db.query("SELECT kind,body,receipt_id FROM idle_notifications").all()).toEqual([{ kind: "question", body: "What next?", receipt_id: "person:question:q" }]);
  expect(db.query("SELECT value FROM metadata WHERE key='thread-questions:person'").get()).toEqual({ value: "101" });
  db.close();
});

test("completion is deferred while a child runs, survives restart, and is rechecked without new settlements", async () => {
  const dir = mkdtempSync(join(tmpdir(), "thread-notifications-"));
  try {
    const path = join(dir, "supervisor.sqlite");
    let db = database(path);
    const child = thread("child", { parentId: "root", role: "worker", state: "running", pendingMessages: 1 });
    const api = apiFor([thread("root"), child], [settlement("root")]);
    await projectThreadNotifications(db, "person", api);
    expect(noticeCount(db)).toBe(0);
    expect(db.query("SELECT value FROM metadata WHERE key='thread-settlements:person'").get()).toEqual({ value: "1" });
    db.close();
    db = database(path);
    await projectThreadNotifications(db, "person", api);
    expect(noticeCount(db)).toBe(0);
    child.state = "idle";
    child.pendingMessages = 0;
    await projectThreadNotifications(db, "person", api);
    expect(db.query("SELECT receipt_id FROM idle_notifications").all()).toEqual([{ receipt_id: "person:execution-root-1" }]);
    db.query("UPDATE thread_views SET idle_unread=0").run();
    await projectThreadNotifications(db, "person", api);
    expect(noticeCount(db)).toBe(1);
    expect(db.query("SELECT idle_unread FROM thread_views WHERE id='root'").get()).toEqual({ idle_unread: 0 });
    db.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("durable agent waits are not completion notifications even after their native turn settles", async () => {
  const db = database();
  const wait = { kind: "job" as const, jobId: "job-1", reason: "Need durable result", since: 1000 };
  const root = thread("root", { waitingOnAgents: wait });
  const api = apiFor([root], [settlement("root")]);
  await projectThreadNotifications(db, "person", api);
  expect(noticeCount(db)).toBe(0);
  delete root.waitingOnAgents;
  const child = thread("child", { parentId: "root", role: "worker", waitingOnAgents: wait });
  const tree = apiFor([root, child]);
  await projectThreadNotifications(db, "person", api, tree);
  expect(noticeCount(db)).toBe(0);
  delete child.waitingOnAgents;
  await projectThreadNotifications(db, "person", api, tree);
  expect(noticeCount(db)).toBe(1);
  db.close();
});

test("paginated, nested cross-owner descendants gate completion but unrelated running threads do not", async () => {
  const db = database();
  const root = thread("root");
  const descendants = [thread("a", { parentId: "root", role: "worker" }), thread("b", { parentId: "root", role: "worker" }),
    thread("c", { parentId: "root", role: "worker" }), thread("grandchild", { parentId: "c", role: "worker", state: "running" }),
    thread("unrelated", { state: "running", pendingMessages: 1 })];
  const api = apiFor([root], [settlement("root")]);
  const treeApi = apiFor([root, ...descendants], [], [], [], 2);
  await projectThreadNotifications(db, "person", api, treeApi);
  expect(noticeCount(db)).toBe(0);
  descendants[3]!.state = "idle";
  await projectThreadNotifications(db, "person", api, treeApi);
  expect(noticeCount(db)).toBe(1);
  db.close();
});

for (const [label, overrides] of [
  ["running root", { state: "running" }],
  ["queued root", { pendingMessages: 1 }],
  ["held root", { held: true }],
  ["archived root", { metadata: { archived: true } }],
] as Array<[string, Partial<Thread>]>) {
  test(`${label} cannot produce a completion alert`, async () => {
    const db = database();
    await projectThreadNotifications(db, "person", apiFor([thread("root", overrides)], [settlement("root")]));
    expect(noticeCount(db)).toBe(0);
    db.close();
  });
}

test("a new running turn and its queued work defer the previous reply until the latest reply replaces it", async () => {
  const db = database();
  const root = thread("root", { state: "running", pendingMessages: 1 });
  const receipts = [settlement("root")];
  const api = apiFor([root], receipts);
  await projectThreadNotifications(db, "person", api);
  expect(noticeCount(db)).toBe(0);
  root.state = "idle";
  await projectThreadNotifications(db, "person", api);
  expect(noticeCount(db)).toBe(0);
  receipts.push(settlement("root", 2));
  root.pendingMessages = 0;
  await projectThreadNotifications(db, "person", api);
  expect(db.query("SELECT receipt_id FROM idle_notifications").all()).toEqual([{ receipt_id: "person:execution-root-2" }]);
  db.close();
});

test("queued unheld descendant work gates completion; stopped descendants with held work are inactive", async () => {
  const db = database();
  const child = thread("child", { parentId: "root", role: "worker", pendingMessages: 2 });
  const api = apiFor([thread("root"), child], [settlement("root")]);
  await projectThreadNotifications(db, "person", api);
  expect(noticeCount(db)).toBe(0);
  child.held = true;
  child.state = "running";
  await projectThreadNotifications(db, "person", api);
  expect(noticeCount(db)).toBe(1);
  db.close();
});

test("worker settlements never create completion alerts, including parentless workers", async () => {
  const db = database();
  const threads = [thread("root"), thread("child", { parentId: "root", role: "worker" }), thread("detached", { role: "worker" })];
  const api = apiFor(threads, [settlement("child"), settlement("detached", 2)]);
  await projectThreadNotifications(db, "person", api);
  expect(idleNotifications(db, 0, id => threads.find(t => t.id === id) ?? null).notifications).toEqual([]);
  db.close();
});

for (const [label, overrides] of [
  ["missing reply", { finalMessage: null }],
  ["whitespace reply", { finalMessage: { role: "assistant", content: [{ type: "text", text: " \n\t " }] } }],
  ["tool-only reply", { finalMessage: { role: "assistant", content: [{ type: "toolCall", id: "tool", name: "read", arguments: {} }] } }],
  ["thinking-only reply", { finalMessage: { role: "assistant", content: [{ type: "thinking", thinking: "Still considering." }] } }],
  ["non-assistant reply", { finalMessage: { role: "user", content: [{ type: "text", text: "Not Kenan's answer" }] } }],
  ["cancelled turn with text", { outcome: "cancelled" }],
  ["failed turn with text", { outcome: "failed" }],
] as Array<[string, Partial<ThreadSettlement>]>) {
  test(`${label} cannot notify or resurrect an earlier deferred reply`, async () => {
    const db = database();
    const child = thread("child", { parentId: "root", role: "worker", state: "running" });
    const receipts = [settlement("root")];
    const api = apiFor([thread("root"), child], receipts);
    await projectThreadNotifications(db, "person", api);
    expect(noticeCount(db)).toBe(0);
    receipts.push(settlement("root", 2, overrides));
    child.state = "idle";
    await projectThreadNotifications(db, "person", api);
    await projectThreadNotifications(db, "person", api);
    expect(noticeCount(db)).toBe(0);
    expect(db.query("SELECT value FROM metadata WHERE key='thread-settlements:person'").get()).toEqual({ value: "2" });
    db.close();
  });
}

test("latest root reply supersedes earlier replies within a page and while completion is deferred", async () => {
  const db = database();
  const child = thread("child", { parentId: "root", role: "worker", state: "running" });
  const receipts = [settlement("root"), settlement("root", 2)];
  const api = apiFor([thread("root"), child], receipts);
  await projectThreadNotifications(db, "person", api);
  expect(noticeCount(db)).toBe(0);
  receipts.push(settlement("root", 3));
  child.state = "idle";
  await projectThreadNotifications(db, "person", api);
  expect(db.query("SELECT receipt_id FROM idle_notifications").all()).toEqual([{ receipt_id: "person:execution-root-3" }]);
  await projectThreadNotifications(db, "person", api);
  expect(noticeCount(db)).toBe(1);
  db.close();
});

test("questions notify immediately from running roots and workers, suppress completion, and are not replayed", async () => {
  const db = database();
  const threads = [thread("root", { state: "running", pendingMessages: 1 }), thread("child", { parentId: "root", role: "worker", state: "running" })];
  const pending = [question("root"), question("child")];
  const events = pending.map((q, index) => ({ seq: index + 1, questionId: q.id, threadId: q.threadId, question: q.question, time: 1000 + index }));
  const api = apiFor(threads, [settlement("root")], pending, events);
  await projectThreadNotifications(db, "person", api);
  expect(db.query("SELECT kind,receipt_id FROM idle_notifications ORDER BY receipt_id").all()).toEqual([
    { kind: "question", receipt_id: "person:question:q-child" }, { kind: "question", receipt_id: "person:question:q-root" },
  ]);
  threads[0]!.state = "idle";
  threads[0]!.pendingMessages = 0;
  threads[1]!.state = "idle";
  await projectThreadNotifications(db, "person", api);
  expect(noticeCount(db)).toBe(2);
  db.close();
});

test("a cross-owner worker's pending question suppresses root completion until answered", async () => {
  const db = database();
  const root = thread("root");
  const api = apiFor([root], [settlement("root")]);
  const pending = [question("child")];
  const treeApi = apiFor([root, thread("child", { parentId: "root", role: "worker" })], [], pending);
  await projectThreadNotifications(db, "person", api, treeApi);
  expect(noticeCount(db)).toBe(0);
  pending.length = 0;
  await projectThreadNotifications(db, "person", api, treeApi);
  expect(noticeCount(db)).toBe(1);
  db.close();
});

test("an incomplete latest settlement on a later receipt page supersedes every earlier reply", async () => {
  const db = database();
  const receipts = Array.from({ length: 101 }, (_, index) => settlement("root", index + 1));
  receipts[100]!.finalMessage = null;
  await projectThreadNotifications(db, "person", apiFor([thread("root")], receipts));
  expect(noticeCount(db)).toBe(0);
  expect(db.query("SELECT value FROM metadata WHERE key='thread-settlements:person'").get()).toEqual({ value: "101" });
  db.close();
});

test("a parent turn queued while descendants are inspected postpones the candidate", async () => {
  const db = database();
  const root = thread("root");
  const api = apiFor([root], [settlement("root")]);
  const treeApi = apiFor([root]);
  const list = treeApi.list;
  let queueTurn = true;
  treeApi.list = async input => {
    if (input?.parentId === "root" && queueTurn) {
      queueTurn = false;
      root.state = "running";
      root.pendingMessages = 1;
    }
    return list(input);
  };
  await projectThreadNotifications(db, "person", api, treeApi);
  expect(noticeCount(db)).toBe(0);
  root.state = "idle";
  root.pendingMessages = 0;
  await projectThreadNotifications(db, "person", api, treeApi);
  expect(noticeCount(db)).toBe(1);
  db.close();
});

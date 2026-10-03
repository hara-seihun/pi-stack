import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import type { ThreadApi, Thread } from "pi-orchestrator/api";
import { ensureSupervisorSchema } from "./database";
import { projectThreadNotifications, projectQuestionNotifications } from "./thread-notifications";

function owner(id: string): Pick<ThreadApi, "settlements" | "questionEvents" | "questions" | "list"> {
  return {
    questions: async () => ({ ok: true, value: [] }),
    questionEvents: after => ({ ok: true, value: { cursor: after ?? 0, items: [] } }),
    settlements: after => ({ ok: true, value: { cursor: 1, items: after ? [] : [{ seq: 1, executionId: `execution-${id}`,
      threadId: id, workId: `work-${id}`, outcome: "complete", time: 1000, finalMessage: null }] } }),
    list: async () => ({ ok: true, value: { threads: [{ id, title: id } as Thread] } }),
  };
}

test("owner settlement cursors survive presentation replay and do not overlap", async () => {
  const db = new Database(":memory:");
  ensureSupervisorSchema(db);
  await projectThreadNotifications(db, "person", owner("local"));
  await projectThreadNotifications(db, "fleet", owner("fleet"));
  db.query("UPDATE thread_views SET idle_unread=0").run();
  await projectThreadNotifications(db, "person", owner("local"));
  await projectThreadNotifications(db, "fleet", owner("fleet"));
  expect(db.query("SELECT count(*) n FROM idle_notifications").get()).toEqual({ n: 2 });
  expect(db.query("SELECT sum(idle_unread) n FROM thread_views").get()).toEqual({ n: 0 });
  db.close();
});

test("a completion cannot replace a pending question notice with an idle notice", async () => {
  const db = new Database(":memory:");
  ensureSupervisorSchema(db);
  const api = owner("root");
  api.questions = async () => ({ ok: true, value: [{ id: "q", threadId: "root", question: "Decision?", suggestions: [], createdAt: 1 }] });
  await projectThreadNotifications(db, "person", api);
  expect(db.query("SELECT count(*) n FROM idle_notifications").get()).toEqual({ n: 0 });
  expect(db.query("SELECT value FROM metadata WHERE key='thread-settlements:person'").get()).toEqual({ value: "1" });
  db.close();
});

test("pending question occurrences project atomically, page past settled questions, and survive replay", async () => {
  const db = new Database(":memory:");
  ensureSupervisorSchema(db);
  const api: Pick<ThreadApi, "questionEvents" | "list"> = {
    questionEvents: after => ({ ok: true, value: after === 0 ? { cursor: 100, items: [] } : after === 100 ? { cursor: 101, items: [{ seq: 101, questionId: "q", threadId: "child", question: "What next?", time: 1000 }] } : { cursor: 101, items: [] } }),
    list: async () => ({ ok: true, value: { threads: [{ id: "child", title: "Child", parentId: "parent" } as Thread] } }),
  };
  await projectQuestionNotifications(db, "person", api);
  await projectQuestionNotifications(db, "person", api);
  expect(db.query("SELECT kind,body,receipt_id FROM idle_notifications").all()).toEqual([{ kind: "question", body: "What next?", receipt_id: "person:question:q" }]);
  expect(db.query("SELECT value FROM metadata WHERE key='thread-questions:person'").get()).toEqual({ value: "101" });
  db.close();
});

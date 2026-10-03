import type { Database } from "bun:sqlite";
import type { ThreadApi } from "pi-orchestrator/api";
import { recordIdleNotification } from "./database";

/** Each owner sequences its own execution receipts. Remote only delivers them to clients. */
export async function projectThreadNotifications(db: Database, owner: string, api: Pick<ThreadApi, "settlements" | "questionEvents" | "questions" | "list">): Promise<void> {
  await projectQuestionNotifications(db, owner, api);
  const key = `thread-settlements:${owner}`;
  let cursor = Number((db.query("SELECT value FROM metadata WHERE key=?").get(key) as { value: string } | null)?.value ?? 0);
  while (true) {
    const result = await api.settlements(cursor, 100);
    if (!result.ok) throw new Error(result.error.message);
    const page = result.value;
    if (!page.items.length) return;
    const named = await Promise.all(page.items.map(async item => {
      const listed = await api.list({ id: item.threadId, limit: 1 });
      if (!listed.ok) throw new Error(listed.error.message);
      const thread = listed.value.threads.find(thread => thread.id === item.threadId);
      if (!thread) throw new Error(`Settlement ${item.executionId} names missing thread ${item.threadId}`);
      const pending = await api.questions(item.threadId);
      if (!pending.ok) throw new Error(pending.error.message);
      return { item, thread, hasQuestions: pending.value.length > 0 };
    }));
    db.transaction(() => {
      for (const { item, thread, hasQuestions } of named) {
        if (!hasQuestions) recordIdleNotification(db, `${owner}:${item.executionId}`, thread, item.time);
      }
      db.query("INSERT OR REPLACE INTO metadata(key,value) VALUES(?,?)").run(key, String(page.cursor));
    })();
    cursor = page.cursor;
    if (page.items.length < 100) return;
  }
}

export async function projectQuestionNotifications(db: Database, owner: string, api: Pick<ThreadApi, "questionEvents" | "list">): Promise<void> {
  const key = `thread-questions:${owner}`;
  let cursor = Number((db.query("SELECT value FROM metadata WHERE key=?").get(key) as { value: string } | null)?.value ?? 0);
  while (true) {
    const result = await api.questionEvents(cursor, 100);
    if (!result.ok) throw new Error(result.error.message);
    const page = result.value;
    if (page.cursor === cursor) return;
    const named = await Promise.all(page.items.map(async item => {
      const listed = await api.list({ id: item.threadId, limit: 1 });
      if (!listed.ok) throw new Error(listed.error.message);
      const thread = listed.value.threads.find(thread => thread.id === item.threadId);
      if (!thread) throw new Error(`Question ${item.questionId} names missing thread ${item.threadId}`);
      return { item, thread };
    }));
    db.transaction(() => {
      for (const { item, thread } of named) {
        if (!thread.metadata?.archived) recordIdleNotification(db, `${owner}:question:${item.questionId}`, thread, item.time, { kind: "question", body: item.question });
      }
      db.query("INSERT OR REPLACE INTO metadata(key,value) VALUES(?,?)").run(key, String(page.cursor));
    })();
    cursor = page.cursor;
  }
}

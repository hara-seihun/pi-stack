import type { Database } from "bun:sqlite";
import type { ThreadApi, Thread, ThreadSettlement } from "pi-orchestrator/api";
import { recordIdleNotification } from "./database";

type Completion = Pick<ThreadSettlement, "executionId" | "threadId" | "time">;
type NotificationApi = Pick<ThreadApi, "settlements" | "questionEvents" | "questions" | "list">;

function hasReply(item: ThreadSettlement): boolean {
  const message = item.finalMessage;
  if (item.outcome !== "complete" || message?.role !== "assistant") return false;
  const content = message.content;
  return typeof content === "string" ? content.trim().length > 0 : Array.isArray(content)
    && content.some(block => block?.type === "text" && typeof block.text === "string" && block.text.trim().length > 0);
}

async function findThread(api: Pick<ThreadApi, "list">, id: string): Promise<Thread> {
  const listed = await api.list({ id, limit: 1 });
  if (!listed.ok) throw new Error(listed.error.message);
  const thread = listed.value.threads.find(thread => thread.id === id);
  if (!thread) throw new Error(`Notification names missing thread ${id}`);
  return thread;
}

function conversation(thread: Thread): boolean {
  return !thread.parentId && thread.role !== "worker" && !thread.metadata?.archived && !thread.held;
}

function busy(thread: Thread): boolean {
  return !thread.held && (thread.state === "running" || thread.pendingMessages > 0);
}

async function descendantsIdle(api: Pick<ThreadApi, "list" | "questions">, root: string): Promise<boolean> {
  const seen = new Set([root]), queue = [root];
  for (const parentId of queue) {
    let cursor: string | undefined;
    do {
      const listed = await api.list({ parentId, limit: 100, cursor });
      if (!listed.ok) throw new Error(listed.error.message);
      if (listed.value.threads.some(busy)) return false;
      const questions = await Promise.all(listed.value.threads.filter(child => !child.metadata?.archived).map(child => api.questions(child.id)));
      for (const result of questions) {
        if (!result.ok) throw new Error(result.error.message);
        if (result.value.length) return false;
      }
      for (const child of listed.value.threads) {
        if (!seen.has(child.id)) { seen.add(child.id); queue.push(child.id); }
      }
      cursor = listed.value.nextCursor;
    } while (cursor);
  }
  return true;
}

/** Each owner sequences its receipts; the directory supplies the whole worker tree. */
export async function projectThreadNotifications(db: Database, owner: string, api: NotificationApi, treeApi: Pick<ThreadApi, "list" | "questions"> = api): Promise<void> {
  await projectQuestionNotifications(db, owner, api);
  const key = `thread-settlements:${owner}`;
  const pendingKey = `thread-completions:${owner}`;
  let cursor = Number((db.query("SELECT value FROM metadata WHERE key=?").get(key) as { value: string } | null)?.value ?? 0);
  const saved = (db.query("SELECT value FROM metadata WHERE key=?").get(pendingKey) as { value: string } | null)?.value;
  const pending = new Map<string, Completion>((saved ? JSON.parse(saved) as Completion[] : []).map(item => [item.threadId, item]));
  const ready: Array<{ item: Completion; thread: Thread }> = [];
  while (true) {
    const result = await api.settlements(cursor, 100);
    if (!result.ok) throw new Error(result.error.message);
    const receipts = await Promise.all(result.value.items.map(async item => {
      const thread = await findThread(api, item.threadId);
      let hasQuestions = false;
      if (thread.parentId || thread.role === "worker") {
        const questions = await api.questions(item.threadId);
        if (!questions.ok) throw new Error(questions.error.message);
        hasQuestions = questions.value.length > 0;
      }
      return { item, thread, hasQuestions };
    }));
    for (const { item, thread, hasQuestions } of receipts) {
      pending.delete(item.threadId);
      if (thread.parentId || thread.role === "worker") {
        if (!hasQuestions) ready.push({ item, thread });
      } else if (hasReply(item) && conversation(thread)) {
        pending.set(item.threadId, { executionId: item.executionId, threadId: item.threadId, time: item.time });
      }
    }
    cursor = result.value.cursor;
    if (result.value.items.length < 100) break;
  }

  for (const item of pending.values()) {
    let thread = await findThread(api, item.threadId);
    const questions = await api.questions(item.threadId);
    if (!questions.ok) throw new Error(questions.error.message);
    if (!conversation(thread) || questions.value.length) { pending.delete(item.threadId); continue; }
    if (busy(thread) || !await descendantsIdle(treeApi, item.threadId)) continue;
    // A child's settlement can queue a parent turn while the tree is being read.
    thread = await findThread(api, item.threadId);
    if (!conversation(thread)) { pending.delete(item.threadId); continue; }
    if (busy(thread)) continue;
    ready.push({ item, thread });
    pending.delete(item.threadId);
  }
  db.transaction(() => {
    for (const { item, thread } of ready) recordIdleNotification(db, `${owner}:${item.executionId}`, thread, item.time);
    db.query("INSERT OR REPLACE INTO metadata(key,value) VALUES(?,?)").run(key, String(cursor));
    db.query("INSERT OR REPLACE INTO metadata(key,value) VALUES(?,?)").run(pendingKey, JSON.stringify([...pending.values()]));
  })();
}

export async function projectQuestionNotifications(db: Database, owner: string, api: Pick<ThreadApi, "questionEvents" | "list">): Promise<void> {
  const key = `thread-questions:${owner}`;
  let cursor = Number((db.query("SELECT value FROM metadata WHERE key=?").get(key) as { value: string } | null)?.value ?? 0);
  while (true) {
    const result = await api.questionEvents(cursor, 100);
    if (!result.ok) throw new Error(result.error.message);
    const page = result.value;
    if (page.cursor === cursor) return;
    const named = await Promise.all(page.items.map(async item => ({ item, thread: await findThread(api, item.threadId) })));
    db.transaction(() => {
      for (const { item, thread } of named) {
        if (!thread.metadata?.archived) recordIdleNotification(db, `${owner}:question:${item.questionId}`, thread, item.time, { kind: "question", body: item.question });
      }
      db.query("INSERT OR REPLACE INTO metadata(key,value) VALUES(?,?)").run(key, String(page.cursor));
    })();
    cursor = page.cursor;
  }
}

import type { Database } from "bun:sqlite";
import type { ThreadApi, Thread, ThreadSettlement, ManagerNotificationPolicy } from "pi-orchestrator/api";
import { CLASSIC_NOTIFICATION_POLICY, humanNotification } from "./notification-policy";
import { recordIdleNotification } from "./database";
import { isSilentAssistant } from "pi-orchestrator/manager-turn";

type Completion = Pick<ThreadSettlement, "executionId" | "threadId" | "time">;
type NotificationApi = Pick<ThreadApi, "settlements" | "questionEvents" | "attentionEvents" | "questions" | "list">;
type NotificationDirectory = Pick<ThreadApi, "list"> & Partial<Pick<ThreadApi, "send">>;

function hasReply(item: ThreadSettlement, thread: Thread): boolean {
  const message = item.finalMessage;
  if (thread.metadata?.manager === true && isSilentAssistant(message)) return false;
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
  return (thread.metadata?.foreground === true || thread.metadata?.foreground === undefined && !thread.parentId && thread.role !== "kenatia")
    && thread.lifecycle.kind !== "archived" && !thread.held;
}

function busy(thread: Thread): boolean {
  switch (thread.lifecycle.kind) {
    case "working": case "waiting": case "cancelling": return true;
    case "failed": return thread.lifecycle.control !== "none";
    case "idle": case "archived": return false;
  }
}

/** UI receipt projection only. Core owns manager dispatch independently of Remote. */
export async function projectThreadNotifications(db: Database, owner: string, api: NotificationApi, directory: NotificationDirectory = api, published?: () => void, policy: ManagerNotificationPolicy = CLASSIC_NOTIFICATION_POLICY): Promise<void> {
  await projectAttentionNotifications(db, owner, api, published, policy, directory);
  await projectQuestionNotifications(db, owner, api, policy, directory);
  const key = `thread-settlements:${owner}`;
  const pendingKey = `thread-completions:${owner}`;
  let cursor = Number((db.query("SELECT value FROM metadata WHERE key=?").get(key) as { value: string } | null)?.value ?? 0);
  const saved = (db.query("SELECT value FROM metadata WHERE key=?").get(pendingKey) as { value: string } | null)?.value;
  const pending = new Map<string, Completion>((saved ? JSON.parse(saved) as Completion[] : []).map(item => [item.threadId, item]));
  const initialCursor = cursor;
  const initialPending = JSON.stringify([...pending.values()]);
  const ready: Array<{ item: Completion; thread: Thread }> = [];
  while (true) {
    const result = await api.settlements(cursor, 100);
    if (!result.ok) throw new Error(result.error.message);
    const receipts = await Promise.all(result.value.items.map(async item => {
      const thread = await findThread(api, item.threadId);
      return { item, thread };
    }));
    for (const { item, thread } of receipts) {
      pending.delete(item.threadId);
      if (humanNotification(policy, thread.id, "idle") && hasReply(item, thread) && conversation(thread)) {
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
    if (!humanNotification(policy, thread.id, "idle") || !conversation(thread) || questions.value.length) { pending.delete(item.threadId); continue; }
    if (busy(thread)) continue;
    thread = await findThread(api, item.threadId);
    if (!conversation(thread)) { pending.delete(item.threadId); continue; }
    if (busy(thread)) continue;
    ready.push({ item, thread });
    pending.delete(item.threadId);
  }
  const nextPending = JSON.stringify([...pending.values()]);
  const cursorChanged = cursor !== initialCursor;
  const pendingChanged = nextPending !== initialPending;
  if (!ready.length && !cursorChanged && !pendingChanged) return;
  db.transaction(() => {
    for (const { item, thread } of ready) recordIdleNotification(db, `${owner}:${item.executionId}`, thread, item.time);
    if (cursorChanged) db.query("INSERT OR REPLACE INTO metadata(key,value) VALUES(?,?)").run(key, String(cursor));
    if (pendingChanged) db.query("INSERT OR REPLACE INTO metadata(key,value) VALUES(?,?)").run(pendingKey, nextPending);
  })();
}

export async function projectAttentionNotifications(db: Database, owner: string, api: Pick<ThreadApi, "attentionEvents" | "list">, published?: () => void, policy: ManagerNotificationPolicy = CLASSIC_NOTIFICATION_POLICY, directory: NotificationDirectory = api as NotificationDirectory): Promise<void> {
  const key = `thread-attention:${owner}`;
  let cursor = Number((db.query("SELECT value FROM metadata WHERE key=?").get(key) as { value: string } | null)?.value ?? 0);
  while (true) {
    const result = await api.attentionEvents(cursor, 100);
    if (!result.ok) throw new Error(result.error.message);
    const page = result.value;
    if (page.cursor === cursor) return;
    const named = await Promise.all(page.items.map(async item => ({ item, thread: await findThread(api, item.threadId) })));
    db.transaction(() => {
      for (const { item, thread } of named) {
        if (!humanNotification(policy, thread.id, "attention")) continue;
        recordIdleNotification(db, `${owner}:attention:${item.seq}`, thread, item.time, { kind: "attention", body: item.summary });
      }
      db.query("INSERT OR REPLACE INTO metadata(key,value) VALUES(?,?)").run(key, String(page.cursor));
    })();
    cursor = page.cursor;
    published?.();
  }
}

export async function projectQuestionNotifications(db: Database, owner: string, api: Pick<ThreadApi, "questionEvents" | "list">, policy: ManagerNotificationPolicy = CLASSIC_NOTIFICATION_POLICY, directory: NotificationDirectory = api as NotificationDirectory): Promise<void> {
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
        if (!humanNotification(policy, thread.id, "question")) continue;
        recordIdleNotification(db, `${owner}:question:${item.questionId}`, thread, item.time, { kind: "question", body: item.question });
      }
      db.query("INSERT OR REPLACE INTO metadata(key,value) VALUES(?,?)").run(key, String(page.cursor));
    })();
    cursor = page.cursor;
  }
}

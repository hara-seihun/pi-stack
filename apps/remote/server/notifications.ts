import type { Database } from "bun:sqlite";
import type { ManagerNotificationPolicy } from "pi-orchestrator/api";
import { CLASSIC_NOTIFICATION_POLICY, humanNotification } from "./notification-policy";

import type { IdleNotification, IdleNotificationFeed, NotificationHistory, HistoryNotification, ThreadQuestion } from "./protocol";
export type { IdleNotification, IdleNotificationFeed } from "./protocol";

export function idleNotifications(
  db: Database,
  after: number | null,
  localThread: (id: string) => { parentId: string | null; role?: "agent" | "conversation" | "worker"; foreground?: boolean } | null,
  policy: ManagerNotificationPolicy | null = CLASSIC_NOTIFICATION_POLICY,
): IdleNotificationFeed {
  const latest = Number((db.query("SELECT COALESCE(MAX(seq),0) AS seq FROM idle_notifications").get() as { seq: number }).seq);
  if (after === null) return { cursor: latest, notifications: [] };
  const page = db.query("SELECT seq,session_id AS sessionId,name,time,kind,body FROM idle_notifications WHERE seq>? ORDER BY seq LIMIT 100")
    .all(after) as IdleNotification[];
  const notifications = page.filter(event => {
    if (!humanNotification(policy, event.sessionId, event.kind)) return false;
    const thread = localThread(event.sessionId);
    return thread !== null && (event.kind === "question" || event.kind === "attention" || thread.foreground === true || thread.foreground === undefined && !thread.parentId && thread.role !== "worker");
  });
  return { cursor: page.at(-1)?.seq ?? latest, notifications };
}

export function notificationHistory(db: Database, before: number | null,
  accessible: (id: string) => unknown, limit = 100, policy: ManagerNotificationPolicy | null = CLASSIC_NOTIFICATION_POLICY): NotificationHistory {
  const rows = db.query(`SELECT n.seq,n.session_id AS sessionId,n.name,n.time,n.kind,n.body,n.receipt_id AS receiptId,
    COALESCE(v.idle_unread,0) AS unread,
    (SELECT MAX(latest.seq) FROM idle_notifications latest WHERE latest.session_id=n.session_id AND latest.kind='attention') AS latestAttention
    FROM idle_notifications n LEFT JOIN thread_views v ON v.id=n.session_id
    WHERE n.kind IN ('question','attention') AND (? IS NULL OR n.seq<?) ORDER BY n.seq DESC LIMIT ?`).all(before, before, limit) as (IdleNotification & { receiptId: string | null; unread: number; latestAttention: number | null })[];
  const notifications: HistoryNotification[] = rows.filter(row => accessible(row.sessionId) && humanNotification(policy, row.sessionId, row.kind)).map(({ receiptId, unread, latestAttention, ...notice }) => {
    if (notice.kind === "attention") return { ...notice, status: unread && notice.seq === latestAttention ? "needs-you" : "history" };
    const marker = receiptId?.indexOf(":question:");
    const questionId = marker !== undefined && marker >= 0 ? receiptId!.slice(marker + ":question:".length) : undefined;
    return { ...notice, questionId, status: "unavailable", error: "Current question status has not been loaded." };
  });
  return { notifications, before: rows.length === limit ? rows.at(-1)!.seq : null };
}

export async function resolveNotificationQuestions(history: NotificationHistory,
  read: (id: string) => Promise<import("pi-orchestrator/api").Result<ThreadQuestion[]>>): Promise<NotificationHistory> {
  const ids = [...new Set(history.notifications.filter(item => item.kind === "question").map(item => item.sessionId))];
  const questions = new Map(await Promise.all(ids.map(async id => [id, await read(id).catch(cause => ({ ok: false as const, error: { code: "unavailable" as const, message: cause instanceof Error ? cause.message : String(cause) } }))] as const)));
  return { ...history, notifications: history.notifications.map(item => {
    if (item.kind !== "question") return item;
    const loaded = questions.get(item.sessionId)!;
    if (!loaded.ok) return { ...item, status: "unavailable", error: loaded.error.message };
    if (!item.questionId) return { ...item, status: "unavailable", error: "This recorded question has no owner receipt." };
    const plain = { seq: item.seq, sessionId: item.sessionId, name: item.name, time: item.time, kind: item.kind, body: item.body, questionId: item.questionId };
    return { ...plain, status: loaded.value.some(question => question.id === item.questionId) ? "needs-you" : "history" };
  }) };
}

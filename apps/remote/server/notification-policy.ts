import type { ManagerNotificationPolicy } from "pi-orchestrator/api";

import { humanNotification } from "../shared/notification-policy";
export { humanNotification, CLASSIC_NOTIFICATION_POLICY } from "../shared/notification-policy";

export function humanQuestions<T extends { id: string; threadId: string }>(db: import("bun:sqlite").Database, policy: ManagerNotificationPolicy | null, questions: T[]): T[] {
  if (policy === null) return [];
  if (policy.view === "classic") return questions;
  const explicit = db.query("SELECT 1 FROM idle_notifications WHERE session_id=? AND kind='attention' AND instr(body,?)>0 LIMIT 1");
  return questions.filter(question => question.threadId === policy.managerThreadId && !!explicit.get(policy.managerThreadId, question.id));
}

export function notificationUnread(db: import("bun:sqlite").Database, policy: ManagerNotificationPolicy | null, threadId: string, unread: boolean): boolean {
  if (!unread || policy === null) return false;
  if (policy.view === "classic") return true;
  if (threadId !== policy.managerThreadId) return false;
  const latest = db.query("SELECT kind FROM idle_notifications WHERE session_id=? ORDER BY seq DESC LIMIT 1").get(threadId) as { kind: "idle" | "question" | "attention" } | null;
  return latest !== null && humanNotification(policy, threadId, latest.kind);
}

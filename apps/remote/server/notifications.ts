import type { Database } from "bun:sqlite";

export interface IdleNotification { seq: number; sessionId: string; name: string; time: string }
export interface IdleNotificationFeed { cursor: number; notifications: IdleNotification[] }

export function idleNotifications(db: Database, after: number | null): IdleNotificationFeed {
  const latest = Number((db.query("SELECT COALESCE(MAX(seq),0) AS seq FROM idle_notifications").get() as { seq: number }).seq);
  if (after === null) return { cursor: latest, notifications: [] };
  const notifications = db.query("SELECT seq,session_id AS sessionId,name,time FROM idle_notifications WHERE seq>? ORDER BY seq LIMIT 100")
    .all(after) as IdleNotification[];
  return { cursor: notifications.at(-1)?.seq ?? latest, notifications };
}

import type { Database } from "bun:sqlite";

import type { IdleNotification, IdleNotificationFeed } from "./protocol";
export type { IdleNotification, IdleNotificationFeed } from "./protocol";

export function idleNotifications(
  db: Database,
  after: number | null,
  localThread: (id: string) => { parentId: string | null } | null,
): IdleNotificationFeed {
  const latest = Number((db.query("SELECT COALESCE(MAX(seq),0) AS seq FROM idle_notifications").get() as { seq: number }).seq);
  if (after === null) return { cursor: latest, notifications: [] };
  const page = db.query("SELECT seq,session_id AS sessionId,name,time FROM idle_notifications WHERE seq>? ORDER BY seq LIMIT 100")
    .all(after) as IdleNotification[];
  const notifications = page.filter(event => {
    const thread = localThread(event.sessionId);
    return thread !== null && !thread.parentId;
  });
  return { cursor: page.at(-1)?.seq ?? latest, notifications };
}

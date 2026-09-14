import type { Database } from "bun:sqlite";
import type { ThreadApi } from "pi-orchestrator/api";
import { recordIdleNotification } from "./database";

/** Each owner sequences its own execution receipts. Remote only delivers them to clients. */
export async function projectThreadNotifications(db: Database, owner: string, api: Pick<ThreadApi, "settlements" | "list">): Promise<void> {
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
      return { item, thread };
    }));
    db.transaction(() => {
      for (const { item, thread } of named) recordIdleNotification(db, `${owner}:${item.executionId}`, thread, item.time);
      db.query("INSERT OR REPLACE INTO metadata(key,value) VALUES(?,?)").run(key, String(page.cursor));
    })();
    cursor = page.cursor;
    if (page.items.length < 100) return;
  }
}

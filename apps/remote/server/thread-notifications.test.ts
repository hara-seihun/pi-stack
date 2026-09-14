import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import type { ThreadApi, Thread } from "pi-orchestrator/api";
import { ensureSupervisorSchema } from "./database";
import { projectThreadNotifications } from "./thread-notifications";

function owner(id: string): Pick<ThreadApi, "settlements" | "list"> {
  return {
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

import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { Manager, parseManagerPatch } from "./manager";

test("Remote adopts presentation preferences but canonical manager identity always comes from core", async () => {
  const db = new Database(":memory:");
  db.exec("CREATE TABLE manager_view(singleton INTEGER,view TEXT,thread_id TEXT,hint_seen INTEGER,initialized INTEGER); INSERT INTO manager_view VALUES(1,'mono','previous-owner',1,1)");
  let identity = "canonical-core-manager";
  const manager = new Manager(db, () => identity, () => {});
  expect(manager.snapshot()).toEqual({ view: "mono", managerThreadId: identity, hintSeen: true });
  expect((await manager.update({ view: "classic" })).ok).toBe(true);
  identity = "core-adopted-manager";
  expect((await manager.update({ view: "mono" })).ok).toBe(true);
  expect(manager.snapshot().managerThreadId).toBe(identity);
  expect((db.query("SELECT thread_id FROM manager_view").get() as any).thread_id).toBe("previous-owner");
  db.close();
});

test("missing core manager cannot create a second controller or commit mono", async () => {
  const db = new Database(":memory:");
  const manager = new Manager(db, () => null, () => {});
  expect(await manager.update({ view: "mono" })).toMatchObject({ ok: false, error: { code: "unavailable" } });
  expect(manager.snapshot()).toEqual({ view: "classic", managerThreadId: null, hintSeen: false });
  expect(parseManagerPatch({ view: "mono", managerThreadId: "injected" }).ok).toBe(false);
  db.close();
});

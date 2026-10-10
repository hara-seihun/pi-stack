import type { Database } from "bun:sqlite";
import type { Result } from "pi-orchestrator/api";
import type { ManagerView } from "./protocol";

export type ManagerPatch = { view: "classic" | "mono"; hintSeen?: boolean };
export function parseManagerPatch(input: unknown): Result<ManagerPatch> {
  if (!input || typeof input !== "object" || Array.isArray(input)
    || Object.keys(input).some(key => key !== "view" && key !== "hintSeen")
    || !("view" in input) || (input.view !== "classic" && input.view !== "mono")
    || ("hintSeen" in input && typeof input.hintSeen !== "boolean")) {
    return { ok: false, error: { code: "invalid_request", message: "Manager preference requires view classic or mono and optional boolean hintSeen" } };
  }
  return { ok: true, value: input as ManagerPatch };
}

export class Manager {
  constructor(private db: Database, private identity: () => string | null, private changed: () => void) {
    db.exec(`CREATE TABLE IF NOT EXISTS manager_preferences (
      singleton INTEGER PRIMARY KEY CHECK(singleton=1),
      view TEXT NOT NULL CHECK(view IN ('classic','mono')),
      hint_seen INTEGER NOT NULL CHECK(hint_seen IN (0,1)));`);
    const previous = db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='manager_view'").get();
    if (previous) db.exec("INSERT OR IGNORE INTO manager_preferences SELECT singleton,view,hint_seen FROM manager_view");
    else db.exec("INSERT OR IGNORE INTO manager_preferences VALUES(1,'classic',0)");
  }

  snapshot(): ManagerView {
    const row = this.db.query("SELECT view,hint_seen FROM manager_preferences WHERE singleton=1").get() as { view: "classic" | "mono"; hint_seen: number };
    const managerThreadId = this.identity();
    if (row.view === "mono") {
      if (managerThreadId === null) throw new Error("Core scope has no canonical manager identity");
      return { view: "mono", managerThreadId, hintSeen: row.hint_seen === 1 };
    }
    return { view: "classic", managerThreadId, hintSeen: row.hint_seen === 1 };
  }

  async update(patch: ManagerPatch): Promise<Result<ManagerView>> {
    if (patch.view === "mono") {
      if (this.identity() === null) return { ok: false, error: { code: "unavailable", message: "Core canonical manager is unavailable" } };
    }
    this.db.query("UPDATE manager_preferences SET view=?,hint_seen=CASE WHEN ?=1 THEN 1 ELSE hint_seen END WHERE singleton=1")
      .run(patch.view, patch.hintSeen === true ? 1 : 0);
    this.changed();
    return { ok: true, value: this.snapshot() };
  }
}

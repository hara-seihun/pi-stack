import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureSupervisorSchema } from "./database";
import { dismissError, observeError } from "./error-feedback";

test("dismissal survives reconnects and supervisor restarts without hiding another source", () => {
  const dir = mkdtempSync(join(tmpdir(), "remote-errors-"));
  let db = new Database(join(dir, "supervisor.sqlite3"));
  try {
    ensureSupervisorSchema(db);
    const first = observeError(db, "naming:one", "Rate limited", "1")!;
    const other = observeError(db, "naming:two", "Rate limited", "1")!;
    expect(dismissError(db, first.id)).toBe(true);
    expect(dismissError(db, first.id)).toBe(false);
    db.close();
    db = new Database(join(dir, "supervisor.sqlite3"));
    ensureSupervisorSchema(db);
    expect(observeError(db, "naming:one", "Rate limited", "1")).toBeNull();
    expect(observeError(db, "naming:two", "Rate limited", "1")).toEqual(other);
    const renewed = observeError(db, "naming:one", "Rate limited", "2")!;
    expect(renewed.id).not.toBe(first.id);
    expect(dismissError(db, first.id)).toBe(false);
    expect(observeError(db, "naming:one", "Rate limited", "2")).toEqual(renewed);
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("a changed error or recovery starts a new dismissible occurrence", () => {
  const db = new Database(":memory:");
  try {
    ensureSupervisorSchema(db);
    const first = observeError(db, "peer:fleet", "Offline")!;
    dismissError(db, first.id);
    const changed = observeError(db, "peer:fleet", "Denied")!;
    expect(changed.id).not.toBe(first.id);
    dismissError(db, changed.id);
    observeError(db, "peer:fleet", null);
    const renewed = observeError(db, "peer:fleet", "Denied")!;
    expect(renewed.id).not.toBe(changed.id);
    expect(dismissError(db, changed.id)).toBe(false);
    expect(observeError(db, "peer:fleet", "Denied")).toEqual(renewed);
  } finally { db.close(); }
});

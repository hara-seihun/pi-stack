import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureSupervisorSchema } from "./database";
import { dismissError, observeError, observeFailure } from "./error-feedback";

test("dismissal survives reconnects and supervisor restarts without hiding another source", () => {
  const dir = mkdtempSync(join(tmpdir(), "remote-errors-"));
  let db = new Database(join(dir, "supervisor.sqlite3"));
  try {
    ensureSupervisorSchema(db);
    const first = observeError(db, "image:one", "Rate limited", "1")!;
    const other = observeError(db, "image:two", "Rate limited", "1")!;
    expect(dismissError(db, first.id)).toBe(true);
    expect(dismissError(db, first.id)).toBe(false);
    db.close();
    db = new Database(join(dir, "supervisor.sqlite3"));
    ensureSupervisorSchema(db);
    expect(observeError(db, "image:one", "Rate limited", "1")).toBeNull();
    expect(observeError(db, "image:two", "Rate limited", "1")).toEqual(other);
    const renewed = observeError(db, "image:one", "Rate limited", "2")!;
    expect(renewed.id).not.toBe(first.id);
    expect(dismissError(db, first.id)).toBe(false);
    expect(observeError(db, "image:one", "Rate limited", "2")).toEqual(renewed);
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("automatic recovery removes stale attention while preserving its diagnostic", () => {
  const db = new Database(":memory:");
  try {
    ensureSupervisorSchema(db);
    observeError(db, "image:one", "Image provider returned an invalid image", "1");
    expect(observeFailure(db, "image:one", {
      recovery: "automatic", message: "invalid image", impact: "Image not generated.",
    }, "2", 100)).toBeNull();
    expect(db.query("SELECT * FROM error_feedback").all()).toEqual([]);
    expect(db.query("SELECT message,occurrence,resolved_at FROM error_diagnostics").get())
      .toEqual({ message: "invalid image", occurrence: "2", resolved_at: null });
    observeFailure(db, "image:one", null, "", 200);
    expect(db.query("SELECT resolved_at FROM error_diagnostics").get()).toEqual({ resolved_at: 200 });
  } finally { db.close(); }
});

test("persistent impact is promoted after grace, not renewed by each internal retry", () => {
  const db = new Database(":memory:");
  try {
    ensureSupervisorSchema(db);
    const failure = { recovery: "automatic" as const, message: "ECONNRESET", impact: "Worker status is delayed. Reconnecting…", attentionAfterMs: 60_000 };
    expect(observeFailure(db, "peer:fleet", failure, "1", 100)).toBeNull();
    expect(observeFailure(db, "peer:fleet", { ...failure, message: "fetch failed" }, "2", 60_099)).toBeNull();
    const visible = observeFailure(db, "peer:fleet", failure, "3", 60_100)!;
    expect(visible.message).toBe(failure.impact);
    dismissError(db, visible.id);
    expect(observeFailure(db, "peer:fleet", { ...failure, message: "HTTP 503" }, "4", 90_100)).toBeNull();
    expect(db.query("SELECT COUNT(*) AS count FROM error_diagnostics").get()).toEqual({ count: 1 });
    observeFailure(db, "peer:fleet", null, "", 90_101);
    expect(observeFailure(db, "peer:fleet", failure, "5", 90_102)).toBeNull();
    const next = observeFailure(db, "peer:fleet", failure, "6", 150_102)!;
    expect(next.id).not.toBe(visible.id);
  } finally { db.close(); }
});

test("required intervention is immediate and contains consequence and action, not implementation detail", () => {
  const db = new Database(":memory:");
  try {
    ensureSupervisorSchema(db);
    const visible = observeFailure(db, "image:one", {
      recovery: "required", message: "No image account is configured",
      impact: "Inline images are unavailable.", action: "Ask Kenan to connect an image account.",
    }, "1", 100)!;
    expect(visible.message).toBe("Inline images are unavailable. Ask Kenan to connect an image account.");
    expect(db.query("SELECT message FROM error_diagnostics").get()).toEqual({ message: "No image account is configured" });
  } finally { db.close(); }
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

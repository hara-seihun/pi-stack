import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { snapshotLedger } from "./ledger-snapshot";

test("ledger snapshots leave the supervisor event loop free and retain the last good copy on failure", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-snapshot-"));
  const source = join(root, "source.sqlite3"), target = join(root, "backup", "supervisor.sqlite3");
  try {
    const db = new Database(source);
    db.exec("CREATE TABLE evidence(value BLOB); INSERT INTO evidence VALUES(randomblob(16000000));");
    db.close();
    let ticked = false;
    const timer = setTimeout(() => { ticked = true; }, 0);
    const snapshot = snapshotLedger(source, target);
    expect(ticked).toBe(false);
    expect(await snapshot.result).toEqual({ ok: true });
    expect(ticked).toBe(true);
    clearTimeout(timer);
    expect((await snapshotLedger(join(root, "missing"), target).result).ok).toBe(false);
    const copy = new Database(target, { readonly: true });
    expect(copy.query("SELECT length(value) AS size FROM evidence").get()).toEqual({ size: 16000000 });
    expect(copy.query("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
    copy.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

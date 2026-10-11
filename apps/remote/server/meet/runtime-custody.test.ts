import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connectRuntime, initializeRuntimeMirror, retainedRuntimeEndpoint } from "./runtime";

test("an alive legacy owner with a missing socket is uncertainty, never permission to initialize or replace it", async () => {
  const data = mkdtempSync(join(tmpdir(), "meet-custody-"));
  const db = new Database(join(data, "supervisor.sqlite3"));
  initializeRuntimeMirror(db);
  const instance = crypto.randomUUID();
  db.query("INSERT INTO meet_runtime_owner(singleton,pid,instance) VALUES(1,?,?)").run(process.pid, instance);
  db.query("INSERT INTO meet_live_rooms VALUES(?,?,?)").run("accepted-room", "thread", instance);
  const before = db.query("SELECT * FROM meet_runtime_owner").all();
  try {
    expect(retainedRuntimeEndpoint(data)).toMatchObject({ ok: true, value: { pid: process.pid, instance } });
    const result = await connectRuntime(data);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("accepted rooms were not touched");
    expect(db.query("SELECT * FROM meet_runtime_owner").all()).toEqual(before);
    expect(db.query("SELECT id FROM meet_live_rooms").all()).toEqual([{ id: "accepted-room" }]);
  } finally { db.close(); rmSync(data, { recursive: true, force: true }); }
});

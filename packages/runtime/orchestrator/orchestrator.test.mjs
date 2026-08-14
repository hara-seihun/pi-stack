import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "agent-orchestrator-test-"));
process.env.AGENT_ORCHESTRATOR_DATA = temporary;
const { chooseTask, insertRun, loadConfig, openDb, resourceSlots } = await import("./orchestrator.mjs");

test.after(() => fs.rmSync(temporary, { recursive: true, force: true }));

test("database initializes with integrity", () => {
  const db = openDb(path.join(temporary, "test.sqlite3"));
  assert.equal(db.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
  assert.deepEqual(db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map((row) => row.name), ["event", "run", "task"]);
  db.close();
});

test("a launch is recorded with a literal running status", () => {
  const db = openDb(path.join(temporary, "run.sqlite3"));
  const timestamp = Date.now();
  db.prepare(`INSERT INTO task(id,prompt,cwd,model,thinking,completion_condition,max_parallel,launch_share,not_before,next_eligible_at,created_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run("task", "prompt", temporary, "provider/model", "high", "done", 1, 1, timestamp, timestamp, timestamp);
  insertRun(db, "run", "task", timestamp);
  assert.equal(db.prepare("SELECT status FROM run WHERE id=?").get("run").status, "running");
  db.close();
});

test("task selection uses launch shares without priority modes", () => {
  const base = {
    completed_at: null,
    cancelled_at: null,
    not_before: 0,
    next_eligible_at: 0,
    max_parallel: 10,
    created_at: 1
  };
  const selected = chooseTask([
    { ...base, id: "wide", launch_share: 4, active: 1 },
    { ...base, id: "narrow", launch_share: 1, active: 1 }
  ], 2);
  assert.equal(selected.id, "wide");
});

test("completed, delayed, and saturated tasks are ineligible", () => {
  const future = Date.now() + 60_000;
  const tasks = [
    { id: "done", completed_at: 1, cancelled_at: null, not_before: 0, next_eligible_at: 0, max_parallel: 1, active: 0, launch_share: 1, created_at: 1 },
    { id: "later", completed_at: null, cancelled_at: null, not_before: future, next_eligible_at: 0, max_parallel: 1, active: 0, launch_share: 1, created_at: 2 },
    { id: "full", completed_at: null, cancelled_at: null, not_before: 0, next_eligible_at: 0, max_parallel: 1, active: 1, launch_share: 1, created_at: 3 }
  ];
  assert.equal(chooseTask(tasks, 1), null);
});

test("resource governor respects memory, load, and operator cap", () => {
  const config = loadConfig();
  assert.equal(resourceSlots(config, 2, 30_000, 1, 1, 32), 10);
  assert.equal(resourceSlots(config, 2, 13_000, 1, 1, 32), 0);
  assert.equal(resourceSlots(config, 2, 60_000, 40, 40, 32), 0);
});

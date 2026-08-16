import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "agent-orchestrator-test-"));
process.env.AGENT_ORCHESTRATOR_DATA = temporary;
const { cancelTask, choosePlanProvider, chooseTask, completionToolResult, Controller, cpuPercent, insertRun, launchBatchSize, loadConfig, nextIncompleteState, openDb, planWindowBurnPerHour, proEntitlementSnapshot, proLaunchAvailability, rankTasks, resourceSlots, setTaskOptions, shouldAdvanceBackoff, taskSettings, TOOL_SHELL, validateCompletion, validateModelPolicy } = await import("./orchestrator.mjs");

test.after(() => fs.rmSync(temporary, { recursive: true, force: true }));

test("database initializes with integrity", () => {
  const db = openDb(path.join(temporary, "test.sqlite3"));
  assert.equal(db.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
  assert.deepEqual(db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map((row) => row.name), ["event", "run", "task"]);
  assert.ok(!db.prepare("PRAGMA table_info(task)").all().some((column) => column.name === "max_parallel"));
  assert.ok(db.prepare("PRAGMA table_info(run)").all().some((column) => column.name === "provider"));
  assert.ok(db.prepare("PRAGMA table_info(run)").all().some((column) => column.name === "productive"));
  assert.match(db.prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name='auto_timestamp_run_update'").get().sql, /productive/);
  for (const table of ["event", "run", "task"]) {
    const columns = db.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name);
    assert.ok(columns.includes("created_at"));
    assert.ok(columns.includes("updated_at"));
    assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type='trigger' AND name=?").get(`auto_timestamp_${table}_insert`));
    assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type='trigger' AND name=?").get(`auto_timestamp_${table}_update`));
  }
  db.close();
});

test("legacy task concurrency caps are deleted during migration", () => {
  const file = path.join(temporary, "legacy-cap.sqlite3");
  const legacy = new DatabaseSync(file);
  legacy.exec(`CREATE TABLE task (
    id TEXT PRIMARY KEY, prompt TEXT NOT NULL, cwd TEXT NOT NULL, model TEXT NOT NULL,
    thinking TEXT NOT NULL, completion_condition TEXT NOT NULL, completion_check TEXT,
    max_parallel INTEGER NOT NULL CHECK(max_parallel > 0), launch_share REAL NOT NULL,
    not_before INTEGER NOT NULL, next_eligible_at INTEGER NOT NULL, incomplete_streak INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL, completed_at INTEGER, cancelled_at INTEGER, updated_at INTEGER NOT NULL
  )`);
  legacy.close();
  const migrated = openDb(file);
  assert.ok(!migrated.prepare("PRAGMA table_info(task)").all().some((column) => column.name === "max_parallel"));
  migrated.close();
});

test("a launch is recorded with a literal running status", () => {
  const db = openDb(path.join(temporary, "run.sqlite3"));
  const timestamp = Date.now();
  db.prepare(`INSERT INTO task(id,prompt,cwd,model,thinking,completion_condition,launch_share,not_before,next_eligible_at,created_at)
    VALUES(?,?,?,?,?,?,?,?,?,?)`).run("task", "prompt", temporary, "provider/model", "high", "done", 1, timestamp, timestamp, timestamp);
  insertRun(db, "run", "task", "provider-account", timestamp);
  const inserted = db.prepare("SELECT status,provider,created_at,updated_at FROM run WHERE id=?").get("run");
  assert.equal(inserted.status, "running");
  assert.equal(inserted.provider, "provider-account");
  assert.ok(inserted.created_at > 0);
  assert.ok(inserted.updated_at > 0);
  db.prepare("UPDATE run SET updated_at=1 WHERE id=?").run("run");
  db.prepare("UPDATE run SET status='incomplete' WHERE id=?").run("run");
  assert.ok(db.prepare("SELECT updated_at FROM run WHERE id=?").get("run").updated_at > 1);
  db.close();
});

test("task prompts can be updated through the governed task interface", () => {
  const db = openDb(path.join(temporary, "task-set.sqlite3"));
  const timestamp = Date.now();
  db.prepare(`INSERT INTO task(id,prompt,cwd,model,thinking,completion_condition,launch_share,not_before,next_eligible_at,created_at)
    VALUES(?,?,?,?,?,?,?,?,?,?)`).run("task", "old", temporary, "provider/model", "high", "done", 1, timestamp, timestamp, timestamp);
  const promptFile = path.join(temporary, "prompt.md");
  fs.writeFileSync(promptFile, "new governed prompt\n");
  setTaskOptions(db, "task", {
    model: "provider/better-model",
    thinking: "max",
    "prompt-file": promptFile,
    condition: "new completion condition",
    "completion-check": "python3 verify.py",
  });
  const updated = db.prepare("SELECT prompt,model,thinking,completion_condition,completion_check FROM task WHERE id=?").get("task");
  assert.equal(updated.prompt, "new governed prompt");
  assert.equal(updated.model, "provider/better-model");
  assert.equal(updated.thinking, "max");
  assert.equal(updated.completion_condition, "new completion condition");
  assert.equal(updated.completion_check, "python3 verify.py");
  assert.throws(() => setTaskOptions(db, "task", { "max-parallel": "3" }), /does not support --max-parallel/);
  db.close();
});

test("task selection uses launch shares without priority modes", () => {
  const base = {
    completed_at: null,
    cancelled_at: null,
    not_before: 0,
    next_eligible_at: 0,
    created_at: 1
  };
  const selected = chooseTask([
    { ...base, id: "wide", launch_share: 4, active: 1 },
    { ...base, id: "narrow", launch_share: 1, active: 1 }
  ], 2);
  assert.equal(selected.id, "wide");
  assert.deepEqual(rankTasks([
    { ...base, id: "wide", launch_share: 4, active: 1 },
    { ...base, id: "narrow", launch_share: 1, active: 1 }
  ], 2).map((task) => task.id), ["wide", "narrow"]);
});

test("completion tools terminate the launch immediately", () => {
  assert.deepEqual(completionToolResult("done", { complete: false }), {
    content: [{ type: "text", text: "done" }],
    details: { complete: false },
    terminate: true,
  });
});

test("machine completion checks override an agent's completion opinion", async () => {
  const task = { cwd: temporary, completion_check: "python3 verify.py" };
  assert.deepEqual(
    await validateCompletion(task, async () => ({ stdout: "frontier empty\n" })),
    { ok: true, detail: "frontier empty" },
  );
  assert.deepEqual(
    await validateCompletion(task, async () => {
      const error = new Error("exit 1");
      error.stdout = "remaining_claims=3\n";
      throw error;
    }),
    { ok: false, detail: "remaining_claims=3" },
  );
});

test("controller shutdown drains active sessions without aborting them", async () => {
  const controller = new Controller(null, {});
  let release;
  const promise = new Promise((resolve) => { release = resolve; });
  controller.active.set("run", {
    promise,
    session: { abort() { assert.fail("planned shutdown must not abort the session"); } },
  });
  let drained = false;
  const stopping = controller.stop().then(() => { drained = true; });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(controller.stopping, true);
  assert.equal(drained, false);
  release();
  await stopping;
  assert.equal(drained, true);
});

test("autonomous bash tools use the OOM-isolated shell", () => {
  const settings = taskSettings(temporary, temporary);
  assert.equal(settings.getShellPath(), TOOL_SHELL);
  assert.ok(fs.statSync(TOOL_SHELL).mode & 0o100);
});

test("the tool shell contains an OOM to the tool call", () => {
  const result = spawnSync(TOOL_SHELL, ["-c", "python3 -c 'x=bytearray(100*1024*1024)'"], {
    encoding: "utf8",
    env: { ...process.env, PI_TOOL_MEMORY_MAX: "64M" },
    timeout: 10_000,
  });
  assert.notEqual(result.status, 0);
  assert.equal(result.signal, "SIGKILL");
});

test("one concurrent launch wave advances task backoff only once", () => {
  assert.equal(shouldAdvanceBackoff(100, 100), true);
  assert.equal(shouldAdvanceBackoff(100, 101), true);
  assert.equal(shouldAdvanceBackoff(200, 101), false);
});

test("productive persistent work resets failure backoff", () => {
  assert.deepEqual(nextIncompleteState(6, false), { streak: 0, delayMs: 0 });
  assert.deepEqual(nextIncompleteState(2, true), { streak: 3, delayMs: 120_000 });
});

test("operator cancellation safely overrides a mistaken completion", () => {
  const db = openDb(path.join(temporary, "task-cancel.sqlite3"));
  const timestamp = Date.now();
  db.prepare(`INSERT INTO task(id,prompt,cwd,model,thinking,completion_condition,launch_share,not_before,next_eligible_at,created_at,completed_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run("task", "prompt", temporary, "provider/model", "high", "done", 1, timestamp, timestamp, timestamp, timestamp);
  cancelTask(db, "task", timestamp + 1);
  const cancelled = db.prepare("SELECT completed_at,cancelled_at FROM task WHERE id='task'").get();
  assert.equal(cancelled.completed_at, null);
  assert.equal(cancelled.cancelled_at, timestamp + 1);
  db.close();
});

test("only completion and time eligibility constrain a task", () => {
  const future = Date.now() + 60_000;
  const tasks = [
    { id: "done", completed_at: 1, cancelled_at: null, not_before: 0, next_eligible_at: 0, active: 0, launch_share: 1, created_at: 1 },
    { id: "later", completed_at: null, cancelled_at: null, not_before: future, next_eligible_at: 0, active: 0, launch_share: 1, created_at: 2 },
    { id: "uncapped", completed_at: null, cancelled_at: null, not_before: 0, next_eligible_at: 0, active: 1_000, launch_share: 1, created_at: 3 }
  ];
  assert.equal(chooseTask(tasks, 1_000).id, "uncapped");
});

test("resource governor admits until CPU or RAM is reached without a numeric agent cap", () => {
  const config = loadConfig();
  assert.equal(resourceSlots(config, 2, 30_000, 60_000, 20), 298);
  assert.equal(resourceSlots(config, 2, 6_000, 60_000, 20), 0);
  assert.equal(resourceSlots(config, 2, 30_000, 60_000, 90), 0);
  assert.equal(resourceSlots(config, 600, 50_000, 60_000, 20, 2_000), 0);
  assert.equal(launchBatchSize(298), 1);
  assert.equal(launchBatchSize(1), 1);
  assert.equal(launchBatchSize(0), 0);
  assert.equal(cpuPercent({ idle: 100, total: 200 }, { idle: 125, total: 300 }), 75);
});

test("plan estimator paces all remaining capacity to window reset", () => {
  const at = Date.UTC(2026, 7, 14, 12);
  assert.equal(planWindowBurnPerHour({ used_percent: 40, reset_at: (at + 10 * 3600_000) / 1000 }, at), 6);
  assert.equal(planWindowBurnPerHour({ used_percent: 40, reset_at: at / 1000 }, at), 0);
  assert.equal(planWindowBurnPerHour({}, at), null);
});

test("GPT-5.5 models are banned", () => {
  assert.throws(() => validateModelPolicy("chatgpt-pro/gpt-5-5-pro"), /banned/);
  assert.throws(() => validateModelPolicy("chatgpt-pro/gpt-5-5-pro-deep-research"), /banned/);
  assert.doesNotThrow(() => validateModelPolicy("chatgpt-pro/gpt-5-6-pro-literal"));
});

test("ChatGPT Pro capacity comes from the signed-in browser entitlement rather than a numeric cap", () => {
  const at = 10_000;
  const idle = proEntitlementSnapshot(at, {
    version: 3,
    browserProfile: "limmy-google",
    cooldownUntil: 0,
    inFlightUntil: 0,
  });
  assert.deepEqual(idle, { configured: 1, eligible: 1, inFlight: 0 });
  assert.equal(proLaunchAvailability(idle, 0), 1);
  assert.equal(proLaunchAvailability(idle, 1), 0);

  const leased = proEntitlementSnapshot(at, {
    version: 3,
    browserProfile: "limmy-google",
    cooldownUntil: 0,
    inFlightUntil: at + 1,
  });
  assert.deepEqual(leased, { configured: 1, eligible: 1, inFlight: 1 });
  assert.equal(proLaunchAvailability(leased, 0), 0);

  const cooling = proEntitlementSnapshot(at, {
    version: 3,
    browserProfile: "limmy-google",
    cooldownUntil: at + 1,
    inFlightUntil: 0,
  });
  assert.deepEqual(cooling, { configured: 1, eligible: 0, inFlight: 0 });
});

test("Codex plan governor assigns a concrete account without exceeding it", () => {
  const accounts = [
    { provider: "openai-codex", allowedBurnPercentPerHour: 0 },
    { provider: "openai-codex-2", allowedBurnPercentPerHour: 1.2 },
    { provider: "openai-codex-3", allowedBurnPercentPerHour: 2.0 },
  ];
  const selected = choosePlanProvider(accounts, [
    { provider: "openai-codex-2", rate: 0.58 },
    { provider: "openai-codex-3", rate: 0.58 },
  ], 0.58);
  assert.equal(selected.provider, "openai-codex-3");
  assert.equal(selected.live, 0.58);
  assert.equal(selected.allowed, 2.0);
  assert.ok(Math.abs(selected.remaining - 0.84) < 1e-12);
  assert.equal(
    choosePlanProvider(accounts, [
      { provider: "openai-codex-2", rate: 0.58 },
      { provider: "openai-codex-2", rate: 0.58 },
      { provider: "openai-codex-3", rate: 1.74 },
    ], 0.58),
    null,
  );
});

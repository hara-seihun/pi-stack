import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "agent-orchestrator-test-"));
process.env.AGENT_ORCHESTRATOR_DATA = temporary;
const { AnthropicGovernor, anthropicOpusHasHeadroom, anthropicWeeklyCapacity, cancelTask, chooseMixedVariant, choosePlanProvider, chooseTask, codexSubscriptionLifecycle, completionToolResult, Controller, cpuPercent, DISPATCH_NO_WORK_TTL_MS, dispatchedTaskPrompt, evaluateDispatch, evaluateWorkCheck, insertRun, isolateTaskShell, isEligibleCodexPlan, launchBatchSize, loadConfig, nextIncompleteState, openDb, orchestratedTaskPrompt, parseAnthropicUsage, PlanGovernor, planWindowBurnPerHour, proEntitlementSnapshot, proLaunchAvailability, rankTasks, resourceSlots, setTaskOptions, shouldAdvanceBackoff, taskSettings, TOOL_SHELL, validateCompletion, validateModelPolicy, WORK_CHECK_TTL_MS, workCheckStale, workReady } = await import("./orchestrator.mjs");

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

test("task selection uses durable weighted launch age without priority modes", () => {
  const at = Date.now();
  const base = {
    completed_at: null,
    cancelled_at: null,
    not_before: 0,
    next_eligible_at: 0,
    created_at: 1
  };
  const selected = chooseTask([
    { ...base, id: "wide", launch_share: 4, last_started_at: at - 100, launches: 10_000 },
    { ...base, id: "narrow", launch_share: 1, last_started_at: at - 200, launches: 2 }
  ], 2);
  assert.equal(selected.id, "wide");
});

test("short persistent lanes retain concurrency beside long sessions", () => {
  const at = Date.now();
  const base = {
    completed_at: null,
    cancelled_at: null,
    not_before: 0,
    next_eligible_at: 0,
    launch_share: 1,
    created_at: 1,
  };
  assert.equal(chooseTask([
    { ...base, id: "long", active: 1, last_started_at: at - 60_000 },
    { ...base, id: "short", active: 0, last_started_at: at - 1_000 },
  ], 1).id, "short");
  assert.equal(chooseTask([
    { ...base, id: "wide", active: 1, launch_share: 4, last_started_at: at - 1_000 },
    { ...base, id: "narrow", active: 1, last_started_at: at - 60_000 },
  ], 2).id, "wide");
});

test("serial provider capacity rotates without lifetime-history starvation", () => {
  const at = Date.now();
  const base = {
    completed_at: null,
    cancelled_at: null,
    not_before: 0,
    next_eligible_at: 0,
    active: 0,
    launch_share: 1,
  };
  const tasks = [
    { ...base, id: "historical", launches: 10_000, last_started_at: at - 4_000, created_at: 1 },
    { ...base, id: "new", launches: 0, last_started_at: null, created_at: 2 },
    { ...base, id: "recent", launches: 10, last_started_at: at - 1_000, created_at: 3 },
  ];
  assert.deepEqual(rankTasks(tasks, 0).map((task) => task.id), [
    "new",
    "historical",
    "recent",
  ]);
  tasks[1].last_started_at = Date.now();
  assert.equal(chooseTask(tasks, 0).id, "historical");
});

test("the generic task contract preserves lane-owned cadence without an endless-work restriction", () => {
  const prompt = orchestratedTaskPrompt({
    id: "slack-lane",
    prompt: "Sweep Slack now.",
    completion_condition: "persistent",
  });
  assert.match(prompt, /Follow the task's stated cadence/);
  assert.match(prompt, /preserve directly resumable state/);
  assert.doesNotMatch(prompt, /stop only when no claimable work remains/);
  assert.doesNotMatch(prompt, /Process as many work units/);
});

test("completion reports do not terminate the launch", () => {
  assert.deepEqual(completionToolResult("done", { complete: false }), {
    content: [{ type: "text", text: "done" }],
    details: { complete: false },
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

test("controller shutdown aborts recoverable sessions instead of freezing replacement launches", async () => {
  const controller = new Controller(null, {});
  let release;
  let aborted = false;
  const promise = new Promise((resolve) => { release = resolve; });
  controller.active.set("run", {
    promise,
    session: { abort() { aborted = true; release(); } },
  });
  await controller.stop();
  assert.equal(controller.stopping, true);
  assert.equal(aborted, true);
});

test("controller shutdown has an internal deadline when an SDK session never settles", async () => {
  const controller = new Controller(null, {});
  let disposed = false;
  controller.active.set("hung", {
    promise: new Promise(() => {}),
    session: { abort() {}, dispose() { disposed = true; } },
  });
  const started = Date.now();
  await controller.stop(10);
  assert.ok(Date.now() - started < 1000);
  assert.equal(disposed, true);
  assert.equal(controller.active.size, 0);
});

test("shutdown and crash recovery never turn interruption into task backoff", () => {
  const db = openDb(path.join(temporary, "shutdown-recovery.sqlite3"));
  const timestamp = Date.now();
  db.prepare(`INSERT INTO task(id,prompt,cwd,model,thinking,completion_condition,launch_share,not_before,next_eligible_at,incomplete_streak,created_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run("task", "prompt", temporary, "provider/model", "high", "done", 1, timestamp, timestamp + 600_000, 5, timestamp);
  insertRun(db, "planned", "task", "provider", timestamp);
  const controller = new Controller(db, {});
  controller.finish({ id: "task" }, "planned", "incomplete", null, [], "controller shutdown interrupted run", false, true);
  let task = db.prepare("SELECT incomplete_streak,next_eligible_at FROM task WHERE id='task'").get();
  assert.equal(task.incomplete_streak, 0);
  assert.ok(task.next_eligible_at <= Date.now());

  db.prepare("UPDATE task SET incomplete_streak=6,next_eligible_at=? WHERE id='task'").run(Date.now() + 600_000);
  insertRun(db, "crash", "task", "provider", Date.now());
  controller.recover();
  task = db.prepare("SELECT incomplete_streak,next_eligible_at FROM task WHERE id='task'").get();
  assert.equal(task.incomplete_streak, 0);
  assert.ok(task.next_eligible_at <= Date.now());
  assert.equal(db.prepare("SELECT status FROM run WHERE id='crash'").get().status, "interrupted");
  db.close();
});

test("noninteractive deployment resolves its newly installed Pi commands", () => {
  const deploy = fs.readFileSync(path.resolve(import.meta.dirname, "../deploy"), "utf8");
  const installAt = deploy.indexOf('install -d -m 700 "$HOME/.local/bin"');
  const pathAt = deploy.indexOf('export PATH="$HOME/.local/bin:$PATH"');
  const proCheckAt = deploy.indexOf('"$HOME/.local/bin/pro" --version');
  const restartAt = deploy.indexOf("sudo systemctl restart agent-orchestrator.service");
  assert.ok(installAt >= 0 && pathAt > installAt && proCheckAt > pathAt && restartAt > proCheckAt);
});

test("autonomous bash tools retain the OOM-isolated shell after resource reload", async () => {
  const settings = taskSettings(temporary, temporary);
  settings.applyOverrides({ shellPath: TOOL_SHELL });
  await settings.reload();
  assert.equal(settings.getShellPath(), undefined, "resource reload clears runtime overrides");
  isolateTaskShell(settings);
  assert.equal(settings.getShellPath(), TOOL_SHELL);
  assert.ok(fs.statSync(TOOL_SHELL).mode & 0o100);
});

test("the tool shell contains an OOM to the tool call from a system-service environment", () => {
  const environment = { ...process.env, PI_TOOL_MEMORY_MAX: "64M" };
  delete environment.XDG_RUNTIME_DIR;
  delete environment.DBUS_SESSION_BUS_ADDRESS;
  const result = spawnSync(TOOL_SHELL, ["-c", "python3 -c 'x=bytearray(100*1024*1024)'"], {
    encoding: "utf8",
    env: environment,
    timeout: 10_000,
  });
  assert.notEqual(result.status, 0);
  assert.equal(result.signal, "SIGKILL");
});

test("the tool shell waits through a transiently unavailable user bus", () => {
  const delayedBus = path.join(temporary, "delayed-user-bus");
  const realBus = process.env.DBUS_SESSION_BUS_ADDRESS?.replace(/^unix:path=/, "")
    ?? path.join("/run/user", String(process.getuid()), "bus");
  const command = `(sleep 0.15; ln -s ${JSON.stringify(realBus)} ${JSON.stringify(delayedBus)}) & exec ${JSON.stringify(TOOL_SHELL)} -c 'printf bus-recovered'`;
  const result = spawnSync("bash", ["-c", command], {
    encoding: "utf8",
    env: { ...process.env, DBUS_SESSION_BUS_ADDRESS: `unix:path=${delayedBus}` },
    timeout: 10_000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "bus-recovered");
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

test("work probes gate launches instead of launch-and-discover", async () => {
  const task = { cwd: temporary, work_check: "probe" };
  assert.deepEqual(
    await evaluateWorkCheck(task, async () => ({ stdout: "pending=3\n" })),
    { state: "work", detail: "pending=3" },
  );
  assert.deepEqual(
    await evaluateWorkCheck(task, async () => {
      const error = new Error("exit 1");
      error.code = 1;
      throw error;
    }),
    { state: "no-work", detail: "no claimable work" },
  );
  // A broken or timed-out probe fails open: the task degrades to
  // launch-and-discover instead of being silently starved.
  const broken = await evaluateWorkCheck(task, async () => {
    const error = new Error("boom");
    error.code = 2;
    error.stderr = "probe crashed";
    throw error;
  });
  assert.equal(broken.state, "error");
  const timedOut = await evaluateWorkCheck(task, async () => {
    const error = new Error("killed");
    error.code = null;
    error.killed = true;
    throw error;
  });
  assert.equal(timedOut.state, "error");
});

test("a no-work probe result excludes the task from ranking", () => {
  const base = {
    completed_at: null,
    cancelled_at: null,
    not_before: 0,
    next_eligible_at: 0,
    active: 0,
    launch_share: 1,
    created_at: 1,
  };
  const tasks = [
    { ...base, id: "empty", work_check: "probe", work_state: "no-work" },
    { ...base, id: "ready", work_check: "probe", work_state: "work", created_at: 2 },
    { ...base, id: "unprobed", work_check: "probe", work_state: null, created_at: 3 },
    { ...base, id: "probeless", created_at: 4 },
  ];
  assert.deepEqual(rankTasks(tasks, 0).map((task) => task.id).sort(), ["probeless", "ready", "unprobed"]);
  assert.equal(workReady(tasks[0]), false);
  assert.equal(workCheckStale({ work_check: "probe", work_state: null }), true);
  assert.equal(workCheckStale({ work_check: "probe", work_state: "no-work", work_checked_at: Date.now() }), false);
  assert.equal(workCheckStale({ work_check: "probe", work_state: "no-work", work_checked_at: Date.now() - WORK_CHECK_TTL_MS }), true);
  assert.equal(workCheckStale({ work_check: null, work_state: null }), false);
});

test("dispatch claims a work unit for the launch and injects its packet", async () => {
  const task = { id: "lane", cwd: temporary, dispatch: "dispatch-command", prompt: "Do the work.", completion_condition: "queue empty" };
  let seenEnvironment = null;
  const packet = await evaluateDispatch(task, "run-123", async (_bash, args, options) => {
    seenEnvironment = options.env.ORCHESTRATOR_RUN_ID;
    assert.equal(args[1], "dispatch-command");
    return { stdout: "### Lease grant\nHANDLE=example\n" };
  });
  assert.equal(seenEnvironment, "run-123");
  assert.equal(packet.state, "packet");
  const prompt = dispatchedTaskPrompt(task, packet.packet);
  assert.match(prompt, /## Dispatched work unit/);
  assert.match(prompt, /HANDLE=example/);
  assert.match(prompt, /## Orchestrated task contract/);

  const idle = await evaluateDispatch(task, "run-124", async () => {
    const error = new Error("exit 1");
    error.code = 1;
    throw error;
  });
  assert.equal(idle.state, "no-work");
  // A broken dispatcher fails open to launch-and-discover.
  const broken = await evaluateDispatch(task, "run-125", async () => {
    const error = new Error("crash");
    error.code = 3;
    error.stderr = "claim tool missing";
    throw error;
  });
  assert.equal(broken.state, "error");
  const empty = await evaluateDispatch(task, "run-126", async () => ({ stdout: "" }));
  assert.equal(empty.state, "error");
});

test("a dispatch-only task retries after its no-work pause instead of freezing", () => {
  const at = Date.now();
  const task = { work_check: null, dispatch: "cmd", work_state: "no-work", work_checked_at: at };
  assert.equal(workReady(task, at), false);
  assert.equal(workReady(task, at + DISPATCH_NO_WORK_TTL_MS), true);
  // With a probe configured, the probe refresh owns the transition back.
  assert.equal(workReady({ ...task, work_check: "probe" }, at + DISPATCH_NO_WORK_TTL_MS), false);
});

test("new work clears idle backoff without waiting out the timer", async () => {
  const db = openDb(path.join(temporary, "work-transition.sqlite3"));
  const timestamp = Date.now();
  const backoffUntil = timestamp + 30 * 60_000;
  db.prepare(`INSERT INTO task(id,prompt,cwd,model,thinking,completion_condition,work_check,work_state,work_checked_at,launch_share,not_before,next_eligible_at,incomplete_streak,created_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run("probe-task", "prompt", temporary, "provider/model", "high", "done", "probe", "no-work", 1, 1, timestamp, backoffUntil, 3, timestamp);
  const controller = new Controller(db, {});
  const tasks = db.prepare("SELECT * FROM task").all();
  await controller.refreshWorkChecks(tasks, async () => ({ stdout: "pending=2\n" }));
  const updated = db.prepare("SELECT work_state,next_eligible_at,incomplete_streak FROM task WHERE id='probe-task'").get();
  assert.equal(updated.work_state, "work");
  assert.ok(updated.next_eligible_at <= Date.now());
  assert.equal(updated.incomplete_streak, 0);
  assert.equal(tasks[0].work_state, "work");
  assert.ok(db.prepare("SELECT 1 FROM event WHERE kind='work-available' AND task_id='probe-task'").get());

  // A repeated no-work verdict keeps the task unlaunched but never fabricates
  // a work-available transition.
  await new Promise((resolve) => setTimeout(resolve, 1));
  db.prepare("UPDATE task SET work_checked_at=0 WHERE id='probe-task'").run();
  tasks[0].work_checked_at = 0;
  await controller.refreshWorkChecks(tasks, async () => {
    const error = new Error("exit 1");
    error.code = 1;
    throw error;
  });
  assert.equal(db.prepare("SELECT work_state FROM task WHERE id='probe-task'").get().work_state, "no-work");
  assert.equal(db.prepare("SELECT count(*) count FROM event WHERE kind='work-available'").get().count, 1);
  db.close();
});

test("work checks are configurable and clearable through the task interface", () => {
  const db = openDb(path.join(temporary, "work-check-set.sqlite3"));
  const timestamp = Date.now();
  db.prepare(`INSERT INTO task(id,prompt,cwd,model,thinking,completion_condition,launch_share,not_before,next_eligible_at,created_at)
    VALUES(?,?,?,?,?,?,?,?,?,?)`).run("task", "prompt", temporary, "provider/model", "high", "done", 1, timestamp, timestamp, timestamp);
  setTaskOptions(db, "task", { "work-check": "python3 probe.py" });
  assert.equal(db.prepare("SELECT work_check FROM task WHERE id='task'").get().work_check, "python3 probe.py");
  db.prepare("UPDATE task SET work_state='no-work',work_checked_at=? WHERE id='task'").run(timestamp);
  setTaskOptions(db, "task", { "work-check": "" });
  const cleared = db.prepare("SELECT work_check,work_state,work_checked_at FROM task WHERE id='task'").get();
  assert.equal(cleared.work_check, null);
  assert.equal(cleared.work_state, null);
  assert.equal(cleared.work_checked_at, 0);
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

test("Sol-grade scheduling derives its active Opus ratio from healthy accounts", () => {
  const task = { model: "openai-codex/gpt-5.6-sol", thinking: "xhigh" };
  const mix = { alternateModel: "anthropic/claude-opus-5", alternateThinking: "xhigh" };
  const assignment = (model, provider) => ({ model, thinking: "xhigh", provider, task });
  const fourSol = Array.from({ length: 4 }, (_, index) => assignment(task.model, `openai-codex-${index + 1}`));
  assert.equal(chooseMixedVariant(task, mix, fourSol, 10, 2).model, task.model);
  const fiveSol = [...fourSol, assignment(task.model, "openai-codex-5")];
  assert.equal(chooseMixedVariant(task, mix, fiveSol, 10, 2).model, "anthropic/claude-opus-5");

  const elevenSol = Array.from({ length: 11 }, (_, index) => assignment(task.model, `openai-codex-${index + 1}`));
  assert.equal(chooseMixedVariant(task, mix, elevenSol, 12, 1).model, task.model);

  const twelveSol = Array.from({ length: 12 }, (_, index) => assignment(task.model, `openai-codex-${index + 1}`));
  assert.equal(chooseMixedVariant(task, mix, twelveSol, 12, 2).model, "anthropic/claude-opus-5");
  const oneOpus = [...twelveSol, assignment("anthropic/claude-opus-5", "anthropic")];
  assert.equal(chooseMixedVariant(task, mix, oneOpus, 12, 2).model, "anthropic/claude-opus-5");
  const twoOpus = [...oneOpus, assignment("anthropic/claude-opus-5", "anthropic-2")];
  assert.equal(chooseMixedVariant(task, mix, twoOpus, 12, 2).model, task.model);
});

test("an independent Opus account remains usable when Codex is full before the target ratio", async () => {
  const config = loadConfig();
  const anthropic = {
    setModelRuntime() {},
    refresh: async () => ({ healthy: 2, withHeadroom: 1 }),
    allows: async (variant) => ({ ok: true, provider: "anthropic", model: variant.model, thinking: variant.thinking, detail: "available" }),
  };
  const governor = new PlanGovernor(config, { anthropic });
  governor.refresh = async () => ({ healthy: 12, accounts: [], allowedBurnPercentPerHour: 0 });
  governor.allowsCodex = async (variant) => ({ ok: false, provider: null, model: variant.model, thinking: variant.thinking, detail: "Codex full" });
  const task = { model: "openai-codex/gpt-5.6-sol", thinking: "xhigh" };
  const assignment = await governor.allows(task, []);
  assert.equal(assignment.ok, true);
  assert.equal(assignment.provider, "anthropic");
  assert.equal(assignment.model, "anthropic/claude-opus-5");
});

test("Anthropic Opus admission preserves enough shared weekly capacity for Fable", async () => {
  const at = Date.UTC(2026, 7, 17, 6);
  const usage = (session, shared, fable, extraUsagePercent = 0) => parseAnthropicUsage({
    limits: [
      { kind: "session", percent: session, resets_at: new Date(at + 3600_000).toISOString() },
      { kind: "weekly_all", percent: shared, resets_at: new Date(at + 86400_000).toISOString() },
      { kind: "weekly_scoped", percent: fable, resets_at: new Date(at + 86400_000).toISOString(), scope: { model: { display_name: "Fable" } } },
    ],
    spend: { enabled: extraUsagePercent > 0, percent: extraUsagePercent },
  }, at);
  const parsed = usage(20, 40, 60);
  assert.equal(parsed.windows.fiveHour.utilization, 20);
  assert.equal(parsed.windows.sharedWeekly.utilization, 40);
  assert.equal(parsed.windows.fableWeekly.utilization, 60);
  assert.equal(parseAnthropicUsage({ five_hour: { utilization: 0 }, seven_day: { utilization: 0 } }, at), null);

  const account = (provider, session, shared, fable, extraUsagePercent = 0) => ({
    provider, stale: false, ...usage(session, shared, fable, extraUsagePercent),
  });
  assert.equal(anthropicOpusHasHeadroom(account("anthropic", 0, 50, 0)), false);
  assert.equal(anthropicOpusHasHeadroom(account("anthropic", 0, 49, 0)), true);
  assert.equal(anthropicOpusHasHeadroom(account("anthropic", 0, 50, 100)), true);
  assert.equal(anthropicOpusHasHeadroom(account("anthropic", 0, 100, 100)), false);
  assert.equal(anthropicOpusHasHeadroom(account("anthropic", 100, 0, 100)), false);
  assert.equal(anthropicOpusHasHeadroom(account("anthropic", 0, 0, 0, 100)), true, "spent extra-usage credits must not hide untouched plan capacity");

  const config = loadConfig();
  const governor = new AnthropicGovernor(config);
  governor.snapshot = {
    at, expiresAt: at + 1000, configured: 2, healthy: 2, withHeadroom: 1,
    accounts: [
      account("anthropic", 0, 50, 0),
      account("anthropic-2", 0, 50, 100),
    ],
  };
  const variant = { model: "anthropic/claude-opus-5", thinking: "xhigh" };
  assert.equal((await governor.allows(variant, [], governor.snapshot)).provider, "anthropic-2");
  assert.equal((await governor.allows(variant, [{ provider: "anthropic-2", model: variant.model, thinking: variant.thinking }], governor.snapshot)).ok, false);
  governor.noteFailure("anthropic-2", new Error("429 usage limit reached"), Date.now());
  assert.equal((await governor.allows(variant, [], governor.snapshot)).ok, false);
});

test("Anthropic weekly capacity treats Max 5x as half of Max 20x", () => {
  assert.deepEqual(anthropicWeeklyCapacity({ organization: { rate_limit_tier: "default_claude_max_20x" } }), {
    rateLimitTier: "default_claude_max_20x", weeklyCapacityWeight: 2,
  });
  assert.deepEqual(anthropicWeeklyCapacity({ organization: { rate_limit_tier: "default_claude_max_5x" } }), {
    rateLimitTier: "default_claude_max_5x", weeklyCapacityWeight: 1,
  });
  assert.equal(anthropicWeeklyCapacity({ organization: { rate_limit_tier: "default_claude_pro" } }).weeklyCapacityWeight, null);
  assert.equal(anthropicWeeklyCapacity({ organization: { rate_limit_tier: "unexpected" } }).weeklyCapacityWeight, null);
});

test("Anthropic governor restores per-account usage across controller restarts", () => {
  const cachePath = path.join(temporary, "anthropic-usage-cache.json");
  const account = {
    provider: "anthropic-2",
    fetchedAt: Date.now(),
    stale: false,
    windows: {
      fiveHour: { utilization: 0 },
      sharedWeekly: { utilization: 20 },
      fableWeekly: { utilization: 40 },
    },
  };
  fs.writeFileSync(cachePath, JSON.stringify({ accounts: [account] }));
  const governor = new AnthropicGovernor(loadConfig(), { cachePath });
  assert.deepEqual(governor.lastGood.get("anthropic-2"), account);
});

test("cancelled Codex subscriptions retire exactly at their access deadline", () => {
  const at = Date.UTC(2026, 7, 23, 12);
  const future = new Date(at + 60_000).toISOString();
  const lifecycle = codexSubscriptionLifecycle({ subscriptions: [
    { provider: "openai-codex", index: 5, lifecycle: { state: "cancelled", accessUntil: new Date(at).toISOString() } },
    { provider: "openai-codex", index: 6, lifecycle: { state: "cancelled", accessUntil: future } },
    { provider: "anthropic", index: 2, lifecycle: { state: "cancelled", accessUntil: "invalid" } },
  ] }, at);
  assert.deepEqual(lifecycle.retiredProviders, ["openai-codex-5"]);
  assert.equal(lifecycle.nextRetirementAt, at + 60_000);
  assert.throws(() => codexSubscriptionLifecycle({ subscriptions: [
    { provider: "openai-codex", index: 7, lifecycle: { state: "cancelled", accessUntil: "invalid" } },
  ] }, at), /invalid subscription accessUntil/);
  assert.equal(isEligibleCodexPlan("pro"), true);
  assert.equal(isEligibleCodexPlan("plus"), true);
  assert.equal(isEligibleCodexPlan("free"), false);
  assert.equal(isEligibleCodexPlan("unknown"), false);
});

test("plan governor excludes an account whose near-expiry OAuth cannot refresh", async () => {
  const authPath = path.join(temporary, "governor-auth.json");
  const expiresLater = Date.now() + 60 * 60_000;
  fs.writeFileSync(authPath, JSON.stringify({
    "openai-codex": { type: "oauth", access: "healthy-access", refresh: "healthy-refresh", expires: expiresLater, accountId: "healthy" },
    "openai-codex-10": { type: "oauth", access: "expiring-access", refresh: "broken-refresh", expires: Date.now() + 60_000, accountId: "broken" },
  }));
  const registered = new Map([["openai-codex", { id: "openai-codex", auth: {} }]]);
  const runtime = {
    getProvider: (provider) => registered.get(provider),
    registerNativeProvider: (provider) => registered.set(provider.id, provider),
    getAuth: async (provider) => { throw new Error(`OAuth refresh failed for ${provider}: refresh_token_reused`); },
  };
  const requestedTokens = [];
  const governor = new PlanGovernor({ plan: { pollSeconds: 120 } }, {
    modelRuntime: runtime,
    authPath,
    fetcher: async (_url, options) => {
      requestedTokens.push(options.headers.Authorization);
      return {
        ok: true,
        json: async () => ({ plan_type: "pro", rate_limit: {
          primary_window: { used_percent: 20, reset_at: (Date.now() + 3600_000) / 1000 },
          secondary_window: { used_percent: 20, reset_at: (Date.now() + 7200_000) / 1000 },
        } }),
      };
    },
  });
  const snapshot = await governor.refresh();
  assert.equal(snapshot.configured, 2);
  assert.equal(snapshot.healthy, 1);
  assert.deepEqual(snapshot.accounts.map((account) => account.provider), ["openai-codex"]);
  assert.deepEqual(requestedTokens, ["Bearer healthy-access"]);
});

test("plan governor excludes retired lifecycle entries and inactive provider plans", async () => {
  const authPath = path.join(temporary, "lifecycle-auth.json");
  const lifecyclePath = path.join(temporary, "lifecycle.json");
  const expiresLater = Date.now() + 60 * 60_000;
  fs.writeFileSync(authPath, JSON.stringify({
    "openai-codex": { type: "oauth", access: "base", expires: expiresLater, accountId: "base" },
    "openai-codex-5": { type: "oauth", access: "retired", expires: expiresLater, accountId: "retired" },
    "openai-codex-6": { type: "oauth", access: "free", expires: expiresLater, accountId: "free" },
  }));
  fs.writeFileSync(lifecyclePath, JSON.stringify({ subscriptions: [
    { provider: "openai-codex", index: 5, lifecycle: { state: "cancelled", accessUntil: new Date(Date.now() - 1).toISOString() } },
  ] }));
  const requested = [];
  const governor = new PlanGovernor({ plan: { pollSeconds: 120 } }, {
    authPath,
    lifecyclePath,
    fetcher: async (_url, options) => {
      requested.push(options.headers.Authorization);
      const planType = options.headers.Authorization === "Bearer free" ? "free" : "pro";
      return { ok: true, json: async () => ({
        plan_type: planType,
        rate_limit: {
          primary_window: { used_percent: 10, reset_at: (Date.now() + 3600_000) / 1000 },
          secondary_window: { used_percent: 10, reset_at: (Date.now() + 7200_000) / 1000 },
        },
      }) };
    },
  });
  const snapshot = await governor.refresh();
  assert.equal(snapshot.configured, 3);
  assert.equal(snapshot.retired, 1);
  assert.deepEqual(snapshot.retiredProviders, ["openai-codex-5"]);
  assert.deepEqual(snapshot.accounts.map((account) => account.provider), ["openai-codex"]);
  assert.deepEqual(requested.sort(), ["Bearer base", "Bearer free"]);
});

test("GPT-5.5 models are banned", () => {
  assert.throws(() => validateModelPolicy("chatgpt-pro/gpt-5-5-pro"), /banned/);
  assert.throws(() => validateModelPolicy("chatgpt-pro/gpt-5-5-pro-deep-research"), /banned/);
  assert.doesNotThrow(() => validateModelPolicy("chatgpt-pro/gpt-5-6-pro-literal"));
});

test("ChatGPT Pro capacity uses authenticated entitlements under the four-agent ceiling", () => {
  const at = 10_000;
  const idle = proEntitlementSnapshot(at, {
    version: 3,
    browserProfile: "limmy-google",
    cooldownUntil: 0,
    inFlightUntil: 0,
  });
  assert.deepEqual(idle, { configured: 1, eligible: 1, inFlight: 0, available: 1, maxParallel: 4 });
  assert.equal(proLaunchAvailability(idle, 0), 1);
  assert.equal(proLaunchAvailability(idle, 1), 0);

  const leased = proEntitlementSnapshot(at, {
    version: 3,
    browserProfile: "limmy-google",
    cooldownUntil: 0,
    inFlightUntil: at + 1,
  });
  assert.deepEqual(leased, { configured: 1, eligible: 1, inFlight: 1, available: 0, maxParallel: 4 });
  assert.equal(proLaunchAvailability(leased, 0), 0);

  const cooling = proEntitlementSnapshot(at, {
    version: 3,
    browserProfile: "limmy-google",
    cooldownUntil: at + 1,
    inFlightUntil: 0,
  });
  assert.deepEqual(cooling, { configured: 1, eligible: 0, inFlight: 0, available: 0, maxParallel: 4 });
});

test("frontier agents have no Pro delegation tool; Pro runs as its own moonshot lane", async () => {
  const source = await import("node:fs").then((fs) => fs.readFileSync(new URL("./orchestrator.mjs", import.meta.url), "utf8"));
  assert.ok(!source.includes("launch_pro"));
});

test("the service locks governor-assigned providers against hidden Multi-Pass rotation", () => {
  const nix = fs.readFileSync("/etc/nixos/configuration.nix", "utf8");
  const multiPass = fs.readFileSync("/home/kenan/tools/pi-multi-pass/extensions/multi-sub.ts", "utf8");
  assert.match(nix, /PI_MULTI_PASS_LOCK_ASSIGNED_PROVIDER = "1"/);
  assert.match(multiPass, /PI_MULTI_PASS_LOCK_ASSIGNED_PROVIDER === "1"/);
});

test("Codex plan governor keeps one baseline worker on every healthy account", () => {
  const selected = choosePlanProvider([
    { provider: "openai-codex", allowedBurnPercentPerHour: 0.448 },
  ], [], 0.45);
  assert.equal(selected.provider, "openai-codex");
  assert.equal(selected.baseline, true);
  assert.ok(selected.remaining < 0);
  assert.equal(choosePlanProvider([
    { provider: "openai-codex", allowedBurnPercentPerHour: 0 },
  ], [], 0.45), null);
  assert.equal(choosePlanProvider([
    { provider: "openai-codex", allowedBurnPercentPerHour: 0.448 },
  ], [{ provider: "openai-codex", rate: 0.45 }], 0.45), null);
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

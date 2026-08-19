import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "agent-orchestrator-test-"));
process.env.AGENT_ORCHESTRATOR_DATA = temporary;
const { AnthropicGovernor, anthropicOpusHasHeadroom, anthropicWeeklyCapacity, cancelTask, chooseIndependentAssignment, chooseTask, codexSubscriptionLifecycle, completionToolResult, controllerProcessIdentity, Controller, cpuPercent, CursorGovernor, DISPATCH_NO_WORK_TTL_MS, dispatchedTaskPrompt, DistributedQuotaFeedback, evaluateDispatch, evaluateWorkCheck, governorAllowanceMultiplier, governorControls, grantQuotaLease, insertRun, isolateTaskShell, isEligibleCodexPlan, launchBatchSize, loadConfig, loadProviderManifest, nextIncompleteState, openDb, orchestratedTaskPrompt, parseAnthropicUsage, parseCursorUsage, PlanGovernor, planWindowBurnPerHour, proEntitlementSnapshot, proLaunchAvailability, rankTasks, resourceSlots, setGovernorBoost, setTaskOptions, shouldAdvanceBackoff, taskSettings, taskSupportsAssignment, TOOL_SHELL, validateCompletion, validateModelPolicy, WORK_CHECK_TTL_MS, workCheckStale, workReady } = await import("./orchestrator.mjs");

test.after(() => fs.rmSync(temporary, { recursive: true, force: true }));

test("controller identity distinguishes process leaders from stale thread IDs", () => {
  const pid = 1338;
  const script = fs.realpathSync(new URL("./orchestrator.mjs", import.meta.url));
  const commandLine = `${process.execPath}\0${script}\0run\0`;
  assert.equal(controllerProcessIdentity(pid, `Tgid:\t${pid}\nPid:\t${pid}\n`, commandLine), true);
  assert.equal(controllerProcessIdentity(pid, `Tgid:\t995\nPid:\t${pid}\n`, commandLine), false);
  assert.equal(controllerProcessIdentity(pid, `Tgid:\t${pid}\nPid:\t${pid}\n`, `${process.execPath}\0${script}\0check\0`), false);
});

test("database initializes with integrity", () => {
  const db = openDb(path.join(temporary, "test.sqlite3"));
  assert.equal(db.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
  assert.deepEqual(db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map((row) => row.name), ["dispatch_reservation", "event", "governor_control", "quota_lease", "run", "task"]);
  assert.ok(!db.prepare("PRAGMA table_info(task)").all().some((column) => column.name === "max_parallel"));
  assert.ok(db.prepare("PRAGMA table_info(run)").all().some((column) => column.name === "provider"));
  assert.ok(db.prepare("PRAGMA table_info(run)").all().some((column) => column.name === "productive"));
  assert.match(db.prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name='auto_timestamp_run_update'").get().sql, /productive/);
  for (const table of ["dispatch_reservation", "event", "governor_control", "quota_lease", "run", "task"]) {
    const columns = db.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name);
    assert.ok(columns.includes("created_at"));
    assert.ok(columns.includes("updated_at"));
    assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type='trigger' AND name=?").get(`auto_timestamp_${table}_insert`));
    assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type='trigger' AND name=?").get(`auto_timestamp_${table}_update`));
  }
  db.close();
});

test("provider allowance boosts are local, persistent, and independently toggleable", () => {
  const file = path.join(temporary, "governor-controls.sqlite3");
  const db = openDb(file);
  assert.deepEqual(governorControls(db), {
    openai: { boosted: false, multiplier: 1 },
    anthropic: { boosted: false, multiplier: 1 },
  });
  assert.deepEqual(setGovernorBoost(db, "openai", true), {
    openai: { boosted: true, multiplier: 5 },
    anthropic: { boosted: false, multiplier: 1 },
  });
  assert.equal(governorAllowanceMultiplier(db, "openai-codex"), 5);
  assert.equal(db.prepare("SELECT count(*) count FROM event WHERE kind='governor-control'").get().count, 1);
  db.close();
  const reopened = openDb(file);
  assert.equal(governorAllowanceMultiplier(reopened, "openai"), 5);
  assert.equal(governorAllowanceMultiplier(reopened, "anthropic"), 1);
  reopened.close();
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

test("controller recovery terminalizes pre-launch dispatch ownership", () => {
  const db = openDb(path.join(temporary, "dispatch-reservation.sqlite3"));
  const at = Date.now();
  db.prepare(`INSERT INTO task(id,prompt,cwd,model,thinking,completion_condition,launch_share,not_before,next_eligible_at,created_at)
    VALUES(?,?,?,?,?,?,?,?,?,?)`).run("task", "prompt", temporary, "provider/model", "high", "done", 1, at, at, at);
  db.prepare(
    "INSERT INTO dispatch_reservation(run_id,task_id,state,reserved_at) VALUES(?,?,'active',?)"
  ).run("reserved-run", "task", at);
  new Controller(db, loadConfig()).recover();
  const reservation = db.prepare(
    "SELECT state,finished_at FROM dispatch_reservation WHERE run_id='reserved-run'"
  ).get();
  assert.equal(reservation.state, "terminal");
  assert.ok(reservation.finished_at >= at);
  db.close();
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

test("governor leases resume interrupted work then rotate after productive boundaries", async () => {
  const db = openDb(path.join(temporary, "quota-lease.sqlite3"));
  const at = Date.now();
  const insertTask = db.prepare(`INSERT INTO task(id,prompt,cwd,model,thinking,completion_condition,launch_share,not_before,next_eligible_at,created_at)
    VALUES(?,?,?,?,?,?,?,?,?,?)`);
  insertTask.run("task", "prompt", temporary, "openai-codex/gpt-5.6-sol", "xhigh", "done", 1, at, at, at);
  insertTask.run("waiting", "prompt", temporary, "openai-codex/gpt-5.6-sol", "xhigh", "done", 1, at, at, at + 1);
  const config = loadConfig();
  config.maxCpuPercent = 101;
  config.maxMemoryPercent = 101;
  const task = db.prepare("SELECT * FROM task WHERE id='task'").get();
  assert.equal(taskSupportsAssignment(config, task, { model: "openai-codex/gpt-5.6-sol", thinking: "xhigh" }), true);
  assert.equal(taskSupportsAssignment(config, task, { model: "anthropic/claude-opus-5", thinking: "xhigh" }), true);
  assert.equal(taskSupportsAssignment(config, task, { model: "cursor/grok-4.6", thinking: "xhigh" }), true);

  const controller = new Controller(db, config);
  insertRun(db, "run-1", task.id, "openai-codex-3", at, task.model, task.thinking);
  const leaseId = controller.activateQuotaLease(task, {
    provider: "openai-codex-3", model: task.model, thinking: task.thinking,
  }, "run-1", at);
  assert.equal(db.prepare("SELECT state FROM quota_lease WHERE id=?").get(leaseId).state, "active");

  new Controller(db, config).recover();
  const recovered = db.prepare("SELECT state,task_id,provider,run_id FROM quota_lease WHERE id=?").get(leaseId);
  assert.deepEqual({ ...recovered }, { state: "available", task_id: "task", provider: "openai-codex-3", run_id: null });
  assert.equal(db.prepare("SELECT status FROM run WHERE id='run-1'").get().status, "interrupted");

  insertRun(db, "run-2", task.id, "openai-codex-3", at + 1, task.model, task.thinking);
  controller.activateQuotaLease(task, {
    leaseId, provider: "openai-codex-3", model: task.model, thinking: task.thinking,
  }, "run-2", at + 1);
  controller.finish(task, "run-2", "incomplete", "productive", [], null, true);
  assert.deepEqual(
    { ...db.prepare("SELECT state,task_id,provider FROM quota_lease WHERE id=?").get(leaseId) },
    { state: "available", task_id: null, provider: null },
  );

  const next = new Controller(db, config);
  next.plan = {
    restores: async (lease) => ({ ok: true, provider: "openai-codex-4", model: lease.model, thinking: lease.thinking }),
    allows: async () => ({ ok: false, detail: "cold admission not expected" }),
  };
  let launched = null;
  next.launch = async (selected) => { launched = selected.id; };
  await next.tick();
  assert.equal(launched, "waiting");
  db.close();
});

test("operator quota leases retain their declared task and provider constraints", () => {
  const db = openDb(path.join(temporary, "operator-quota-lease.sqlite3"));
  const at = Date.now();
  db.prepare(`INSERT INTO task(id,prompt,cwd,model,thinking,completion_condition,launch_share,not_before,next_eligible_at,created_at)
    VALUES(?,?,?,?,?,?,?,?,?,?)`).run("task", "prompt", temporary, "openai-codex/gpt-5.6-sol", "xhigh", "done", 1, at, at, at);
  const config = loadConfig();
  const leaseId = grantQuotaLease(db, config, {
    provider: "openai-codex-3", model: "openai-codex/gpt-5.6-sol", thinking: "xhigh", taskId: "task", hours: 1,
  }, at);
  const task = db.prepare("SELECT * FROM task WHERE id='task'").get();
  const controller = new Controller(db, config);
  insertRun(db, "run", task.id, "openai-codex-3", at, task.model, task.thinking);
  controller.activateQuotaLease(task, {
    leaseId, provider: "openai-codex-3", model: task.model, thinking: task.thinking,
  }, "run", at);
  controller.finish(task, "run", "incomplete", "productive", [], null, true);
  assert.deepEqual(
    { ...db.prepare("SELECT state,task_id,provider FROM quota_lease WHERE id=?").get(leaseId) },
    { state: "available", task_id: "task", provider: "openai-codex-3" },
  );
  db.close();
});

test("restart handoffs are restored before unrelated cold admission", async () => {
  const db = openDb(path.join(temporary, "quota-lease-priority.sqlite3"));
  const at = Date.now();
  const insert = db.prepare(`INSERT INTO task(id,prompt,cwd,model,thinking,completion_condition,launch_share,not_before,next_eligible_at,created_at)
    VALUES(?,?,?,?,?,?,?,?,?,?)`);
  insert.run("unleased", "prompt", temporary, "openai-codex/gpt-5.6-sol", "xhigh", "done", 1, at, at, at);
  insert.run("leased", "prompt", temporary, "openai-codex/gpt-5.6-sol", "xhigh", "done", 1, at, at, at + 1);
  const config = loadConfig();
  config.maxCpuPercent = 101;
  config.maxMemoryPercent = 101;
  grantQuotaLease(db, config, {
    provider: "openai-codex-3", model: "openai-codex/gpt-5.6-sol", thinking: "xhigh", taskId: "leased", hours: 1,
  }, at);
  const controller = new Controller(db, config);
  let normalAdmissions = 0;
  controller.plan = {
    restores: async (lease) => ({ ok: true, provider: lease.provider, model: lease.model, thinking: lease.thinking }),
    allows: async () => { normalAdmissions++; return { ok: false, detail: "not expected" }; },
  };
  let launched = null;
  controller.launch = async (task, assignment) => { launched = { task: task.id, provider: assignment.provider }; };
  await controller.tick();
  assert.deepEqual(launched, { task: "leased", provider: "openai-codex-3" });
  assert.equal(normalAdmissions, 0);
  db.close();
});

test("an unsafe interrupted governor lease returns to its model lane instead of blocking healthy cold capacity", async () => {
  const db = openDb(path.join(temporary, "unsafe-handoff.sqlite3"));
  const at = Date.now();
  db.prepare(`INSERT INTO task(id,prompt,cwd,model,thinking,completion_condition,launch_share,not_before,next_eligible_at,created_at)
    VALUES(?,?,?,?,?,?,?,?,?,?)`).run("task", "prompt", temporary, "openai-codex/gpt-5.6-sol", "xhigh", "done", 1, at, at, at);
  const insertLease = db.prepare(`INSERT INTO quota_lease(id,task_id,provider,model,thinking,state,run_id,source,issued_at,expires_at,heartbeat_at)
    VALUES(?,?,?,?,?,'available',NULL,'governor',?,?,?)`);
  insertLease.run("handoff", "task", "anthropic-2", "anthropic/claude-opus-5", "xhigh", at, at + 3600_000, at);
  insertLease.run("other-model", null, "openai-codex-3", "openai-codex/gpt-5.6-luna", "max", at, at + 3600_000, at);
  const config = loadConfig();
  config.maxCpuPercent = 101;
  config.maxMemoryPercent = 101;
  const controller = new Controller(db, config);
  let coldAdmissions = 0;
  controller.plan = {
    restores: async () => ({ ok: false, detail: "account sensor circuit is closed" }),
    allows: async (task) => {
      coldAdmissions++;
      return { ok: true, provider: "anthropic-3", model: "anthropic/claude-opus-5", thinking: task.thinking };
    },
  };
  let launched = null;
  controller.launch = async (task, assignment) => { launched = { task: task.id, provider: assignment.provider }; };
  await controller.tick();
  assert.deepEqual(launched, { task: "task", provider: "anthropic-3" });
  assert.equal(coldAdmissions, 1);
  assert.deepEqual(
    { ...db.prepare("SELECT task_id,provider,state FROM quota_lease WHERE id='handoff'").get() },
    { task_id: null, provider: null, state: "available" },
  );
  assert.deepEqual(
    { ...db.prepare("SELECT task_id,provider,state FROM quota_lease WHERE id='other-model'").get() },
    { task_id: null, provider: "openai-codex-3", state: "available" },
  );
  db.close();
});

test("a healthy exact account can restore while another account holds the aggregate sensor circuit open", async () => {
  const config = loadConfig();
  const account = {
    provider: "anthropic-3",
    windows: {
      fiveHour: { utilization: 0 },
      sharedWeekly: { utilization: 20 },
      fableWeekly: { utilization: 20 },
    },
  };
  const anthropic = {
    cooldowns: new Map(),
    refresh: async () => ({
      distributed: {
        sensorInconsistent: true,
        accounts: { "anthropic-3": { sensorInconsistent: false, sustainableRate: 1 } },
      },
      accounts: [account],
    }),
    feedback: {
      selectAccount: (accounts) => accounts.length ? { account: accounts[0], block: 1, sign: 0 } : null,
    },
    setModelRuntime() {},
  };
  const governor = new PlanGovernor(config, { anthropic });
  const restored = await governor.restores({
    provider: "anthropic-3", model: "anthropic/claude-opus-5", thinking: "xhigh",
  }, []);
  assert.equal(restored.ok, true);
  assert.equal(restored.provider, "anthropic-3");
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
  assert.match(deploy, /claude_extension_configured=.*any/);
  assert.match(deploy, /if \[\[ "\$claude_extension_configured" == true \]\]/);
  assert.match(deploy, /PI_RUNTIME_SKIP_RESTART:-0/);
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

test("the tool shell terminates a command that outruns its scope ceiling", () => {
  const result = spawnSync(TOOL_SHELL, ["-c", "printf started; sleep 60"], {
    encoding: "utf8",
    env: { ...process.env, PI_TOOL_TIMEOUT_SECONDS: "2" },
    timeout: 30_000,
  });
  assert.equal(result.stdout, "started");
  assert.notEqual(result.status, 0);
});

test("the tool shell rejects and kills detached command processes", () => {
  const pidFile = path.join(temporary, "detached.pid");
  const command = `sleep 60 & printf '%s' $! > ${JSON.stringify(pidFile)}; printf launched`;
  const result = spawnSync(TOOL_SHELL, ["-c", command], {
    encoding: "utf8",
    timeout: 10_000,
  });
  assert.equal(result.status, 125);
  assert.equal(result.stdout, "launched");
  assert.match(result.stderr, /rejected a detached process/);
  const surviving = spawnSync("kill", ["-0", fs.readFileSync(pidFile, "utf8")], { encoding: "utf8" });
  assert.equal(surviving.status, 1, surviving.stderr);
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

test("the tool shell thaws a frozen shared tool slice before launching", () => {
  const mockBin = fs.mkdtempSync(path.join(temporary, "tool-shell-mock-"));
  const calls = path.join(mockBin, "systemctl.calls");
  const executable = 0o755;
  fs.writeFileSync(path.join(mockBin, "busctl"), "#!/usr/bin/env bash\nexit 0\n", { mode: executable });
  fs.writeFileSync(path.join(mockBin, "systemd-id128"), "#!/usr/bin/env bash\nprintf '00000000000000000000000000000001\\n'\n", { mode: executable });
  fs.writeFileSync(path.join(mockBin, "systemctl"), `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> ${JSON.stringify(calls)}\nif [[ " $* " == *" show "* ]]; then printf 'frozen\\n'; fi\n`, { mode: executable });
  fs.writeFileSync(path.join(mockBin, "systemd-run"), "#!/usr/bin/env bash\nwhile [[ $# -gt 0 && $1 != -- ]]; do shift; done\nshift\nif [[ $2 == --guard ]]; then exec bash -c \"$3\"; fi\nexec \"$@\"\n", { mode: executable });
  const result = spawnSync(TOOL_SHELL, ["-c", "printf slice-recovered"], {
    encoding: "utf8",
    env: { ...process.env, PATH: `${mockBin}:${process.env.PATH}` },
    timeout: 10_000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "slice-recovered");
  assert.match(fs.readFileSync(calls, "utf8"), /--user thaw pi-tools\.slice/);
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

test("plan estimator paces all remaining capacity to 100% at window reset", () => {
  assert.equal(loadConfig().plan.distributed.targetPercent, 100);
  const at = Date.UTC(2026, 7, 14, 12);
  assert.equal(planWindowBurnPerHour({ used_percent: 40, reset_at: (at + 10 * 3600_000) / 1000 }, at), 6);
  assert.equal(planWindowBurnPerHour({ used_percent: 40, reset_at: at / 1000 }, at), 0);
  assert.equal(planWindowBurnPerHour({}, at), null);
});

test("provider manifest is the sole model-mix declaration", () => {
  const manifest = loadProviderManifest();
  assert.deepEqual(manifest.mixes, [{ base: "sol", alternatives: ["opus", "grok"], strategy: "independent-capacity" }]);
  const config = loadConfig();
  assert.deepEqual(config.plan.modelMixes["openai-codex/gpt-5.6-sol:xhigh"].alternatives, [
    { model: "anthropic/claude-opus-5", thinking: "xhigh" },
    { model: "cursor/grok-4.6", thinking: "xhigh" },
  ]);
});

test("mixed models choose independently admitted provider capacity", () => {
  const sol = { ok: true, provider: "openai-codex", pressure: 1.4 };
  const opus = { ok: true, provider: "anthropic", pressure: 0.8 };
  const grok = { ok: true, provider: "cursor", pressure: 0.6 };
  assert.equal(chooseIndependentAssignment(sol, opus), opus);
  assert.equal(chooseIndependentAssignment(sol, opus, grok), grok);
  assert.equal(chooseIndependentAssignment({ ...sol, pressure: 0.4 }, opus, grok).provider, "openai-codex");
  assert.equal(chooseIndependentAssignment({ ...sol, ok: false }, opus), opus);
  assert.equal(chooseIndependentAssignment(sol, { ...opus, ok: false }), sol);
  assert.equal(chooseIndependentAssignment({ ...sol, ok: false }, { ...opus, ok: false }), null);
});

test("independent Opus capacity remains usable when Codex is full", async () => {
  const config = loadConfig();
  const anthropic = {
    setModelRuntime() {},
    refresh: async () => ({ healthy: 2, withHeadroom: 1 }),
    allows: async (variant) => ({ ok: true, provider: "anthropic", model: variant.model, thinking: variant.thinking, detail: "available" }),
  };
  const cursor = {
    setModelRuntime() {},
    allows: async (variant) => ({ ok: false, provider: null, model: variant.model, thinking: variant.thinking, detail: "Cursor full" }),
  };
  const governor = new PlanGovernor(config, { anthropic, cursor });
  governor.refresh = async () => ({ healthy: 12, accounts: [], allowedBurnPercentPerHour: 0 });
  governor.allowsCodex = async (variant) => ({ ok: false, provider: null, model: variant.model, thinking: variant.thinking, detail: "Codex full" });
  const task = { model: "openai-codex/gpt-5.6-sol", thinking: "xhigh" };
  const assignment = await governor.allows(task, []);
  assert.equal(assignment.ok, true);
  assert.equal(assignment.provider, "anthropic");
  assert.equal(assignment.model, "anthropic/claude-opus-5");
});

test("mixed-provider rejection reports both quota gates", async () => {
  const config = loadConfig();
  const anthropic = {
    setModelRuntime() {},
    refresh: async () => ({ healthy: 3, withHeadroom: 3 }),
    allows: async (variant) => ({ ok: false, provider: null, model: variant.model, thinking: variant.thinking, detail: "Anthropic allowance=0.300" }),
  };
  const cursor = {
    setModelRuntime() {},
    allows: async (variant) => ({ ok: false, provider: null, model: variant.model, thinking: variant.thinking, detail: "Cursor allowance=0.302" }),
  };
  const governor = new PlanGovernor(config, { anthropic, cursor });
  governor.refresh = async () => ({ healthy: 12, accounts: [], allowedBurnPercentPerHour: 0 });
  governor.allowsCodex = async (variant) => ({ ok: false, provider: null, model: variant.model, thinking: variant.thinking, detail: "Codex allowance=0.301" });
  const result = await governor.allows({ model: "openai-codex/gpt-5.6-sol", thinking: "xhigh" }, []);
  assert.match(result.detail, /Codex allowance=0\.301/);
  assert.match(result.detail, /Anthropic allowance=0\.300/);
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
  const jittered = parseAnthropicUsage({
    limits: [
      { kind: "session", percent: 21, resets_at: new Date(at + 3600_000 - 1000).toISOString() },
      { kind: "weekly_all", percent: 41, resets_at: new Date(at + 86400_000 - 1000).toISOString() },
      { kind: "weekly_scoped", percent: 61, resets_at: new Date(at + 86400_000 - 1000).toISOString(), scope: { model: { display_name: "Fable" } } },
    ],
  }, at);
  assert.equal(jittered.windows.fiveHour.resetsAt, parsed.windows.fiveHour.resetsAt);
  assert.equal(jittered.windows.sharedWeekly.resetsAt, parsed.windows.sharedWeekly.resetsAt);
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
  governor.feedback.state.share = 1;
  governor.feedback.state.accountShares["anthropic-2"] = 1;
  governor.snapshot = {
    at, expiresAt: at + 1000, configured: 2, healthy: 2, withHeadroom: 1,
    distributed: { share: 1, accounts: {
      anthropic: { sustainableRate: 1 },
      "anthropic-2": { sustainableRate: 1 },
    } },
    accounts: [
      account("anthropic", 0, 50, 0),
      account("anthropic-2", 0, 50, 100),
    ],
  };
  const variant = { model: "anthropic/claude-opus-5", thinking: "xhigh" };
  const active = (count) => Array.from({ length: count }, () => ({
    provider: "anthropic-2", model: variant.model, thinking: variant.thinking,
  }));
  assert.equal((await governor.allows(variant, [], governor.snapshot)).provider, "anthropic-2");
  assert.equal((await governor.allows(variant, active(3), governor.snapshot)).provider, "anthropic-2");
  assert.equal((await governor.allows(variant, active(4), governor.snapshot)).ok, false);
  governor.usageMultiplier = () => 5;
  assert.equal((await governor.allows(variant, active(19), governor.snapshot)).provider, "anthropic-2");
  assert.equal((await governor.allows(variant, active(20), governor.snapshot)).ok, false);
  governor.noteFailure("anthropic-2", new Error("429 usage limit reached"), Date.now());
  assert.equal((await governor.allows(variant, [], governor.snapshot)).ok, false);
});

test("Cursor plan usage dynamically admits Grok load from sustainable burn", async () => {
  const at = Date.UTC(2026, 7, 18, 12);
  assert.deepEqual(parseCursorUsage({
    billingCycleStart: at - 86400_000,
    billingCycleEnd: at + 86400_000,
    planUsage: { totalPercentUsed: 25 },
    spendLimitUsage: { limitType: "user" },
  }, at), {
    used: 25,
    startAt: at - 86400_000,
    resetAt: at + 86400_000,
    reportedReset: true,
    membershipType: "pro",
  });
  assert.equal(parseCursorUsage({ planUsage: {} }, at), null);

  const config = loadConfig();
  const runtime = { getModel: (provider, id) => provider === "cursor" && id === "grok-4.6" ? { provider, id } : undefined };
  const feedback = new DistributedQuotaFeedback(config, path.join(temporary, "cursor-feedback.json"), false);
  feedback.state.accountShares.cursor = 1;
  const governor = new CursorGovernor(config, { modelRuntime: runtime, feedback, cachePath: path.join(temporary, "cursor-cache.json") });
  governor.snapshot = {
    at,
    expiresAt: Date.now() + 1000,
    healthy: 1,
    usage: { used: 25, startAt: at - 86400_000, resetAt: at + 86400_000, reportedReset: true, membershipType: "pro" },
    distributed: { share: 1, accounts: { cursor: { sustainableRate: 1 } } },
    error: null,
  };
  const variant = { model: "cursor/grok-4.6", thinking: "xhigh" };
  const active = (count) => Array.from({ length: count }, () => ({ provider: "cursor", ...variant }));
  assert.equal((await governor.allows(variant, active(3), governor.snapshot)).provider, "cursor");
  assert.equal((await governor.allows(variant, active(4), governor.snapshot)).ok, false);
  assert.equal((await governor.restores(variant, active(10), governor.snapshot)).provider, "cursor",
    "an explicit quota lease bypasses adaptive allowance while retaining raw plan and sensor checks");
  governor.snapshot.usage.used = 99;
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

test("forbidden autonomous models are rejected", () => {
  assert.throws(() => validateModelPolicy("chatgpt-pro/gpt-5-5-pro"), /banned/);
  assert.throws(() => validateModelPolicy("chatgpt-pro/gpt-5-5-pro-deep-research"), /banned/);
  assert.throws(() => validateModelPolicy("anthropic/claude-fable-5"), /interactive use/);
  assert.throws(() => validateModelPolicy("anthropic-2/claude-fable-5"), /interactive use/);
  assert.doesNotThrow(() => validateModelPolicy("anthropic/claude-opus-5"));
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

test("the controller locks governor-assigned providers against hidden Multi-Pass rotation", () => {
  const multiPass = fs.readFileSync("/home/kenan/tools/pi-multi-pass/extensions/multi-sub.ts", "utf8");
  assert.equal(process.env.PI_MULTI_PASS_LOCK_ASSIGNED_PROVIDER, "1");
  assert.match(multiPass, /PI_MULTI_PASS_LOCK_ASSIGNED_PROVIDER === "1"/);
});

test("distributed quota feedback has no unconditional per-machine baseline", () => {
  const feedback = new DistributedQuotaFeedback(loadConfig(), path.join(temporary, "distributed-admission.json"));
  feedback.state.share = 0.5;
  assert.equal(feedback.admits(0, 0.58, 2, "sol", 0), true);
  assert.equal(feedback.admits(0.58, 0.58, 2, "sol", 0), false);
  assert.equal(feedback.admits(0, 0.58, 0, "sol", 0), false);
});

test("boosted mode multiplies the final local allowance without bypassing headroom", () => {
  const feedback = new DistributedQuotaFeedback(loadConfig(), path.join(temporary, "distributed-boost.json"));
  feedback.state.accountShares.account = 0.1;
  const accounts = [{ provider: "account", allowedBurnPercentPerHour: 1 }];
  assert.equal(feedback.totalAllowance(accounts), 0.1);
  assert.equal(feedback.totalAllowance(accounts, 5), 0.5);
  assert.equal(feedback.admitsAccounts(0.2, 0.2, accounts, "model", 0, 1), false);
  assert.equal(feedback.admitsAccounts(0.2, 0.2, accounts, "model", 0, 5), true);
  assert.equal(feedback.admitsAccounts(0, 0.2, [{ provider: "account", allowedBurnPercentPerHour: 0 }], "model", 0, 5), false);
});

test("private balanced routing instruments assign a concrete healthy account", () => {
  const feedback = new DistributedQuotaFeedback(loadConfig(), path.join(temporary, "distributed-routing.json"));
  feedback.state.share = 0.5;
  feedback.state.seed = "local-private-seed";
  const accounts = [
    { provider: "openai-codex", allowedBurnPercentPerHour: 0 },
    { provider: "openai-codex-2", allowedBurnPercentPerHour: 1.2 },
    { provider: "openai-codex-3", allowedBurnPercentPerHour: 2.0 },
  ];
  const selected = feedback.selectAccount(accounts, [{ provider: "openai-codex-2", rate: 0.58 }], "openai-codex/gpt-5.6-sol:xhigh", 0.58, 0);
  assert.ok(["openai-codex-2", "openai-codex-3"].includes(selected.account.provider));
  assert.ok([-1, 0, 1].includes(selected.sign));
  assert.equal(Number.isInteger(selected.block), true);
});

test("calibration schema changes do not erase valid allocation state", () => {
  const statePath = path.join(temporary, "distributed-state-v2.json");
  fs.writeFileSync(statePath, JSON.stringify({
    version: 2,
    meterIdentityVersion: 3,
    seed: "preserved-seed",
    share: 0.61,
    accountShares: { a: 0.7 },
    sensorInconsistent: false,
    samples: [{ at: 1 }],
    estimates: { model: { upper: 2 } },
  }));
  const feedback = new DistributedQuotaFeedback(loadConfig(), statePath);
  assert.equal(feedback.state.version, 3);
  assert.equal(feedback.state.seed, "preserved-seed");
  assert.equal(feedback.state.share, 0.61);
  assert.deepEqual(feedback.state.accountShares, { a: 0.7 });
  assert.deepEqual(feedback.state.samples, [{ at: 1 }]);
  assert.deepEqual(feedback.state.estimates, { model: { upper: 2 } });
});

test("premature calibration state cannot poison model admission", () => {
  const statePath = path.join(temporary, "distributed-state-migration.json");
  fs.writeFileSync(statePath, JSON.stringify({
    version: 1,
    seed: "bad-state",
    share: 0,
    sensorInconsistent: true,
    estimates: { "openai-codex/gpt-5.6-sol:xhigh": { upper: 68.6 } },
  }));
  const feedback = new DistributedQuotaFeedback(loadConfig(), statePath);
  assert.equal(feedback.state.share, loadConfig().plan.distributed.initialShare);
  assert.equal(feedback.state.sensorInconsistent, false);
  assert.deepEqual(feedback.state.estimates, {});

  const calibration = {
    accounts: [{ provider: "a" }, { provider: "b" }],
    assignments: [{ provider: "a", model: "openai-codex/gpt-5.6-sol", thinking: "xhigh", instrumentBlock: 0 }],
    priors: { "openai-codex/gpt-5.6-sol:xhigh": 0.58 },
    rate: () => 0.58,
  };
  for (let sample = 0; sample < feedback.config.calibrationMinSamples - 1; sample++) {
    feedback.calibrate({ a: sample % 2, b: (sample + 1) % 2 }, calibration, 1 / 12, sample * 300_000);
  }
  assert.deepEqual(feedback.state.estimates, {});
});

test("a frozen provider meter trips and a later advance clears the consistency circuit", () => {
  const config = loadConfig();
  const feedback = new DistributedQuotaFeedback(config, path.join(temporary, "distributed-circuit.json"));
  const start = 1_000_000;
  const resetAt = start + 168 * 3600_000;
  const resource = (used) => [{ id: "account", provider: "account", group: "weekly", used, resetAt, weight: 1, available: 92 - used }];
  feedback.observe(resource(0), 6, null, start);
  feedback.observe(resource(0), 6, null, start + 21 * 60_000);
  assert.equal(feedback.status.sensorInconsistent, true);
  feedback.observe(resource(1), 0, null, start + 42 * 60_000);
  assert.equal(feedback.status.sensorInconsistent, false);
});

test("a monotone rolling meter advance is recognized when the provider omits reset timestamps", () => {
  const config = loadConfig();
  const feedback = new DistributedQuotaFeedback(config, path.join(temporary, "distributed-rolling-meter.json"));
  const start = 1_000_000;
  const resource = (used, at) => [{
    id: "account", provider: "account", group: "weekly", used,
    resetAt: at + 168 * 3600_000, reportedReset: false, weight: 1, available: 92 - used,
  }];
  feedback.observe(resource(0, start), 6, null, start);
  feedback.observe(resource(1, start + 21 * 60_000), 6, null, start + 21 * 60_000);
  assert.equal(feedback.status.sensorInconsistent, false);
  assert.equal(feedback.status.unconfirmed, 0);
  assert.equal(feedback.state.cumulative.weekly, 1);
});

test("meter identity migration discards circuits produced by incomparable fallback reset times", () => {
  const statePath = path.join(temporary, "distributed-meter-migration.json");
  fs.writeFileSync(statePath, JSON.stringify({
    version: 3,
    allocationVersion: 1,
    calibrationVersion: 1,
    seed: "preserved-seed",
    share: 0,
    accountShares: { account: 0 },
    accountUnconfirmed: { account: 3 },
    accountSensorInconsistent: { account: true },
    unconfirmed: 3,
    sensorInconsistent: true,
    samples: [{ at: 1 }],
    estimates: { model: { upper: 2 } },
  }));
  const feedback = new DistributedQuotaFeedback(loadConfig(), statePath);
  assert.equal(feedback.state.seed, "preserved-seed");
  assert.equal(feedback.state.share, loadConfig().plan.distributed.initialShare);
  assert.deepEqual(feedback.state.accountShares, {});
  assert.equal(feedback.state.sensorInconsistent, false);
  assert.deepEqual(feedback.state.samples, []);
  assert.deepEqual(feedback.state.estimates, {});
});

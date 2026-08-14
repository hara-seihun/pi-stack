#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Type } from "typebox";
import {
  createAgentSession,
  DefaultResourceLoader,
  defineTool,
  getAgentDir,
  ModelRuntime,
  resolveCliModel,
  SessionManager,
} from "@earendil-works/pi-coding-agent";

const HOME = os.homedir();
const DATA = process.env.AGENT_ORCHESTRATOR_DATA ?? path.join(HOME, "data/agent-orchestrator");
const DB_PATH = path.join(DATA, "orchestrator.sqlite3");
const CONFIG_PATH = path.join(DATA, "config.json");
const SESSIONS = path.join(DATA, "sessions");
const LOCK = path.join(DATA, "controller.lock");
const AUTH_PATH = path.join(getAgentDir(), "auth.json");
const TICK_MS = 1000;

const DEFAULT_CONFIG = {
  maxSessions: 64,
  reserveMemoryMiB: 12288,
  estimatedSessionMiB: 256,
  maxLoadPerCpu: 1.0,
  quota: {
    pollSeconds: 120,
    targetFraction: 0.5,
    creditsPerPercent: 504,
    modelCreditsPerHour: {
      "openai-codex/gpt-5.6-sol:xhigh": 293.55,
      "openai-codex/gpt-5.6-luna:max": 12.64
    }
  }
};

function now() { return Date.now(); }
function iso(ms) { return new Date(ms).toISOString(); }
function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function fail(message) { throw new Error(message); }

function atomicWrite(file, value, mode = 0o600) {
  const temporary = `${file}.tmp.${process.pid}`;
  fs.writeFileSync(temporary, value, { mode });
  fs.renameSync(temporary, file);
}

export function ensureLayout() {
  fs.mkdirSync(DATA, { recursive: true, mode: 0o700 });
  fs.mkdirSync(SESSIONS, { recursive: true, mode: 0o700 });
  if (!fs.existsSync(CONFIG_PATH)) atomicWrite(CONFIG_PATH, `${JSON.stringify(DEFAULT_CONFIG, null, 2)}\n`);
}

export function loadConfig() {
  ensureLayout();
  const config = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
  for (const key of ["maxSessions", "reserveMemoryMiB", "estimatedSessionMiB", "maxLoadPerCpu"]) {
    if (!(Number.isFinite(config[key]) && config[key] > 0)) fail(`invalid config.${key}`);
  }
  if (!(Number.isFinite(config.quota?.pollSeconds) && config.quota.pollSeconds > 0)) fail("invalid config.quota.pollSeconds");
  if (!(Number.isFinite(config.quota?.targetFraction) && config.quota.targetFraction > 0 && config.quota.targetFraction <= 1)) fail("invalid config.quota.targetFraction");
  if (!(Number.isFinite(config.quota?.creditsPerPercent) && config.quota.creditsPerPercent > 0)) fail("invalid config.quota.creditsPerPercent");
  if (!config.quota.modelCreditsPerHour || typeof config.quota.modelCreditsPerHour !== "object") fail("missing config.quota.modelCreditsPerHour");
  return config;
}

export function openDb(file = DB_PATH) {
  ensureLayout();
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=30000;");
  db.exec(`
    CREATE TABLE IF NOT EXISTS task (
      id TEXT PRIMARY KEY,
      prompt TEXT NOT NULL,
      cwd TEXT NOT NULL,
      model TEXT NOT NULL,
      thinking TEXT NOT NULL,
      completion_condition TEXT NOT NULL,
      max_parallel INTEGER NOT NULL CHECK(max_parallel > 0),
      launch_share REAL NOT NULL CHECK(launch_share > 0),
      not_before INTEGER NOT NULL,
      next_eligible_at INTEGER NOT NULL,
      incomplete_streak INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      completed_at INTEGER,
      cancelled_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS run (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL REFERENCES task(id),
      session_id TEXT,
      status TEXT NOT NULL CHECK(status IN ('running','complete','incomplete','interrupted')),
      started_at INTEGER NOT NULL,
      finished_at INTEGER,
      summary TEXT,
      artifacts_json TEXT NOT NULL DEFAULT '[]',
      error TEXT
    );
    CREATE INDEX IF NOT EXISTS run_task_status ON run(task_id,status);
    CREATE TABLE IF NOT EXISTS event (
      id INTEGER PRIMARY KEY,
      at INTEGER NOT NULL,
      kind TEXT NOT NULL,
      task_id TEXT,
      run_id TEXT,
      detail TEXT NOT NULL
    );
  `);
  return db;
}

function event(db, kind, detail, taskId = null, runId = null) {
  db.prepare("INSERT INTO event(at,kind,task_id,run_id,detail) VALUES(?,?,?,?,?)")
    .run(now(), kind, taskId, runId, detail);
}

function taskRows(db) {
  return db.prepare(`
    SELECT t.*, count(CASE WHEN r.status='running' THEN 1 END) AS active
    FROM task t LEFT JOIN run r ON r.task_id=t.id
    GROUP BY t.id ORDER BY t.created_at,t.id
  `).all();
}

export function rankTasks(tasks, activeTotal) {
  const eligible = tasks.filter((task) =>
    task.completed_at === null && task.cancelled_at === null &&
    task.not_before <= now() && task.next_eligible_at <= now() &&
    Number(task.active) < task.max_parallel);
  if (!eligible.length) return [];
  const totalShare = eligible.reduce((sum, task) => sum + task.launch_share, 0);
  return eligible
    .map((task) => ({ task, deficit: (task.launch_share / totalShare) * (activeTotal + 1) - Number(task.active) }))
    .sort((a, b) => b.deficit - a.deficit || a.task.created_at - b.task.created_at)
    .map((item) => item.task);
}

export function chooseTask(tasks, activeTotal) {
  return rankTasks(tasks, activeTotal)[0] ?? null;
}

export function resourceSlots(config, activeCount, memAvailableMiB, load1, load5, cpuCount = os.cpus().length) {
  const memorySlots = Math.max(0, Math.floor((memAvailableMiB - config.reserveMemoryMiB) / config.estimatedSessionMiB));
  const loadAllows = load1 / cpuCount <= config.maxLoadPerCpu && load5 / cpuCount <= config.maxLoadPerCpu;
  const total = loadAllows ? Math.min(config.maxSessions, memorySlots) : activeCount;
  return Math.max(0, total - activeCount);
}

function availableMemoryMiB() {
  try {
    const line = fs.readFileSync("/proc/meminfo", "utf8").split("\n").find((item) => item.startsWith("MemAvailable:"));
    if (line) return Number(line.split(/\s+/)[1]) / 1024;
  } catch {}
  return os.freemem() / 1048576;
}

function runModelKey(task) { return `${task.model}:${task.thinking}`; }

class QuotaGovernor {
  constructor(config) { this.config = config; this.snapshot = null; this.refreshing = null; }

  async refresh() {
    if (this.snapshot && now() - this.snapshot.at < this.config.quota.pollSeconds * 1000) return this.snapshot;
    if (this.refreshing) return this.refreshing;
    this.refreshing = this.fetch().finally(() => { this.refreshing = null; });
    return this.refreshing;
  }

  async fetch() {
    const auth = JSON.parse(fs.readFileSync(AUTH_PATH, "utf8"));
    const accounts = Object.entries(auth).filter(([name, value]) =>
      (name === "openai-codex" || name.startsWith("openai-codex-")) && value?.access);
    if (!accounts.length) fail("quota governor found no Codex OAuth accounts");
    const endpoint = `${(process.env.CHATGPT_BASE_URL ?? "https://chatgpt.com/backend-api").replace(/\/$/, "")}/wham/usage`;
    const results = await Promise.all(accounts.map(async ([, credential]) => {
      try {
        const response = await fetch(endpoint, {
          signal: AbortSignal.timeout(10000),
          headers: {
            Authorization: `Bearer ${credential.access}`,
            "chatgpt-account-id": credential.accountId ?? "",
            Accept: "application/json",
            "User-Agent": "works.kenan.agent-orchestrator"
          }
        });
        if (!response.ok) return null;
        const body = await response.json();
        const rate = body.rate_limit ?? {};
        const windows = [rate.primary_window, rate.secondary_window].filter(Boolean);
        if (!windows.length) return null;
        return Math.min(...windows.map((window) => {
          const remaining = Math.max(0, 100 - Number(window.used_percent ?? 100));
          const hours = Math.max(0, Number(window.reset_at ?? 0) * 1000 - now()) / 3600000;
          return hours > 0 ? remaining * this.config.quota.targetFraction / hours : 0;
        }));
      } catch { return null; }
    }));
    const healthy = results.filter((value) => value !== null);
    if (!healthy.length) fail("quota governor could not read any Codex account");
    this.snapshot = { at: now(), healthy: healthy.length, accounts: accounts.length, allowedPercentPerHour: healthy.reduce((a, b) => a + b, 0) };
    return this.snapshot;
  }

  modelRate(task) {
    const credits = this.config.quota.modelCreditsPerHour[runModelKey(task)];
    if (!(Number.isFinite(credits) && credits >= 0)) fail(`no quota rate configured for ${runModelKey(task)}`);
    return credits / this.config.quota.creditsPerPercent;
  }

  async allows(task, activeTasks) {
    const quota = await this.refresh();
    const live = activeTasks.reduce((sum, item) => sum + this.modelRate(item), 0);
    const candidate = this.modelRate(task);
    return { ok: live + candidate <= quota.allowedPercentPerHour, live, candidate, quota };
  }
}

function randomId() { return crypto.randomUUID(); }
function backoffMs(streak) { return Math.min(30 * 60_000, 30_000 * (2 ** Math.min(6, Math.max(0, streak - 1)))); }

export function insertRun(db, runId, taskId, startedAt = now()) {
  db.prepare("INSERT INTO run(id,task_id,status,started_at) VALUES(?,?,?,?)")
    .run(runId, taskId, "running", startedAt);
}

class Controller {
  constructor(db, config) {
    this.db = db;
    this.config = config;
    this.modelRuntime = null;
    this.quota = new QuotaGovernor(config);
    this.active = new Map();
    this.stopping = false;
    this.lastGovernorEvent = { at: 0, detail: "" };
    this.lastControllerError = { at: 0, detail: "" };
  }

  recover() {
    const interrupted = this.db.prepare("SELECT id,task_id FROM run WHERE status='running'").all();
    const finish = this.db.prepare("UPDATE run SET status='interrupted',finished_at=?,error=? WHERE id=?");
    for (const row of interrupted) {
      finish.run(now(), "controller restarted while run was active", row.id);
      event(this.db, "run-interrupted", "controller restart", row.task_id, row.id);
    }
  }

  async init() {
    this.recover();
    this.modelRuntime = await ModelRuntime.create({ signal: AbortSignal.timeout(15000) });
  }

  async launch(task) {
    const runId = randomId();
    insertRun(this.db, runId, task.id);
    event(this.db, "run-started", runModelKey(task), task.id, runId);
    const promise = this.execute(task, runId).finally(() => this.active.delete(runId));
    this.active.set(runId, { task, promise });
  }

  async execute(task, runId) {
    let session;
    let report = null;
    let sessionId = null;
    try {
      const resolved = resolveCliModel({ cliModel: `${task.model}:${task.thinking}`, modelRuntime: this.modelRuntime });
      if (resolved.error || !resolved.model) fail(resolved.error ?? `cannot resolve ${runModelKey(task)}`);
      const completionTool = defineTool({
        name: "task_complete",
        label: "Complete task launch",
        description: "Report this launch's validated output. Set complete=true only when the task completion condition is now satisfied; otherwise the persistent task remains eligible.",
        parameters: Type.Object({
          complete: Type.Boolean(),
          summary: Type.String({ minLength: 1 }),
          artifacts: Type.Optional(Type.Array(Type.String()))
        }),
        execute: async (_id, parameters) => {
          if (report) return { content: [{ type: "text", text: "This launch has already reported completion." }], details: {} };
          report = { complete: parameters.complete, summary: parameters.summary, artifacts: parameters.artifacts ?? [] };
          return { content: [{ type: "text", text: parameters.complete ? "Task completion recorded." : "Launch output recorded; the task remains eligible." }], details: report };
        }
      });
      const loader = new DefaultResourceLoader({ cwd: task.cwd, agentDir: getAgentDir() });
      await loader.reload();
      const extensionErrors = loader.getExtensions().errors;
      if (extensionErrors.length) fail(`extension loading failed: ${extensionErrors.map((item) => item.error).join("; ")}`);
      ({ session } = await createAgentSession({
        cwd: task.cwd,
        modelRuntime: this.modelRuntime,
        model: resolved.model,
        thinkingLevel: resolved.thinkingLevel,
        resourceLoader: loader,
        customTools: [completionTool],
        sessionManager: SessionManager.create(task.cwd, SESSIONS)
      }));
      this.active.get(runId).session = session;
      sessionId = session.sessionId;
      this.db.prepare("UPDATE run SET session_id=? WHERE id=?").run(sessionId, runId);
      const prompt = `${task.prompt}\n\n## Orchestrated task contract\nTask: ${task.id}\nCompletion condition: ${task.completion_condition}\nThis task may run repeatedly or concurrently. Make external effects idempotent where possible. Before finishing, call task_complete exactly once with the validated result. Set complete=true only if the completion condition is satisfied.`;
      await session.prompt(prompt);
      if (!report) fail("agent ended without task_complete");
      this.finish(task, runId, report.complete ? "complete" : "incomplete", report.summary, report.artifacts, null);
    } catch (error) {
      this.finish(task, runId, "incomplete", report?.summary ?? null, report?.artifacts ?? [], String(error?.message ?? error));
    } finally {
      session?.dispose();
    }
  }

  finish(task, runId, status, summary, artifacts, error) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("UPDATE run SET status=?,finished_at=?,summary=?,artifacts_json=?,error=? WHERE id=?")
        .run(status, now(), summary, JSON.stringify(artifacts), error, runId);
      if (status === "complete") {
        this.db.prepare("UPDATE task SET completed_at=?,incomplete_streak=0 WHERE id=? AND completed_at IS NULL").run(now(), task.id);
      } else {
        const row = this.db.prepare("SELECT incomplete_streak FROM task WHERE id=?").get(task.id);
        const streak = Number(row.incomplete_streak) + 1;
        this.db.prepare("UPDATE task SET incomplete_streak=?,next_eligible_at=? WHERE id=?")
          .run(streak, now() + backoffMs(streak), task.id);
      }
      event(this.db, `run-${status}`, error ?? summary ?? "", task.id, runId);
      this.db.exec("COMMIT");
    } catch (failure) {
      this.db.exec("ROLLBACK");
      throw failure;
    }
  }

  controllerError(detail) {
    if (detail !== this.lastControllerError.detail || now() - this.lastControllerError.at >= 60_000) {
      event(this.db, "controller-error", detail);
      this.lastControllerError = { at: now(), detail };
    }
  }

  governorBlocked(detail, taskId) {
    if (detail !== this.lastGovernorEvent.detail || now() - this.lastGovernorEvent.at >= 60_000) {
      event(this.db, "governor-blocked", detail, taskId);
      this.lastGovernorEvent = { at: now(), detail };
    }
  }

  async tick() {
    const tasks = taskRows(this.db);
    const activeTasks = [...this.active.values()].map((item) => item.task);
    const [load1, load5] = os.loadavg();
    const slots = resourceSlots(this.config, this.active.size, availableMemoryMiB(), load1, load5);
    if (slots <= 0) return;
    for (const task of rankTasks(tasks, this.active.size)) {
      let governed;
      try { governed = await this.quota.allows(task, activeTasks); }
      catch (error) {
        this.governorBlocked(String(error.message ?? error), task.id);
        return;
      }
      if (governed.ok) {
        await this.launch(task);
        return;
      }
      this.governorBlocked(`quota live=${governed.live.toFixed(3)} candidate=${governed.candidate.toFixed(3)} allowed=${governed.quota.allowedPercentPerHour.toFixed(3)}`, task.id);
    }
  }

  async run() {
    while (!this.stopping) {
      try { await this.tick(); }
      catch (error) { this.controllerError(String(error.stack ?? error)); }
      await sleep(TICK_MS);
    }
    await Promise.allSettled([...this.active.values()].map(async ({ promise }) => promise));
  }

  async stop() {
    this.stopping = true;
    await Promise.allSettled([...this.active.values()].map(async ({ session }) => session?.abort()));
    await Promise.allSettled([...this.active.values()].map(async ({ promise }) => promise));
  }
}

function acquireLock() {
  try { fs.mkdirSync(LOCK, { mode: 0o700 }); }
  catch (error) {
    if (error.code !== "EEXIST") throw error;
    const pidFile = path.join(LOCK, "pid");
    const pid = Number(fs.existsSync(pidFile) ? fs.readFileSync(pidFile, "utf8") : 0);
    if (pid > 0 && fs.existsSync(`/proc/${pid}`)) fail(`controller already running as pid ${pid}`);
    fs.rmSync(LOCK, { recursive: true, force: true });
    fs.mkdirSync(LOCK, { mode: 0o700 });
  }
  fs.writeFileSync(path.join(LOCK, "pid"), `${process.pid}\n`);
  return () => fs.rmSync(LOCK, { recursive: true, force: true });
}

function parseOptions(args) {
  const options = {};
  for (let index = 0; index < args.length; index++) {
    const item = args[index];
    if (!item.startsWith("--")) fail(`unexpected argument ${item}`);
    const key = item.slice(2);
    const value = args[++index];
    if (value === undefined) fail(`missing value for ${item}`);
    options[key] = value;
  }
  return options;
}

function createTask(db, options) {
  for (const key of ["id", "cwd", "model", "thinking", "condition"]) if (!options[key]) fail(`task create requires --${key}`);
  const prompt = options["prompt-file"] ? fs.readFileSync(options["prompt-file"], "utf8").trim() : options.prompt;
  if (!prompt) fail("task create requires --prompt or --prompt-file");
  const cwd = path.resolve(options.cwd);
  if (!fs.statSync(cwd).isDirectory()) fail(`task cwd is not a directory: ${cwd}`);
  const maxParallel = Number(options["max-parallel"] ?? 1);
  const share = Number(options.share ?? 1);
  if (!(Number.isInteger(maxParallel) && maxParallel > 0)) fail("--max-parallel must be a positive integer");
  if (!(Number.isFinite(share) && share > 0)) fail("--share must be positive");
  const notBefore = options["not-before"] ? Date.parse(options["not-before"]) : now();
  if (!Number.isFinite(notBefore)) fail("--not-before must be an ISO timestamp");
  db.prepare(`INSERT INTO task(id,prompt,cwd,model,thinking,completion_condition,max_parallel,launch_share,not_before,next_eligible_at,created_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(options.id, prompt, cwd, options.model, options.thinking, options.condition, maxParallel, share, notBefore, notBefore, now());
  event(db, "task-created", options.condition, options.id);
  console.log(`created ${options.id}`);
}

function printTasks(db) {
  for (const row of taskRows(db)) {
    const state = row.cancelled_at ? "cancelled" : row.completed_at ? "complete" : row.not_before > now() ? `eligible ${iso(row.not_before)}` : row.next_eligible_at > now() ? `backoff ${iso(row.next_eligible_at)}` : "eligible";
    console.log(`${row.id}\t${state}\tactive=${row.active}/${row.max_parallel}\tshare=${row.launch_share}\t${row.model}:${row.thinking}`);
  }
}

function check(db) {
  const integrity = db.prepare("PRAGMA integrity_check").get().integrity_check;
  if (integrity !== "ok") fail(`database integrity: ${integrity}`);
  const config = loadConfig();
  for (const task of taskRows(db)) {
    if (!fs.existsSync(task.cwd)) fail(`task ${task.id} cwd is missing: ${task.cwd}`);
    const key = runModelKey(task);
    if (!(key in config.quota.modelCreditsPerHour)) fail(`task ${task.id} has no quota rate for ${key}`);
  }
  console.log(`ok: ${taskRows(db).length} tasks; database and configuration valid`);
}

async function main(argv = process.argv.slice(2)) {
  ensureLayout();
  const db = openDb();
  const [command, subcommand, ...rest] = argv;
  if (command === "task" && subcommand === "create") return createTask(db, parseOptions(rest));
  if (command === "task" && subcommand === "list") return printTasks(db);
  if (command === "task" && subcommand === "show") {
    const id = rest[0]; if (!id) fail("task show requires ID");
    const task = db.prepare("SELECT * FROM task WHERE id=?").get(id);
    if (!task) fail(`unknown task ${id}`);
    console.log(JSON.stringify(task, null, 2)); return;
  }
  if (command === "task" && subcommand === "set") {
    const id = rest.shift(); if (!id) fail("task set requires ID");
    const options = parseOptions(rest);
    if (!Object.keys(options).length) fail("task set requires --max-parallel and/or --share");
    if (options["max-parallel"] !== undefined) {
      const value = Number(options["max-parallel"]);
      if (!(Number.isInteger(value) && value > 0)) fail("--max-parallel must be a positive integer");
      db.prepare("UPDATE task SET max_parallel=? WHERE id=?").run(value, id);
    }
    if (options.share !== undefined) {
      const value = Number(options.share);
      if (!(Number.isFinite(value) && value > 0)) fail("--share must be positive");
      db.prepare("UPDATE task SET launch_share=? WHERE id=?").run(value, id);
    }
    event(db, "task-set", JSON.stringify(options), id); console.log(`updated ${id}`); return;
  }
  if (command === "task" && ["cancel", "reopen"].includes(subcommand)) {
    const id = rest[0]; if (!id) fail(`task ${subcommand} requires ID`);
    if (subcommand === "cancel") db.prepare("UPDATE task SET cancelled_at=? WHERE id=? AND completed_at IS NULL").run(now(), id);
    else db.prepare("UPDATE task SET cancelled_at=NULL,completed_at=NULL,next_eligible_at=?,incomplete_streak=0 WHERE id=?").run(now(), id);
    event(db, `task-${subcommand}`, "operator command", id); console.log(`${subcommand} ${id}`); return;
  }
  if (command === "status") return printTasks(db);
  if (command === "runs") {
    const id = subcommand;
    const rows = id
      ? db.prepare("SELECT * FROM run WHERE task_id=? ORDER BY started_at DESC LIMIT 50").all(id)
      : db.prepare("SELECT * FROM run ORDER BY started_at DESC LIMIT 50").all();
    for (const row of rows) console.log(`${row.id}\t${row.task_id}\t${row.status}\t${iso(row.started_at)}\t${row.summary ?? row.error ?? ""}`);
    return;
  }
  if (command === "governor") {
    const snapshot = await new QuotaGovernor(loadConfig()).refresh();
    console.log(JSON.stringify(snapshot, null, 2));
    return;
  }
  if (command === "check") return check(db);
  if (command === "run") {
    const release = acquireLock();
    const controller = new Controller(db, loadConfig());
    const stop = async () => { await controller.stop(); };
    process.once("SIGTERM", stop); process.once("SIGINT", stop);
    try { await controller.init(); await controller.run(); }
    finally { release(); }
    return;
  }
  console.log(`Usage:
  orchestrator task create --id ID --cwd DIR --model PROVIDER/MODEL --thinking LEVEL --condition TEXT [--max-parallel N] [--share N] [--not-before ISO] (--prompt TEXT | --prompt-file FILE)
  orchestrator task list
  orchestrator task show ID
  orchestrator task set ID [--max-parallel N] [--share N]
  orchestrator task cancel ID
  orchestrator task reopen ID
  orchestrator status
  orchestrator runs [TASK_ID]
  orchestrator governor
  orchestrator check
  orchestrator run`);
  if (command) process.exitCode = 2;
}

const invokedPath = process.argv[1] && fs.existsSync(process.argv[1]) ? fs.realpathSync(process.argv[1]) : null;
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(error.stack ?? error); process.exitCode = 1; });
}

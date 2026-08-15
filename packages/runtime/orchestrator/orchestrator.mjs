#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import { execFile } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
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
const CHATGPT_PRO_POOL_PATH = path.join(getAgentDir(), "chatgpt-pro-pool.json");
const CHATGPT_PRO_PROVIDER = "chatgpt-pro";
const TICK_MS = 1000;
const execFileAsync = promisify(execFile);

const DEFAULT_CONFIG = {
  maxMemoryPercent: 90,
  maxCpuPercent: 90,
  estimatedSessionMiB: 80,
  plan: {
    pollSeconds: 120,
    modelBurnPercentPerHour: {
      "openai-codex/gpt-5.6-sol:xhigh": 0.5824404761904762,
      "openai-codex/gpt-5.6-luna:max": 0.02507936507936508
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
  if (!(Number.isInteger(config.estimatedSessionMiB) && config.estimatedSessionMiB > 0)) fail("invalid config.estimatedSessionMiB");
  for (const key of ["maxMemoryPercent", "maxCpuPercent"]) {
    if (!(Number.isFinite(config[key]) && config[key] > 0 && config[key] <= 100)) fail(`invalid config.${key}`);
  }
  if (!(Number.isFinite(config.plan?.pollSeconds) && config.plan.pollSeconds > 0)) fail("invalid config.plan.pollSeconds");
  if (!config.plan.modelBurnPercentPerHour || typeof config.plan.modelBurnPercentPerHour !== "object") fail("missing config.plan.modelBurnPercentPerHour");
  return config;
}

const SQLITE_NOW_MS = "CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)";

function ensureTableTimestamps(db, table) {
  const quote = (value) => `"${value.replaceAll('"', '""')}"`;
  const columns = db.prepare(`PRAGMA table_info(${quote(table)})`).all().map((row) => row.name);
  if (!columns.includes("created_at")) {
    db.exec(`ALTER TABLE ${quote(table)} ADD COLUMN created_at INTEGER`);
    columns.push("created_at");
  }
  if (!columns.includes("updated_at")) {
    db.exec(`ALTER TABLE ${quote(table)} ADD COLUMN updated_at INTEGER`);
    columns.push("updated_at");
  }
  const first = (candidates) => candidates.find((name) => columns.includes(name));
  const createdSource = first(["started_at", "at"]) ?? null;
  const updatedSource = first(["finished_at", "completed_at", "cancelled_at", "started_at", "at"]) ?? null;
  db.exec(`UPDATE ${quote(table)} SET created_at=coalesce(created_at,${createdSource ? quote(createdSource) : SQLITE_NOW_MS},${SQLITE_NOW_MS}) WHERE created_at IS NULL`);
  db.exec(`UPDATE ${quote(table)} SET updated_at=coalesce(updated_at,${updatedSource ? quote(updatedSource) : "created_at"},created_at,${SQLITE_NOW_MS}) WHERE updated_at IS NULL`);
  const domainColumns = columns.filter((name) => !["created_at", "updated_at"].includes(name));
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS ${quote(`auto_timestamp_${table}_insert`)}
    AFTER INSERT ON ${quote(table)}
    WHEN NEW.created_at IS NULL OR NEW.updated_at IS NULL
    BEGIN
      UPDATE ${quote(table)} SET
        created_at=coalesce(NEW.created_at,${SQLITE_NOW_MS}),
        updated_at=coalesce(NEW.updated_at,NEW.created_at,${SQLITE_NOW_MS})
      WHERE rowid=NEW.rowid;
    END;
    CREATE TRIGGER IF NOT EXISTS ${quote(`auto_timestamp_${table}_update`)}
    AFTER UPDATE OF ${domainColumns.map(quote).join(",")} ON ${quote(table)}
    BEGIN
      UPDATE ${quote(table)} SET updated_at=${SQLITE_NOW_MS} WHERE rowid=NEW.rowid;
    END;
  `);
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
      completion_check TEXT,
      launch_share REAL NOT NULL CHECK(launch_share > 0),
      not_before INTEGER NOT NULL,
      next_eligible_at INTEGER NOT NULL,
      incomplete_streak INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      completed_at INTEGER,
      cancelled_at INTEGER,
      updated_at INTEGER NOT NULL DEFAULT (CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER))
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
      error TEXT,
      productive INTEGER CHECK(productive IN (0,1)),
      created_at INTEGER NOT NULL DEFAULT (CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)),
      updated_at INTEGER NOT NULL DEFAULT (CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER))
    );
    CREATE INDEX IF NOT EXISTS run_task_status ON run(task_id,status);
    CREATE TABLE IF NOT EXISTS event (
      id INTEGER PRIMARY KEY,
      at INTEGER NOT NULL,
      kind TEXT NOT NULL,
      task_id TEXT,
      run_id TEXT,
      detail TEXT NOT NULL,
      created_at INTEGER NOT NULL DEFAULT (CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)),
      updated_at INTEGER NOT NULL DEFAULT (CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER))
    );
  `);
  let taskColumns = new Set(db.prepare("PRAGMA table_info(task)").all().map((row) => row.name));
  if (taskColumns.has("max_parallel")) {
    db.exec("DROP TRIGGER IF EXISTS auto_timestamp_task_insert; DROP TRIGGER IF EXISTS auto_timestamp_task_update; ALTER TABLE task DROP COLUMN max_parallel;");
    taskColumns = new Set(db.prepare("PRAGMA table_info(task)").all().map((row) => row.name));
  }
  if (!taskColumns.has("completion_check")) {
    db.exec("DROP TRIGGER IF EXISTS auto_timestamp_task_insert; DROP TRIGGER IF EXISTS auto_timestamp_task_update; ALTER TABLE task ADD COLUMN completion_check TEXT");
  }
  const runColumns = new Set(db.prepare("PRAGMA table_info(run)").all().map((row) => row.name));
  if (!runColumns.has("provider")) {
    db.exec("DROP TRIGGER IF EXISTS auto_timestamp_run_insert; DROP TRIGGER IF EXISTS auto_timestamp_run_update; ALTER TABLE run ADD COLUMN provider TEXT");
  }
  if (!runColumns.has("productive")) {
    db.exec("DROP TRIGGER IF EXISTS auto_timestamp_run_insert; DROP TRIGGER IF EXISTS auto_timestamp_run_update; ALTER TABLE run ADD COLUMN productive INTEGER CHECK(productive IN (0,1))");
  }
  for (const table of ["task", "run", "event"]) ensureTableTimestamps(db, table);
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
    task.not_before <= now() && task.next_eligible_at <= now());
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

export function resourceSlots(config, activeCount, memAvailableMiB, memTotalMiB, cpuPercent, agentMemoryMiB = 0) {
  if (cpuPercent >= config.maxCpuPercent) return 0;
  const usedMiB = memTotalMiB - memAvailableMiB;
  const nonAgentUsedMiB = Math.max(0, usedMiB - agentMemoryMiB);
  const committedAgentMiB = Math.max(agentMemoryMiB, activeCount * config.estimatedSessionMiB);
  const memoryHeadroomMiB = memTotalMiB * config.maxMemoryPercent / 100 - nonAgentUsedMiB - committedAgentMiB;
  return Math.max(0, Math.floor(memoryHeadroomMiB / config.estimatedSessionMiB));
}

function memoryMiB() {
  try {
    const values = Object.fromEntries(fs.readFileSync("/proc/meminfo", "utf8").split("\n").flatMap((line) => {
      const match = line.match(/^(MemTotal|MemAvailable):\s+(\d+)/);
      return match ? [[match[1], Number(match[2]) / 1024]] : [];
    }));
    if (values.MemTotal && values.MemAvailable) return { total: values.MemTotal, available: values.MemAvailable };
  } catch {}
  return { total: os.totalmem() / 1048576, available: os.freemem() / 1048576 };
}

function agentMemoryMiB() {
  try { return Number(fs.readFileSync("/sys/fs/cgroup/system.slice/agent-orchestrator.service/memory.current", "utf8")) / 1048576; }
  catch { return 0; }
}

function cpuTotals() {
  const fields = fs.readFileSync("/proc/stat", "utf8").split("\n", 1)[0].trim().split(/\s+/).slice(1).map(Number);
  return { idle: (fields[3] ?? 0) + (fields[4] ?? 0), total: fields.reduce((sum, value) => sum + value, 0) };
}

export function cpuPercent(before, after) {
  const total = after.total - before.total;
  const idle = after.idle - before.idle;
  return total > 0 ? Math.max(0, Math.min(100, (total - idle) * 100 / total)) : 0;
}

function runModelKey(task) { return `${task.model}:${task.thinking}`; }
function providerOf(model) { return String(model).split("/", 1)[0]; }
function modelIdOf(model) { return String(model).slice(String(model).indexOf("/") + 1); }
export function validateModelPolicy(model) {
  if (/^gpt-5-5(?:-|$)/.test(modelIdOf(model))) fail("GPT-5.5 models are banned; use GPT-5.6");
}
function isChatGptProTask(task) { return providerOf(task.model) === CHATGPT_PRO_PROVIDER; }

export function proEntitlementSnapshot(at = now(), auth = null, state = null) {
  const credentials = auth ?? JSON.parse(fs.readFileSync(AUTH_PATH, "utf8"));
  let pool = state;
  if (pool === null) {
    try { pool = JSON.parse(fs.readFileSync(CHATGPT_PRO_POOL_PATH, "utf8")); }
    catch { pool = {}; }
  }
  const accounts = Object.entries(credentials).filter(([name, value]) =>
    (name === "openai-codex" || name.startsWith("openai-codex-")) && (value?.access || value?.refresh));
  const eligible = accounts.filter(([name]) =>
    Number(pool?.cooldowns?.[name] ?? 0) <= at && Number(pool?.proQuotaExhaustedUntil?.[name] ?? 0) <= at);
  const inFlight = eligible.filter(([name]) => Number(pool?.inFlight?.[name] ?? 0) > at).length;
  return { configured: accounts.length, eligible: eligible.length, inFlight };
}

export function proLaunchAvailability(entitlement, active) {
  return Math.max(0, entitlement.eligible - Math.max(active, entitlement.inFlight));
}

export function choosePlanProvider(accounts, activeRates, candidate) {
  const liveByProvider = new Map();
  for (const assignment of activeRates) {
    liveByProvider.set(
      assignment.provider,
      (liveByProvider.get(assignment.provider) ?? 0) + assignment.rate,
    );
  }
  return accounts
    .map((account) => {
      const live = liveByProvider.get(account.provider) ?? 0;
      return {
        provider: account.provider,
        live,
        allowed: account.allowedBurnPercentPerHour,
        remaining: account.allowedBurnPercentPerHour - live - candidate,
      };
    })
    .filter((account) => account.remaining >= 0)
    .sort((left, right) => right.remaining - left.remaining || left.provider.localeCompare(right.provider))[0] ?? null;
}

export function planWindowBurnPerHour(window, at = now()) {
  const used = Number(window?.used_percent);
  const resetAt = Number(window?.reset_at) * 1000;
  if (!Number.isFinite(used) || !Number.isFinite(resetAt)) return null;
  const hours = Math.max(0, resetAt - at) / 3600000;
  if (hours <= 0) return 0;
  return Math.max(0, 100 - used) / hours;
}

export class PlanGovernor {
  constructor(config) { this.config = config; this.snapshot = null; this.refreshing = null; }

  async refresh() {
    if (this.snapshot && now() - this.snapshot.at < this.config.plan.pollSeconds * 1000) return this.snapshot;
    if (this.refreshing) return this.refreshing;
    this.refreshing = this.fetch().finally(() => { this.refreshing = null; });
    return this.refreshing;
  }

  async fetch() {
    const auth = JSON.parse(fs.readFileSync(AUTH_PATH, "utf8"));
    const configured = Object.entries(auth).filter(([name, value]) =>
      (name === "openai-codex" || name.startsWith("openai-codex-")) && value?.access);
    if (!configured.length) fail("plan governor found no Codex OAuth accounts");
    const endpoint = `${(process.env.CHATGPT_BASE_URL ?? "https://chatgpt.com/backend-api").replace(/\/$/, "")}/wham/usage`;
    const results = await Promise.all(configured.map(async ([provider, credential]) => {
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
        const windows = [rate.primary_window, rate.secondary_window]
          .map((window) => planWindowBurnPerHour(window))
          .filter((value) => value !== null);
        if (!windows.length) return null;
        return { provider, allowedBurnPercentPerHour: Math.min(...windows) };
      } catch { return null; }
    }));
    const accounts = results.filter((value) => value !== null);
    if (!accounts.length) fail("plan governor could not read any Codex account");
    this.snapshot = {
      at: now(),
      healthy: accounts.length,
      configured: configured.length,
      allowedBurnPercentPerHour: accounts.reduce((sum, account) => sum + account.allowedBurnPercentPerHour, 0),
      accounts,
    };
    return this.snapshot;
  }

  modelRate(task) {
    const rate = this.config.plan.modelBurnPercentPerHour[runModelKey(task)];
    if (!(Number.isFinite(rate) && rate >= 0)) fail(`no plan burn rate configured for ${runModelKey(task)}`);
    return rate;
  }

  async allows(task, activeAssignments) {
    if (isChatGptProTask(task)) {
      const entitlement = proEntitlementSnapshot();
      const active = activeAssignments.filter((item) => isChatGptProTask(item.task)).length;
      const reserved = Math.max(active, entitlement.inFlight);
      const available = proLaunchAvailability(entitlement, active);
      return {
        ok: available > 0,
        provider: available > 0 ? CHATGPT_PRO_PROVIDER : null,
        detail: `ChatGPT Pro eligible=${entitlement.eligible} reserved=${reserved} available=${available}`,
      };
    }
    const plan = await this.refresh();
    const candidate = this.modelRate(task);
    const codexAssignments = activeAssignments
      .filter((item) => !isChatGptProTask(item.task))
      .map((item) => ({ provider: item.provider, rate: this.modelRate(item.task) }));
    const selected = choosePlanProvider(plan.accounts, codexAssignments, candidate);
    const live = codexAssignments.reduce((sum, item) => sum + item.rate, 0);
    return {
      ok: selected !== null,
      provider: selected?.provider ?? null,
      detail: selected
        ? `Codex account=${selected.provider} live=${selected.live.toFixed(3)} candidate=${candidate.toFixed(3)} allowed=${selected.allowed.toFixed(3)}`
        : `Codex accounts full: fleet live=${live.toFixed(3)} candidate=${candidate.toFixed(3)} pool allowed=${plan.allowedBurnPercentPerHour.toFixed(3)}`,
    };
  }
}

function randomId() { return crypto.randomUUID(); }
function backoffMs(streak) { return Math.min(30 * 60_000, 30_000 * (2 ** Math.min(6, Math.max(0, streak - 1)))); }
export function nextIncompleteState(streak, failed) {
  if (!failed) return { streak: 0, delayMs: 0 };
  const nextStreak = Number(streak) + 1;
  return { streak: nextStreak, delayMs: backoffMs(nextStreak) };
}
export function completionToolResult(text, details) {
  return { content: [{ type: "text", text }], details, terminate: true };
}
export async function validateCompletion(task, runner = execFileAsync) {
  if (!task.completion_check) return { ok: true, detail: "no completion check configured" };
  try {
    const result = await runner("bash", ["-lc", task.completion_check], {
      cwd: task.cwd,
      timeout: 120_000,
      maxBuffer: 1024 * 1024,
    });
    return { ok: true, detail: String(result.stdout ?? "").trim() || "completion check passed" };
  } catch (error) {
    const output = [error?.stdout, error?.stderr].map((value) => String(value ?? "").trim()).filter(Boolean).join("\n");
    return { ok: false, detail: output || String(error?.message ?? error) };
  }
}
export async function stopSession(session) {
  if (!session) return;
  session.clearQueue();
  await session.abort();
}
export function shouldAdvanceBackoff(nextEligibleAt, runStartedAt) { return Number(nextEligibleAt) <= Number(runStartedAt); }

export function insertRun(db, runId, taskId, provider = null, startedAt = now()) {
  db.prepare("INSERT INTO run(id,task_id,status,started_at,provider) VALUES(?,?,?,?,?)")
    .run(runId, taskId, "running", startedAt, provider);
}

class Controller {
  constructor(db, config) {
    this.db = db;
    this.config = config;
    this.modelRuntime = null;
    this.plan = new PlanGovernor(config);
    this.active = new Map();
    this.stopping = false;
    this.lastGovernorEvents = new Map();
    this.lastControllerError = { at: 0, detail: "" };
    this.previousCpu = cpuTotals();
  }

  recover() {
    const interrupted = this.db.prepare("SELECT id,task_id FROM run WHERE status='running'").all();
    const finish = this.db.prepare("UPDATE run SET status='interrupted',finished_at=?,error=?,productive=0 WHERE id=?");
    for (const row of interrupted) {
      finish.run(now(), "controller restarted while run was active", row.id);
      event(this.db, "run-interrupted", "controller restart", row.task_id, row.id);
    }
  }

  async init() {
    this.recover();
    for (const task of taskRows(this.db)) validateModelPolicy(task.model);
    this.modelRuntime = await ModelRuntime.create({ signal: AbortSignal.timeout(15000) });
  }

  async launch(task, provider) {
    const runId = randomId();
    insertRun(this.db, runId, task.id, provider);
    event(this.db, "run-started", `${runModelKey(task)} via ${provider}`, task.id, runId);
    const promise = this.execute(task, runId, provider).finally(() => this.active.delete(runId));
    this.active.set(runId, { task, provider, promise });
  }

  async execute(task, runId, provider) {
    let session;
    let report = null;
    let sessionId = null;
    try {
      const bootstrap = isChatGptProTask(task) ? `openai-codex/gpt-5.6-sol:${task.thinking}` : `${task.model}:${task.thinking}`;
      const resolved = resolveCliModel({ cliModel: bootstrap, modelRuntime: this.modelRuntime });
      if (resolved.error || !resolved.model) fail(resolved.error ?? `cannot resolve bootstrap for ${runModelKey(task)}`);
      const completionTool = defineTool({
        name: "task_complete",
        label: "Complete task launch",
        description: "Report this launch's validated output. Set complete=true only when the task completion condition is now satisfied. Set productive=false only when no claimable work unit existed; idle reports receive bounded backoff instead of immediately launching another agent.",
        parameters: Type.Object({
          complete: Type.Boolean(),
          productive: Type.Optional(Type.Boolean({ description: "Whether this launch claimed and processed a real work unit. Defaults to true." })),
          summary: Type.String({ minLength: 1 }),
          artifacts: Type.Optional(Type.Array(Type.String()))
        }),
        execute: async (_id, parameters) => {
          if (report) return completionToolResult("This launch has already reported completion.", {});
          const validation = parameters.complete ? await validateCompletion(task) : null;
          const complete = parameters.complete && validation.ok;
          const summary = parameters.complete && !validation.ok
            ? `${parameters.summary}\nCompletion validation failed: ${validation.detail}`
            : parameters.summary;
          report = {
            complete,
            productive: parameters.productive ?? true,
            summary,
            artifacts: parameters.artifacts ?? [],
            validation,
          };
          const text = complete
            ? "Task completion recorded after the configured machine check passed."
            : parameters.complete
              ? `Task completion rejected by the configured machine check: ${validation.detail}`
              : "Launch output recorded; the task remains eligible.";
          return completionToolResult(text, report);
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
      const targetProvider = isChatGptProTask(task) ? providerOf(task.model) : provider;
      const targetModelId = isChatGptProTask(task) ? modelIdOf(task.model) : resolved.model.id;
      if (targetProvider !== resolved.model.provider || targetModelId !== resolved.model.id) {
        const routed = (await this.modelRuntime.getAvailable()).find((model) => model.provider === targetProvider && model.id === targetModelId);
        if (!routed) fail(`governor-selected model unavailable after extension load: ${targetProvider}/${targetModelId}`);
        await session.setModel(routed);
        session.setThinkingLevel(task.thinking);
      }
      this.active.get(runId).session = session;
      sessionId = session.sessionId;
      this.db.prepare("UPDATE run SET session_id=? WHERE id=?").run(sessionId, runId);
      const prompt = isChatGptProTask(task)
        ? task.prompt
        : `${task.prompt}\n\n## Orchestrated task contract\nTask: ${task.id}\nCompletion condition: ${task.completion_condition}\nThis task may run repeatedly or concurrently. Make external effects idempotent where possible. Before finishing, call task_complete exactly once with the validated result. Set complete=true only if the completion condition is satisfied. Set productive=false only if no claimable work unit existed; otherwise omit it or set productive=true.`;
      await session.prompt(prompt);
      const assistant = [...session.messages].reverse().find((message) => message.role === "assistant");
      if (!report && isChatGptProTask(task)) {
        const text = assistant?.content?.filter((part) => part.type === "text").map((part) => part.text).join("\n").trim();
        if (text) report = { complete: false, summary: text, artifacts: [], validation: null };
      }
      if (!report && assistant?.errorMessage) fail(`provider turn failed: ${assistant.errorMessage}`);
      if (!report) fail(isChatGptProTask(task) ? "ChatGPT Pro returned no verified text" : "agent ended without task_complete");
      this.finish(
        task, runId, report.complete ? "complete" : "incomplete",
        report.summary, report.artifacts, null, report.productive,
      );
    } catch (error) {
      this.finish(
        task, runId, "incomplete", report?.summary ?? null,
        report?.artifacts ?? [], String(error?.message ?? error), false,
      );
    } finally {
      session?.dispose();
    }
  }

  finish(task, runId, status, summary, artifacts, error, productive = true) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("UPDATE run SET status=?,finished_at=?,summary=?,artifacts_json=?,error=?,productive=? WHERE id=?")
        .run(status, now(), summary, JSON.stringify(artifacts), error, productive ? 1 : 0, runId);
      if (status === "complete") {
        this.db.prepare("UPDATE task SET completed_at=?,incomplete_streak=0 WHERE id=? AND completed_at IS NULL").run(now(), task.id);
      } else {
        const row = this.db.prepare(`
          SELECT t.incomplete_streak,t.next_eligible_at,r.started_at
          FROM task t JOIN run r ON r.task_id=t.id
          WHERE t.id=? AND r.id=?`).get(task.id, runId);
        // Real persistent work restores eligibility unless an idle/error sibling
        // from the same concurrent launch wave has already established a later
        // pause. A no-unit launch uses bounded backoff without being mislabeled
        // as an execution error. Only the first terminal result that began after
        // the previous eligibility time may update the shared schedule.
        const idleOrFailed = error !== null || productive === false;
        if (shouldAdvanceBackoff(row.next_eligible_at, row.started_at)) {
          const next = nextIncompleteState(row.incomplete_streak, idleOrFailed);
          this.db.prepare("UPDATE task SET incomplete_streak=?,next_eligible_at=? WHERE id=?")
            .run(next.streak, now() + next.delayMs, task.id);
        }
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
    const previous = this.lastGovernorEvents.get(taskId) ?? { at: 0, detail: "" };
    if (detail !== previous.detail || now() - previous.at >= 60_000) {
      const at = now();
      event(this.db, "governor-blocked", detail, taskId);
      this.lastGovernorEvents.set(taskId, { at, detail });
    }
  }

  async tick() {
    const tasks = taskRows(this.db);
    const activeAssignments = [...this.active.values()].map(({ task, provider }) => ({ task, provider }));
    const currentCpu = cpuTotals();
    const currentCpuPercent = cpuPercent(this.previousCpu, currentCpu);
    this.previousCpu = currentCpu;
    const memory = memoryMiB();
    const slots = resourceSlots(this.config, this.active.size, memory.available, memory.total, currentCpuPercent, agentMemoryMiB());
    for (let launchIndex = 0; launchIndex < slots; launchIndex++) {
      let launched = false;
      for (const task of rankTasks(tasks, this.active.size)) {
        let governed;
        try { governed = await this.plan.allows(task, activeAssignments); }
        catch (error) {
          this.governorBlocked(String(error.message ?? error), task.id);
          return;
        }
        if (!governed.ok) {
          this.governorBlocked(governed.detail, task.id);
          continue;
        }
        await this.launch(task, governed.provider);
        task.active = Number(task.active) + 1;
        activeAssignments.push({ task, provider: governed.provider });
        launched = true;
        break;
      }
      if (!launched) return;
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
    await Promise.allSettled([...this.active.values()].map(async ({ session }) => stopSession(session)));
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
  const unknown = Object.keys(options).filter((key) => !["id", "cwd", "model", "thinking", "condition", "completion-check", "share", "not-before", "prompt", "prompt-file"].includes(key));
  if (unknown.length) fail(`task create does not support ${unknown.map((key) => `--${key}`).join(", ")}`);
  for (const key of ["id", "cwd", "model", "thinking", "condition"]) if (!options[key]) fail(`task create requires --${key}`);
  validateModelPolicy(options.model);
  const prompt = options["prompt-file"] ? fs.readFileSync(options["prompt-file"], "utf8").trim() : options.prompt;
  const completionCheck = options["completion-check"]?.trim() || null;
  if (!prompt) fail("task create requires --prompt or --prompt-file");
  const cwd = path.resolve(options.cwd);
  if (!fs.statSync(cwd).isDirectory()) fail(`task cwd is not a directory: ${cwd}`);
  const share = Number(options.share ?? 1);
  if (!(Number.isFinite(share) && share > 0)) fail("--share must be positive");
  const notBefore = options["not-before"] ? Date.parse(options["not-before"]) : now();
  if (!Number.isFinite(notBefore)) fail("--not-before must be an ISO timestamp");
  db.prepare(`INSERT INTO task(id,prompt,cwd,model,thinking,completion_condition,completion_check,launch_share,not_before,next_eligible_at,created_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(options.id, prompt, cwd, options.model, options.thinking, options.condition, completionCheck, share, notBefore, notBefore, now());
  event(db, "task-created", options.condition, options.id);
  console.log(`created ${options.id}`);
}

export function setTaskOptions(db, id, options) {
  if (!db.prepare("SELECT 1 FROM task WHERE id=?").get(id)) fail(`unknown task ${id}`);
  if (!Object.keys(options).length) fail("task set requires --model, --thinking, --share, --prompt-file, --condition, and/or --completion-check");
  const unknown = Object.keys(options).filter((key) => !["model", "thinking", "share", "prompt-file", "condition", "completion-check"].includes(key));
  if (unknown.length) fail(`task set does not support ${unknown.map((key) => `--${key}`).join(", ")}`);
  if (options.model !== undefined) {
    const model = options.model.trim();
    if (!model) fail("--model must be nonempty");
    validateModelPolicy(model);
    db.prepare("UPDATE task SET model=? WHERE id=?").run(model, id);
  }
  if (options.thinking !== undefined) {
    const thinking = options.thinking.trim();
    if (!thinking) fail("--thinking must be nonempty");
    db.prepare("UPDATE task SET thinking=? WHERE id=?").run(thinking, id);
  }
  if (options.share !== undefined) {
    const value = Number(options.share);
    if (!(Number.isFinite(value) && value > 0)) fail("--share must be positive");
    db.prepare("UPDATE task SET launch_share=? WHERE id=?").run(value, id);
  }
  if (options["prompt-file"] !== undefined) {
    const prompt = fs.readFileSync(options["prompt-file"], "utf8").trim();
    if (!prompt) fail("--prompt-file must contain a nonempty prompt");
    db.prepare("UPDATE task SET prompt=? WHERE id=?").run(prompt, id);
  }
  if (options.condition !== undefined) {
    const condition = options.condition.trim();
    if (!condition) fail("--condition must be nonempty");
    db.prepare("UPDATE task SET completion_condition=? WHERE id=?").run(condition, id);
  }
  if (options["completion-check"] !== undefined) {
    const check = options["completion-check"].trim();
    if (!check) fail("--completion-check must be nonempty");
    db.prepare("UPDATE task SET completion_check=? WHERE id=?").run(check, id);
  }
  event(db, "task-set", JSON.stringify(options), id);
}

export function cancelTask(db, id, at = now()) {
  db.prepare("UPDATE task SET cancelled_at=?,completed_at=NULL WHERE id=?").run(at, id);
}

function printTasks(db) {
  for (const row of taskRows(db)) {
    const state = row.cancelled_at ? "cancelled" : row.completed_at ? "complete" : row.not_before > now() ? `eligible ${iso(row.not_before)}` : row.next_eligible_at > now() ? `backoff ${iso(row.next_eligible_at)}` : "eligible";
    console.log(`${row.id}\t${state}\tactive=${row.active}\tshare=${row.launch_share}\t${row.model}:${row.thinking}`);
  }
}

function check(db) {
  const integrity = db.prepare("PRAGMA integrity_check").get().integrity_check;
  if (integrity !== "ok") fail(`database integrity: ${integrity}`);
  const config = loadConfig();
  for (const task of taskRows(db)) {
    validateModelPolicy(task.model);
    if (!fs.existsSync(task.cwd)) fail(`task ${task.id} cwd is missing: ${task.cwd}`);
    const key = runModelKey(task);
    if (!isChatGptProTask(task) && !(key in config.plan.modelBurnPercentPerHour)) fail(`task ${task.id} has no plan burn rate for ${key}`);
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
    setTaskOptions(db, id, parseOptions(rest));
    console.log(`updated ${id}`); return;
  }
  if (command === "task" && ["cancel", "reopen"].includes(subcommand)) {
    const id = rest[0]; if (!id) fail(`task ${subcommand} requires ID`);
    if (subcommand === "cancel") cancelTask(db, id);
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
    const config = loadConfig();
    const memory = memoryMiB();
    const before = cpuTotals();
    await sleep(250);
    const utilization = cpuPercent(before, cpuTotals());
    const active = Number(db.prepare("SELECT count(*) count FROM run WHERE status='running'").get().count);
    const resources = {
      active,
      slots: resourceSlots(config, active, memory.available, memory.total, utilization, agentMemoryMiB()),
      cpuPercent: Number(utilization.toFixed(1)),
      maxCpuPercent: config.maxCpuPercent,
      memoryPercent: Number(((memory.total - memory.available) * 100 / memory.total).toFixed(1)),
      maxMemoryPercent: config.maxMemoryPercent,
    };
    const snapshot = await new PlanGovernor(config).refresh();
    const plan = {
      at: snapshot.at,
      healthyAccounts: snapshot.healthy,
      configuredAccounts: snapshot.configured,
      allowedBurnPercentPerHour: snapshot.allowedBurnPercentPerHour,
    };
    const pro = proEntitlementSnapshot();
    console.log(JSON.stringify({ resources, plan, chatgptPro: pro }, null, 2));
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
  orchestrator task create --id ID --cwd DIR --model PROVIDER/MODEL --thinking LEVEL --condition TEXT [--completion-check COMMAND] [--share N] [--not-before ISO] (--prompt TEXT | --prompt-file FILE)
  orchestrator task list
  orchestrator task show ID
  orchestrator task set ID [--model PROVIDER/MODEL] [--thinking LEVEL] [--share N] [--prompt-file FILE] [--condition TEXT] [--completion-check COMMAND]
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

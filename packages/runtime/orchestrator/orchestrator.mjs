#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
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
  readStoredCredential,
  resolveCliModel,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { createUsageLogger } from "../extensions/pi-usage-logger/logger.mjs";
import {
  browserPoolCapacitySnapshot,
  completeInKernelBrowser,
  orphanedConversationsFromAudits,
  PRO_MAX_PARALLEL,
  recoverPendingProConversations,
} from "../extensions/chatgpt-pro/browser.mjs";

const HOME = os.homedir();
const DATA = process.env.AGENT_ORCHESTRATOR_DATA ?? path.join(HOME, "data/agent-orchestrator");
const DB_PATH = path.join(DATA, "orchestrator.sqlite3");
const CONFIG_PATH = path.join(DATA, "config.json");
const SESSIONS = path.join(DATA, "sessions");
const LOCK = path.join(DATA, "controller.lock");
const SCRIPT_PATH = fileURLToPath(import.meta.url);
const PROVIDER_MANIFEST_PATH = process.env.AGENT_ORCHESTRATOR_PROVIDER_MANIFEST ?? path.join(path.dirname(SCRIPT_PATH), "providers.json");
const AUTH_PATH = path.join(getAgentDir(), "auth.json");
const MULTI_PASS_PATH = path.join(getAgentDir(), "multi-pass.json");
const CHATGPT_PRO_POOL_PATH = path.join(getAgentDir(), "chatgpt-pro-pool.json");
const CHATGPT_PRO_PROVIDER = "chatgpt-pro";
const CODEX_PROVIDER = "openai-codex";
const ANTHROPIC_PROVIDER = "anthropic";
const CURSOR_PROVIDER = "cursor";
const CURSOR_USAGE_ENDPOINT = "https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage";
const ANTHROPIC_USAGE_ENDPOINT = "https://api.anthropic.com/api/oauth/usage";
const ANTHROPIC_PROFILE_ENDPOINT = "https://api.anthropic.com/api/oauth/profile";
const ANTHROPIC_CLIENT_USER_AGENT = "claude-code/2.1.80";
const ANTHROPIC_USAGE_CACHE_PATH = path.join(DATA, "anthropic-plan-usage.json");
const CURSOR_USAGE_CACHE_PATH = path.join(DATA, "cursor-plan-usage.json");
const CODEX_GOVERNOR_STATE_PATH = path.join(DATA, "codex-distributed-governor.json");
const ANTHROPIC_GOVERNOR_STATE_PATH = path.join(DATA, "anthropic-distributed-governor.json");
const CURSOR_GOVERNOR_STATE_PATH = path.join(DATA, "cursor-distributed-governor.json");
const BOOSTED_ALLOWANCE_MULTIPLIER = 5;
export const TOOL_SHELL = fileURLToPath(new URL("./tool-shell", import.meta.url));
const TICK_MS = 5000;
const DISTRIBUTED_ALLOCATION_VERSION = 1;
const DISTRIBUTED_CALIBRATION_VERSION = 1;
const DISTRIBUTED_METER_IDENTITY_VERSION = 3;
const execFileAsync = promisify(execFile);

// Per-account feedback and causal attribution are invalid if Multi-Pass rotates
// a governor-pinned run after admission, so the controller owns this invariant
// even on hosts whose systemd unit does not duplicate the environment setting.
process.env.PI_MULTI_PASS_LOCK_ASSIGNED_PROVIDER = "1";

export function loadProviderManifest(file = PROVIDER_MANIFEST_PATH) {
  const manifest = JSON.parse(fs.readFileSync(file, "utf8"));
  if (manifest?.version !== 1 || !Array.isArray(manifest.providers) || !Array.isArray(manifest.models) ||
      !Array.isArray(manifest.mixes) || !Array.isArray(manifest.plans) || !Array.isArray(manifest.agentOrder)) {
    fail("invalid provider manifest structure");
  }
  const providers = new Set();
  for (const provider of manifest.providers) {
    if (typeof provider?.id !== "string" || !provider.id || providers.has(provider.id) ||
        typeof provider.prefix !== "string" || !provider.prefix || typeof provider.governor !== "string") {
      fail("invalid provider manifest provider");
    }
    providers.add(provider.id);
  }
  const models = new Map();
  for (const model of manifest.models) {
    if (typeof model?.id !== "string" || !model.id || models.has(model.id) || !providers.has(model.provider) ||
        typeof model.model !== "string" || !model.model.includes("/") || typeof model.thinking !== "string" ||
        typeof model.label !== "string" || !Array.isArray(model.aliases)) fail("invalid provider manifest model");
    models.set(model.id, model);
  }
  for (const mix of manifest.mixes) {
    if (!models.has(mix?.base) || !Array.isArray(mix.alternatives) || mix.alternatives.length === 0 ||
        mix.alternatives.some((id) => !models.has(id)) || mix.strategy !== "independent-capacity") {
      fail("invalid provider manifest mix");
    }
  }
  const planIds = new Set();
  for (const plan of manifest.plans) {
    if (typeof plan?.id !== "string" || planIds.has(plan.id) || typeof plan.label !== "string" ||
        typeof plan.icon !== "string" || !Array.isArray(plan.metrics) || plan.metrics.length === 0 ||
        plan.metrics.some((metric) => typeof metric?.id !== "string" || typeof metric.field !== "string" ||
          (metric.paceField !== undefined && typeof metric.paceField !== "string"))) {
      fail("invalid provider manifest plan");
    }
    planIds.add(plan.id);
  }
  return manifest;
}

function manifestModelMixes(manifest) {
  const models = new Map(manifest.models.map((model) => [model.id, model]));
  return Object.fromEntries(manifest.mixes.map((mix) => {
    const base = models.get(mix.base);
    return [`${base.model}:${base.thinking}`, {
      alternatives: mix.alternatives.map((id) => {
        const model = models.get(id);
        return { model: model.model, thinking: model.thinking };
      }),
      strategy: mix.strategy,
    }];
  }));
}

const PROVIDER_MANIFEST = loadProviderManifest();

const DEFAULT_CONFIG = {
  maxMemoryPercent: 90,
  maxCpuPercent: 90,
  estimatedSessionMiB: 80,
  plan: {
    pollSeconds: 120,
    modelBurnPercentPerHour: {
      "openai-codex/gpt-5.6-sol:xhigh": 0.5824404761904762,
      "openai-codex/gpt-5.6-luna:max": 0.02507936507936508
    },
    distributed: {
      targetPercent: 100,
      slopeWindowHours: 2,
      safetyDelayHours: 0.5,
      initialShare: 0.08,
      minimumShare: 0.001,
      blindDecay: 0.94,
      controlGain: 0.18,
      additiveRamp: 0.01,
      minimumRatio: 0.25,
      maximumRatio: 2,
      rateFloor: 0.01,
      consistencyLimitPercent: 2,
      routingExcitation: 0.35,
      routingBlockMinutes: 5,
      calibrationMinSamples: 2000,
      calibrationMinHours: 120,
      leaseHours: 2,
      restartLeaseMinutes: 10
    },
    anthropic: {
      pollSeconds: 300,
      maxStaleSeconds: 3600,
      predictedPercentPerActiveHour: 0.25
    },
    cursor: {
      pollSeconds: 300,
      maxStaleSeconds: 3600,
      reservePercent: 2,
      predictedPercentPerActiveHour: 0.25
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
  config.plan.modelMixes = manifestModelMixes(PROVIDER_MANIFEST);
  config.plan.distributed = { ...DEFAULT_CONFIG.plan.distributed, ...config.plan.distributed };
  const distributed = config.plan.distributed;
  for (const key of ["targetPercent", "slopeWindowHours", "safetyDelayHours", "initialShare", "minimumShare", "blindDecay", "controlGain", "additiveRamp", "minimumRatio", "maximumRatio", "rateFloor", "consistencyLimitPercent", "routingExcitation", "routingBlockMinutes", "calibrationMinSamples", "calibrationMinHours", "leaseHours", "restartLeaseMinutes"]) {
    if (!(Number.isFinite(distributed[key]) && distributed[key] >= 0)) fail(`invalid config.plan.distributed.${key}`);
  }
  if (distributed.targetPercent <= 0 || distributed.targetPercent > 100 || distributed.initialShare > 1 ||
      distributed.minimumShare > distributed.initialShare || distributed.blindDecay > 1 || distributed.routingExcitation > 1 ||
      distributed.minimumRatio > distributed.maximumRatio || distributed.routingBlockMinutes <= 0 ||
      !Number.isInteger(distributed.calibrationMinSamples) || distributed.calibrationMinSamples < 100 ||
      distributed.calibrationMinHours < 24 || distributed.leaseHours <= 0 || distributed.restartLeaseMinutes <= 0) {
    fail("invalid config.plan.distributed bounds");
  }
  const anthropic = config.plan.anthropic;
  if (!anthropic || !(Number.isFinite(anthropic.pollSeconds) && anthropic.pollSeconds > 0) ||
      !(Number.isFinite(anthropic.maxStaleSeconds) && anthropic.maxStaleSeconds >= anthropic.pollSeconds) ||
      !(Number.isFinite(anthropic.predictedPercentPerActiveHour ?? DEFAULT_CONFIG.plan.anthropic.predictedPercentPerActiveHour) &&
        (anthropic.predictedPercentPerActiveHour ?? DEFAULT_CONFIG.plan.anthropic.predictedPercentPerActiveHour) > 0)) {
    fail("invalid config.plan.anthropic");
  }
  for (const [base, mix] of Object.entries(config.plan.modelMixes)) {
    if (!base.includes(":") || !Array.isArray(mix?.alternatives) || mix.alternatives.length === 0 ||
        mix.strategy !== "independent-capacity") fail(`invalid model mix ${base}`);
    const keys = new Set([base]);
    for (const variant of mix.alternatives) {
      if (typeof variant?.model !== "string" || !variant.model.includes("/") || typeof variant?.thinking !== "string") {
        fail(`invalid model mix variant ${base}`);
      }
      const key = runModelKey(variant);
      if (keys.has(key)) fail(`duplicate model mix variant ${key}`);
      keys.add(key);
      validateModelPolicy(variant.model);
    }
  }
  config.plan.cursor = { ...DEFAULT_CONFIG.plan.cursor, ...config.plan.cursor };
  const cursor = config.plan.cursor;
  if (!(Number.isFinite(cursor.pollSeconds) && cursor.pollSeconds > 0) ||
      !(Number.isFinite(cursor.maxStaleSeconds) && cursor.maxStaleSeconds >= cursor.pollSeconds) ||
      !(Number.isFinite(cursor.reservePercent) && cursor.reservePercent >= 0 && cursor.reservePercent < 100) ||
      !(Number.isFinite(cursor.predictedPercentPerActiveHour) && cursor.predictedPercentPerActiveHour > 0)) {
    fail("invalid config.plan.cursor");
  }
  return config;
}

const SQLITE_NOW_MS = "CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)";
// Work-probe bookkeeping columns are scheduler telemetry, not domain mutations;
// they must not churn updated_at every probe interval.
const AUTO_TIMESTAMP_EXCLUDED = new Set(["created_at", "updated_at", "work_state", "work_checked_at"]);

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
  const domainColumns = columns.filter((name) => !AUTO_TIMESTAMP_EXCLUDED.has(name));
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
      provider TEXT,
      model TEXT,
      thinking TEXT,
      created_at INTEGER NOT NULL DEFAULT (CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)),
      updated_at INTEGER NOT NULL DEFAULT (CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER))
    );
    CREATE INDEX IF NOT EXISTS run_task_status ON run(task_id,status);
    CREATE TABLE IF NOT EXISTS dispatch_reservation (
      run_id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL REFERENCES task(id),
      state TEXT NOT NULL CHECK(state IN ('active','terminal')),
      reserved_at INTEGER NOT NULL,
      finished_at INTEGER,
      created_at INTEGER NOT NULL DEFAULT (CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)),
      updated_at INTEGER NOT NULL DEFAULT (CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER))
    );
    CREATE INDEX IF NOT EXISTS dispatch_reservation_state ON dispatch_reservation(state);
    CREATE TABLE IF NOT EXISTS quota_lease (
      id TEXT PRIMARY KEY,
      task_id TEXT REFERENCES task(id),
      provider TEXT,
      model TEXT NOT NULL,
      thinking TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('available','active')),
      run_id TEXT,
      source TEXT NOT NULL CHECK(source IN ('governor','operator')),
      issued_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      heartbeat_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL DEFAULT (CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)),
      updated_at INTEGER NOT NULL DEFAULT (CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER))
    );
    CREATE UNIQUE INDEX IF NOT EXISTS quota_lease_run ON quota_lease(run_id) WHERE run_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS quota_lease_availability ON quota_lease(state,expires_at,task_id);
    CREATE TABLE IF NOT EXISTS governor_control (
      provider_family TEXT PRIMARY KEY CHECK(provider_family IN ('openai','anthropic')),
      allowance_multiplier INTEGER NOT NULL CHECK(allowance_multiplier IN (1,5)),
      created_at INTEGER NOT NULL DEFAULT (CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)),
      updated_at INTEGER NOT NULL DEFAULT (CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER))
    );
    INSERT OR IGNORE INTO governor_control(provider_family,allowance_multiplier) VALUES('openai',1),('anthropic',1);
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
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS log_governor_control_update
    AFTER UPDATE OF allowance_multiplier ON governor_control
    WHEN OLD.allowance_multiplier <> NEW.allowance_multiplier
    BEGIN
      INSERT INTO event(at,kind,detail)
      VALUES(${SQLITE_NOW_MS},'governor-control',NEW.provider_family || ' allowance multiplier set to ' || NEW.allowance_multiplier);
    END;
  `);
  let taskColumns = new Set(db.prepare("PRAGMA table_info(task)").all().map((row) => row.name));
  if (!taskColumns.has("dispatch")) {
    db.exec("DROP TRIGGER IF EXISTS auto_timestamp_task_insert; DROP TRIGGER IF EXISTS auto_timestamp_task_update; ALTER TABLE task ADD COLUMN dispatch TEXT");
    taskColumns = new Set(db.prepare("PRAGMA table_info(task)").all().map((row) => row.name));
  }
  if (taskColumns.has("max_parallel")) {
    db.exec("DROP TRIGGER IF EXISTS auto_timestamp_task_insert; DROP TRIGGER IF EXISTS auto_timestamp_task_update; ALTER TABLE task DROP COLUMN max_parallel;");
    taskColumns = new Set(db.prepare("PRAGMA table_info(task)").all().map((row) => row.name));
  }
  if (!taskColumns.has("completion_check")) {
    db.exec("DROP TRIGGER IF EXISTS auto_timestamp_task_insert; DROP TRIGGER IF EXISTS auto_timestamp_task_update; ALTER TABLE task ADD COLUMN completion_check TEXT");
  }
  if (!taskColumns.has("work_check")) {
    db.exec(`
      DROP TRIGGER IF EXISTS auto_timestamp_task_insert;
      DROP TRIGGER IF EXISTS auto_timestamp_task_update;
      ALTER TABLE task ADD COLUMN work_check TEXT;
      ALTER TABLE task ADD COLUMN work_state TEXT CHECK(work_state IN ('work','no-work','error'));
      ALTER TABLE task ADD COLUMN work_checked_at INTEGER NOT NULL DEFAULT 0;
    `);
  }
  const runColumns = new Set(db.prepare("PRAGMA table_info(run)").all().map((row) => row.name));
  if (!runColumns.has("provider")) {
    db.exec("DROP TRIGGER IF EXISTS auto_timestamp_run_insert; DROP TRIGGER IF EXISTS auto_timestamp_run_update; ALTER TABLE run ADD COLUMN provider TEXT");
  }
  if (!runColumns.has("productive")) {
    db.exec("DROP TRIGGER IF EXISTS auto_timestamp_run_insert; DROP TRIGGER IF EXISTS auto_timestamp_run_update; ALTER TABLE run ADD COLUMN productive INTEGER CHECK(productive IN (0,1))");
  }
  if (!runColumns.has("dispatched")) {
    db.exec("DROP TRIGGER IF EXISTS auto_timestamp_run_insert; DROP TRIGGER IF EXISTS auto_timestamp_run_update; ALTER TABLE run ADD COLUMN dispatched INTEGER CHECK(dispatched IN (0,1))");
  }
  if (!runColumns.has("model")) {
    db.exec("DROP TRIGGER IF EXISTS auto_timestamp_run_insert; DROP TRIGGER IF EXISTS auto_timestamp_run_update; ALTER TABLE run ADD COLUMN model TEXT; ALTER TABLE run ADD COLUMN thinking TEXT");
  }
  db.exec(`
    UPDATE run SET
      model=coalesce(model,(SELECT model FROM task WHERE task.id=run.task_id)),
      thinking=coalesce(thinking,(SELECT thinking FROM task WHERE task.id=run.task_id))
    WHERE model IS NULL OR thinking IS NULL;
  `);
  for (const table of ["task", "run", "dispatch_reservation", "quota_lease", "governor_control", "event"]) ensureTableTimestamps(db, table);
  return db;
}

function event(db, kind, detail, taskId = null, runId = null) {
  db.prepare("INSERT INTO event(at,kind,task_id,run_id,detail) VALUES(?,?,?,?,?)")
    .run(now(), kind, taskId, runId, detail);
}

function governorControlKey(providerFamily) {
  if (providerFamily === CODEX_PROVIDER || providerFamily === "openai") return "openai";
  if (providerFamily === ANTHROPIC_PROVIDER) return "anthropic";
  fail(`unsupported governor provider family ${providerFamily}`);
}

export function governorAllowanceMultiplier(db, providerFamily) {
  const key = governorControlKey(providerFamily);
  const value = Number(db.prepare("SELECT allowance_multiplier FROM governor_control WHERE provider_family=?").get(key)?.allowance_multiplier);
  if (value !== 1 && value !== BOOSTED_ALLOWANCE_MULTIPLIER) fail(`invalid ${key} governor allowance multiplier`);
  return value;
}

export function governorControls(db) {
  return Object.fromEntries(["openai", "anthropic"].map((provider) => {
    const multiplier = governorAllowanceMultiplier(db, provider);
    return [provider, { boosted: multiplier === BOOSTED_ALLOWANCE_MULTIPLIER, multiplier }];
  }));
}

export function setGovernorBoost(db, providerFamily, boosted) {
  const key = governorControlKey(providerFamily);
  const multiplier = boosted ? BOOSTED_ALLOWANCE_MULTIPLIER : 1;
  const result = db.prepare("UPDATE governor_control SET allowance_multiplier=? WHERE provider_family=?").run(multiplier, key);
  if (result.changes !== 1) fail(`missing ${key} governor control`);
  return governorControls(db);
}

function taskRows(db) {
  return db.prepare(`
    SELECT t.*,
      count(CASE WHEN r.status='running' THEN 1 END) AS active,
      count(r.id) AS launches,
      max(r.started_at) AS last_started_at
    FROM task t LEFT JOIN run r ON r.task_id=t.id
    GROUP BY t.id ORDER BY t.created_at,t.id
  `).all();
}

// A declared work probe is the launch gate: a task whose probe most recently
// reported no claimable work is simply not launched. There is no idle launch to
// discover the emptiness and no timed backoff to wait out; the probe refresh
// notices new work and restores eligibility immediately. A dispatch-only task
// (no separate probe) retries its dispatch after a short pause instead.
export const DISPATCH_NO_WORK_TTL_MS = 60_000;
export function workReady(task, at = now()) {
  if (task.work_state !== "no-work") return true;
  if (task.work_check) return false;
  return at - Number(task.work_checked_at ?? 0) >= DISPATCH_NO_WORK_TTL_MS;
}

export function rankTasks(tasks, _activeTotal) {
  const at = now();
  const eligible = tasks.filter((task) =>
    task.completed_at === null && task.cancelled_at === null &&
    task.not_before <= at && task.next_eligible_at <= at && workReady(task, at));
  return eligible
    // Active/share is the durable concurrency allocation: fast lanes that finish
    // must regain a slot instead of gradually yielding the whole fleet to long
    // sessions. Weighted age breaks equal-allocation ties and rotates correctly
    // even with one provider slot. Lifetime launches remain observability only.
    .map((task) => ({
      task,
      normalizedActive: Number(task.active ?? 0) / Number(task.launch_share),
      debt: task.last_started_at === null || task.last_started_at === undefined
        ? Number.POSITIVE_INFINITY
        : Math.max(0, at - Number(task.last_started_at)) * Number(task.launch_share),
    }))
    .sort((a, b) => a.normalizedActive - b.normalizedActive || b.debt - a.debt || a.task.created_at - b.task.created_at)
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

function runModelKey(value) { return `${value.model}:${value.thinking}`; }
function providerOf(model) { return String(model).split("/", 1)[0]; }
function modelIdOf(model) { return String(model).slice(String(model).indexOf("/") + 1); }
function providerDefinition(provider) {
  return PROVIDER_MANIFEST.providers.find((candidate) =>
    provider === candidate.prefix || provider.startsWith(`${candidate.prefix}-`)) ?? null;
}
function providerFamily(provider) { return providerDefinition(provider)?.id ?? provider; }
function governorKind(provider) { return providerDefinition(provider)?.governor ?? providerFamily(provider); }
function taskMix(config, task) { return config.plan.modelMixes[runModelKey(task)] ?? null; }
function taskVariants(config, task) {
  const primary = { model: task.model, thinking: task.thinking };
  return [primary, ...(taskMix(config, task)?.alternatives ?? [])];
}
export function taskSupportsAssignment(config, task, assignment) {
  return taskVariants(config, task).some((variant) => runModelKey(variant) === runModelKey(assignment));
}
export function chooseIndependentAssignment(...assignments) {
  const admitted = assignments.flat().filter((assignment) => assignment?.ok);
  if (admitted.length === 0) return null;
  return admitted.sort((left, right) => Number(left.pressure) - Number(right.pressure))[0];
}
export function validateModelPolicy(model) {
  if (/^gpt-5-5(?:-|$)/.test(modelIdOf(model))) fail("GPT-5.5 models are banned; use GPT-5.6");
  if (providerFamily(providerOf(model)) === ANTHROPIC_PROVIDER && /^claude-fable(?:-|$)/.test(modelIdOf(model))) {
    fail("Fable is reserved for interactive use; autonomous tasks must use Opus");
  }
}
function isChatGptProTask(task) { return providerOf(task.model) === CHATGPT_PRO_PROVIDER; }

export function proEntitlementSnapshot(at = now(), state = null) {
  const suppliedState = state !== null;
  let pool = state;
  if (pool === null) {
    try { pool = JSON.parse(fs.readFileSync(CHATGPT_PRO_POOL_PATH, "utf8")); }
    catch { pool = {}; }
  }
  const configuredProfiles = suppliedState
    ? (pool?.version === 4
      ? pool.profiles?.map((profile) => profile.browserProfile)
      : pool?.version === 3 && pool.browserProfile ? [pool.browserProfile] : [])
    : undefined;
  return browserPoolCapacitySnapshot(pool, at, configuredProfiles);
}

export function proLaunchAvailability(entitlement, active) {
  const activeWithoutLease = Math.max(0, active - entitlement.inFlight);
  return Math.max(0, Math.min(
    entitlement.available - activeWithoutLease,
    entitlement.maxParallel - active,
  ));
}

function slope(points) {
  if (points.length < 2) return null;
  const x = points.reduce((sum, point) => sum + point.at, 0) / points.length;
  const y = points.reduce((sum, point) => sum + point.value, 0) / points.length;
  let numerator = 0;
  let denominator = 0;
  for (const point of points) {
    numerator += (point.at - x) * (point.value - y);
    denominator += (point.at - x) ** 2;
  }
  return denominator > 0 ? numerator / denominator * 3600_000 : null;
}

function bounded(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value));
}

export class DistributedQuotaFeedback {
  constructor(config, statePath, persist = true) {
    this.config = { ...DEFAULT_CONFIG.plan.distributed, ...config.plan?.distributed };
    this.statePath = statePath;
    this.persist = persist;
    this.state = {
      version: 3,
      allocationVersion: DISTRIBUTED_ALLOCATION_VERSION,
      calibrationVersion: DISTRIBUTED_CALIBRATION_VERSION,
      meterIdentityVersion: DISTRIBUTED_METER_IDENTITY_VERSION,
      seed: randomBytes(16).toString("hex"),
      share: this.config.initialShare,
      previous: {},
      cumulative: {},
      history: {},
      samples: [],
      estimates: {},
      accountShares: {},
      accountCumulative: {},
      accountHistory: {},
      accountUnconfirmed: {},
      accountSensorInconsistent: {},
      unconfirmed: 0,
      sensorInconsistent: false,
      lastObservedAt: 0,
      lastControlAt: 0,
    };
    try {
      const parsed = JSON.parse(fs.readFileSync(statePath, "utf8"));
      const allocationVersion = parsed?.version === 2 ? 1 : parsed?.allocationVersion;
      const calibrationVersion = parsed?.version === 2 ? 1 : parsed?.calibrationVersion;
      const meterIdentityCompatible = parsed?.meterIdentityVersion === DISTRIBUTED_METER_IDENTITY_VERSION;
      if (typeof parsed.seed === "string") this.state.seed = parsed.seed;
      if (meterIdentityCompatible && allocationVersion === DISTRIBUTED_ALLOCATION_VERSION &&
          Number.isFinite(parsed.share)) {
        for (const key of ["share", "previous", "cumulative", "history", "accountShares", "accountCumulative", "accountHistory", "accountUnconfirmed", "accountSensorInconsistent", "unconfirmed", "sensorInconsistent", "lastObservedAt", "lastControlAt"]) {
          if (parsed[key] !== undefined) this.state[key] = parsed[key];
        }
      }
      if (meterIdentityCompatible && calibrationVersion === DISTRIBUTED_CALIBRATION_VERSION) {
        if (Array.isArray(parsed.samples)) this.state.samples = parsed.samples;
        if (parsed.estimates && typeof parsed.estimates === "object") this.state.estimates = parsed.estimates;
      }
    } catch {}
    this.status = { share: this.state.share, sustainableRate: 0, observedRate: null, sensorInconsistent: this.state.sensorInconsistent };
  }

  score(key, block = Math.floor(now() / (this.config.routingBlockMinutes * 60_000))) {
    const digest = createHash("sha256").update(`${this.state.seed}:${block}:${key}`).digest();
    return digest.readUIntBE(0, 6) / 2 ** 48;
  }

  pattern(accounts, modelKey, block) {
    const ranked = accounts.map((provider) => ({
      provider,
      score: this.score(`route:${modelKey}:${provider}`, block),
    })).sort((left, right) => left.score - right.score || left.provider.localeCompare(right.provider));
    const signs = new Map();
    const positive = Math.floor(ranked.length / 2);
    ranked.forEach((item, index) => signs.set(item.provider, index < positive ? 1 : index < positive * 2 ? -1 : 0));
    return signs;
  }

  estimate(modelKey, prior) {
    const learned = this.state.estimates?.[modelKey];
    return Number.isFinite(learned?.upper) ? Math.max(prior, learned.upper) : prior;
  }

  calibrate(accountDeltas, calibration, elapsedHours, at) {
    if (!calibration || elapsedHours <= 0) return;
    const providers = calibration.accounts.map((account) => account.provider).sort();
    const modelKeys = [...new Set(calibration.assignments.map((item) => runModelKey(item.model ? item : item.task)))];
    const x = {};
    const patterns = {};
    for (const assignment of calibration.assignments) {
      const modelKey = runModelKey(assignment.model ? assignment : assignment.task);
      const rate = calibration.rate(assignment.model ? assignment : assignment.task);
      x[assignment.provider] ??= {};
      x[assignment.provider][modelKey] = (x[assignment.provider][modelKey] ?? 0) + rate;
      patterns[modelKey] ??= [];
      patterns[modelKey].push(assignment.instrumentBlock ?? Math.floor(at / (this.config.routingBlockMinutes * 60_000)));
    }
    const z = {};
    for (const provider of providers) {
      z[provider] = {};
      for (const modelKey of modelKeys) {
        const blocks = patterns[modelKey] ?? [];
        z[provider][modelKey] = blocks.length
          ? blocks.reduce((sum, block) => sum + (this.pattern(providers, modelKey, block).get(provider) ?? 0), 0) / blocks.length
          : 0;
      }
    }
    this.state.samples.push({ at, y: Object.fromEntries(Object.entries(accountDeltas).map(([provider, delta]) => [provider, delta / elapsedHours])), x, z });
    const cutoff = at - 28 * 24 * 3600_000;
    this.state.samples = this.state.samples.filter((sample) => sample.at >= cutoff).slice(-20_000);
    if (this.state.samples.length < this.config.calibrationMinSamples ||
        this.state.samples.at(-1).at - this.state.samples[0].at < this.config.calibrationMinHours * 3600_000) return;
    const maxLag = Math.max(0, Math.ceil(30 * 60_000 / Math.max(1, at - this.state.samples.at(-2).at)));
    for (const modelKey of Object.keys(calibration.priors ?? {})) {
      let selected = null;
      for (let lag = 0; lag <= maxLag; lag++) {
        let numerator = 0;
        let denominator = 0;
        const moments = [];
        for (let index = lag; index < this.state.samples.length; index++) {
          const observed = this.state.samples[index];
          const source = this.state.samples[index - lag];
          let sampleNumerator = 0;
          let sampleDenominator = 0;
          for (const provider of providers) {
            const instrument = source.z?.[provider]?.[modelKey] ?? 0;
            sampleNumerator += instrument * (observed.y?.[provider] ?? 0);
            sampleDenominator += instrument * (source.x?.[provider]?.[modelKey] ?? 0);
          }
          numerator += sampleNumerator;
          denominator += sampleDenominator;
          moments.push({ numerator: sampleNumerator, denominator: sampleDenominator });
        }
        if (denominator > 1e-6 && (!selected || numerator > selected.numerator)) selected = { lag, numerator, denominator, moments };
      }
      if (!selected) continue;
      const multiplier = Math.max(0, selected.numerator / selected.denominator);
      const residuals = selected.moments.map((moment) => moment.numerator - multiplier * moment.denominator);
      const residualMean = residuals.reduce((sum, value) => sum + value, 0) / residuals.length;
      const variance = residuals.length > 1
        ? residuals.reduce((sum, value) => sum + (value - residualMean) ** 2, 0) / (residuals.length - 1)
        : Number.POSITIVE_INFINITY;
      const denominatorMean = selected.denominator / residuals.length;
      const standardError = denominatorMean > 0 ? Math.sqrt(variance / residuals.length) / denominatorMean : Number.POSITIVE_INFINITY;
      const prior = calibration.priors[modelKey];
      if (Number.isFinite(multiplier) && Number.isFinite(standardError) && Number.isFinite(prior) && prior > 0) {
        this.state.estimates[modelKey] = {
          estimate: prior * multiplier,
          upper: prior * (multiplier + 2 * standardError),
          standardError: prior * standardError,
          multiplier,
          samples: residuals.length,
          lagMinutes: selected.lag * Math.max(1, at - this.state.samples.at(-2).at) / 60_000,
          at,
        };
      }
    }
  }

  observe(resources, localPredictedRate = 0, calibration = null, at = now(), allowanceMultiplier = 1) {
    const previousAt = this.state.lastObservedAt;
    const elapsedHours = previousAt > 0 ? Math.max(0, at - previousAt) / 3600_000 : 0;
    const localByProvider = typeof localPredictedRate === "object" && localPredictedRate !== null ? localPredictedRate : {};
    const scalarPredicted = typeof localPredictedRate === "number" ? localPredictedRate : Object.values(localByProvider).reduce((sum, value) => sum + value, 0);
    if (elapsedHours > 0) this.state.unconfirmed += scalarPredicted * elapsedHours;
    const accountDeltas = {};
    const resourceDeltas = {};
    const advancedProviders = new Set();
    let meterAdvanced = false;
    for (const resource of resources) {
      const previous = this.state.previous[resource.id];
      let delta = 0;
      const reportedReset = resource.reportedReset !== false;
      const previousReportedReset = previous?.reportedReset !== false;
      const sameWindow = previous && reportedReset === previousReportedReset &&
        (!reportedReset || previous.resetAt === resource.resetAt);
      if (sameWindow && resource.used >= previous.used) {
        delta = (resource.used - previous.used) * resource.weight;
      }
      if (delta > 1e-9) {
        meterAdvanced = true;
        advancedProviders.add(resource.provider);
      }
      resourceDeltas[`${resource.provider}:${resource.group}`] = delta;
      accountDeltas[resource.provider] = (accountDeltas[resource.provider] ?? 0) + delta;
      this.state.cumulative[resource.group] = (this.state.cumulative[resource.group] ?? 0) + delta;
      this.state.previous[resource.id] = { used: resource.used, resetAt: resource.resetAt, reportedReset, at };
    }
    if (meterAdvanced) {
      this.state.unconfirmed = 0;
      this.state.sensorInconsistent = false;
    }
    for (const provider of new Set(resources.map((resource) => resource.provider))) {
      this.state.accountShares[provider] ??= this.config.initialShare;
      this.state.accountUnconfirmed[provider] ??= 0;
      if (elapsedHours > 0) this.state.accountUnconfirmed[provider] += (localByProvider[provider] ?? 0) * elapsedHours;
      if (advancedProviders.has(provider)) {
        this.state.accountUnconfirmed[provider] = 0;
        this.state.accountSensorInconsistent[provider] = false;
      }
    }
    this.state.lastObservedAt = at;
    const groups = [...new Set(resources.map((resource) => resource.group))];
    const rates = {};
    const sustainable = {};
    for (const group of groups) {
      this.state.history[group] ??= [];
      this.state.history[group].push({ at, value: this.state.cumulative[group] ?? 0 });
      const cutoff = at - this.config.slopeWindowHours * 2 * 3600_000;
      this.state.history[group] = this.state.history[group].filter((point) => point.at >= cutoff);
      const recent = this.state.history[group].filter((point) => point.at >= at - this.config.slopeWindowHours * 3600_000);
      rates[group] = recent.length >= 4 ? Math.max(0, slope(recent) ?? 0) : null;
      sustainable[group] = resources.filter((resource) => resource.group === group).reduce((sum, resource) => {
        const hours = Math.max(1 / 60, (resource.resetAt - at) / 3600_000);
        return sum + Math.max(0, resource.available) / hours;
      }, 0);
    }
    const providerStatus = {};
    for (const provider of new Set(resources.map((resource) => resource.provider))) {
      const providerResources = resources.filter((resource) => resource.provider === provider);
      const providerGroups = [...new Set(providerResources.map((resource) => resource.group))];
      const providerRates = {};
      const providerSustainable = {};
      for (const group of providerGroups) {
        const key = `${provider}:${group}`;
        this.state.accountCumulative[key] = (this.state.accountCumulative[key] ?? 0) + (resourceDeltas[key] ?? 0);
        this.state.accountHistory[key] ??= [];
        this.state.accountHistory[key].push({ at, value: this.state.accountCumulative[key] });
        const cutoff = at - this.config.slopeWindowHours * 2 * 3600_000;
        this.state.accountHistory[key] = this.state.accountHistory[key].filter((point) => point.at >= cutoff);
        const recent = this.state.accountHistory[key].filter((point) => point.at >= at - this.config.slopeWindowHours * 3600_000);
        providerRates[group] = recent.length >= 4 ? Math.max(0, slope(recent) ?? 0) : null;
        providerSustainable[group] = providerResources.filter((resource) => resource.group === group).reduce((sum, resource) => {
          const hours = Math.max(1 / 60, (resource.resetAt - at) / 3600_000);
          return sum + Math.max(0, resource.available) / hours;
        }, 0);
      }
      providerStatus[provider] = {
        rates: providerRates,
        sustainable: providerSustainable,
        sustainableRate: providerGroups.length ? Math.min(...providerGroups.map((group) => providerSustainable[group])) : 0,
      };
    }
    this.calibrate(accountDeltas, calibration, elapsedHours, at);
    if (at - this.state.lastControlAt >= 20 * 60_000) {
      this.state.lastControlAt = at;
      for (const [provider, status] of Object.entries(providerStatus)) {
        if (this.state.accountUnconfirmed[provider] >= this.config.consistencyLimitPercent) {
          this.state.accountShares[provider] = 0;
          this.state.accountSensorInconsistent[provider] = true;
          continue;
        }
        const observed = Object.keys(status.rates).filter((group) => status.rates[group] !== null && status.rates[group] > this.config.rateFloor);
        if (observed.length) {
          const ratio = Math.min(...observed.map((group) => allowanceMultiplier * status.sustainable[group] / status.rates[group]));
          this.state.accountShares[provider] = bounded(
            this.state.accountShares[provider] * Math.exp(this.config.controlGain * Math.log(bounded(ratio, this.config.minimumRatio, this.config.maximumRatio))),
            this.config.minimumShare,
            1,
          );
        } else if ((localByProvider[provider] ?? 0) > 0) {
          this.state.accountShares[provider] = Math.max(this.config.minimumShare, this.state.accountShares[provider] * this.config.blindDecay);
        } else {
          this.state.accountShares[provider] = Math.min(1, this.state.accountShares[provider] + this.config.additiveRamp);
        }
      }
      if (this.state.unconfirmed >= this.config.consistencyLimitPercent) {
        this.state.share = 0;
        this.state.sensorInconsistent = true;
      } else {
        const observedGroups = groups.filter((group) => rates[group] !== null && rates[group] > this.config.rateFloor);
        if (observedGroups.length) {
          const ratio = Math.min(...observedGroups.map((group) => allowanceMultiplier * sustainable[group] / rates[group]));
          this.state.share = bounded(
            this.state.share * Math.exp(this.config.controlGain * Math.log(bounded(ratio, this.config.minimumRatio, this.config.maximumRatio))),
            this.config.minimumShare,
            1,
          );
        } else if (scalarPredicted > 0) {
          this.state.share = Math.max(this.config.minimumShare, this.state.share * this.config.blindDecay);
        } else {
          this.state.share = Math.min(1, this.state.share + this.config.additiveRamp);
        }
      }
    }
    const sustainableRate = groups.length ? Math.min(...groups.map((group) => sustainable[group])) : 0;
    const observedValues = groups.map((group) => rates[group]).filter(Number.isFinite);
    const providerValues = Object.entries(providerStatus);
    const weightedAllowance = providerValues.reduce((sum, [provider, status]) => sum + (this.state.accountShares[provider] ?? 0) * status.sustainableRate, 0);
    const totalSustainable = providerValues.reduce((sum, [, status]) => sum + status.sustainableRate, 0);
    this.status = {
      share: totalSustainable > 0 ? weightedAllowance / totalSustainable : this.state.share,
      sustainableRate,
      observedRate: observedValues.length ? Math.max(...observedValues) : null,
      rates,
      sustainable,
      unconfirmed: this.state.unconfirmed,
      sensorInconsistent: this.state.sensorInconsistent,
      estimates: this.state.estimates,
      accounts: Object.fromEntries(providerValues.map(([provider, status]) => [provider, {
        ...status,
        share: this.state.accountShares[provider],
        unconfirmed: this.state.accountUnconfirmed[provider],
        sensorInconsistent: this.state.accountSensorInconsistent[provider] === true,
      }])),
    };
    if (this.persist) atomicWrite(this.statePath, `${JSON.stringify(this.state)}\n`);
    return this.status;
  }

  admits(localLoad, candidate, capacity, key, at = now()) {
    if (this.state.sensorInconsistent || capacity <= 0 || candidate <= 0) return false;
    const allowance = this.state.share * capacity;
    if (localLoad + candidate <= allowance + 1e-9) return true;
    if (localLoad > 1e-9 || allowance <= 0) return false;
    return this.score(`admit:${key}`, Math.floor(at / (this.config.routingBlockMinutes * 60_000))) < Math.min(1, allowance / candidate);
  }

  totalAllowance(accounts, allowanceMultiplier = 1) {
    return allowanceMultiplier * accounts.reduce((sum, account) => sum +
      (this.state.accountSensorInconsistent[account.provider] ? 0 : (this.state.accountShares[account.provider] ?? this.config.initialShare)) *
      account.allowedBurnPercentPerHour, 0);
  }

  admitsAccounts(localLoad, candidate, accounts, key, at = now(), allowanceMultiplier = 1) {
    const allowance = this.totalAllowance(accounts, allowanceMultiplier);
    if (allowance <= 0 || candidate <= 0) return false;
    if (localLoad + candidate <= allowance + 1e-9) return true;
    if (localLoad > 1e-9) return false;
    return this.score(`admit-pool:${key}`, Math.floor(at / (this.config.routingBlockMinutes * 60_000))) < Math.min(1, allowance / candidate);
  }

  adaptiveAssignment(accounts, activeRates, modelKey, candidate, at = now(), allowanceMultiplier = 1) {
    const localLoad = activeRates.reduce((sum, assignment) => sum + assignment.rate, 0);
    const allowance = this.totalAllowance(accounts, allowanceMultiplier);
    const admitted = this.admitsAccounts(localLoad, candidate, accounts, modelKey, at, allowanceMultiplier);
    const selected = admitted
      ? this.selectAccount(accounts, activeRates, modelKey, candidate, at, allowanceMultiplier)
      : null;
    return {
      selected,
      localLoad,
      candidate,
      allowance,
      pressure: allowance > 0 ? (localLoad + candidate) / allowance : Number.POSITIVE_INFINITY,
    };
  }

  selectAccount(accounts, activeRates, modelKey, candidate, at = now(), allowanceMultiplier = 1) {
    const providers = accounts.map((account) => account.provider).sort();
    const block = Math.floor(at / (this.config.routingBlockMinutes * 60_000));
    const signs = this.pattern(providers, modelKey, block);
    const live = new Map();
    for (const assignment of activeRates) live.set(assignment.provider, (live.get(assignment.provider) ?? 0) + assignment.rate);
    const selected = accounts
      .filter((account) => account.allowedBurnPercentPerHour > 0 && !this.state.accountSensorInconsistent[account.provider])
      .map((account) => ({
        account,
        live: live.get(account.provider) ?? 0,
        sign: signs.get(account.provider) ?? 0,
      }))
      .sort((left, right) => {
        const leftAllowance = allowanceMultiplier * (this.state.accountShares[left.account.provider] ?? this.config.initialShare) * left.account.allowedBurnPercentPerHour;
        const rightAllowance = allowanceMultiplier * (this.state.accountShares[right.account.provider] ?? this.config.initialShare) * right.account.allowedBurnPercentPerHour;
        const leftPressure = left.live / Math.max(candidate, leftAllowance) - this.config.routingExcitation * left.sign;
        const rightPressure = right.live / Math.max(candidate, rightAllowance) - this.config.routingExcitation * right.sign;
        return leftPressure - rightPressure || left.account.provider.localeCompare(right.account.provider);
      })[0] ?? null;
    return selected ? { ...selected, block } : null;
  }
}

export function isEligibleCodexPlan(planType) {
  const normalized = typeof planType === "string" ? planType.trim().toLowerCase() : "";
  return normalized === "pro" || normalized === "plus";
}

export function codexSubscriptionLifecycle(raw, at = now()) {
  const subscriptions = Array.isArray(raw?.subscriptions) ? raw.subscriptions : [];
  const retiredProviders = [];
  let nextRetirementAt = Number.POSITIVE_INFINITY;
  for (const entry of subscriptions) {
    if (entry?.provider !== "openai-codex" || !Number.isInteger(entry.index) || entry.index < 2) continue;
    if (entry.lifecycle === undefined) continue;
    if (entry.lifecycle?.state !== "cancelled" || typeof entry.lifecycle?.accessUntil !== "string") {
      fail(`invalid subscription lifecycle for openai-codex-${entry.index}`);
    }
    const accessUntil = Date.parse(entry.lifecycle.accessUntil);
    if (!Number.isFinite(accessUntil)) fail(`invalid subscription accessUntil for openai-codex-${entry.index}`);
    const provider = `openai-codex-${entry.index}`;
    if (accessUntil <= at) retiredProviders.push(provider);
    else nextRetirementAt = Math.min(nextRetirementAt, accessUntil);
  }
  return { retiredProviders, nextRetirementAt };
}

function readCodexSubscriptionLifecycle(file, at = now()) {
  try {
    return codexSubscriptionLifecycle(JSON.parse(fs.readFileSync(file, "utf8")), at);
  } catch (error) {
    if (error?.code === "ENOENT") return { retiredProviders: [], nextRetirementAt: Number.POSITIVE_INFINITY };
    throw error;
  }
}

function configuredOAuthAccounts(auth, baseProvider) {
  return Object.entries(auth).filter(([name, value]) =>
    (name === baseProvider || name.startsWith(`${baseProvider}-`)) && value?.type === "oauth" && value?.access);
}

async function resolveOAuthCredential({ modelRuntime, provider, baseProvider, stored, authPath, pollSeconds, readCredential }) {
  const minimumValidityMs = Math.max(5 * 60_000, pollSeconds * 2_000);
  if (Number(stored.expires) - now() >= minimumValidityMs) return { access: stored.access, accountId: stored.accountId ?? "" };
  if (!modelRuntime.getProvider(provider)) {
    const base = modelRuntime.getProvider(baseProvider);
    if (!base) fail(`could not resolve OAuth provider ${baseProvider}`);
    modelRuntime.registerNativeProvider({ ...base, id: provider, name: provider });
  }
  const resolved = await modelRuntime.getAuth(provider, {
    minOAuthValidityMs: minimumValidityMs,
    signal: AbortSignal.timeout(15000),
  });
  const latest = readCredential(provider, authPath);
  if (!resolved?.auth?.apiKey || latest?.type !== "oauth" || !latest.access) return null;
  return { access: latest.access, accountId: latest.accountId ?? "" };
}

function anthropicWindow(raw, durationHours, fetchedAt) {
  if (!raw || typeof raw !== "object") return null;
  const utilization = Number(raw.utilization ?? raw.percent);
  if (!Number.isFinite(utilization)) return null;
  const parsedReset = raw.resets_at ? Date.parse(raw.resets_at) : Number.NaN;
  // Anthropic reconstructs reset timestamps from a countdown and commonly
  // alternates by one second between polls. Normalize reported boundaries to
  // their intended minute so one rolling window retains one meter identity.
  const normalizedReset = Number.isFinite(parsedReset) ? Math.round(parsedReset / 60_000) * 60_000 : Number.NaN;
  return {
    utilization: Math.max(0, Math.min(100, utilization)),
    resetsAt: Number.isFinite(normalizedReset) ? normalizedReset : fetchedAt + durationHours * 3600_000,
    reportedReset: Number.isFinite(normalizedReset),
  };
}

function anthropicLimit(body, kind, displayName = null) {
  const limits = Array.isArray(body?.limits) ? body.limits : [];
  return limits.find((limit) => limit?.kind === kind && (displayName === null ||
    String(limit?.scope?.model?.display_name ?? "").trim().toLowerCase() === displayName.toLowerCase())) ?? null;
}

export function parseAnthropicUsage(body, fetchedAt = now()) {
  const windows = {
    fiveHour: anthropicWindow(anthropicLimit(body, "session") ?? body?.five_hour, 5, fetchedAt),
    sharedWeekly: anthropicWindow(anthropicLimit(body, "weekly_all") ?? body?.seven_day, 7 * 24, fetchedAt),
    fableWeekly: anthropicWindow(anthropicLimit(body, "weekly_scoped", "Fable"), 7 * 24, fetchedAt),
  };
  if (Object.values(windows).some((window) => window === null)) return null;
  const spendPercent = Number(body?.spend?.percent ?? body?.extra_usage?.utilization);
  return {
    windows,
    extraUsageExhausted: (body?.spend?.enabled === true || body?.extra_usage?.is_enabled === true) &&
      Number.isFinite(spendPercent) && spendPercent >= 99,
  };
}

export function anthropicOpusHasHeadroom(account) {
  const { fiveHour, sharedWeekly, fableWeekly } = account.windows ?? {};
  if (!fiveHour || !sharedWeekly || !fableWeekly || fiveHour.utilization >= 100 || sharedWeekly.utilization >= 100) return false;
  const sharedRemaining = 100 - sharedWeekly.utilization;
  const fableRemaining = 100 - fableWeekly.utilization;
  return 2 * sharedRemaining > fableRemaining;
}

export function anthropicWeeklyCapacity(profile) {
  const rateLimitTier = String(profile?.organization?.rate_limit_tier ?? "").trim().toLowerCase();
  const weeklyCapacityWeight = rateLimitTier === "default_claude_max_20x"
    ? 2
    : rateLimitTier === "default_claude_max_5x" ? 1 : null;
  return { rateLimitTier: rateLimitTier || null, weeklyCapacityWeight };
}

export class AnthropicGovernor {
  constructor(config, { modelRuntime = null, authPath = AUTH_PATH, fetcher = fetch, readCredential = readStoredCredential, cachePath = ANTHROPIC_USAGE_CACHE_PATH, feedback = null, usageMultiplier = () => 1 } = {}) {
    this.config = config;
    this.modelRuntime = modelRuntime;
    this.usageMultiplier = usageMultiplier;
    this.authPath = authPath;
    this.fetcher = fetcher;
    this.readCredential = readCredential;
    this.cachePath = cachePath;
    this.feedback = feedback ?? new DistributedQuotaFeedback(config, ANTHROPIC_GOVERNOR_STATE_PATH);
    this.pendingAssignments = [];
    this.snapshot = null;
    this.lastGood = new Map();
    this.cooldowns = new Map();
    this.refreshing = null;
    try {
      const cached = JSON.parse(fs.readFileSync(this.cachePath, "utf8"));
      for (const account of Array.isArray(cached?.accounts) ? cached.accounts : []) {
        if (typeof account?.provider === "string" && Number.isFinite(account?.fetchedAt) && account?.windows) {
          this.lastGood.set(account.provider, account);
        }
      }
    } catch {}
  }

  setModelRuntime(modelRuntime) { this.modelRuntime = modelRuntime; }

  async authRuntime() {
    if (!this.modelRuntime) this.modelRuntime = await ModelRuntime.create({ signal: AbortSignal.timeout(15000) });
    return this.modelRuntime;
  }

  async accountUsage(provider, credential, fetchedAt) {
    try {
      const usable = await resolveOAuthCredential({
        modelRuntime: await this.authRuntime(),
        provider,
        baseProvider: ANTHROPIC_PROVIDER,
        stored: credential,
        authPath: this.authPath,
        pollSeconds: this.config.plan.anthropic.pollSeconds,
        readCredential: this.readCredential,
      });
      if (!usable) return { account: null, error: "OAuth credential unavailable" };
      const headers = {
        Authorization: `Bearer ${usable.access}`,
        Accept: "application/json",
        "anthropic-version": "2023-06-01",
        "anthropic-beta": "oauth-2025-04-20",
        "User-Agent": ANTHROPIC_CLIENT_USER_AGENT,
      };
      const [response, profileResponse] = await Promise.all([
        this.fetcher(ANTHROPIC_USAGE_ENDPOINT, { signal: AbortSignal.timeout(10000), headers }),
        this.fetcher(ANTHROPIC_PROFILE_ENDPOINT, { signal: AbortSignal.timeout(10000), headers }),
      ]);
      if (!response.ok) return { account: null, error: `usage endpoint HTTP ${response.status}` };
      if (!profileResponse.ok) return { account: null, error: `profile endpoint HTTP ${profileResponse.status}` };
      const usage = parseAnthropicUsage(await response.json(), fetchedAt);
      if (!usage) return { account: null, error: "usage endpoint returned malformed windows" };
      const capacity = anthropicWeeklyCapacity(await profileResponse.json());
      if (capacity.weeklyCapacityWeight === null) return { account: null, error: `weekly capacity is not configured for Anthropic rate-limit tier ${capacity.rateLimitTier ?? "missing"}` };
      const account = { provider, windows: usage.windows, extraUsageExhausted: usage.extraUsageExhausted, ...capacity, fetchedAt, stale: false };
      this.lastGood.set(provider, account);
      return { account, error: null };
    } catch (error) {
      return { account: null, error: String(error?.message ?? error) };
    }
  }

  async refresh(activeAssignments = null) {
    if (activeAssignments) this.pendingAssignments = activeAssignments;
    const allowanceMultiplier = this.usageMultiplier(ANTHROPIC_PROVIDER);
    if (this.snapshot && this.snapshot.allowanceMultiplier === allowanceMultiplier && now() < this.snapshot.expiresAt) return this.snapshot;
    if (this.refreshing) return this.refreshing;
    this.refreshing = this.fetch().finally(() => { this.refreshing = null; });
    return this.refreshing;
  }

  async fetch() {
    const auth = JSON.parse(fs.readFileSync(this.authPath, "utf8"));
    const configured = configuredOAuthAccounts(auth, ANTHROPIC_PROVIDER);
    const fetchedAt = now();
    const accounts = [];
    const errors = [];
    for (const [provider, credential] of configured) {
      const result = await this.accountUsage(provider, credential, fetchedAt);
      if (result.account) {
        accounts.push(result.account);
        continue;
      }
      const cached = this.lastGood.get(provider);
      if (cached && fetchedAt - cached.fetchedAt <= this.config.plan.anthropic.maxStaleSeconds * 1000) {
        accounts.push({ ...cached, stale: true });
        errors.push({ provider, error: result.error, recoveredFromCache: true });
      } else {
        errors.push({ provider, error: result.error, recoveredFromCache: false });
      }
    }
    const target = this.config.plan.distributed.targetPercent;
    const resources = accounts.flatMap((account) => [
      {
        id: `five:${account.provider}`,
        provider: account.provider,
        group: "fiveHour",
        used: account.windows.fiveHour.utilization,
        resetAt: account.windows.fiveHour.resetsAt,
        reportedReset: account.windows.fiveHour.reportedReset,
        weight: 1,
        available: Math.max(0, target - account.windows.fiveHour.utilization),
      },
      {
        id: `weekly:${account.provider}`,
        provider: account.provider,
        group: "weekly",
        used: account.windows.sharedWeekly.utilization,
        resetAt: account.windows.sharedWeekly.resetsAt,
        reportedReset: account.windows.sharedWeekly.reportedReset,
        weight: account.weeklyCapacityWeight,
        available: account.weeklyCapacityWeight * Math.max(0,
          target - account.windows.sharedWeekly.utilization - (100 - account.windows.fableWeekly.utilization) / 2),
      },
    ]);
    const activeByProvider = Object.fromEntries(accounts.map((account) => [account.provider, 0]));
    for (const item of this.pendingAssignments.filter((assignment) => providerFamily(assignment.provider) === ANTHROPIC_PROVIDER)) {
      activeByProvider[item.provider] = (activeByProvider[item.provider] ?? 0) + 1;
    }
    const predictedRate = this.config.plan.anthropic.predictedPercentPerActiveHour ?? DEFAULT_CONFIG.plan.anthropic.predictedPercentPerActiveHour;
    const predicted = Object.fromEntries(Object.entries(activeByProvider).map(([provider, active]) => [provider, active * predictedRate]));
    const allowanceMultiplier = this.usageMultiplier(ANTHROPIC_PROVIDER);
    const distributed = this.feedback.observe(resources, predicted, null, fetchedAt, allowanceMultiplier);
    this.snapshot = {
      at: fetchedAt,
      allowanceMultiplier,
      expiresAt: fetchedAt + this.config.plan.anthropic.pollSeconds * 1000,
      configured: configured.length,
      healthy: accounts.length,
      withHeadroom: accounts.filter(anthropicOpusHasHeadroom).length,
      distributed,
      accounts,
      errors,
    };
    atomicWrite(this.cachePath, `${JSON.stringify(this.snapshot, null, 2)}\n`);
    return this.snapshot;
  }

  noteFailure(provider, error, at = now()) {
    if (!/(?:429|rate.?limit|usage limit|exhausted)/i.test(String(error?.message ?? error))) return;
    this.cooldowns.set(provider, at + 5 * 60_000);
  }

  async allows(variant, activeAssignments, snapshot = null) {
    this.pendingAssignments = activeAssignments;
    const usage = snapshot ?? await this.refresh(activeAssignments);
    const activeByProvider = new Map();
    for (const item of activeAssignments) {
      if (providerFamily(item.provider) !== ANTHROPIC_PROVIDER) continue;
      activeByProvider.set(item.provider, (activeByProvider.get(item.provider) ?? 0) + 1);
    }
    const eligible = usage.accounts
      .filter((account) => anthropicOpusHasHeadroom(account) && (this.cooldowns.get(account.provider) ?? 0) <= now());
    const candidate = this.config.plan.anthropic.predictedPercentPerActiveHour ?? DEFAULT_CONFIG.plan.anthropic.predictedPercentPerActiveHour;
    const allowanceMultiplier = this.usageMultiplier(ANTHROPIC_PROVIDER);
    const syntheticAccounts = usage.accounts.filter(anthropicOpusHasHeadroom).map((account) => ({
      ...account,
      allowedBurnPercentPerHour: usage.distributed?.accounts?.[account.provider]?.sustainableRate ?? 0,
    }));
    const syntheticActive = [...activeByProvider.entries()].map(([provider, active]) => ({ provider, rate: active * candidate }));
    const eligibleProviders = new Set(eligible.map((account) => account.provider));
    const adaptive = this.feedback.adaptiveAssignment(
      syntheticAccounts.filter((account) => eligibleProviders.has(account.provider)),
      syntheticActive,
      runModelKey(variant),
      candidate,
      now(),
      allowanceMultiplier,
    );
    const routed = adaptive.selected;
    const selected = routed ? { account: routed.account, active: activeByProvider.get(routed.account.provider) ?? 0, ...routed } : null;
    const distributed = usage.distributed ?? this.feedback.status;
    return {
      ok: selected !== null,
      provider: selected?.account.provider ?? null,
      model: variant.model,
      thinking: variant.thinking,
      instrumentBlock: selected?.block ?? null,
      instrumentSign: selected?.sign ?? null,
      pressure: adaptive.pressure,
      detail: selected
        ? `Anthropic account=${selected.account.provider} active=${selected.active} local=${adaptive.localLoad.toFixed(3)} candidate=${candidate.toFixed(3)} allowance=${adaptive.allowance.toFixed(3)} multiplier=${allowanceMultiplier} share=${distributed.share.toFixed(3)} healthy=${usage.healthy} headroom=${usage.withHeadroom}`
        : `Anthropic distributed gate closed: local=${adaptive.localLoad.toFixed(3)} candidate=${candidate.toFixed(3)} allowance=${adaptive.allowance.toFixed(3)} multiplier=${allowanceMultiplier} share=${distributed.share.toFixed(3)} healthy=${usage.healthy} headroom=${usage.withHeadroom}`,
    };
  }
}

export function planWindowBurnPerHour(window, at = now()) {
  const used = Number(window?.used_percent);
  const resetAt = Number(window?.reset_at) * 1000;
  if (!Number.isFinite(used) || !Number.isFinite(resetAt)) return null;
  const hours = Math.max(0, resetAt - at) / 3600000;
  if (hours <= 0) return 0;
  return Math.max(0, 100 - used) / hours;
}

function cursorEpoch(value) {
  if (value === null || value === undefined || value === "") return Number.NaN;
  if (typeof value === "string" && !/^\d+(?:\.\d+)?$/.test(value)) return Date.parse(value);
  const numeric = Number(value);
  return numeric < 10_000_000_000 ? numeric * 1000 : numeric;
}

export function parseCursorUsage(body, fetchedAt = now()) {
  const rawUsed = body?.planUsage?.totalPercentUsed;
  if (rawUsed === null || rawUsed === undefined || rawUsed === "") return null;
  const used = Number(rawUsed);
  if (!Number.isFinite(used)) return null;
  const parsedStart = cursorEpoch(body?.billingCycleStart);
  const parsedReset = cursorEpoch(body?.billingCycleEnd);
  const limitType = String(body?.spendLimitUsage?.limitType ?? "").trim().toLowerCase();
  const membershipType = String(body?.membershipType ?? (limitType === "team" ? "team" : "pro")).trim().toLowerCase();
  return {
    used: Math.max(0, Math.min(100, used)),
    startAt: Number.isFinite(parsedStart) ? parsedStart : null,
    resetAt: Number.isFinite(parsedReset) ? parsedReset : fetchedAt + 30 * 24 * 3600_000,
    reportedReset: Number.isFinite(parsedReset),
    membershipType,
  };
}

export class CursorGovernor {
  constructor(config, {
    modelRuntime = null,
    authPath = AUTH_PATH,
    fetcher = fetch,
    readCredential = readStoredCredential,
    cachePath = CURSOR_USAGE_CACHE_PATH,
    feedback = null,
  } = {}) {
    this.config = config;
    this.modelRuntime = modelRuntime;
    this.authPath = authPath;
    this.fetcher = fetcher;
    this.readCredential = readCredential;
    this.cachePath = cachePath;
    this.feedback = feedback ?? new DistributedQuotaFeedback(config, CURSOR_GOVERNOR_STATE_PATH);
    this.pendingAssignments = [];
    this.snapshot = null;
    this.lastGood = null;
    this.refreshing = null;
    this.cooldownUntil = 0;
    try {
      const cached = JSON.parse(fs.readFileSync(this.cachePath, "utf8"));
      const usageFetchedAt = Number(cached?.usageFetchedAt ?? cached?.at);
      if (cached?.usage && Number.isFinite(usageFetchedAt)) this.lastGood = { usage: cached.usage, fetchedAt: usageFetchedAt };
    } catch {}
  }

  setModelRuntime(modelRuntime) { this.modelRuntime = modelRuntime; }

  async refresh(activeAssignments = null) {
    if (activeAssignments) this.pendingAssignments = activeAssignments;
    if (this.snapshot && now() < this.snapshot.expiresAt) return this.snapshot;
    if (this.refreshing) return this.refreshing;
    this.refreshing = this.fetch().finally(() => { this.refreshing = null; });
    return this.refreshing;
  }

  async readUsage(fetchedAt) {
    const stored = this.readCredential(CURSOR_PROVIDER, this.authPath);
    if (stored?.type !== "oauth" || !stored.access) throw new Error("Cursor OAuth credential unavailable");
    if (!this.modelRuntime?.getProvider(CURSOR_PROVIDER)) throw new Error("Cursor provider extension is not loaded");
    const usable = await resolveOAuthCredential({
      modelRuntime: this.modelRuntime,
      provider: CURSOR_PROVIDER,
      baseProvider: CURSOR_PROVIDER,
      stored,
      authPath: this.authPath,
      pollSeconds: this.config.plan.cursor.pollSeconds,
      readCredential: this.readCredential,
    });
    if (!usable) throw new Error("Cursor OAuth credential could not be refreshed");
    const response = await this.fetcher(CURSOR_USAGE_ENDPOINT, {
      method: "POST",
      headers: { Authorization: `Bearer ${usable.access}`, "Content-Type": "application/json" },
      body: "{}",
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`Cursor usage endpoint HTTP ${response.status}`);
    const usage = parseCursorUsage(await response.json(), fetchedAt);
    if (!usage) throw new Error("Cursor usage endpoint returned malformed plan usage");
    return usage;
  }

  async fetch() {
    const fetchedAt = now();
    let usage = null;
    let usageFetchedAt = fetchedAt;
    let stale = false;
    let error = null;
    try {
      usage = await this.readUsage(fetchedAt);
      this.lastGood = { usage, fetchedAt };
    } catch (cause) {
      error = String(cause?.message ?? cause);
      if (this.lastGood && fetchedAt - this.lastGood.fetchedAt <= this.config.plan.cursor.maxStaleSeconds * 1000) {
        usage = this.lastGood.usage;
        usageFetchedAt = this.lastGood.fetchedAt;
        stale = true;
      }
    }
    const paid = usage !== null && ["pro", "pro+", "ultra", "team", "enterprise"].includes(usage.membershipType);
    if (usage && !paid) error = `Cursor membership is not paid: ${usage.membershipType || "missing"}`;
    const target = 100 - this.config.plan.cursor.reservePercent;
    const resources = paid ? [{
      id: CURSOR_PROVIDER,
      provider: CURSOR_PROVIDER,
      group: "cursor",
      used: usage.used,
      resetAt: usage.resetAt,
      reportedReset: usage.reportedReset,
      weight: 1,
      available: Math.max(0, target - usage.used),
    }] : [];
    const active = this.pendingAssignments.filter((assignment) => providerFamily(assignment.provider) === CURSOR_PROVIDER).length;
    const candidate = this.config.plan.cursor.predictedPercentPerActiveHour;
    const distributed = resources.length
      ? this.feedback.observe(resources, { [CURSOR_PROVIDER]: active * candidate }, null, fetchedAt)
      : this.feedback.status;
    this.snapshot = {
      at: fetchedAt,
      usageFetchedAt,
      expiresAt: fetchedAt + this.config.plan.cursor.pollSeconds * 1000,
      healthy: paid ? 1 : 0,
      usage,
      stale,
      distributed,
      error,
    };
    atomicWrite(this.cachePath, `${JSON.stringify(this.snapshot, null, 2)}\n`);
    return this.snapshot;
  }

  noteFailure(error, at = now()) {
    if (/(?:429|rate.?limit|usage limit|exhausted)/i.test(String(error?.message ?? error))) {
      this.cooldownUntil = at + 5 * 60_000;
      this.snapshot = null;
    }
  }

  async restores(variant, activeAssignments, snapshot = null) {
    this.pendingAssignments = activeAssignments;
    const usage = snapshot ?? await this.refresh(activeAssignments);
    const modelAvailable = this.modelRuntime?.getModel(CURSOR_PROVIDER, modelIdOf(variant.model)) !== undefined;
    const sensorHealthy = usage.distributed?.accounts?.[CURSOR_PROVIDER]?.sensorInconsistent !== true;
    const available = usage.healthy === 1 && modelAvailable && sensorHealthy && now() >= this.cooldownUntil &&
      usage.usage?.used < 100 - this.config.plan.cursor.reservePercent;
    return {
      ok: available,
      provider: available ? CURSOR_PROVIDER : null,
      model: variant.model,
      thinking: variant.thinking,
      pressure: 0,
      detail: available
        ? `restored Cursor quota lease at ${usage.usage.used.toFixed(3)}% used`
        : `Cursor quota lease unavailable: used=${usage.usage?.used?.toFixed(3) ?? "unknown"}% model=${modelAvailable ? "available" : "missing"} sensor=${sensorHealthy ? "healthy" : "inconsistent"} error=${usage.error ?? "none"}`,
    };
  }

  async allows(variant, activeAssignments, snapshot = null) {
    this.pendingAssignments = activeAssignments;
    const usage = snapshot ?? await this.refresh(activeAssignments);
    const active = activeAssignments.filter((assignment) => providerFamily(assignment.provider) === CURSOR_PROVIDER).length;
    const candidate = this.config.plan.cursor.predictedPercentPerActiveHour;
    const localBurn = active * candidate;
    const modelAvailable = this.modelRuntime?.getModel(CURSOR_PROVIDER, modelIdOf(variant.model)) !== undefined;
    const sustainable = usage.distributed?.accounts?.[CURSOR_PROVIDER]?.sustainableRate ?? 0;
    const account = { provider: CURSOR_PROVIDER, allowedBurnPercentPerHour: sustainable };
    const eligible = usage.healthy === 1 && modelAvailable && now() >= this.cooldownUntil &&
      usage.usage?.used < 100 - this.config.plan.cursor.reservePercent;
    const accounts = eligible ? [account] : [];
    const adaptive = this.feedback.adaptiveAssignment(
      accounts,
      active > 0 ? [{ provider: CURSOR_PROVIDER, rate: localBurn }] : [],
      runModelKey(variant),
      candidate,
      now(),
    );
    const selected = adaptive.selected;
    const remaining = usage.usage ? 100 - usage.usage.used : 0;
    return {
      ok: selected !== null,
      provider: selected ? CURSOR_PROVIDER : null,
      model: variant.model,
      thinking: variant.thinking,
      pressure: adaptive.pressure,
      detail: selected
        ? `Cursor dynamic gate active=${active} local=${adaptive.localLoad.toFixed(3)} candidate=${candidate.toFixed(3)} allowance=${adaptive.allowance.toFixed(3)} share=${usage.distributed.share.toFixed(3)} used=${usage.usage.used.toFixed(3)}% remaining=${remaining.toFixed(3)}% resets=${iso(usage.usage.resetAt)}`
        : `Cursor dynamic gate closed: active=${active} local=${adaptive.localLoad.toFixed(3)} candidate=${candidate.toFixed(3)} allowance=${adaptive.allowance.toFixed(3)} share=${usage.distributed.share.toFixed(3)} used=${usage.usage?.used?.toFixed(3) ?? "unknown"}% model=${modelAvailable ? "available" : "missing"} error=${usage.error ?? "none"}`,
    };
  }
}

export class PlanGovernor {
  constructor(config, { modelRuntime = null, authPath = AUTH_PATH, lifecyclePath = MULTI_PASS_PATH, fetcher = fetch, readCredential = readStoredCredential, anthropic = null, cursor = null, feedback = null, usageMultiplier = () => 1 } = {}) {
    this.config = config;
    this.usageMultiplier = usageMultiplier;
    this.modelRuntime = modelRuntime;
    this.authPath = authPath;
    this.lifecyclePath = lifecyclePath;
    this.fetcher = fetcher;
    this.readCredential = readCredential;
    this.snapshot = null;
    this.refreshing = null;
    this.pendingAssignments = [];
    this.feedback = feedback ?? new DistributedQuotaFeedback(config, CODEX_GOVERNOR_STATE_PATH);
    this.anthropic = anthropic ?? new AnthropicGovernor(config, { modelRuntime, authPath, fetcher, readCredential, usageMultiplier });
    this.cursor = cursor ?? new CursorGovernor(config, { modelRuntime, authPath, fetcher, readCredential });
  }

  setModelRuntime(modelRuntime) {
    this.modelRuntime = modelRuntime;
    this.anthropic.setModelRuntime(modelRuntime);
    this.cursor.setModelRuntime(modelRuntime);
  }

  async authRuntime() {
    if (!this.modelRuntime) this.setModelRuntime(await ModelRuntime.create({ signal: AbortSignal.timeout(15000) }));
    return this.modelRuntime;
  }

  async resolveCredential(provider, stored) {
    const runtime = await this.authRuntime();
    return resolveOAuthCredential({
      modelRuntime: runtime,
      provider,
      baseProvider: CODEX_PROVIDER,
      stored,
      authPath: this.authPath,
      pollSeconds: this.config.plan.pollSeconds,
      readCredential: this.readCredential,
    });
  }

  async refresh(activeAssignments = null) {
    if (activeAssignments) this.pendingAssignments = activeAssignments;
    const allowanceMultiplier = this.usageMultiplier(CODEX_PROVIDER);
    if (this.snapshot && this.snapshot.allowanceMultiplier === allowanceMultiplier && now() < this.snapshot.expiresAt) return this.snapshot;
    if (this.refreshing) return this.refreshing;
    this.refreshing = this.fetch().finally(() => { this.refreshing = null; });
    return this.refreshing;
  }

  async fetch() {
    const auth = JSON.parse(fs.readFileSync(this.authPath, "utf8"));
    const configured = configuredOAuthAccounts(auth, CODEX_PROVIDER);
    if (!configured.length) fail("plan governor found no Codex OAuth accounts");
    const fetchedAt = now();
    const lifecycle = readCodexSubscriptionLifecycle(this.lifecyclePath, fetchedAt);
    const retired = new Set(lifecycle.retiredProviders);
    const routable = configured.filter(([provider]) => !retired.has(provider));
    const endpoint = `${(process.env.CHATGPT_BASE_URL ?? "https://chatgpt.com/backend-api").replace(/\/$/, "")}/wham/usage`;
    const results = await Promise.all(routable.map(async ([provider, credential]) => {
      try {
        // Resolve near-expiry OAuth through Pi's locked credential path before
        // trusting /wham/usage. A still-valid access token does not prove that
        // its one-use refresh token remains usable.
        const usable = await this.resolveCredential(provider, credential);
        if (!usable) return null;
        const response = await this.fetcher(endpoint, {
          signal: AbortSignal.timeout(10000),
          headers: {
            Authorization: `Bearer ${usable.access}`,
            "chatgpt-account-id": usable.accountId,
            Accept: "application/json",
            "User-Agent": "works.kenan.agent-orchestrator"
          }
        });
        if (!response.ok) return null;
        const body = await response.json();
        if (!isEligibleCodexPlan(body.plan_type)) return null;
        const rate = body.rate_limit ?? {};
        const windows = [rate.primary_window, rate.secondary_window].filter(Boolean).map((window) => ({
          used: Number(window.used_percent),
          resetAt: Number(window.reset_at) * 1000,
          durationSeconds: Number(window.limit_window_seconds),
          allowedBurnPercentPerHour: planWindowBurnPerHour(window, fetchedAt),
        })).filter((window) => Number.isFinite(window.used) && Number.isFinite(window.resetAt) && window.allowedBurnPercentPerHour !== null);
        if (!windows.length) return null;
        const binding = [...windows].sort((left, right) => left.allowedBurnPercentPerHour - right.allowedBurnPercentPerHour)[0];
        const hours = Math.max(1 / 60, (binding.resetAt - fetchedAt) / 3600_000);
        const target = this.config.plan.distributed?.targetPercent ?? DEFAULT_CONFIG.plan.distributed.targetPercent;
        const allowedBurnPercentPerHour = Math.max(0, target - binding.used) / hours;
        return { provider, planType: body.plan_type.trim().toLowerCase(), allowedBurnPercentPerHour, binding, windows };
      } catch { return null; }
    }));
    const accounts = results.filter((value) => value !== null);
    if (!accounts.length) fail("plan governor could not read any Codex account");
    const localAssignments = this.pendingAssignments.filter((item) => providerFamily(item.provider) === CODEX_PROVIDER);
    const localPredictedRate = Object.fromEntries(accounts.map((account) => [account.provider, 0]));
    for (const item of localAssignments) {
      localPredictedRate[item.provider] = (localPredictedRate[item.provider] ?? 0) + this.modelRate(item.model ? item : item.task);
    }
    const resources = accounts.map((account) => ({
      id: account.provider,
      provider: account.provider,
      group: "codex",
      used: account.binding.used,
      resetAt: account.binding.resetAt,
      weight: 1,
      available: Math.max(0, (this.config.plan.distributed?.targetPercent ?? DEFAULT_CONFIG.plan.distributed.targetPercent) - account.binding.used),
    }));
    const allowanceMultiplier = this.usageMultiplier(CODEX_PROVIDER);
    const distributed = this.feedback.observe(resources, localPredictedRate, {
      accounts,
      assignments: localAssignments,
      priors: this.config.plan.modelBurnPercentPerHour,
      rate: (value) => this.config.plan.modelBurnPercentPerHour[runModelKey(value)] ?? 0,
    }, fetchedAt, allowanceMultiplier);
    const snapshotAt = now();
    this.snapshot = {
      at: snapshotAt,
      allowanceMultiplier,
      expiresAt: Math.min(snapshotAt + this.config.plan.pollSeconds * 1000, lifecycle.nextRetirementAt),
      healthy: accounts.length,
      withHeadroom: accounts.filter((account) => account.allowedBurnPercentPerHour > 0).length,
      configured: configured.length,
      retired: lifecycle.retiredProviders.length,
      retiredProviders: lifecycle.retiredProviders,
      allowedBurnPercentPerHour: accounts.reduce((sum, account) => sum + account.allowedBurnPercentPerHour, 0),
      distributed,
      accounts,
    };
    return this.snapshot;
  }

  modelRate(value) {
    const key = runModelKey(value);
    const prior = this.config.plan.modelBurnPercentPerHour[key];
    if (!(Number.isFinite(prior) && prior >= 0)) fail(`no plan burn rate configured for ${key}`);
    return this.feedback.estimate(key, prior);
  }

  async allowsCodex(variant, activeAssignments, plan = null) {
    this.pendingAssignments = activeAssignments;
    const snapshot = plan ?? await this.refresh(activeAssignments);
    const candidate = this.modelRate(variant);
    const allowanceMultiplier = this.usageMultiplier(CODEX_PROVIDER);
    const codexAssignments = activeAssignments
      .filter((item) => providerFamily(item.provider) === CODEX_PROVIDER)
      .map((item) => ({ provider: item.provider, rate: this.modelRate(item.model ? item : item.task) }));
    const adaptive = this.feedback.adaptiveAssignment(
      snapshot.accounts,
      codexAssignments,
      runModelKey(variant),
      candidate,
      now(),
      allowanceMultiplier,
    );
    const selected = adaptive.selected;
    return {
      ok: selected !== null,
      provider: selected?.account.provider ?? null,
      model: variant.model,
      thinking: variant.thinking,
      instrumentBlock: selected?.block ?? null,
      instrumentSign: selected?.sign ?? null,
      pressure: adaptive.pressure,
      detail: selected
        ? `Codex account=${selected.account.provider} local=${adaptive.localLoad.toFixed(3)} candidate=${candidate.toFixed(3)} allowance=${adaptive.allowance.toFixed(3)} multiplier=${allowanceMultiplier} share=${snapshot.distributed.share.toFixed(3)} sustainable=${snapshot.distributed.sustainableRate.toFixed(3)}`
        : `Codex distributed gate closed: local=${adaptive.localLoad.toFixed(3)} candidate=${candidate.toFixed(3)} allowance=${adaptive.allowance.toFixed(3)} multiplier=${allowanceMultiplier} share=${snapshot.distributed.share.toFixed(3)} sustainable=${snapshot.distributed.sustainableRate.toFixed(3)} observed=${snapshot.distributed.observedRate?.toFixed(3) ?? "unknown"}`,
    };
  }

  noteFailure(assignment, error) {
    if (providerFamily(assignment.provider) === ANTHROPIC_PROVIDER) this.anthropic.noteFailure(assignment.provider, error);
    if (providerFamily(assignment.provider) === CURSOR_PROVIDER) this.cursor.noteFailure(error);
    if (providerFamily(assignment.provider) === CODEX_PROVIDER && /(?:429|rate.?limit|usage limit|exhausted)/i.test(String(error?.message ?? error))) {
      this.snapshot = null;
    }
  }

  async restores(lease, activeAssignments) {
    const family = providerFamily(lease.provider ?? providerOf(lease.model));
    const governor = governorKind(lease.provider ?? providerOf(lease.model));
    const variant = { model: lease.model, thinking: lease.thinking };
    if (governor === "codex") {
      const snapshot = await this.refresh(activeAssignments);
      const activeRates = activeAssignments
        .filter((item) => providerFamily(item.provider) === CODEX_PROVIDER)
        .map((item) => ({ provider: item.provider, rate: this.modelRate(item.model ? item : item.task) }));
      const accounts = snapshot.accounts.filter((account) => account.allowedBurnPercentPerHour > 0 &&
        !snapshot.distributed.accounts?.[account.provider]?.sensorInconsistent &&
        (lease.provider === null || lease.provider === undefined || account.provider === lease.provider));
      const selected = this.feedback.selectAccount(
        accounts, activeRates, runModelKey(variant), this.modelRate(variant), now(), this.usageMultiplier(CODEX_PROVIDER),
      );
      return selected ? {
        ok: true,
        provider: selected.account.provider,
        ...variant,
        instrumentBlock: selected.block,
        instrumentSign: selected.sign,
        pressure: 0,
        detail: `restored Codex quota lease on ${selected.account.provider}`,
      } : { ok: false, detail: `Codex quota lease account unavailable: ${lease.provider ?? "any"}` };
    }
    if (governor === "cursor") {
      return this.cursor.restores(variant, activeAssignments);
    }
    if (governor === "anthropic") {
      const usage = await this.anthropic.refresh(activeAssignments);
      const activeByProvider = new Map();
      for (const item of activeAssignments.filter((item) => providerFamily(item.provider) === ANTHROPIC_PROVIDER)) {
        activeByProvider.set(item.provider, (activeByProvider.get(item.provider) ?? 0) + 1);
      }
      const accounts = usage.accounts.filter((account) => anthropicOpusHasHeadroom(account) &&
        (this.anthropic.cooldowns.get(account.provider) ?? 0) <= now() &&
        !usage.distributed.accounts?.[account.provider]?.sensorInconsistent &&
        (lease.provider === null || lease.provider === undefined || account.provider === lease.provider))
        .map((account) => ({ ...account, allowedBurnPercentPerHour: usage.distributed.accounts?.[account.provider]?.sustainableRate ?? 0 }));
      const candidate = this.config.plan.anthropic.predictedPercentPerActiveHour ?? DEFAULT_CONFIG.plan.anthropic.predictedPercentPerActiveHour;
      const activeRates = [...activeByProvider.entries()].map(([provider, active]) => ({ provider, rate: active * candidate }));
      const selected = this.anthropic.feedback.selectAccount(
        accounts, activeRates, runModelKey(variant), candidate, now(), this.usageMultiplier(ANTHROPIC_PROVIDER),
      );
      return selected ? {
        ok: true,
        provider: selected.account.provider,
        ...variant,
        instrumentBlock: selected.block,
        instrumentSign: selected.sign,
        pressure: 0,
        detail: `restored Anthropic quota lease on ${selected.account.provider}`,
      } : { ok: false, detail: `Anthropic quota lease account unavailable: ${lease.provider ?? "any"}` };
    }
    return { ok: false, detail: `quota leases do not support provider family ${family}` };
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
        model: task.model,
        thinking: task.thinking,
        detail: `ChatGPT Pro eligible=${entitlement.eligible} reserved=${reserved} available=${available}`,
      };
    }
    const evaluate = (variant) => {
      const family = providerFamily(providerOf(variant.model));
      const governor = governorKind(providerOf(variant.model));
      if (governor === "codex") return this.allowsCodex(variant, activeAssignments);
      if (governor === "anthropic") return this.anthropic.allows(variant, activeAssignments);
      if (governor === "cursor") return this.cursor.allows(variant, activeAssignments);
      return Promise.resolve({
        ok: false,
        provider: null,
        model: variant.model,
        thinking: variant.thinking,
        pressure: Number.POSITIVE_INFINITY,
        detail: `No quota governor for provider family ${family}`,
      });
    };
    const results = await Promise.all(taskVariants(this.config, task).map(evaluate));
    const selected = chooseIndependentAssignment(results);
    const detail = `independent provider gates; ${results.map((result) => result.detail).join("; ")}`;
    return selected ? { ...selected, detail } : { ...results[0], detail };
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
  return { content: [{ type: "text", text }], details };
}

export function orchestratedTaskPrompt(task) {
  return `${task.prompt}\n\n## Orchestrated task contract\nTask: ${task.id}\nCompletion condition: ${task.completion_condition}\nThis task runs repeatedly and may run concurrently with other launches; make external effects idempotent and use the project's claim/lease tools. Follow the task's stated cadence and own the session boundary: complete coherent work, preserve directly resumable state for larger follow-on work, and return promptly when extending this turn would delay the next heartbeat or another useful lane. Explore whatever files, state, or tools help you do the work well, and exercise initiative: retry transient failures, and repair broken tooling at its owning layer instead of reporting around it. Before finishing, call task_complete with the validated result; calling it again replaces the earlier report, so keep it current if you continue working. Set complete=true only if the completion condition is satisfied. Set productive=false only if this launch processed no work unit at all; otherwise omit it or set productive=true.`;
}

export const WORK_CHECK_TTL_MS = 15_000;
export const WORK_CHECK_TIMEOUT_MS = 30_000;
export const DISPATCH_TIMEOUT_MS = 120_000;

// A dispatch command claims one work unit for the imminent launch (worker id =
// the run id) and prints a complete context packet on stdout, so the agent's
// first tokens go to the work instead of orientation. Exit 0: packet ready.
// Exit 1: nothing claimable (a work-check race). Anything else is a dispatch
// defect: fail open to launch-and-discover so a broken dispatcher can never
// starve its task.
export async function evaluateDispatch(task, runId, runner = execFileAsync) {
  try {
    const result = await runner("bash", ["-lc", task.dispatch], {
      cwd: task.cwd,
      timeout: DISPATCH_TIMEOUT_MS,
      maxBuffer: 16 * 1024 * 1024,
      env: { ...process.env, ORCHESTRATOR_RUN_ID: runId },
    });
    const packet = String(result.stdout ?? "").trim();
    if (!packet) return { state: "error", detail: "dispatch produced an empty packet" };
    return { state: "packet", packet };
  } catch (error) {
    const output = [error?.stdout, error?.stderr].map((value) => String(value ?? "").trim()).filter(Boolean).join("\n");
    if (error?.code === 1 && !error?.killed) {
      return { state: "no-work", detail: output || "no claimable work" };
    }
    return { state: "error", detail: output || String(error?.message ?? error) };
  }
}

export function dispatchedTaskPrompt(task, packet) {
  return `${orchestratedTaskPrompt(task)}\n\n## Dispatched work unit\n\nThe controller has already claimed one work unit for this launch and assembled its context below. Do not repeat the claim step; begin working this unit directly. Treat any truncated section as regenerable through the printed command.\n\n${packet}`;
}

// Exit 0: claimable work exists. Exit 1: no claimable work. Any other outcome
// (spawn failure, other exit codes, timeout) is a probe defect: fail open so a
// broken probe degrades to launch-and-discover instead of silently starving
// the task, and surface the defect as a controller event.
export async function evaluateWorkCheck(task, runner = execFileAsync) {
  try {
    const result = await runner("bash", ["-lc", task.work_check], {
      cwd: task.cwd,
      timeout: WORK_CHECK_TIMEOUT_MS,
      maxBuffer: 1024 * 1024,
    });
    return { state: "work", detail: String(result.stdout ?? "").trim() || "work available" };
  } catch (error) {
    const output = [error?.stdout, error?.stderr].map((value) => String(value ?? "").trim()).filter(Boolean).join("\n");
    if (error?.code === 1 && !error?.killed) {
      return { state: "no-work", detail: output || "no claimable work" };
    }
    return { state: "error", detail: output || String(error?.message ?? error) };
  }
}

export function workCheckStale(task, at = now()) {
  return Boolean(task.work_check) &&
    (task.work_state === null || task.work_state === undefined ||
      at - Number(task.work_checked_at ?? 0) >= WORK_CHECK_TTL_MS);
}

export async function validateCompletion(task, runner = execFileAsync) {
  if (!task.completion_check) return { ok: true, detail: "no completion check configured" };
  try {
    const result = await runner("bash", ["-lc", task.completion_check], {
      cwd: task.cwd,
      maxBuffer: 16 * 1024 * 1024,
    });
    return { ok: true, detail: String(result.stdout ?? "").trim() || "completion check passed" };
  } catch (error) {
    const output = [error?.stdout, error?.stderr].map((value) => String(value ?? "").trim()).filter(Boolean).join("\n");
    return { ok: false, detail: output || String(error?.message ?? error) };
  }
}
export function launchBatchSize(resourceSlotCount) {
  return resourceSlotCount > 0 ? 1 : 0;
}
export function taskSettings(cwd, agentDir = getAgentDir()) {
  return SettingsManager.create(cwd, agentDir);
}
export function isolateTaskShell(settingsManager) {
  // DefaultResourceLoader.reload() reloads SettingsManager and clears runtime
  // overrides. Apply containment only after resource discovery has finished.
  settingsManager.applyOverrides({ shellPath: TOOL_SHELL });
  return settingsManager;
}
export function shouldAdvanceBackoff(nextEligibleAt, runStartedAt) { return Number(nextEligibleAt) <= Number(runStartedAt); }

export function insertRun(db, runId, taskId, provider = null, startedAt = now(), model = null, thinking = null) {
  db.prepare("INSERT INTO run(id,task_id,status,started_at,provider,model,thinking) VALUES(?,?,?,?,?,?,?)")
    .run(runId, taskId, "running", startedAt, provider, model, thinking);
}

export function grantQuotaLease(db, config, { provider, model, thinking, taskId = null, hours = null }, at = now()) {
  if (!(typeof provider === "string" && provider.length > 0)) fail("quota lease requires an exact provider");
  if (!(typeof model === "string" && model.includes("/") && typeof thinking === "string" && thinking.length > 0)) {
    fail("quota lease requires a model and thinking level");
  }
  validateModelPolicy(model);
  const family = providerFamily(provider);
  if (family !== providerFamily(providerOf(model))) fail(`provider ${provider} cannot run ${model}`);
  if (!["codex", "anthropic", "cursor"].includes(governorKind(provider))) fail(`quota leases do not support provider family ${family}`);
  if (taskId !== null) {
    const task = db.prepare("SELECT * FROM task WHERE id=?").get(taskId);
    if (!task) fail(`unknown task ${taskId}`);
    if (!taskSupportsAssignment(config, task, { model, thinking })) fail(`task ${taskId} cannot consume ${model}:${thinking}`);
  }
  const leaseHours = hours === null ? config.plan.distributed.leaseHours : Number(hours);
  if (!(Number.isFinite(leaseHours) && leaseHours > 0)) fail("quota lease hours must be positive");
  const id = randomId();
  db.prepare(`INSERT INTO quota_lease(id,task_id,provider,model,thinking,state,run_id,source,issued_at,expires_at,heartbeat_at)
    VALUES(?,?,?,?,?,'available',NULL,'operator',?,?,?)`)
    .run(id, taskId, provider, model, thinking, at, at + leaseHours * 3600_000, at);
  event(db, "quota-lease-granted", `${model}:${thinking} via ${provider}; expires ${iso(at + leaseHours * 3600_000)}`, taskId);
  return id;
}

async function loadExtensionProviders(modelRuntime, cwd = HOME) {
  const settingsManager = SettingsManager.create(cwd, getAgentDir());
  const loader = new DefaultResourceLoader({ cwd, agentDir: getAgentDir(), settingsManager });
  await loader.reload();
  const loaded = await createAgentSession({
    cwd,
    modelRuntime,
    resourceLoader: loader,
    settingsManager,
    sessionManager: SessionManager.inMemory(cwd),
    noTools: "all",
  });
  if (loaded.extensionsResult.errors.length) {
    loaded.session.dispose();
    fail(`extension loading failed: ${loaded.extensionsResult.errors.map((item) => item.error).join("; ")}`);
  }
  return loaded.session;
}

export class Controller {
  constructor(db, config) {
    this.db = db;
    this.config = config;
    this.modelRuntime = null;
    this.plan = new PlanGovernor(config, {
      usageMultiplier: (providerFamily) => governorAllowanceMultiplier(this.db, providerFamily),
    });
    this.active = new Map();
    this.stopping = false;
    this.stopPromise = null;
    this.lastThrottledEvents = new Map();
    this.lastControllerError = { at: 0, detail: "" };
    this.previousCpu = cpuTotals();
  }

  recover() {
    const at = now();
    this.db.prepare(
      "UPDATE dispatch_reservation SET state='terminal',finished_at=? WHERE state='active'"
    ).run(at);
    const restartWindow = (this.config.plan?.distributed?.restartLeaseMinutes ?? DEFAULT_CONFIG.plan.distributed.restartLeaseMinutes) * 60_000;
    const interrupted = this.db.prepare("SELECT id,task_id,provider,model,thinking,started_at FROM run WHERE status='running'").all();
    const finish = this.db.prepare("UPDATE run SET status='interrupted',finished_at=?,error=?,productive=0 WHERE id=?");
    const resume = this.db.prepare("UPDATE task SET incomplete_streak=0,next_eligible_at=min(next_eligible_at,?) WHERE id=?");
    for (const row of interrupted) {
      const lease = this.db.prepare("SELECT * FROM quota_lease WHERE run_id=?").get(row.id);
      if (lease && lease.heartbeat_at >= at - restartWindow) {
        this.db.prepare("UPDATE quota_lease SET state='available',task_id=?,run_id=NULL,expires_at=max(expires_at,?),heartbeat_at=? WHERE id=?")
          .run(row.task_id, at + restartWindow, at, lease.id);
        event(this.db, "quota-lease-handoff", `${row.model}:${row.thinking} via ${row.provider}`, row.task_id, row.id);
      } else if (!lease && row.provider && row.model && row.thinking && row.started_at >= at - restartWindow) {
        const id = randomId();
        this.db.prepare(`INSERT INTO quota_lease(id,task_id,provider,model,thinking,state,run_id,source,issued_at,expires_at,heartbeat_at)
          VALUES(?,?,?,?,?,'available',NULL,'governor',?,?,?)`)
          .run(id, row.task_id, row.provider, row.model, row.thinking, at, at + restartWindow, at);
        event(this.db, "quota-lease-handoff", `${row.model}:${row.thinking} via ${row.provider}`, row.task_id, row.id);
      } else if (lease) {
        this.db.prepare("DELETE FROM quota_lease WHERE id=?").run(lease.id);
      }
      finish.run(at, "controller restarted while run was active", row.id);
      resume.run(at, row.task_id);
      event(this.db, "run-interrupted", "controller restart", row.task_id, row.id);
    }
    this.db.prepare("DELETE FROM quota_lease WHERE state='available' AND expires_at<=?").run(at);
    this.db.prepare(`DELETE FROM quota_lease WHERE state='active' AND
      (run_id IS NULL OR NOT EXISTS (SELECT 1 FROM run WHERE run.id=quota_lease.run_id AND run.status='running'))`).run();
  }

  async init() {
    this.recover();
    for (const task of taskRows(this.db)) validateModelPolicy(task.model);
    this.modelRuntime = await ModelRuntime.create({ signal: AbortSignal.timeout(15000) });
    const bootstrap = await loadExtensionProviders(this.modelRuntime);
    bootstrap.dispose();
    this.plan.setModelRuntime(this.modelRuntime);
    // A restart aborts in-flight Pro polls while ChatGPT keeps reasoning
    // server-side; harvest those conversations instead of stranding them.
    void recoverPendingProConversations({
      log: (result) => event(this.db, "pro-recovery", JSON.stringify(result)),
    }).catch((error) => this.controllerError(`pro recovery failed: ${String(error?.message ?? error)}`));
  }

  async restoreQuotaLease(task, activeAssignments) {
    const leases = this.db.prepare(`SELECT * FROM quota_lease
      WHERE state='available' AND expires_at>? AND (task_id=? OR task_id IS NULL)
      ORDER BY CASE WHEN task_id=? THEN 0 ELSE 1 END,issued_at,id`).all(now(), task.id, task.id);
    for (const lease of leases) {
      if (!taskSupportsAssignment(this.config, task, lease)) {
        if (lease.source === "governor" && lease.task_id === task.id) {
          this.db.prepare("UPDATE quota_lease SET task_id=NULL,provider=NULL,heartbeat_at=? WHERE id=? AND state='available'")
            .run(now(), lease.id);
          event(this.db, "quota-lease-released", "interrupted assignment no longer matches its task; lease returned to its model lane", task.id);
        }
        continue;
      }
      const restored = await this.plan.restores(lease, activeAssignments);
      if (restored.ok) return { ...restored, leaseId: lease.id };
      this.throttledEvent("quota-lease-blocked", restored.detail, task.id);
      if (lease.source === "governor" && lease.task_id === task.id) {
        this.db.prepare("UPDATE quota_lease SET task_id=NULL,provider=NULL,heartbeat_at=? WHERE id=? AND state='available'")
          .run(now(), lease.id);
        event(this.db, "quota-lease-released", "unsafe interrupted assignment returned to its model lane", task.id);
      }
    }
    return null;
  }

  activateQuotaLease(task, assignment, runId, at) {
    if (isChatGptProTask(task)) return null;
    if (assignment.leaseId) {
      const changed = this.db.prepare(`UPDATE quota_lease SET state='active',task_id=?,provider=?,run_id=?,heartbeat_at=?
        WHERE id=? AND state='available' AND expires_at>?`)
        .run(task.id, assignment.provider, runId, at, assignment.leaseId, at).changes;
      if (changed !== 1) fail(`quota lease ${assignment.leaseId} is no longer available`);
      return assignment.leaseId;
    }
    const id = randomId();
    const expiresAt = at + (this.config.plan?.distributed?.leaseHours ?? DEFAULT_CONFIG.plan.distributed.leaseHours) * 3600_000;
    this.db.prepare(`INSERT INTO quota_lease(id,task_id,provider,model,thinking,state,run_id,source,issued_at,expires_at,heartbeat_at)
      VALUES(?,?,?,?,?,'active',?,'governor',?,?,?)`)
      .run(id, task.id, assignment.provider, assignment.model, assignment.thinking, runId, at, expiresAt, at);
    return id;
  }

  heartbeatQuotaLeases(at = now()) {
    if (!this.active.size) return;
    this.db.prepare(`UPDATE quota_lease SET heartbeat_at=? WHERE state='active' AND run_id IN
      (SELECT id FROM run WHERE status='running')`).run(at);
  }

  async launch(task, assignment, runId = randomId(), packet = null, dispatchMs = null) {
    const startedAt = now();
    this.db.exec("BEGIN IMMEDIATE");
    let leaseId;
    try {
      insertRun(this.db, runId, task.id, assignment.provider, startedAt, assignment.model, assignment.thinking);
      this.db.prepare("UPDATE run SET dispatched=? WHERE id=?").run(packet === null ? 0 : 1, runId);
      if (packet !== null) {
        const transferred = this.db.prepare(
          "DELETE FROM dispatch_reservation WHERE run_id=? AND state='active'"
        ).run(runId).changes;
        if (transferred !== 1) fail(`missing active dispatch reservation ${runId}`);
      }
      leaseId = this.activateQuotaLease(task, assignment, runId, startedAt);
      const note = packet === null ? "" : ` (dispatched ${dispatchMs ?? "?"}ms, ${packet.length}B)`;
      event(this.db, "run-started", `${runModelKey(assignment)} via ${assignment.provider}${note}`, task.id, runId);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      if (packet !== null) {
        this.db.prepare(
          "UPDATE dispatch_reservation SET state='terminal',finished_at=? WHERE run_id=?"
        ).run(now(), runId);
      }
      throw error;
    }
    const promise = this.execute(task, runId, assignment, packet).finally(() => this.active.delete(runId));
    this.active.set(runId, { task, ...assignment, leaseId, promise });
  }

  async execute(task, runId, assignment, packet = null) {
    let session;
    let report = null;
    let sessionId = null;
    try {
      const bootstrap = isChatGptProTask(task) ? `openai-codex/gpt-5.6-sol:${assignment.thinking}` : runModelKey(assignment);
      const resolved = resolveCliModel({ cliModel: bootstrap, modelRuntime: this.modelRuntime });
      if (resolved.error || !resolved.model) fail(resolved.error ?? `cannot resolve bootstrap for ${runModelKey(task)}`);
      const completionTool = defineTool({
        name: "task_complete",
        label: "Complete task launch",
        description: "Report this launch's validated output. Call it when your work is done; if you keep working afterward, call it again and the newest report replaces the old one. Set complete=true only when the task completion condition is now satisfied. Set productive=false only when this launch processed no work unit at all; idle reports receive bounded backoff instead of immediately launching another agent.",
        parameters: Type.Object({
          complete: Type.Boolean(),
          productive: Type.Optional(Type.Boolean({ description: "Whether this launch claimed and processed a real work unit. Defaults to true." })),
          summary: Type.String({ minLength: 1 }),
          artifacts: Type.Optional(Type.Array(Type.String()))
        }),
        execute: async (_id, parameters) => {
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
              : "Launch output recorded; the task remains eligible. If you continue working, call task_complete again to update this report.";
          return completionToolResult(text, report);
        }
      });
      const customTools = [completionTool];
      const settingsManager = taskSettings(task.cwd);
      const loader = new DefaultResourceLoader({
        cwd: task.cwd,
        agentDir: getAgentDir(),
        settingsManager,
        extensionFactories: [{
          name: "pi-usage-logger",
          factory: createUsageLogger({ owner: { kind: "orchestrator", id: runId, label: task.id } }),
        }],
      });
      await loader.reload();
      isolateTaskShell(settingsManager);
      const extensionErrors = loader.getExtensions().errors;
      if (extensionErrors.length) fail(`extension loading failed: ${extensionErrors.map((item) => item.error).join("; ")}`);
      ({ session } = await createAgentSession({
        cwd: task.cwd,
        modelRuntime: this.modelRuntime,
        model: resolved.model,
        thinkingLevel: resolved.thinkingLevel,
        resourceLoader: loader,
        customTools,
        sessionManager: SessionManager.create(task.cwd, SESSIONS),
        settingsManager,
      }));
      const targetProvider = isChatGptProTask(task) ? providerOf(assignment.model) : assignment.provider;
      const targetModelId = modelIdOf(assignment.model);
      if (targetProvider !== resolved.model.provider || targetModelId !== resolved.model.id) {
        const routed = (await this.modelRuntime.getAvailable()).find((model) => model.provider === targetProvider && model.id === targetModelId);
        if (!routed) fail(`governor-selected model unavailable after extension load: ${targetProvider}/${targetModelId}`);
        await session.setModel(routed);
        session.setThinkingLevel(assignment.thinking);
      }
      this.active.get(runId).session = session;
      sessionId = session.sessionId;
      this.db.prepare("UPDATE run SET session_id=? WHERE id=?").run(sessionId, runId);
      // A Pro task's dispatched packet IS the literal text-only prompt (one
      // claimed question from the queue); the task prompt is only the fallback.
      const prompt = isChatGptProTask(task)
        ? (packet ?? task.prompt)
        : packet !== null
          ? dispatchedTaskPrompt(task, packet)
          : orchestratedTaskPrompt(task);
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
      const interrupted = this.stopping;
      if (!interrupted) this.plan.noteFailure(assignment, error);
      this.finish(
        task, runId, "incomplete", report?.summary ?? null,
        report?.artifacts ?? [],
        interrupted ? "controller shutdown interrupted run" : String(error?.message ?? error),
        false, interrupted,
      );
    } finally {
      session?.dispose();
    }
  }

  finish(task, runId, status, summary, artifacts, error, productive = true, suppressBackoff = false) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("UPDATE run SET status=?,finished_at=?,summary=?,artifacts_json=?,error=?,productive=? WHERE id=?")
        .run(status, now(), summary, JSON.stringify(artifacts), error, productive ? 1 : 0, runId);
      const lease = this.db.prepare("SELECT * FROM quota_lease WHERE run_id=?").get(runId);
      if (lease) {
        if (suppressBackoff) {
          const restartUntil = now() + (this.config.plan?.distributed?.restartLeaseMinutes ?? DEFAULT_CONFIG.plan.distributed.restartLeaseMinutes) * 60_000;
          this.db.prepare("UPDATE quota_lease SET state='available',task_id=?,run_id=NULL,expires_at=max(expires_at,?),heartbeat_at=? WHERE id=?")
            .run(task.id, restartUntil, now(), lease.id);
        } else if (status === "incomplete" && productive && lease.expires_at > now()) {
          this.db.prepare(`UPDATE quota_lease SET
            state='available',
            task_id=CASE WHEN source='governor' THEN NULL ELSE task_id END,
            provider=CASE WHEN source='governor' THEN NULL ELSE provider END,
            run_id=NULL,
            heartbeat_at=?
            WHERE id=?`).run(now(), lease.id);
        } else {
          this.db.prepare("DELETE FROM quota_lease WHERE id=?").run(lease.id);
        }
      }
      if (status === "complete") {
        this.db.prepare("UPDATE task SET completed_at=?,incomplete_streak=0 WHERE id=? AND completed_at IS NULL").run(now(), task.id);
      } else if (suppressBackoff) {
        this.db.prepare("UPDATE task SET incomplete_streak=0,next_eligible_at=min(next_eligible_at,?) WHERE id=?")
          .run(now(), task.id);
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

  throttledEvent(kind, detail, taskId, intervalOnly = false) {
    const key = `${kind}:${taskId}`;
    const previous = this.lastThrottledEvents.get(key) ?? { at: 0, detail: "" };
    const due = intervalOnly
      ? now() - previous.at >= 300_000
      : detail !== previous.detail || now() - previous.at >= 60_000;
    if (due) {
      const at = now();
      event(this.db, kind, detail, taskId);
      this.lastThrottledEvents.set(key, { at, detail });
    }
  }

  governorBlocked(detail, taskId) {
    // Blocked details embed live burn numbers that change every launch; a
    // detail-sensitive throttle would record one event per tick forever.
    this.throttledEvent("governor-blocked", detail, taskId, true);
  }

  purgeOldEvents() {
    if (now() - (this.lastEventPurge ?? 0) < 6 * 3600_000) return;
    this.lastEventPurge = now();
    this.db.prepare("DELETE FROM event WHERE at < ?").run(now() - 14 * 86400_000);
  }

  // Refresh stale work probes for every live probe-carrying task, including
  // tasks currently in idle backoff: the arrival of new work — not the passage
  // of time — is what makes such a task launchable again, so a no-work→work
  // transition clears the timed pause established while the queue was empty.
  async refreshWorkChecks(tasks, runner = execFileAsync) {
    const at = now();
    const due = tasks.filter((task) =>
      task.completed_at === null && task.cancelled_at === null &&
      task.not_before <= at && workCheckStale(task, at));
    if (!due.length) return;
    const results = await Promise.all(due.map(async (task) => ({ task, result: await evaluateWorkCheck(task, runner) })));
    for (const { task, result } of results) {
      const previous = task.work_state ?? null;
      const checkedAt = now();
      this.db.prepare("UPDATE task SET work_state=?,work_checked_at=? WHERE id=?")
        .run(result.state, checkedAt, task.id);
      task.work_state = result.state;
      task.work_checked_at = checkedAt;
      if (result.state === "error") {
        this.throttledEvent("work-check-error", result.detail, task.id);
      } else if (result.state === "work" && previous === "no-work") {
        this.db.prepare("UPDATE task SET next_eligible_at=min(next_eligible_at,?),incomplete_streak=0 WHERE id=?")
          .run(checkedAt, task.id);
        task.next_eligible_at = Math.min(Number(task.next_eligible_at), checkedAt);
        task.incomplete_streak = 0;
        event(this.db, "work-available", result.detail, task.id);
      }
    }
  }

  async tick() {
    this.purgeOldEvents();
    this.heartbeatQuotaLeases();
    this.db.prepare("DELETE FROM quota_lease WHERE state='available' AND expires_at<=?").run(now());
    const tasks = taskRows(this.db);
    try { await this.refreshWorkChecks(tasks); }
    catch (error) { this.controllerError(String(error.stack ?? error)); }
    const activeAssignments = [...this.active.values()].map(({ task, provider, model, thinking, instrumentBlock, instrumentSign }) => ({ task, provider, model, thinking, instrumentBlock, instrumentSign }));
    const currentCpu = cpuTotals();
    const currentCpuPercent = cpuPercent(this.previousCpu, currentCpu);
    this.previousCpu = currentCpu;
    const memory = memoryMiB();
    const slots = resourceSlots(this.config, this.active.size, memory.available, memory.total, currentCpuPercent, agentMemoryMiB());
    // Admit only one session per measurement tick. SDK sessions and child tools
    // take time to appear in CPU/RAM telemetry; filling every computed slot from
    // one stale snapshot can create a launch stampede before the governor can
    // observe either real resource use or a task's first no-work backoff.
    for (let launchIndex = 0; launchIndex < launchBatchSize(slots); launchIndex++) {
      let launched = false;
      const rankedTasks = rankTasks(tasks, this.active.size);
      const eligibleTaskIds = new Set(rankedTasks.map((task) => task.id));
      const specificLeases = this.db.prepare(`SELECT id,task_id FROM quota_lease
        WHERE state='available' AND expires_at>? AND task_id IS NOT NULL`).all(now());
      for (const lease of specificLeases) {
        if (!eligibleTaskIds.has(lease.task_id)) {
          this.db.prepare("UPDATE quota_lease SET task_id=NULL,heartbeat_at=? WHERE id=?").run(now(), lease.id);
        }
      }
      const taskLeaseIds = new Set(specificLeases.filter((lease) => eligibleTaskIds.has(lease.task_id)).map((lease) => lease.task_id));
      const ranked = rankedTasks.sort((left, right) => Number(taskLeaseIds.has(right.id)) - Number(taskLeaseIds.has(left.id)));
      for (const task of ranked) {
        if (taskLeaseIds.size && !taskLeaseIds.has(task.id)) continue;
        let governed;
        try {
          const restored = await this.restoreQuotaLease(task, activeAssignments);
          const pinnedOperatorLease = this.db.prepare(`SELECT 1 FROM quota_lease
            WHERE state='available' AND expires_at>? AND task_id=? AND source='operator' LIMIT 1`).get(now(), task.id);
          governed = restored ?? (pinnedOperatorLease
            ? { ok: false, detail: "task-specific operator quota lease is not currently restorable" }
            : await this.plan.allows(task, activeAssignments));
        }
        catch (error) {
          this.governorBlocked(String(error.message ?? error), task.id);
          return;
        }
        if (!governed.ok) {
          this.governorBlocked(governed.detail, task.id);
          continue;
        }
        if (task.dispatch) {
          const runId = randomId();
          const dispatchStarted = now();
          this.db.prepare(
            "INSERT INTO dispatch_reservation(run_id,task_id,state,reserved_at) " +
            "VALUES(?,?,'active',?)"
          ).run(runId, task.id, dispatchStarted);
          const dispatched = await evaluateDispatch(task, runId);
          const dispatchMs = now() - dispatchStarted;
          if (dispatched.state === "no-work") {
            const checkedAt = now();
            this.db.prepare("DELETE FROM dispatch_reservation WHERE run_id=?").run(runId);
            if (governed.leaseId) {
              this.db.prepare("UPDATE quota_lease SET task_id=NULL,heartbeat_at=? WHERE id=? AND state='available'")
                .run(checkedAt, governed.leaseId);
              event(this.db, "quota-lease-released", "task had no claimable work; lease returned to its model lane", task.id);
            }
            this.db.prepare("UPDATE task SET work_state='no-work',work_checked_at=? WHERE id=?").run(checkedAt, task.id);
            task.work_state = "no-work";
            task.work_checked_at = checkedAt;
            this.throttledEvent("dispatch-no-work", dispatched.detail, task.id);
            continue;
          }
          if (dispatched.state === "error") {
            this.db.prepare(
              "UPDATE dispatch_reservation SET state='terminal',finished_at=? WHERE run_id=?"
            ).run(now(), runId);
            this.throttledEvent("dispatch-error", dispatched.detail, task.id);
            await this.launch(task, governed);
          } else {
            await this.launch(task, governed, runId, dispatched.packet, dispatchMs);
          }
        } else {
          await this.launch(task, governed);
        }
        task.active = Number(task.active) + 1;
        activeAssignments.push({ task, provider: governed.provider, model: governed.model, thinking: governed.thinking, instrumentBlock: governed.instrumentBlock, instrumentSign: governed.instrumentSign });
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
    await this.stop();
  }

  async stop(timeoutMs = 5000) {
    if (this.stopPromise) return this.stopPromise;
    this.stopping = true;
    const active = [...this.active.entries()];
    this.stopPromise = (async () => {
      for (const [, { session }] of active) {
        try {
          const aborting = session?.abort();
          if (aborting && typeof aborting.catch === "function") void aborting.catch(() => {});
        } catch {}
      }
      const settled = await Promise.race([
        Promise.allSettled(active.map(([, { promise }]) => promise)).then(() => true),
        sleep(timeoutMs).then(() => false),
      ]);
      if (settled) return;
      for (const [runId, { task, session }] of active) {
        try { session?.dispose(); } catch {}
        if (!this.db) continue;
        const row = this.db.prepare("SELECT status FROM run WHERE id=?").get(runId);
        if (row?.status === "running") {
          this.finish(task, runId, "interrupted", null, [], "controller shutdown timed out", false, true);
        }
      }
      this.active.clear();
    })();
    return this.stopPromise;
  }
}

export function controllerProcessIdentity(pid, status, commandLine) {
  const tgid = Number(status.match(/^Tgid:\s+(\d+)$/m)?.[1] ?? 0);
  const args = commandLine.split("\0").filter(Boolean);
  if (tgid !== pid || args.at(-1) !== "run" || !args[1]) return false;
  try { return fs.realpathSync(args[1]) === SCRIPT_PATH; }
  catch { return false; }
}

function controllerProcessExists(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    return controllerProcessIdentity(
      pid,
      fs.readFileSync(`/proc/${pid}/status`, "utf8"),
      fs.readFileSync(`/proc/${pid}/cmdline`, "utf8"),
    );
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

function acquireLock() {
  try { fs.mkdirSync(LOCK, { mode: 0o700 }); }
  catch (error) {
    if (error.code !== "EEXIST") throw error;
    const pidFile = path.join(LOCK, "pid");
    const pid = Number(fs.existsSync(pidFile) ? fs.readFileSync(pidFile, "utf8") : 0);
    if (controllerProcessExists(pid)) fail(`controller already running as pid ${pid}`);
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
  const unknown = Object.keys(options).filter((key) => !["id", "cwd", "model", "thinking", "condition", "completion-check", "work-check", "dispatch", "share", "not-before", "prompt", "prompt-file"].includes(key));
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
  const workCheck = options["work-check"]?.trim() || null;
  const dispatch = options.dispatch?.trim() || null;
  db.prepare(`INSERT INTO task(id,prompt,cwd,model,thinking,completion_condition,completion_check,work_check,dispatch,launch_share,not_before,next_eligible_at,created_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(options.id, prompt, cwd, options.model, options.thinking, options.condition, completionCheck, workCheck, dispatch, share, notBefore, notBefore, now());
  event(db, "task-created", options.condition, options.id);
  console.log(`created ${options.id}`);
}

export function setTaskOptions(db, id, options) {
  if (!db.prepare("SELECT 1 FROM task WHERE id=?").get(id)) fail(`unknown task ${id}`);
  if (!Object.keys(options).length) fail("task set requires --model, --thinking, --share, --prompt-file, --condition, --completion-check, --work-check, and/or --dispatch");
  const unknown = Object.keys(options).filter((key) => !["model", "thinking", "share", "prompt-file", "condition", "completion-check", "work-check", "dispatch"].includes(key));
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
  if (options["work-check"] !== undefined) {
    // An empty value removes the probe; the task returns to launch-and-discover.
    const check = options["work-check"].trim() || null;
    db.prepare("UPDATE task SET work_check=?,work_state=NULL,work_checked_at=0 WHERE id=?").run(check, id);
  }
  if (options.dispatch !== undefined) {
    // An empty value removes pre-launch dispatch; agents claim their own work.
    const dispatch = options.dispatch.trim() || null;
    db.prepare("UPDATE task SET dispatch=?,work_state=NULL,work_checked_at=0 WHERE id=?").run(dispatch, id);
  }
  event(db, "task-set", JSON.stringify(options), id);
}

export function cancelTask(db, id, at = now()) {
  db.prepare("UPDATE task SET cancelled_at=?,completed_at=NULL WHERE id=?").run(at, id);
}

function taskModelLabel(task, config) {
  const mix = taskMix(config, task);
  return mix ? taskVariants(config, task).map(runModelKey).join(" + ") : runModelKey(task);
}

function printTasks(db) {
  const config = loadConfig();
  for (const row of taskRows(db)) {
    const state = row.cancelled_at ? "cancelled"
      : row.completed_at ? "complete"
      : row.not_before > now() ? `eligible ${iso(row.not_before)}`
      : !workReady(row) ? "no-work"
      : row.next_eligible_at > now() ? `backoff ${iso(row.next_eligible_at)}`
      : "eligible";
    console.log(`${row.id}\t${state}\tactive=${row.active}\tshare=${row.launch_share}\t${taskModelLabel(row, config)}`);
  }
}

function printQuotaLeases(db) {
  const rows = db.prepare("SELECT * FROM quota_lease ORDER BY state,expires_at,id").all();
  for (const row of rows) {
    console.log(`${row.id}\t${row.state}\t${row.source}\t${row.task_id ?? "*"}\t${row.model}:${row.thinking}\t${row.provider ?? "any"}\texpires=${iso(row.expires_at)}`);
  }
}

function check(db) {
  const integrity = db.prepare("PRAGMA integrity_check").get().integrity_check;
  if (integrity !== "ok") fail(`database integrity: ${integrity}`);
  const config = loadConfig();
  governorControls(db);
  for (const task of taskRows(db)) {
    validateModelPolicy(task.model);
    if (!fs.existsSync(task.cwd)) fail(`task ${task.id} cwd is missing: ${task.cwd}`);
    const key = runModelKey(task);
    if (!isChatGptProTask(task) && providerOf(task.model) === CODEX_PROVIDER && !(key in config.plan.modelBurnPercentPerHour)) fail(`task ${task.id} has no plan burn rate for ${key}`);
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
    else db.prepare("UPDATE task SET cancelled_at=NULL,completed_at=NULL,next_eligible_at=?,incomplete_streak=0,work_state=NULL,work_checked_at=0 WHERE id=?").run(now(), id);
    event(db, `task-${subcommand}`, "operator command", id); console.log(`${subcommand} ${id}`); return;
  }
  if (command === "status") return printTasks(db);
  if (command === "governor-control" && subcommand === "status") {
    console.log(JSON.stringify(governorControls(db), null, 2)); return;
  }
  if (command === "governor-control" && subcommand === "set") {
    const provider = rest[0];
    const mode = rest[1];
    if (!provider || !["on", "off"].includes(mode)) fail("governor-control set requires PROVIDER on|off");
    console.log(JSON.stringify(setGovernorBoost(db, provider, mode === "on"), null, 2)); return;
  }
  if (command === "quota" && subcommand === "grant") {
    const options = parseOptions(rest);
    const unknown = Object.keys(options).filter((key) => !["provider", "model", "thinking", "task", "hours"].includes(key));
    if (unknown.length) fail(`quota grant does not support ${unknown.map((key) => `--${key}`).join(", ")}`);
    const id = grantQuotaLease(db, loadConfig(), {
      provider: options.provider,
      model: options.model,
      thinking: options.thinking,
      taskId: options.task ?? null,
      hours: options.hours ?? null,
    });
    console.log(`granted ${id}`); return;
  }
  if (command === "quota" && subcommand === "list") return printQuotaLeases(db);
  if (command === "quota" && subcommand === "revoke") {
    const id = rest[0]; if (!id) fail("quota revoke requires LEASE_ID");
    const lease = db.prepare("SELECT * FROM quota_lease WHERE id=?").get(id);
    if (!lease) fail(`unknown quota lease ${id}`);
    db.prepare("DELETE FROM quota_lease WHERE id=?").run(id);
    event(db, "quota-lease-revoked", `${lease.model}:${lease.thinking} via ${lease.provider ?? "any"}`, lease.task_id);
    console.log(`revoked ${id}`); return;
  }
  if (command === "runs") {
    const id = subcommand;
    const rows = id
      ? db.prepare("SELECT * FROM run WHERE task_id=? ORDER BY started_at DESC LIMIT 50").all(id)
      : db.prepare("SELECT * FROM run ORDER BY started_at DESC LIMIT 50").all();
    for (const row of rows) console.log(`${row.id}\t${row.task_id}\t${row.status}\t${iso(row.started_at)}\t${row.model ?? "?"}:${row.thinking ?? "?"}\t${row.summary ?? row.error ?? ""}`);
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
    const codexFeedback = new DistributedQuotaFeedback(config, CODEX_GOVERNOR_STATE_PATH, false);
    const usageMultiplier = (providerFamily) => governorAllowanceMultiplier(db, providerFamily);
    const modelRuntime = await ModelRuntime.create({ signal: AbortSignal.timeout(15_000) });
    const bootstrap = await loadExtensionProviders(modelRuntime);
    const cursorFeedback = new DistributedQuotaFeedback(config, CURSOR_GOVERNOR_STATE_PATH, false);
    const cursorGovernor = new CursorGovernor(config, { modelRuntime, feedback: cursorFeedback });
    const governor = new PlanGovernor(config, { modelRuntime, cursor: cursorGovernor, feedback: codexFeedback, usageMultiplier });
    const snapshot = await governor.refresh();
    const plan = {
      at: snapshot.at,
      healthyAccounts: snapshot.healthy,
      accountsWithHeadroom: snapshot.withHeadroom,
      configuredAccounts: snapshot.configured,
      retiredAccounts: snapshot.retired,
      retiredProviders: snapshot.retiredProviders,
      allowedBurnPercentPerHour: snapshot.allowedBurnPercentPerHour,
      distributed: snapshot.distributed,
      accounts: snapshot.accounts.map((account) => ({
        provider: account.provider,
        usedPercent: account.binding.used,
        resetsAt: account.binding.resetAt,
        allowedBurnPercentPerHour: account.allowedBurnPercentPerHour,
      })),
    };
    const anthropicFeedback = new DistributedQuotaFeedback(config, ANTHROPIC_GOVERNOR_STATE_PATH, false);
    const anthropicSnapshot = await new AnthropicGovernor(config, { feedback: anthropicFeedback, usageMultiplier }).refresh();
    const anthropic = {
      at: anthropicSnapshot.at,
      healthyAccounts: anthropicSnapshot.healthy,
      accountsWithHeadroom: anthropicSnapshot.withHeadroom,
      configuredAccounts: anthropicSnapshot.configured,
      distributed: anthropicSnapshot.distributed,
      errors: anthropicSnapshot.errors,
      accounts: anthropicSnapshot.accounts.map((account) => ({
        provider: account.provider,
        stale: account.stale,
        extraUsageExhausted: account.extraUsageExhausted,
        rateLimitTier: account.rateLimitTier,
        weeklyCapacityWeight: account.weeklyCapacityWeight,
        windows: Object.fromEntries(Object.entries(account.windows).filter(([, value]) => value).map(([name, value]) => [name, {
          utilization: value.utilization,
          resetsAt: value.resetsAt,
        }])),
      })),
    };
    const cursorSnapshot = await governor.cursor.refresh();
    const cursor = {
      at: cursorSnapshot.at,
      healthyAccounts: cursorSnapshot.healthy,
      usedPercent: cursorSnapshot.usage?.used ?? null,
      resetsAt: cursorSnapshot.usage?.resetAt ?? null,
      membershipType: cursorSnapshot.usage?.membershipType ?? null,
      modelAvailable: modelRuntime.getModel(CURSOR_PROVIDER, "grok-4.6") !== undefined,
      active: Number(db.prepare("SELECT count(*) count FROM run WHERE status='running' AND provider=?").get(CURSOR_PROVIDER).count),
      predictedPercentPerActiveHour: config.plan.cursor.predictedPercentPerActiveHour,
      allowedBurnPercentPerHour: cursorSnapshot.distributed?.accounts?.[CURSOR_PROVIDER]?.sustainableRate ?? 0,
      localAllowancePercentPerHour: governor.cursor.feedback.totalAllowance(cursorSnapshot.healthy ? [{
        provider: CURSOR_PROVIDER,
        allowedBurnPercentPerHour: cursorSnapshot.distributed?.accounts?.[CURSOR_PROVIDER]?.sustainableRate ?? 0,
      }] : []),
      share: cursorSnapshot.distributed?.share ?? 0,
      reservePercent: config.plan.cursor.reservePercent,
      stale: cursorSnapshot.stale,
      error: cursorSnapshot.error,
    };
    bootstrap.dispose();
    const pro = proEntitlementSnapshot();
    console.log(JSON.stringify({ resources, controls: governorControls(db), plan, anthropic, cursor, chatgptPro: pro }, null, 2));
    return;
  }
  if (command === "pro-recover") {
    const days = Number(parseOptions(subcommand === undefined ? [] : [subcommand, ...rest])["from-audits"] ?? 0);
    const extra = days > 0 ? orphanedConversationsFromAudits(days) : [];
    const results = await recoverPendingProConversations({
      extra,
      log: (result) => console.log(JSON.stringify(result)),
    });
    const recovered = results.filter((result) => result.outcome === "recovered-verified").length;
    console.log(`pro-recover: ${results.length} conversation(s) checked, ${recovered} verified response(s) recovered`);
    for (const result of results) event(db, "pro-recovery", JSON.stringify(result));
    return;
  }
  if (command === "check") return check(db);
  if (command === "run") {
    const release = acquireLock();
    const controller = new Controller(db, loadConfig());
    const terminate = async () => {
      try {
        await controller.stop();
        release();
        db.close();
        process.exit(0);
      } catch (error) {
        console.error(error.stack ?? error);
        process.exit(1);
      }
    };
    process.once("SIGTERM", terminate); process.once("SIGINT", terminate);
    try { await controller.init(); await controller.run(); }
    finally { release(); }
    return;
  }
  console.log(`Usage:
  orchestrator task create --id ID --cwd DIR --model PROVIDER/MODEL --thinking LEVEL --condition TEXT [--completion-check COMMAND] [--work-check COMMAND] [--dispatch COMMAND] [--share N] [--not-before ISO] (--prompt TEXT | --prompt-file FILE)
  orchestrator task list
  orchestrator task show ID
  orchestrator task set ID [--model PROVIDER/MODEL] [--thinking LEVEL] [--share N] [--prompt-file FILE] [--condition TEXT] [--completion-check COMMAND] [--work-check COMMAND, '' clears] [--dispatch COMMAND, '' clears]
  orchestrator task cancel ID
  orchestrator task reopen ID
  orchestrator status
  orchestrator governor-control status
  orchestrator governor-control set openai|anthropic on|off
  orchestrator quota grant --provider EXACT_PROVIDER --model PROVIDER/MODEL --thinking LEVEL [--task TASK_ID] [--hours N]
  orchestrator quota list
  orchestrator quota revoke LEASE_ID
  orchestrator runs [TASK_ID]
  orchestrator governor
  orchestrator pro-recover [--from-audits DAYS]
  orchestrator check
  orchestrator run`);
  if (command) process.exitCode = 2;
}

const invokedPath = process.argv[1] && fs.existsSync(process.argv[1]) ? fs.realpathSync(process.argv[1]) : null;
if (invokedPath === SCRIPT_PATH) {
  main().catch((error) => { console.error(error.stack ?? error); process.exitCode = 1; });
}

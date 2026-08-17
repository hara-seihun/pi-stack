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
const AUTH_PATH = path.join(getAgentDir(), "auth.json");
const MULTI_PASS_PATH = path.join(getAgentDir(), "multi-pass.json");
const CHATGPT_PRO_POOL_PATH = path.join(getAgentDir(), "chatgpt-pro-pool.json");
const CHATGPT_PRO_PROVIDER = "chatgpt-pro";
const CODEX_PROVIDER = "openai-codex";
const ANTHROPIC_PROVIDER = "anthropic";
const ANTHROPIC_USAGE_ENDPOINT = "https://api.anthropic.com/api/oauth/usage";
const ANTHROPIC_PROFILE_ENDPOINT = "https://api.anthropic.com/api/oauth/profile";
const ANTHROPIC_CLIENT_USER_AGENT = "claude-code/2.1.80";
const ANTHROPIC_USAGE_CACHE_PATH = path.join(DATA, "anthropic-plan-usage.json");
const CODEX_GOVERNOR_STATE_PATH = path.join(DATA, "codex-distributed-governor.json");
const ANTHROPIC_GOVERNOR_STATE_PATH = path.join(DATA, "anthropic-distributed-governor.json");
export const TOOL_SHELL = fileURLToPath(new URL("./tool-shell", import.meta.url));
const TICK_MS = 5000;
const DISTRIBUTED_ALLOCATION_VERSION = 1;
const DISTRIBUTED_CALIBRATION_VERSION = 1;
const execFileAsync = promisify(execFile);

// Per-account feedback and causal attribution are invalid if Multi-Pass rotates
// a governor-pinned run after admission, so the controller owns this invariant
// even on hosts whose systemd unit does not duplicate the environment setting.
process.env.PI_MULTI_PASS_LOCK_ASSIGNED_PROVIDER = "1";

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
    modelMixes: {
      "openai-codex/gpt-5.6-sol:xhigh": {
        alternateModel: "anthropic/claude-opus-5",
        alternateThinking: "xhigh",
        strategy: "independent-capacity"
      }
    },
    distributed: {
      targetPercent: 92,
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
      maxActivePerAccount: 1,
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
  if (!config.plan.modelMixes || typeof config.plan.modelMixes !== "object") config.plan.modelMixes = {};
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
      !(Number.isInteger(anthropic.maxActivePerAccount) && anthropic.maxActivePerAccount > 0) ||
      !(Number.isFinite(anthropic.predictedPercentPerActiveHour ?? DEFAULT_CONFIG.plan.anthropic.predictedPercentPerActiveHour) &&
        (anthropic.predictedPercentPerActiveHour ?? DEFAULT_CONFIG.plan.anthropic.predictedPercentPerActiveHour) > 0)) {
    fail("invalid config.plan.anthropic");
  }
  for (const [base, mix] of Object.entries(config.plan.modelMixes)) {
    if (!base.includes(":") || typeof mix?.alternateModel !== "string" || !mix.alternateModel.includes("/") ||
        typeof mix?.alternateThinking !== "string" || mix.strategy !== "independent-capacity") fail(`invalid model mix ${base}`);
    validateModelPolicy(mix.alternateModel);
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
  for (const table of ["task", "run", "quota_lease", "event"]) ensureTableTimestamps(db, table);
  return db;
}

function event(db, kind, detail, taskId = null, runId = null) {
  db.prepare("INSERT INTO event(at,kind,task_id,run_id,detail) VALUES(?,?,?,?,?)")
    .run(now(), kind, taskId, runId, detail);
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
function providerFamily(provider) {
  if (provider === CODEX_PROVIDER || provider.startsWith(`${CODEX_PROVIDER}-`)) return CODEX_PROVIDER;
  if (provider === ANTHROPIC_PROVIDER || provider.startsWith(`${ANTHROPIC_PROVIDER}-`)) return ANTHROPIC_PROVIDER;
  return provider;
}
function taskMix(config, task) { return config.plan.modelMixes[runModelKey(task)] ?? null; }
export function taskSupportsAssignment(config, task, assignment) {
  if (runModelKey(task) === runModelKey(assignment)) return true;
  const mix = taskMix(config, task);
  return mix !== null && `${mix.alternateModel}:${mix.alternateThinking}` === runModelKey(assignment);
}
export function chooseIndependentAssignment(primary, alternate) {
  if (primary.ok && alternate.ok) {
    return Number(primary.pressure) <= Number(alternate.pressure) ? primary : alternate;
  }
  return primary.ok ? primary : alternate.ok ? alternate : null;
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
      if (allocationVersion === DISTRIBUTED_ALLOCATION_VERSION &&
          typeof parsed.seed === "string" && Number.isFinite(parsed.share)) {
        for (const key of ["seed", "share", "previous", "cumulative", "history", "accountShares", "accountCumulative", "accountHistory", "accountUnconfirmed", "accountSensorInconsistent", "unconfirmed", "sensorInconsistent", "lastObservedAt", "lastControlAt"]) {
          if (parsed[key] !== undefined) this.state[key] = parsed[key];
        }
      }
      if (calibrationVersion === DISTRIBUTED_CALIBRATION_VERSION) {
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

  observe(resources, localPredictedRate = 0, calibration = null, at = now()) {
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
      if (previous && previous.resetAt === resource.resetAt && resource.used >= previous.used) {
        delta = (resource.used - previous.used) * resource.weight;
      }
      if (delta > 1e-9) {
        meterAdvanced = true;
        advancedProviders.add(resource.provider);
      }
      resourceDeltas[`${resource.provider}:${resource.group}`] = delta;
      accountDeltas[resource.provider] = (accountDeltas[resource.provider] ?? 0) + delta;
      this.state.cumulative[resource.group] = (this.state.cumulative[resource.group] ?? 0) + delta;
      this.state.previous[resource.id] = { used: resource.used, resetAt: resource.resetAt, at };
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
          const ratio = Math.min(...observed.map((group) => status.sustainable[group] / status.rates[group]));
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
          const ratio = Math.min(...observedGroups.map((group) => sustainable[group] / rates[group]));
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

  totalAllowance(accounts) {
    return accounts.reduce((sum, account) => sum +
      (this.state.accountSensorInconsistent[account.provider] ? 0 : (this.state.accountShares[account.provider] ?? this.config.initialShare)) *
      account.allowedBurnPercentPerHour, 0);
  }

  admitsAccounts(localLoad, candidate, accounts, key, at = now()) {
    const allowance = this.totalAllowance(accounts);
    if (allowance <= 0 || candidate <= 0) return false;
    if (localLoad + candidate <= allowance + 1e-9) return true;
    if (localLoad > 1e-9) return false;
    return this.score(`admit-pool:${key}`, Math.floor(at / (this.config.routingBlockMinutes * 60_000))) < Math.min(1, allowance / candidate);
  }

  selectAccount(accounts, activeRates, modelKey, candidate, at = now()) {
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
        const leftAllowance = (this.state.accountShares[left.account.provider] ?? this.config.initialShare) * left.account.allowedBurnPercentPerHour;
        const rightAllowance = (this.state.accountShares[right.account.provider] ?? this.config.initialShare) * right.account.allowedBurnPercentPerHour;
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
  if (!resolved?.auth?.apiKey || latest?.type !== "oauth") return null;
  return { access: resolved.auth.apiKey, accountId: latest.accountId ?? "" };
}

function anthropicWindow(raw, durationHours, fetchedAt) {
  if (!raw || typeof raw !== "object") return null;
  const utilization = Number(raw.utilization ?? raw.percent);
  if (!Number.isFinite(utilization)) return null;
  const parsedReset = raw.resets_at ? Date.parse(raw.resets_at) : Number.NaN;
  return {
    utilization: Math.max(0, Math.min(100, utilization)),
    resetsAt: Number.isFinite(parsedReset) ? parsedReset : fetchedAt + durationHours * 3600_000,
    reportedReset: Number.isFinite(parsedReset),
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
  constructor(config, { modelRuntime = null, authPath = AUTH_PATH, fetcher = fetch, readCredential = readStoredCredential, cachePath = ANTHROPIC_USAGE_CACHE_PATH, feedback = null } = {}) {
    this.config = config;
    this.modelRuntime = modelRuntime;
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
    if (this.snapshot && now() < this.snapshot.expiresAt) return this.snapshot;
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
        weight: 1,
        available: Math.max(0, target - account.windows.fiveHour.utilization),
      },
      {
        id: `weekly:${account.provider}`,
        provider: account.provider,
        group: "weekly",
        used: account.windows.sharedWeekly.utilization,
        resetAt: account.windows.sharedWeekly.resetsAt,
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
    const distributed = this.feedback.observe(resources, predicted, null, fetchedAt);
    this.snapshot = {
      at: fetchedAt,
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
    const limit = this.config.plan.anthropic.maxActivePerAccount;
    const eligible = usage.accounts
      .filter((account) => anthropicOpusHasHeadroom(account) && (this.cooldowns.get(account.provider) ?? 0) <= now() &&
        (activeByProvider.get(account.provider) ?? 0) < limit);
    const candidate = this.config.plan.anthropic.predictedPercentPerActiveHour ?? DEFAULT_CONFIG.plan.anthropic.predictedPercentPerActiveHour;
    const localActive = [...activeByProvider.values()].reduce((sum, value) => sum + value, 0);
    const localBurn = localActive * candidate;
    const syntheticAccounts = usage.accounts.filter(anthropicOpusHasHeadroom).map((account) => ({
      ...account,
      allowedBurnPercentPerHour: usage.distributed?.accounts?.[account.provider]?.sustainableRate ?? 0,
    }));
    const allowance = this.feedback.totalAllowance(syntheticAccounts);
    const admitted = this.feedback.admitsAccounts(localBurn, candidate, syntheticAccounts, runModelKey(variant));
    const syntheticActive = [...activeByProvider.entries()].map(([provider, active]) => ({ provider, rate: active * candidate }));
    const eligibleProviders = new Set(eligible.map((account) => account.provider));
    const routed = admitted ? this.feedback.selectAccount(
      syntheticAccounts.filter((account) => eligibleProviders.has(account.provider)),
      syntheticActive,
      runModelKey(variant),
      candidate,
    ) : null;
    const selected = routed ? { account: routed.account, active: activeByProvider.get(routed.account.provider) ?? 0, ...routed } : null;
    const distributed = usage.distributed ?? this.feedback.status;
    return {
      ok: selected !== null,
      provider: selected?.account.provider ?? null,
      model: variant.model,
      thinking: variant.thinking,
      instrumentBlock: selected?.block ?? null,
      instrumentSign: selected?.sign ?? null,
      pressure: allowance > 0 ? (localBurn + candidate) / allowance : Number.POSITIVE_INFINITY,
      detail: selected
        ? `Anthropic account=${selected.account.provider} active=${selected.active} local=${localBurn.toFixed(3)} candidate=${candidate.toFixed(3)} allowance=${allowance.toFixed(3)} share=${distributed.share.toFixed(3)} healthy=${usage.healthy} headroom=${usage.withHeadroom}`
        : `Anthropic distributed gate closed: local=${localBurn.toFixed(3)} candidate=${candidate.toFixed(3)} allowance=${allowance.toFixed(3)} share=${distributed.share.toFixed(3)} healthy=${usage.healthy} headroom=${usage.withHeadroom}`,
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

export class PlanGovernor {
  constructor(config, { modelRuntime = null, authPath = AUTH_PATH, lifecyclePath = MULTI_PASS_PATH, fetcher = fetch, readCredential = readStoredCredential, anthropic = null, feedback = null } = {}) {
    this.config = config;
    this.modelRuntime = modelRuntime;
    this.authPath = authPath;
    this.lifecyclePath = lifecyclePath;
    this.fetcher = fetcher;
    this.readCredential = readCredential;
    this.snapshot = null;
    this.refreshing = null;
    this.pendingAssignments = [];
    this.feedback = feedback ?? new DistributedQuotaFeedback(config, CODEX_GOVERNOR_STATE_PATH);
    this.anthropic = anthropic ?? new AnthropicGovernor(config, { modelRuntime, authPath, fetcher, readCredential });
  }

  setModelRuntime(modelRuntime) {
    this.modelRuntime = modelRuntime;
    this.anthropic.setModelRuntime(modelRuntime);
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
    if (this.snapshot && now() < this.snapshot.expiresAt) return this.snapshot;
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
    const distributed = this.feedback.observe(resources, localPredictedRate, {
      accounts,
      assignments: localAssignments,
      priors: this.config.plan.modelBurnPercentPerHour,
      rate: (value) => this.config.plan.modelBurnPercentPerHour[runModelKey(value)] ?? 0,
    }, fetchedAt);
    const snapshotAt = now();
    this.snapshot = {
      at: snapshotAt,
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
    const codexAssignments = activeAssignments
      .filter((item) => providerFamily(item.provider) === CODEX_PROVIDER)
      .map((item) => ({ provider: item.provider, rate: this.modelRate(item.model ? item : item.task) }));
    const live = codexAssignments.reduce((sum, item) => sum + item.rate, 0);
    const allowance = this.feedback.totalAllowance(snapshot.accounts);
    const admitted = this.feedback.admitsAccounts(live, candidate, snapshot.accounts, runModelKey(variant));
    const selected = admitted ? this.feedback.selectAccount(snapshot.accounts, codexAssignments, runModelKey(variant), candidate) : null;
    return {
      ok: selected !== null,
      provider: selected?.account.provider ?? null,
      model: variant.model,
      thinking: variant.thinking,
      instrumentBlock: selected?.block ?? null,
      instrumentSign: selected?.sign ?? null,
      pressure: allowance > 0 ? (live + candidate) / allowance : Number.POSITIVE_INFINITY,
      detail: selected
        ? `Codex account=${selected.account.provider} local=${live.toFixed(3)} candidate=${candidate.toFixed(3)} allowance=${allowance.toFixed(3)} share=${snapshot.distributed.share.toFixed(3)} sustainable=${snapshot.distributed.sustainableRate.toFixed(3)}`
        : `Codex distributed gate closed: local=${live.toFixed(3)} candidate=${candidate.toFixed(3)} allowance=${allowance.toFixed(3)} share=${snapshot.distributed.share.toFixed(3)} sustainable=${snapshot.distributed.sustainableRate.toFixed(3)} observed=${snapshot.distributed.observedRate?.toFixed(3) ?? "unknown"}`,
    };
  }

  noteFailure(assignment, error) {
    if (providerFamily(assignment.provider) === ANTHROPIC_PROVIDER) this.anthropic.noteFailure(assignment.provider, error);
    if (providerFamily(assignment.provider) === CODEX_PROVIDER && /(?:429|rate.?limit|usage limit|exhausted)/i.test(String(error?.message ?? error))) {
      this.snapshot = null;
    }
  }

  async restores(lease, activeAssignments) {
    const family = providerFamily(lease.provider ?? providerOf(lease.model));
    const variant = { model: lease.model, thinking: lease.thinking };
    if (family === CODEX_PROVIDER) {
      const snapshot = await this.refresh(activeAssignments);
      if (snapshot.distributed.sensorInconsistent) return { ok: false, detail: "Codex sensor circuit blocks quota lease restoration" };
      const activeRates = activeAssignments
        .filter((item) => providerFamily(item.provider) === CODEX_PROVIDER)
        .map((item) => ({ provider: item.provider, rate: this.modelRate(item.model ? item : item.task) }));
      const accounts = snapshot.accounts.filter((account) => account.allowedBurnPercentPerHour > 0 &&
        !snapshot.distributed.accounts?.[account.provider]?.sensorInconsistent &&
        (lease.provider === null || lease.provider === undefined || account.provider === lease.provider));
      const selected = this.feedback.selectAccount(accounts, activeRates, runModelKey(variant), this.modelRate(variant));
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
    if (family === ANTHROPIC_PROVIDER) {
      const usage = await this.anthropic.refresh(activeAssignments);
      if (usage.distributed.sensorInconsistent) return { ok: false, detail: "Anthropic sensor circuit blocks quota lease restoration" };
      const activeByProvider = new Map();
      for (const item of activeAssignments.filter((item) => providerFamily(item.provider) === ANTHROPIC_PROVIDER)) {
        activeByProvider.set(item.provider, (activeByProvider.get(item.provider) ?? 0) + 1);
      }
      const accounts = usage.accounts.filter((account) => anthropicOpusHasHeadroom(account) &&
        (this.anthropic.cooldowns.get(account.provider) ?? 0) <= now() &&
        (activeByProvider.get(account.provider) ?? 0) < this.config.plan.anthropic.maxActivePerAccount &&
        !usage.distributed.accounts?.[account.provider]?.sensorInconsistent &&
        (lease.provider === null || lease.provider === undefined || account.provider === lease.provider))
        .map((account) => ({ ...account, allowedBurnPercentPerHour: usage.distributed.accounts?.[account.provider]?.sustainableRate ?? 0 }));
      const candidate = this.config.plan.anthropic.predictedPercentPerActiveHour ?? DEFAULT_CONFIG.plan.anthropic.predictedPercentPerActiveHour;
      const activeRates = [...activeByProvider.entries()].map(([provider, active]) => ({ provider, rate: active * candidate }));
      const selected = this.anthropic.feedback.selectAccount(accounts, activeRates, runModelKey(variant), candidate);
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
    const mix = taskMix(this.config, task);
    if (!mix) {
      if (providerOf(task.model) === ANTHROPIC_PROVIDER) {
        return this.anthropic.allows({ model: task.model, thinking: task.thinking }, activeAssignments);
      }
      return this.allowsCodex({ model: task.model, thinking: task.thinking }, activeAssignments);
    }
    const [codex, anthropic] = await Promise.all([this.refresh(activeAssignments), this.anthropic.refresh(activeAssignments)]);
    const primaryVariant = { model: task.model, thinking: task.thinking };
    const alternateVariant = { model: mix.alternateModel, thinking: mix.alternateThinking };
    const [primary, alternate] = await Promise.all([
      this.allowsCodex(primaryVariant, activeAssignments, codex),
      this.anthropic.allows(alternateVariant, activeAssignments, anthropic),
    ]);
    const selected = chooseIndependentAssignment(primary, alternate);
    const detail = `independent provider gates; ${primary.detail}; ${alternate.detail}`;
    return selected ? { ...selected, detail } : { ...primary, detail };
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
  if (![CODEX_PROVIDER, ANTHROPIC_PROVIDER].includes(family)) fail(`quota leases do not support provider family ${family}`);
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

export class Controller {
  constructor(db, config) {
    this.db = db;
    this.config = config;
    this.modelRuntime = null;
    this.plan = new PlanGovernor(config);
    this.active = new Map();
    this.stopping = false;
    this.stopPromise = null;
    this.lastThrottledEvents = new Map();
    this.lastControllerError = { at: 0, detail: "" };
    this.previousCpu = cpuTotals();
  }

  recover() {
    const at = now();
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
      if (!taskSupportsAssignment(this.config, task, lease)) continue;
      const restored = await this.plan.restores(lease, activeAssignments);
      if (restored.ok) return { ...restored, leaseId: lease.id };
      this.throttledEvent("quota-lease-blocked", restored.detail, task.id);
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
      leaseId = this.activateQuotaLease(task, assignment, runId, startedAt);
      const note = packet === null ? "" : ` (dispatched ${dispatchMs ?? "?"}ms, ${packet.length}B)`;
      event(this.db, "run-started", `${runModelKey(assignment)} via ${assignment.provider}${note}`, task.id, runId);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
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
          this.db.prepare("UPDATE quota_lease SET state='available',task_id=?,run_id=NULL,heartbeat_at=? WHERE id=?")
            .run(task.id, now(), lease.id);
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
      for (const task of rankTasks(tasks, this.active.size)) {
        let governed;
        try { governed = await this.restoreQuotaLease(task, activeAssignments) ?? await this.plan.allows(task, activeAssignments); }
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
          const dispatched = await evaluateDispatch(task, runId);
          const dispatchMs = now() - dispatchStarted;
          if (dispatched.state === "no-work") {
            const checkedAt = now();
            this.db.prepare("UPDATE task SET work_state='no-work',work_checked_at=? WHERE id=?").run(checkedAt, task.id);
            task.work_state = "no-work";
            task.work_checked_at = checkedAt;
            this.throttledEvent("dispatch-no-work", dispatched.detail, task.id);
            continue;
          }
          if (dispatched.state === "error") {
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
  return mix ? `${runModelKey(task)} + ${mix.alternateModel}:${mix.alternateThinking}` : runModelKey(task);
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
    const snapshot = await new PlanGovernor(config, { feedback: codexFeedback }).refresh();
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
    const anthropicSnapshot = await new AnthropicGovernor(config, { feedback: anthropicFeedback }).refresh();
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
    const pro = proEntitlementSnapshot();
    console.log(JSON.stringify({ resources, plan, anthropic, chatgptPro: pro }, null, 2));
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
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(error.stack ?? error); process.exitCode = 1; });
}

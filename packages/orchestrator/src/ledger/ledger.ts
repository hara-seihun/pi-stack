import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { AccountCalibrator } from "../calibrator/calibrator.js";
import { gateRefs, parseGate } from "../tasks/gate.js";
import { TIERS, type DemandState, type TaskSpec, type Tier } from "../tasks/types.js";
import type {
  CalibratorConfig,
  MeterId,
  MeterReading,
  MeterSpec,
  UsageEvent,
} from "../calibrator/types.js";

/**
 * The ledger stores facts, not conclusions: provider meter readings and token
 * usage events. Calibration is always rebuilt by replaying those facts, so
 * there is exactly one source of truth and calibrator improvements apply
 * retroactively to all recorded history.
 */

const SCHEMA = `
CREATE TABLE account (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  label TEXT,
  access_until INTEGER,
  created_at INTEGER NOT NULL
) STRICT;

CREATE TABLE meter_reading (
  account_id TEXT NOT NULL REFERENCES account(id),
  meter_id TEXT NOT NULL,
  at INTEGER NOT NULL,
  used_percent INTEGER NOT NULL,
  reset_at INTEGER,
  PRIMARY KEY (account_id, meter_id, at)
) STRICT;

CREATE TABLE usage_event (
  id INTEGER PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES account(id),
  class_id TEXT NOT NULL,
  at INTEGER NOT NULL,
  tokens REAL NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('orchestrator', 'machine')),
  session_id TEXT
) STRICT;

CREATE INDEX usage_event_account_at ON usage_event (account_id, at);
`;

const TASK_SCHEMA = `
CREATE TABLE control (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
) STRICT;
INSERT INTO control (key, value) VALUES ('launches', 'enabled');

CREATE TABLE task (
  id TEXT PRIMARY KEY,
  demand_command TEXT,
  demand_constant REAL,
  gate TEXT,
  tiers TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  CHECK ((demand_command IS NULL) <> (demand_constant IS NULL))
) STRICT;

CREATE TABLE task_demand (
  task_id TEXT PRIMARY KEY REFERENCES task(id) ON DELETE CASCADE,
  units REAL,
  probed_at INTEGER,
  invalidated INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  gate_open_since INTEGER
) STRICT;
`;

const RUN_SCHEMA = `
ALTER TABLE task ADD COLUMN prompt TEXT;
ALTER TABLE task ADD COLUMN cwd TEXT;
ALTER TABLE account ADD COLUMN cooldown_until INTEGER;

CREATE TABLE run (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  tier TEXT NOT NULL,
  account_id TEXT NOT NULL,
  model TEXT NOT NULL,
  provider TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('running', 'done', 'error', 'aborted')),
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  heartbeat_at INTEGER,
  abort_requested INTEGER NOT NULL DEFAULT 0,
  productive INTEGER,
  complete INTEGER,
  detail TEXT
) STRICT;

CREATE INDEX run_state ON run (state);
CREATE INDEX run_task_started ON run (task_id, started_at);
`;

/**
 * Runs become ledger-mediated: the controller creates them 'pending', runner
 * processes claim them atomically. The table is rebuilt because the state
 * CHECK cannot be altered in place; claimed_at backfills from started_at.
 */
const RUNNER_SCHEMA = `
ALTER TABLE account ADD COLUMN last_bound_at INTEGER;

CREATE TABLE run_next (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  tier TEXT NOT NULL,
  account_id TEXT NOT NULL,
  model TEXT NOT NULL,
  provider TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending', 'running', 'done', 'error', 'aborted')),
  started_at INTEGER NOT NULL,
  claimed_at INTEGER,
  runner_id TEXT,
  ended_at INTEGER,
  heartbeat_at INTEGER,
  abort_requested INTEGER NOT NULL DEFAULT 0,
  productive INTEGER,
  complete INTEGER,
  detail TEXT
) STRICT;
INSERT INTO run_next (id, task_id, tier, account_id, model, provider, state, started_at,
                      claimed_at, ended_at, heartbeat_at, abort_requested, productive, complete, detail)
  SELECT id, task_id, tier, account_id, model, provider, state, started_at,
         started_at, ended_at, heartbeat_at, abort_requested, productive, complete, detail FROM run;
DROP TABLE run;
ALTER TABLE run_next RENAME TO run;
CREATE INDEX run_state ON run (state);
CREATE INDEX run_task_started ON run (task_id, started_at);

INSERT INTO control (key, value) VALUES ('runner_generation', '1');
`;

const THINKING_SCHEMA = `
ALTER TABLE run ADD COLUMN thinking TEXT;
`;

const MIGRATIONS: readonly string[] = [SCHEMA, TASK_SCHEMA, RUN_SCHEMA, RUNNER_SCHEMA, THINKING_SCHEMA];

export interface AccountRow {
  readonly id: string;
  readonly provider: string;
  readonly label: string | undefined;
  readonly accessUntil: number | undefined;
  readonly cooldownUntil: number | undefined;
  readonly lastBoundAt: number | undefined;
  readonly createdAt: number;
}

export type RunState = "pending" | "running" | "done" | "error" | "aborted";

/** Launch-side custody of one agent session. `tier` lives here for capacity
 * accounting and statistics only; it must never reach agent-visible surfaces.
 * Deliberately no FK to task: run history outlives deleted tasks. */
export interface RunRow {
  readonly id: string;
  readonly taskId: string;
  readonly tier: Tier;
  readonly accountId: string;
  readonly model: string;
  readonly provider: string;
  readonly thinking: string | undefined;
  readonly state: RunState;
  readonly startedAt: number;
  readonly claimedAt: number | undefined;
  readonly runnerId: string | undefined;
  readonly endedAt: number | undefined;
  readonly heartbeatAt: number | undefined;
  readonly abortRequested: boolean;
  readonly productive: boolean | undefined;
  readonly complete: boolean | undefined;
  readonly detail: string | undefined;
}

export interface RunResult {
  readonly state: "done" | "error" | "aborted";
  readonly productive?: boolean;
  readonly complete?: boolean;
  readonly detail?: string;
}

export interface LoggedUsageEvent extends UsageEvent {
  readonly sessionId?: string;
}

export class Ledger {
  private constructor(private readonly db: DatabaseSync) {}

  static open(path: string): Ledger {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    const db = new DatabaseSync(path);
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA synchronous = NORMAL");
    db.exec("PRAGMA busy_timeout = 5000");
    db.exec("PRAGMA foreign_keys = ON");
    const row = db.prepare("PRAGMA user_version").get() as { user_version: number };
    for (let v = row.user_version; v < MIGRATIONS.length; v++) {
      db.exec("BEGIN");
      db.exec(MIGRATIONS[v]);
      db.exec(`PRAGMA user_version = ${v + 1}`);
      db.exec("COMMIT");
    }
    return new Ledger(db);
  }

  close(): void {
    this.db.close();
  }

  upsertAccount(a: {
    id: string;
    provider: string;
    label?: string;
    accessUntil?: number;
  }): void {
    this.db
      .prepare(
        `INSERT INTO account (id, provider, label, access_until, created_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET
           provider = excluded.provider,
           label = COALESCE(excluded.label, account.label),
           access_until = COALESCE(excluded.access_until, account.access_until)`,
      )
      .run(a.id, a.provider, a.label ?? null, a.accessUntil ?? null, Date.now());
  }

  accounts(): AccountRow[] {
    const rows = this.db
      .prepare(
        "SELECT id, provider, label, access_until, cooldown_until, last_bound_at, created_at FROM account ORDER BY id",
      )
      .all() as {
      id: string;
      provider: string;
      label: string | null;
      access_until: number | null;
      cooldown_until: number | null;
      last_bound_at: number | null;
      created_at: number;
    }[];
    return rows.map((r) => ({
      id: r.id,
      provider: r.provider,
      label: r.label ?? undefined,
      accessUntil: r.access_until ?? undefined,
      cooldownUntil: r.cooldown_until ?? undefined,
      lastBoundAt: r.last_bound_at ?? undefined,
      createdAt: r.created_at,
    }));
  }

  /** A cooling account is skipped by admission until the deadline passes. */
  /** Explicit lifecycle transition: upsertAccount coalesces missing fields
   * (usage attribution must never erase registration metadata), so clearing
   * a cancelled subscription's deadline on reactivation needs this setter. */
  setAccountAccessUntil(id: string, until: number | undefined): void {
    this.db
      .prepare("UPDATE account SET access_until = ? WHERE id = ?")
      .run(until ?? null, id);
  }

  setAccountCooldown(id: string, until: number | undefined): void {
    this.db
      .prepare("UPDATE account SET cooldown_until = ? WHERE id = ?")
      .run(until ?? null, id);
  }

  /** Session-binding fact for least-used round-robin tie-breaking. */
  setAccountLastBound(id: string, at: number): void {
    this.db.prepare("UPDATE account SET last_bound_at = ? WHERE id = ?").run(at, id);
  }

  /** Freshest provider-reported utilization: max over meters of the latest
   * used_percent reading. Undefined when the account has no readings. */
  latestUsedPercent(accountId: string): number | undefined {
    const row = this.db
      .prepare(
        `SELECT MAX(used_percent) AS p FROM meter_reading r
         WHERE account_id = ?
           AND at = (SELECT MAX(at) FROM meter_reading
                     WHERE account_id = r.account_id AND meter_id = r.meter_id)`,
      )
      .get(accountId) as { p: number | null };
    return row.p ?? undefined;
  }

  /**
   * Stores a reading verbatim. Every reading is a fact and segment semantics
   * depend on exact boundaries, so nothing is deduplicated; `prune` bounds
   * growth instead. Out-of-order readings (concurrent writers racing) are
   * rejected loudly; callers may drop the redundant loser.
   */
  recordReading(accountId: string, meterId: MeterId, r: MeterReading): void {
    const last = this.db
      .prepare(
        `SELECT at FROM meter_reading
         WHERE account_id = ? AND meter_id = ? ORDER BY at DESC LIMIT 1`,
      )
      .get(accountId, meterId) as { at: number } | undefined;
    if (last && r.at <= last.at) {
      throw new Error(`out-of-order reading for ${accountId}/${meterId}: ${r.at} <= ${last.at}`);
    }
    this.db
      .prepare(
        `INSERT INTO meter_reading (account_id, meter_id, at, used_percent, reset_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(accountId, meterId, r.at, r.usedPercent, r.resetAt ?? null);
  }

  recordUsage(accountId: string, e: LoggedUsageEvent): void {
    this.db
      .prepare(
        `INSERT INTO usage_event (account_id, class_id, at, tokens, source, session_id)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(accountId, e.classId, e.at, e.tokens, e.source, e.sessionId ?? null);
  }

  recordUsageBatch(accountId: string, events: readonly LoggedUsageEvent[]): void {
    this.db.exec("BEGIN");
    try {
      for (const e of events) this.recordUsage(accountId, e);
      this.db.exec("COMMIT");
    } catch (thrown) {
      this.db.exec("ROLLBACK");
      throw thrown;
    }
  }

  /**
   * Rebuilds an account's calibrator by folding stored facts in time order.
   * `transform` maps stored usage facts onto calibration classes (e.g. raw
   * token components onto price-weighted cost units); because it runs at
   * replay time, corrected weights apply retroactively to all history.
   */
  replayCalibrator(
    accountId: string,
    specs: readonly MeterSpec[],
    cfg?: Partial<CalibratorConfig>,
    transform?: (classId: string, tokens: number) => { classId: string; tokens: number },
  ): AccountCalibrator {
    const cal = new AccountCalibrator(specs, cfg);
    const readings = this.db
      .prepare(
        `SELECT meter_id, at, used_percent, reset_at FROM meter_reading
         WHERE account_id = ? ORDER BY at`,
      )
      .all(accountId) as {
      meter_id: string;
      at: number;
      used_percent: number;
      reset_at: number | null;
    }[];
    const usage = this.db
      .prepare(
        `SELECT class_id, at, tokens, source FROM usage_event
         WHERE account_id = ? ORDER BY at`,
      )
      .all(accountId) as {
      class_id: string;
      at: number;
      tokens: number;
      source: "orchestrator" | "machine";
    }[];
    const fold = (e: { class_id: string; at: number; tokens: number; source: "orchestrator" | "machine" }) => {
      const t = transform ? transform(e.class_id, e.tokens) : { classId: e.class_id, tokens: e.tokens };
      cal.recordUsage({ at: e.at, classId: t.classId, tokens: t.tokens, source: e.source });
    };
    let u = 0;
    for (const r of readings) {
      while (u < usage.length && usage[u].at <= r.at) fold(usage[u++]);
      cal.recordReading(r.meter_id, {
        at: r.at,
        usedPercent: r.used_percent,
        resetAt: r.reset_at ?? undefined,
      });
    }
    while (u < usage.length) fold(usage[u++]);
    return cal;
  }

  counts(accountId: string): { readings: number; usageEvents: number } {
    const one = (sql: string) =>
      (this.db.prepare(sql).get(accountId) as { n: number }).n;
    return {
      readings: one("SELECT COUNT(*) AS n FROM meter_reading WHERE account_id = ?"),
      usageEvents: one("SELECT COUNT(*) AS n FROM usage_event WHERE account_id = ?"),
    };
  }

  upsertTask(t: TaskSpec): void {
    if ((t.demandCommand === undefined) === (t.demandConstant === undefined)) {
      throw new Error(`task ${t.id}: exactly one of demandCommand/demandConstant required`);
    }
    if (t.tiers.length === 0 || new Set(t.tiers).size !== t.tiers.length) {
      throw new Error(`task ${t.id}: tiers must be a non-empty list without duplicates`);
    }
    for (const tier of t.tiers) {
      if (!TIERS.includes(tier)) throw new Error(`task ${t.id}: unknown tier ${tier}`);
    }
    if (t.gate !== undefined) parseGate(t.gate); // Validate syntax at write time.
    this.db
      .prepare(
        `INSERT INTO task (id, demand_command, demand_constant, gate, tiers, prompt, cwd, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET
           demand_command = excluded.demand_command,
           demand_constant = excluded.demand_constant,
           gate = excluded.gate,
           tiers = excluded.tiers,
           prompt = excluded.prompt,
           cwd = excluded.cwd`,
      )
      .run(
        t.id,
        t.demandCommand ?? null,
        t.demandConstant ?? null,
        t.gate ?? null,
        JSON.stringify(t.tiers),
        t.prompt ?? null,
        t.cwd ?? null,
        Date.now(),
      );
  }

  deleteTask(id: string): void {
    this.db.prepare("DELETE FROM task WHERE id = ?").run(id);
  }

  tasks(): TaskSpec[] {
    const rows = this.db
      .prepare(
        "SELECT id, demand_command, demand_constant, gate, tiers, prompt, cwd FROM task ORDER BY id",
      )
      .all() as {
      id: string;
      demand_command: string | null;
      demand_constant: number | null;
      gate: string | null;
      tiers: string;
      prompt: string | null;
      cwd: string | null;
    }[];
    return rows.map((r) => ({
      id: r.id,
      demandCommand: r.demand_command ?? undefined,
      demandConstant: r.demand_constant ?? undefined,
      gate: r.gate ?? undefined,
      tiers: JSON.parse(r.tiers) as Tier[],
      prompt: r.prompt ?? undefined,
      cwd: r.cwd ?? undefined,
    }));
  }

  getControl(key: string): string | undefined {
    const row = this.db.prepare("SELECT value FROM control WHERE key = ?").get(key) as
      | { value: string }
      | undefined;
    return row?.value;
  }

  setControl(key: string, value: string): void {
    this.db
      .prepare(
        `INSERT INTO control (key, value) VALUES (?, ?)
         ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
      )
      .run(key, value);
  }

  demandState(taskId: string): DemandState | undefined {
    const row = this.db
      .prepare(
        `SELECT units, probed_at, invalidated, error, gate_open_since
         FROM task_demand WHERE task_id = ?`,
      )
      .get(taskId) as
      | {
          units: number | null;
          probed_at: number | null;
          invalidated: number;
          error: string | null;
          gate_open_since: number | null;
        }
      | undefined;
    if (!row) return undefined;
    return {
      units: row.units ?? undefined,
      probedAt: row.probed_at ?? undefined,
      invalidated: row.invalidated !== 0,
      error: row.error ?? undefined,
      gateOpenSince: row.gate_open_since ?? undefined,
    };
  }

  /** A successful probe stores units and clears invalidation; a failed one
   * stores the error and clears units (fail closed). */
  recordDemand(taskId: string, result: { units?: number; error?: string }, at: number): void {
    this.db
      .prepare(
        `INSERT INTO task_demand (task_id, units, probed_at, invalidated, error)
         VALUES (?, ?, ?, 0, ?)
         ON CONFLICT (task_id) DO UPDATE SET
           units = excluded.units,
           probed_at = excluded.probed_at,
           invalidated = 0,
           error = excluded.error`,
      )
      .run(taskId, result.units ?? null, at, result.error ?? null);
  }

  setGateOpenSince(taskId: string, value: number | undefined): void {
    this.db
      .prepare(
        `INSERT INTO task_demand (task_id, gate_open_since) VALUES (?, ?)
         ON CONFLICT (task_id) DO UPDATE SET gate_open_since = excluded.gate_open_since`,
      )
      .run(taskId, value ?? null);
  }

  invalidateDemand(taskId: string): void {
    // No-op for deleted tasks: a run can finish after its task is removed.
    this.db
      .prepare(
        `INSERT INTO task_demand (task_id, invalidated)
         SELECT id, 1 FROM task WHERE id = ?
         ON CONFLICT (task_id) DO UPDATE SET invalidated = 1`,
      )
      .run(taskId);
  }

  /**
   * A finished run of `taskId` may have changed its own demand and the gates
   * that reference it; invalidate both so the next evaluation re-probes.
   */
  taskFinished(taskId: string): void {
    this.invalidateDemand(taskId);
    for (const t of this.tasks()) {
      if (t.gate !== undefined && gateRefs(parseGate(t.gate)).includes(taskId)) {
        this.invalidateDemand(t.id);
      }
    }
  }

  createRun(r: {
    taskId: string;
    tier: Tier;
    accountId: string;
    model: string;
    provider: string;
    thinking?: string;
    at: number;
  }): string {
    const id = crypto.randomUUID();
    this.db
      .prepare(
        `INSERT INTO run (id, task_id, tier, account_id, model, provider, thinking, state, started_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
      )
      .run(id, r.taskId, r.tier, r.accountId, r.model, r.provider, r.thinking ?? null, r.at);
    return id;
  }

  /**
   * Atomically claims up to `limit` pending runs for a runner (oldest first).
   * A single UPDATE statement, so concurrent runners never claim the same
   * run. Returns the claimed rows.
   */
  claimRuns(runnerId: string, limit: number, at: number): RunRow[] {
    if (limit <= 0) return [];
    const ids = this.db
      .prepare(
        `UPDATE run SET state = 'running', runner_id = ?, claimed_at = ?, heartbeat_at = ?
         WHERE state = 'pending' AND id IN
           (SELECT id FROM run WHERE state = 'pending' ORDER BY started_at LIMIT ?)
         RETURNING id`,
      )
      .all(runnerId, at, at, limit) as { id: string }[];
    return ids.map((r) => this.run(r.id)!);
  }

  /** Pending runs no runner claimed in time: aborted, not error, so a runner
   * outage never trips task circuit breakers. */
  expireUnclaimed(before: number, at: number): RunRow[] {
    const ids = this.db
      .prepare(
        `UPDATE run SET state = 'aborted', ended_at = ?, detail = 'unclaimed'
         WHERE state = 'pending' AND started_at < ? RETURNING id`,
      )
      .all(at, before) as { id: string }[];
    return ids.map((r) => this.run(r.id)!);
  }

  run(id: string): RunRow | undefined {
    return this.runRows("WHERE id = ?", [id])[0];
  }

  runs(filter?: { state?: RunState; runnerId?: string }): RunRow[] {
    const clauses: string[] = [];
    const params: (string | number)[] = [];
    if (filter?.state !== undefined) {
      clauses.push("state = ?");
      params.push(filter.state);
    }
    if (filter?.runnerId !== undefined) {
      clauses.push("runner_id = ?");
      params.push(filter.runnerId);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")} ` : "";
    return this.runRows(`${where}ORDER BY started_at`, params);
  }

  private runRows(clause: string, params: (string | number)[]): RunRow[] {
    const rows = this.db
      .prepare(
        `SELECT id, task_id, tier, account_id, model, provider, thinking, state, started_at,
                claimed_at, runner_id, ended_at, heartbeat_at, abort_requested, productive, complete, detail
         FROM run ${clause}`,
      )
      .all(...params) as {
      id: string;
      task_id: string;
      tier: Tier;
      account_id: string;
      model: string;
      provider: string;
      thinking: string | null;
      state: RunState;
      started_at: number;
      claimed_at: number | null;
      runner_id: string | null;
      ended_at: number | null;
      heartbeat_at: number | null;
      abort_requested: number;
      productive: number | null;
      complete: number | null;
      detail: string | null;
    }[];
    return rows.map((r) => ({
      id: r.id,
      taskId: r.task_id,
      tier: r.tier,
      accountId: r.account_id,
      model: r.model,
      provider: r.provider,
      thinking: r.thinking ?? undefined,
      state: r.state,
      startedAt: r.started_at,
      claimedAt: r.claimed_at ?? undefined,
      runnerId: r.runner_id ?? undefined,
      endedAt: r.ended_at ?? undefined,
      heartbeatAt: r.heartbeat_at ?? undefined,
      abortRequested: r.abort_requested !== 0,
      productive: r.productive === null ? undefined : r.productive !== 0,
      complete: r.complete === null ? undefined : r.complete !== 0,
      detail: r.detail ?? undefined,
    }));
  }

  finishRun(id: string, result: RunResult, at: number): void {
    this.db
      .prepare(
        `UPDATE run SET state = ?, ended_at = ?, productive = ?, complete = ?, detail = ?
         WHERE id = ? AND state IN ('pending', 'running')`,
      )
      .run(
        result.state,
        at,
        result.productive === undefined ? null : result.productive ? 1 : 0,
        result.complete === undefined ? null : result.complete ? 1 : 0,
        result.detail ?? null,
        id,
      );
  }

  heartbeatRun(id: string, at: number): void {
    this.db.prepare("UPDATE run SET heartbeat_at = ? WHERE id = ?").run(at, id);
  }

  requestAbort(id: string): void {
    this.db.prepare("UPDATE run SET abort_requested = 1 WHERE id = ?").run(id);
  }

  /** Failover moves a running session's assignment; history keeps only the
   * final assignment because per-hop provenance lives in `detail`. */
  reassignRun(id: string, a: { accountId: string; model: string; provider: string }): void {
    this.db
      .prepare("UPDATE run SET account_id = ?, model = ?, provider = ? WHERE id = ?")
      .run(a.accountId, a.model, a.provider, id);
  }

  /** Pending runs reserve the account just like running ones. */
  activeRunCount(accountId: string): number {
    const row = this.db
      .prepare(
        "SELECT COUNT(*) AS n FROM run WHERE account_id = ? AND state IN ('pending', 'running')",
      )
      .get(accountId) as { n: number };
    return row.n;
  }

  /** Session-hours this account served inside [since, now]. */
  runHours(accountId: string, since: number, now: number): number {
    const rows = this.db
      .prepare(
        `SELECT COALESCE(claimed_at, started_at) AS s, ended_at FROM run
         WHERE account_id = ? AND state != 'pending'
           AND (ended_at IS NULL OR ended_at > ?) AND COALESCE(claimed_at, started_at) < ?`,
      )
      .all(accountId, since, now) as { s: number; ended_at: number | null }[];
    let ms = 0;
    for (const r of rows) {
      ms += Math.max(0, Math.min(r.ended_at ?? now, now) - Math.max(r.s, since));
    }
    return ms / 3_600_000;
  }

  /** Error runs for a task since the cutoff; the controller's circuit breaker. */
  recentErrorCount(taskId: string, since: number): number {
    const row = this.db
      .prepare(
        "SELECT COUNT(*) AS n FROM run WHERE task_id = ? AND state = 'error' AND ended_at >= ?",
      )
      .get(taskId, since) as { n: number };
    return row.n;
  }

  /**
   * Observed percent drained since the cutoff, from meter readings: the sum of
   * positive used-percent deltas per meter (resets appear as negative deltas
   * and are skipped), taking the most binding meter. This is a fact-level
   * aggregate for burn measurement, deliberately simpler than calibration.
   */
  drainSince(accountId: string, since: number): number {
    const rows = this.db
      .prepare(
        `SELECT meter_id, at, used_percent FROM meter_reading
         WHERE account_id = ? AND at >= ? ORDER BY meter_id, at`,
      )
      .all(accountId, since) as { meter_id: string; at: number; used_percent: number }[];
    const drain = new Map<string, { last: number; sum: number }>();
    for (const r of rows) {
      const d = drain.get(r.meter_id);
      if (d === undefined) {
        drain.set(r.meter_id, { last: r.used_percent, sum: 0 });
      } else {
        if (r.used_percent > d.last) d.sum += r.used_percent - d.last;
        d.last = r.used_percent;
      }
    }
    let max = 0;
    for (const d of drain.values()) max = Math.max(max, d.sum);
    return max;
  }

  /** Deletes facts older than the cutoff; calibration only needs recent windows. */
  prune(beforeMs: number): { readings: number; usageEvents: number } {
    const readings = this.db
      .prepare("DELETE FROM meter_reading WHERE at < ?")
      .run(beforeMs).changes;
    const usageEvents = this.db
      .prepare("DELETE FROM usage_event WHERE at < ?")
      .run(beforeMs).changes;
    return { readings: Number(readings), usageEvents: Number(usageEvents) };
  }
}

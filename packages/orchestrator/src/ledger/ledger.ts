import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { AccountCalibrator } from "../calibrator/calibrator.js";
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

const MIGRATIONS: readonly string[] = [SCHEMA];

export interface AccountRow {
  readonly id: string;
  readonly provider: string;
  readonly label: string | undefined;
  readonly accessUntil: number | undefined;
  readonly createdAt: number;
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
           label = excluded.label,
           access_until = excluded.access_until`,
      )
      .run(a.id, a.provider, a.label ?? null, a.accessUntil ?? null, Date.now());
  }

  accounts(): AccountRow[] {
    const rows = this.db
      .prepare("SELECT id, provider, label, access_until, created_at FROM account ORDER BY id")
      .all() as {
      id: string;
      provider: string;
      label: string | null;
      access_until: number | null;
      created_at: number;
    }[];
    return rows.map((r) => ({
      id: r.id,
      provider: r.provider,
      label: r.label ?? undefined,
      accessUntil: r.access_until ?? undefined,
      createdAt: r.created_at,
    }));
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

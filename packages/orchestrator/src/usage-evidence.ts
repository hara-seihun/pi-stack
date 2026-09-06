import type { DatabaseSync } from "node:sqlite";
import { openSqlite } from "./sqlite.js";
import { ORCHESTRATOR_CATALOG, catalogModel } from "./catalog.js";

export interface UsageEvidence {
  version: 1;
  capturedAt: number;
  accounts: { id: string; provider: string; use: string }[];
  meters: { accountId: string; meterId: string; at: number; usedPercent: number; resetAt: number | null }[];
  hours: { accountId: string; hour: number; model: string; component: string; tokens: number }[];
  weeklyMeters: { id: string; provider: string; windowHours: number; models: string[] | null }[];
}

/** A read-only snapshot, with no credentials, account labels, run ids or transcript paths. */
export function readUsageEvidence(path: string, now = Date.now()):
  { ok: true; value: UsageEvidence } | { ok: false; error: string } {
  let db: DatabaseSync | undefined;
  try {
    db = openSqlite(path, true);
    db.exec("BEGIN");
    const since = now - 24 * 3_600_000;
    const value: UsageEvidence = {
      version: 1,
      capturedAt: now,
      accounts: db.prepare(`SELECT id,provider,
        CASE WHEN (SELECT value FROM control WHERE key='account-use:'||account.id)='voice'
        THEN 'voice' ELSE 'shared' END AS use FROM account`).all() as UsageEvidence["accounts"],
      meters: db.prepare(`SELECT account_id AS accountId,meter_id AS meterId,observed_at AS at,
        used_percent AS usedPercent,reset_at AS resetAt FROM meter
        WHERE observed_at>=? AND observed_at<=? ORDER BY observed_at`).all(since, now) as UsageEvidence["meters"],
      hours: db.prepare(`SELECT account_id AS accountId,hour,model,component,SUM(tokens) AS tokens
        FROM usage_hour WHERE hour>=? AND hour<? GROUP BY account_id,hour,model,component`)
        .all(Math.floor(since / 3_600_000) * 3_600_000, now) as UsageEvidence["hours"],
      weeklyMeters: ORCHESTRATOR_CATALOG.meters.filter(m => m.windowHours >= 168).map(m => ({
        id: m.id, provider: m.provider, windowHours: m.windowHours,
        models: m.drainedBy.length === 1
          ? m.drainedBy.map(key => catalogModel(key.split(":")[0]!)?.model ?? key)
          : null,
      })),
    };
    return { ok: true, value };
  } catch (error) {
    return { ok: false, error: `Cannot read usage evidence at ${path}: ${String(error)}` };
  } finally {
    db?.close();
  }
}

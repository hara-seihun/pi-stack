import type { Database } from "bun:sqlite";
import { FEATURES, type Feature, type FeatureActor, type FeatureEvent, type FeatureObservation, type FeatureUsageSummary, type UsageResult } from "../shared/feature-usage";
const DAY = 86_400_000;
const actors: FeatureActor[] = ["human", "agent", "phone"];

export class FeatureUsage {
  constructor(private readonly db: Database, now = Date.now()) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS feature_usage_coverage (id INTEGER PRIMARY KEY CHECK(id=1), since INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS feature_usage_totals (
        feature TEXT NOT NULL, actor TEXT NOT NULL, uses INTEGER NOT NULL, last_used INTEGER,
        state TEXT, state_at INTEGER, PRIMARY KEY(feature,actor));
      CREATE TABLE IF NOT EXISTS feature_usage_days (
        day INTEGER NOT NULL, feature TEXT NOT NULL, actor TEXT NOT NULL, uses INTEGER NOT NULL,
        PRIMARY KEY(day,feature,actor));
      CREATE TABLE IF NOT EXISTS feature_usage_receipts (id TEXT PRIMARY KEY, at INTEGER NOT NULL);
    `);
    db.query("INSERT OR IGNORE INTO feature_usage_coverage VALUES(1,?)").run(now);
  }

  record(event: FeatureEvent, actor: FeatureActor, now = Date.now()): UsageResult<{ recorded: boolean }> {
    try {
      return this.db.transaction(() => {
        if (event.kind === "state") {
          const previous = this.db.query("SELECT state FROM feature_usage_totals WHERE feature=? AND actor=?").get(event.feature, actor) as { state: string | null } | null;
          if (previous?.state === event.state) return { ok: true as const, value: { recorded: false } };
        }
        const inserted = this.db.query("INSERT OR IGNORE INTO feature_usage_receipts VALUES(?,?)").run(event.id, now);
        if (inserted.changes === 0) return { ok: true as const, value: { recorded: false } };
        const day = Math.floor(now / DAY);
        this.db.query("INSERT OR IGNORE INTO feature_usage_totals VALUES(?,?,0,NULL,NULL,NULL)").run(event.feature, actor);
        if (event.kind === "use") {
          this.db.query("UPDATE feature_usage_totals SET uses=uses+1,last_used=? WHERE feature=? AND actor=?").run(now, event.feature, actor);
          this.db.query("INSERT INTO feature_usage_days VALUES(?,?,?,1) ON CONFLICT(day,feature,actor) DO UPDATE SET uses=uses+1").run(day, event.feature, actor);
        } else {
          this.db.query("UPDATE feature_usage_totals SET state=?,state_at=? WHERE feature=? AND actor=?").run(event.state, now, event.feature, actor);
        }
        this.db.query("DELETE FROM feature_usage_days WHERE day<?").run(day - 89);
        this.db.query("DELETE FROM feature_usage_receipts WHERE at<?").run((day - 89) * DAY);
        return { ok: true as const, value: { recorded: true } };
      })();
    } catch {
      return { ok: false, error: { code: "storage_unavailable", message: "Feature usage could not be recorded; collection has a gap" } };
    }
  }

  summary(now = Date.now()): UsageResult<FeatureUsageSummary> {
    try {
      const since = (this.db.query("SELECT since FROM feature_usage_coverage WHERE id=1").get() as { since: number }).since;
      const today = Math.floor(now / DAY);
      const features = (Object.keys(FEATURES) as Feature[]).map(id => {
        const observations: FeatureObservation[] = actors.map(actor => {
          const row = this.db.query("SELECT * FROM feature_usage_totals WHERE feature=? AND actor=?").get(id, actor) as
            { uses: number; last_used: number | null; state: "enabled" | "disabled" | "unavailable" | null; state_at: number | null } | null;
          const counts = this.db.query(`SELECT COALESCE(SUM(CASE WHEN day>=? THEN uses ELSE 0 END),0) recent,
            COALESCE(SUM(CASE WHEN day<? AND day>=? THEN uses ELSE 0 END),0) previous
            FROM feature_usage_days WHERE feature=? AND actor=?`).get(today - 6, today - 6, today - 36, id, actor) as { recent: number; previous: number };
          return { actor, uses: row === null ? 0 : row.uses, lastUsedAt: row === null ? null : row.last_used,
            last7Days: counts.recent, previous30Days: counts.previous,
            state: row?.state !== null && row?.state !== undefined && row.state_at !== null ? { value: row.state, observedAt: row.state_at } : null };
        });
        return { id, observations };
      });
      return { ok: true, value: { since, asOf: now, retentionDays: 90, features } };
    } catch {
      return { ok: false, error: { code: "storage_unavailable", message: "Feature usage is unavailable" } };
    }
  }
}

import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { AgentCapacity, CapacityCustody, CapacityRecovery, CapacityReleaseClient } from "../agent-capacity.js";
import type { Result } from "./contracts.js";

export interface ThreadCapacityRow {
  execution_id: string; logical_execution_id: string; thread_id: string; source_id: string;
  kind: "work" | "command"; state: "requested" | "held" | "releasing" | "released";
  lease_id: string | null; entered_native: number; error: string | null; owner_id: string | null;
}
export type CapacityHandoffProof = { kind: "unentered"; observedAt: number } | { kind: "native-idle" | "native-absent"; observedAt: number; threadId: string };
const good = <T>(value: T): Result<T> => ({ ok: true, value });

/** Durable outbox for global custody. Only the thread owner supplies positive native release proof. */
export class ThreadCapacityLedger {
  constructor(private readonly db: DatabaseSync, private readonly capacity: AgentCapacity, private readonly recovery?: CapacityRecovery) {
    db.exec(`CREATE TABLE IF NOT EXISTS thread_capacity (
      execution_id TEXT PRIMARY KEY, logical_execution_id TEXT NOT NULL, thread_id TEXT NOT NULL,
      source_id TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('work','command')),
      state TEXT NOT NULL CHECK(state IN ('requested','held','releasing','released')),
      lease_id TEXT, entered_native INTEGER NOT NULL CHECK(entered_native IN (0,1)), error TEXT,
      CHECK(state!='held' OR lease_id IS NOT NULL)
    ) STRICT;
    CREATE UNIQUE INDEX IF NOT EXISTS thread_capacity_current ON thread_capacity(thread_id,logical_execution_id) WHERE state!='released';
    CREATE INDEX IF NOT EXISTS thread_capacity_pending ON thread_capacity(state) WHERE state!='released';`);
    const columns = db.prepare("PRAGMA table_info(thread_capacity)").all() as { name: string }[];
    if (!columns.some(column => column.name === "owner_id")) db.exec("ALTER TABLE thread_capacity ADD COLUMN owner_id TEXT");
    db.exec("CREATE TABLE IF NOT EXISTS thread_capacity_handoff (execution_id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, proof TEXT NOT NULL, acknowledged_at INTEGER) STRICT");
  }
  private rows(where: string, ...parameters: string[]): ThreadCapacityRow[] {
    return this.db.prepare(`SELECT * FROM thread_capacity WHERE ${where}`).all(...parameters) as unknown as ThreadCapacityRow[];
  }
  async identify(row: ThreadCapacityRow): Promise<Result<string | null>> {
    if (row.owner_id !== null) return good(row.owner_id);
    const execution = { agentId: row.thread_id, executionId: row.execution_id };
    let ownerId: string | undefined;
    if (this.recovery) {
      const owner = await this.recovery.recordedOwner(execution); if (!owner.ok) return owner;
      ownerId = owner.value ?? this.capacity.ownerId;
    } else {
      if (!this.capacity.ownerId) return good(null);
      const observed = await this.capacity.inspect(execution); if (!observed.ok) return observed;
      ownerId = this.capacity.ownerId;
    }
    if (!ownerId) return { ok: false, error: { code: "unavailable", message: "Global agent capacity: original owner is unresolved; custody retained" } };
    this.db.prepare("UPDATE thread_capacity SET owner_id=? WHERE execution_id=? AND owner_id IS NULL").run(ownerId, row.execution_id);
    row.owner_id = ownerId;
    return good(ownerId);
  }
  private async releasingClient(row: ThreadCapacityRow): Promise<Result<CapacityReleaseClient>> {
    const owner = await this.identify(row); if (!owner.ok) return owner;
    if (owner.value === null || owner.value === this.capacity.ownerId) return good(this.capacity);
    return this.recovery ? this.recovery.originalOwner(owner.value, { agentId: row.thread_id, executionId: row.execution_id })
      : { ok: false, error: { code: "unavailable", message: "Global agent capacity: original owner recovery is not registered" } };
  }
  async handoff(row: ThreadCapacityRow, proof: CapacityHandoffProof): Promise<Result<void>> {
    if (proof.kind === "unentered" ? row.entered_native !== 0 : proof.threadId !== row.thread_id)
      return { ok: false, error: { code: "conflict", message: "Global agent capacity: handoff proof does not match execution" } };
    const owner = await this.identify(row); if (!owner.ok) return owner;
    if (!owner.value) return { ok: false, error: { code: "unavailable", message: "Global agent capacity: handoff owner remains unknown" } };
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("INSERT OR IGNORE INTO thread_capacity_handoff(execution_id,owner_id,proof) VALUES(?,?,?)").run(row.execution_id, owner.value, JSON.stringify(proof));
      this.db.prepare("UPDATE thread_capacity SET state='releasing' WHERE execution_id=? AND state IN ('held','requested')").run(row.execution_id);
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
    return this.flush(row.execution_id);
  }
  current(threadId: string): ThreadCapacityRow[] { return this.rows("thread_id=? AND state!='released'", threadId); }
  candidate(threadId: string, workId: string): string | undefined {
    return (this.db.prepare("SELECT logical_execution_id FROM thread_capacity WHERE thread_id=? AND source_id=? AND kind='work' AND state IN ('requested','held') ORDER BY rowid DESC LIMIT 1").get(threadId, workId) as { logical_execution_id: string } | undefined)?.logical_execution_id;
  }
  retain(threadId: string, logicalExecutionId: string, sourceId: string, kind: ThreadCapacityRow["kind"]): void {
    if (this.db.prepare("SELECT 1 FROM thread_capacity WHERE thread_id=? AND logical_execution_id=?").get(threadId, logicalExecutionId)) return;
    this.db.prepare("INSERT INTO thread_capacity(execution_id,logical_execution_id,thread_id,source_id,kind,state,entered_native) VALUES(?,?,?,?,?,'requested',1)")
      .run(logicalExecutionId, logicalExecutionId, threadId, sourceId, kind);
  }
  async acquire(threadId: string, logicalExecutionId: string, sourceId: string, kind: ThreadCapacityRow["kind"]): Promise<Result<CapacityCustody>> {
    let row = this.rows("thread_id=? AND logical_execution_id=? AND state!='released'", threadId, logicalExecutionId)[0];
    if (!row) {
      const previous = this.db.prepare("SELECT 1 FROM thread_capacity WHERE logical_execution_id=? LIMIT 1").get(logicalExecutionId);
      const executionId = previous ? `${logicalExecutionId}:${randomUUID()}` : logicalExecutionId;
      this.db.prepare("INSERT INTO thread_capacity(execution_id,logical_execution_id,thread_id,source_id,kind,state,entered_native) VALUES(?,?,?,?,?,'requested',0)")
        .run(executionId, logicalExecutionId, threadId, sourceId, kind);
      row = this.rows("execution_id=?", executionId)[0]!;
      if (this.capacity.ownerId) {
        this.db.prepare("UPDATE thread_capacity SET owner_id=? WHERE execution_id=?").run(this.capacity.ownerId, executionId);
        row.owner_id = this.capacity.ownerId;
      } else if (this.recovery) return { ok: false, error: { code: "unavailable", message: "Global agent capacity: successor owner registration unavailable" } };
    }
    if (row.state === "releasing") {
      const released = await this.flush(row.execution_id);
      if (!released.ok) return released;
      return this.acquire(threadId, logicalExecutionId, sourceId, kind);
    }
    const owner = await this.identify(row);
    if (!owner.ok) return owner;
    if (owner.value !== null && owner.value !== this.capacity.ownerId) return { ok: false, error: { code: "unavailable", message: "Global agent capacity: original-owner custody awaits positive native handoff", retryAt: Date.now() + 5_000 } };
    const acquired = await this.capacity.acquire({ agentId: threadId, executionId: row.execution_id });
    if (!acquired.ok) {
      this.db.prepare("UPDATE thread_capacity SET error=? WHERE execution_id=?").run(acquired.error.message, row.execution_id);
      return acquired;
    }
    this.db.prepare("UPDATE thread_capacity SET lease_id=?,state=CASE WHEN state='releasing' THEN 'releasing' ELSE 'held' END,error=NULL WHERE execution_id=? AND state!='released'")
      .run(acquired.value.leaseId, row.execution_id);
    if (this.rows("execution_id=?", row.execution_id)[0]?.state !== "held") {
      const released = await this.flush(row.execution_id);
      return released.ok ? { ok: false, error: { code: "unavailable", message: "Global agent capacity: acquisition was withdrawn before native dispatch", retryAt: Date.now() + 5_000 } } : released;
    }
    return good({ agentId: acquired.value.agentId, executionId: acquired.value.executionId, leaseId: acquired.value.leaseId });
  }
  entered(threadId: string, logicalExecutionId: string): void {
    this.db.prepare("UPDATE thread_capacity SET entered_native=1 WHERE thread_id=? AND logical_execution_id=? AND state='held'").run(threadId, logicalExecutionId);
  }
  requestRelease(threadId: string, logicalExecutionId?: string): void {
    this.db.prepare(`UPDATE thread_capacity SET state='releasing' WHERE thread_id=? AND state IN ('requested','held') ${logicalExecutionId === undefined ? "" : "AND logical_execution_id=?"}`)
      .run(...logicalExecutionId === undefined ? [threadId] : [threadId, logicalExecutionId]);
  }
  async release(threadId: string, logicalExecutionId?: string): Promise<Result<void>> {
    this.requestRelease(threadId, logicalExecutionId);
    return this.flush(undefined, threadId);
  }
  async releaseUnentered(threadId: string, logicalExecutionId: string): Promise<Result<void>> {
    this.db.prepare("UPDATE thread_capacity SET state='releasing' WHERE thread_id=? AND logical_execution_id=? AND entered_native=0 AND state IN ('requested','held')").run(threadId, logicalExecutionId);
    return this.flush(undefined, threadId);
  }
  async flush(executionId?: string, threadId?: string): Promise<Result<void>> {
    const rows = this.rows(`state='releasing' ${executionId === undefined ? "" : "AND execution_id=?"} ${threadId === undefined ? "" : "AND thread_id=?"}`,
      ...executionId === undefined ? [] : [executionId], ...threadId === undefined ? [] : [threadId]);
    let failure: Result<void> | undefined;
    for (const row of rows) {
      const execution = { agentId: row.thread_id, executionId: row.execution_id };
      let result: Result<void>;
      const client = await this.releasingClient(row);
      if (!client.ok) result = client;
      else if (row.lease_id) result = await client.value.release({ ...execution, leaseId: row.lease_id });
      else {
        const observation = await client.value.inspect(execution);
        if (!observation.ok) result = observation;
        else if (observation.value.state === "active") {
          const custody = observation.value.custody;
          this.db.prepare("UPDATE thread_capacity SET lease_id=? WHERE execution_id=?").run(custody.leaseId, row.execution_id);
          result = await client.value.release(custody);
        } else result = await client.value.withdraw(execution);
      }
      if (!result.ok) {
        this.db.prepare("UPDATE thread_capacity SET error=? WHERE execution_id=? AND state='releasing'").run(result.error.message, row.execution_id);
        failure ??= result;
        continue;
      }
      this.db.exec("BEGIN IMMEDIATE");
      try {
        this.db.prepare("UPDATE thread_capacity SET state='released',error=NULL WHERE execution_id=? AND state='releasing'").run(row.execution_id);
        this.db.prepare("UPDATE thread_capacity_handoff SET acknowledged_at=? WHERE execution_id=? AND acknowledged_at IS NULL").run(Date.now(), row.execution_id);
        this.db.exec("COMMIT");
      } catch (error) { this.db.exec("ROLLBACK"); throw error; }
    }
    return failure ?? good(undefined);
  }
}

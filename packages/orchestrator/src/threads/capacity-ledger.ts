import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { AgentCapacity, CapacityCustody } from "../agent-capacity.js";
import type { Result } from "./contracts.js";

export interface ThreadCapacityRow {
  execution_id: string; logical_execution_id: string; thread_id: string; source_id: string;
  kind: "work" | "command"; state: "requested" | "held" | "releasing" | "released";
  lease_id: string | null; entered_native: number; error: string | null;
}
const good = <T>(value: T): Result<T> => ({ ok: true, value });

/** Durable outbox for global custody. Only the thread owner supplies positive native release proof. */
export class ThreadCapacityLedger {
  constructor(private readonly db: DatabaseSync, private readonly capacity: AgentCapacity) {
    db.exec(`CREATE TABLE IF NOT EXISTS thread_capacity (
      execution_id TEXT PRIMARY KEY, logical_execution_id TEXT NOT NULL, thread_id TEXT NOT NULL,
      source_id TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('work','command')),
      state TEXT NOT NULL CHECK(state IN ('requested','held','releasing','released')),
      lease_id TEXT, entered_native INTEGER NOT NULL CHECK(entered_native IN (0,1)), error TEXT,
      CHECK(state!='held' OR lease_id IS NOT NULL)
    ) STRICT;
    CREATE UNIQUE INDEX IF NOT EXISTS thread_capacity_current ON thread_capacity(thread_id,logical_execution_id) WHERE state!='released';
    CREATE INDEX IF NOT EXISTS thread_capacity_pending ON thread_capacity(state) WHERE state!='released';`);
  }
  private rows(where: string, ...parameters: string[]): ThreadCapacityRow[] {
    return this.db.prepare(`SELECT * FROM thread_capacity WHERE ${where}`).all(...parameters) as unknown as ThreadCapacityRow[];
  }
  current(threadId: string): ThreadCapacityRow[] { return this.rows("thread_id=? AND state!='released'", threadId); }
  candidate(threadId: string, workId: string): string | undefined {
    return (this.db.prepare("SELECT logical_execution_id FROM thread_capacity WHERE thread_id=? AND source_id=? AND kind='work' ORDER BY rowid DESC LIMIT 1").get(threadId, workId) as { logical_execution_id: string } | undefined)?.logical_execution_id;
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
    }
    if (row.state === "releasing") {
      const released = await this.flush(row.execution_id);
      if (!released.ok) return released;
      return this.acquire(threadId, logicalExecutionId, sourceId, kind);
    }
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
    return this.flush();
  }
  async releaseUnentered(threadId: string, logicalExecutionId: string): Promise<Result<void>> {
    this.db.prepare("UPDATE thread_capacity SET state='releasing' WHERE thread_id=? AND logical_execution_id=? AND entered_native=0 AND state IN ('requested','held')").run(threadId, logicalExecutionId);
    return this.flush();
  }
  async flush(executionId?: string): Promise<Result<void>> {
    const rows = this.rows(`state='releasing' ${executionId === undefined ? "" : "AND execution_id=?"}`, ...executionId === undefined ? [] : [executionId]);
    for (const row of rows) {
      const execution = { agentId: row.thread_id, executionId: row.execution_id };
      let result: Result<void>;
      if (row.lease_id) result = await this.capacity.release({ ...execution, leaseId: row.lease_id });
      else {
        const observation = await this.capacity.inspect(execution);
        if (!observation.ok) result = observation;
        else if (observation.value.state === "active") {
          const custody = observation.value.custody;
          this.db.prepare("UPDATE thread_capacity SET lease_id=? WHERE execution_id=?").run(custody.leaseId, row.execution_id);
          result = await this.capacity.release(custody);
        } else result = await this.capacity.withdraw(execution);
      }
      if (!result.ok) {
        this.db.prepare("UPDATE thread_capacity SET error=? WHERE execution_id=? AND state='releasing'").run(result.error.message, row.execution_id);
        return result;
      }
      this.db.prepare("UPDATE thread_capacity SET state='released',error=NULL WHERE execution_id=? AND state='releasing'").run(row.execution_id);
    }
    return good(undefined);
  }
}

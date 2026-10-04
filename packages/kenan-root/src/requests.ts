import { Database } from "bun:sqlite";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { createHash } from "node:crypto";
import type { RootAdmission } from "kenan-memory/contract";
import type { RootExecution } from "./root-runtime.js";

export type RootRequest = {
  id: string;
  requestHash: string;
  admission: Omit<RootAdmission, "memoryToken">;
  delivery: "pending" | "delivered" | "inline";
  attemptedAt?: number;
} & (
  | { state: "executing" | "interrupted" | "failed" }
  | { state: "finalizing" | "completed"; chosen: RootExecution }
);
export const requestHash = (request: string) => createHash("sha256").update(request).digest("hex");

export class RootRequestStore {
  private readonly db: Database;
  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new Database(path, { create: true, strict: true });
    if (path !== ":memory:") chmodSync(path, 0o600);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA secure_delete=ON;
      CREATE TABLE IF NOT EXISTS requests(id TEXT PRIMARY KEY, body TEXT NOT NULL);
      UPDATE requests SET body=json_set(body,'$.state','interrupted') WHERE json_extract(body,'$.state')='executing';`);
  }
  get(id: string): RootRequest | undefined {
    const row = this.db.query("SELECT body FROM requests WHERE id=?").get(id) as { body: string } | null;
    return row ? JSON.parse(row.body) : undefined;
  }
  accept(id: string, request: string, admission: RootAdmission, asynchronous = true): RootRequest {
    const { memoryToken: _token, ...original } = admission;
    const record: RootRequest = { id, requestHash: requestHash(request), admission: original, state: "executing", delivery: asynchronous ? "pending" : "inline" };
    this.db.query("INSERT INTO requests(id,body) VALUES(?,?)").run(id, JSON.stringify(record));
    return record;
  }
  save(record: RootRequest) {
    this.db.query("UPDATE requests SET body=? WHERE id=?").run(JSON.stringify(record), record.id);
  }
  pending(limit = 4): RootRequest[] {
    return (this.db.query("SELECT body FROM requests WHERE json_extract(body,'$.state')='finalizing' OR (json_extract(body,'$.state') IN ('completed','failed','interrupted') AND json_extract(body,'$.delivery')='pending') ORDER BY coalesce(json_extract(body,'$.attemptedAt'),0),rowid LIMIT ?").all(limit) as { body: string }[]).map(row => JSON.parse(row.body));
  }
  close() { this.db.close(); }
}

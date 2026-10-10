import { Database } from "bun:sqlite";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { createHash } from "node:crypto";
import { KENAN_REQUEST_QUEUE_REASONS, type KenanRequestQueuedReason, type RootAdmission } from "kenan-memory/contract";
import type { RootExecution } from "./root-runtime.js";

export type RootRequest = {
  id: string;
  requestHash: string;
  admission: Omit<RootAdmission, "memoryToken">;
  delivery: "pending" | "delivered" | "inline";
  attemptedAt?: number;
} & (
  | { state: "queued"; request: string; reason: KenanRequestQueuedReason; retryAt: number }
  | { state: "executing" | "interrupted" | "failed" }
  | { state: "finalizing" | "completed"; chosen: RootExecution }
);
export const requestHash = (request: string) => createHash("sha256").update(request).digest("hex");

export function parseRootRequest(body: string): RootRequest {
  const record = JSON.parse(body);
  if (!record || !["queued", "executing", "interrupted", "failed", "finalizing", "completed"].includes(record.state)
    || !["pending", "delivered", "inline"].includes(record.delivery)) throw new Error("Invalid stored root request lifecycle");
  if (record.state === "queued" && (typeof record.request !== "string" || !record.request.trim() || record.requestHash !== requestHash(record.request)
    || !KENAN_REQUEST_QUEUE_REASONS.includes(record.reason) || !Number.isFinite(record.retryAt))) throw new Error("Stored root queue is missing runnable admission data");
  if ((record.state === "finalizing" || record.state === "completed")
    && (typeof record.chosen?.reply !== "string" || !Array.isArray(record.chosen?.subjects))) throw new Error("Stored root reply is missing its chosen result");
  return record;
}

export class RootRequestStore {
  private readonly db: Database;
  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new Database(path, { create: true, strict: true });
    if (path !== ":memory:") chmodSync(path, 0o600);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA secure_delete=ON;
      CREATE TABLE IF NOT EXISTS requests(id TEXT PRIMARY KEY, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS not_accepted(id TEXT PRIMARY KEY);
      UPDATE requests SET body=json_set(body,'$.state','interrupted') WHERE json_extract(body,'$.state')='executing';`);
  }
  get(id: string): RootRequest | undefined {
    const row = this.db.query("SELECT body FROM requests WHERE id=?").get(id) as { body: string } | null;
    return row ? parseRootRequest(row.body) : undefined;
  }
  notAccepted(id: string): boolean {
    return !!this.db.query("SELECT id FROM not_accepted WHERE id=?").get(id);
  }
  fenceNotAccepted(id: string): void {
    if (this.get(id)) throw new Error("An accepted request cannot be declared not accepted");
    this.db.query("INSERT OR IGNORE INTO not_accepted(id) VALUES(?)").run(id);
  }
  accept(id: string, request: string, admission: RootAdmission, asynchronous = true, initial: "executing" | "queued" = "executing"): RootRequest {
    if (this.notAccepted(id)) throw new Error("A request fenced as not accepted cannot execute");
    const { memoryToken: _token, ...original } = admission;
    const common = { id, requestHash: requestHash(request), admission: original, delivery: asynchronous ? "pending" as const : "inline" as const };
    const record: RootRequest = initial === "executing" ? { ...common, state: "executing" }
      : { ...common, state: "queued", request, reason: "root-concurrency", retryAt: Date.now() };
    this.db.query("INSERT INTO requests(id,body) VALUES(?,?)").run(id, JSON.stringify(record));
    return record;
  }
  save(record: RootRequest) {
    this.db.query("UPDATE requests SET body=? WHERE id=?").run(JSON.stringify(record), record.id);
  }
  pending(limit = 4): RootRequest[] {
    return (this.db.query("SELECT body FROM requests WHERE (json_extract(body,'$.state')='queued' AND json_extract(body,'$.retryAt')<=?) OR json_extract(body,'$.state')='finalizing' OR (json_extract(body,'$.state') IN ('completed','failed','interrupted') AND json_extract(body,'$.delivery')='pending') OR coalesce(json_extract(body,'$.state'),'') NOT IN ('queued','executing','finalizing','completed','failed','interrupted') OR coalesce(json_extract(body,'$.delivery'),'') NOT IN ('pending','delivered','inline') ORDER BY coalesce(json_extract(body,'$.attemptedAt'),0),rowid LIMIT ?").all(Date.now(), limit) as { body: string }[]).map(row => parseRootRequest(row.body));
  }
  close() { this.db.close(); }
}

import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import type { DatabaseSync } from "node:sqlite";
import { openSqlite } from "./sqlite.js";
import { AGENT_CAPACITY_AUTHORITY, GLOBAL_AGENT_LIMIT, isAgentExecution, isCapacityCustody,
  type AgentExecution, type CapacityCustody, type CapacityAcquireResult, type AgentCapacityStatus, type CapacityObservation } from "./agent-capacity.js";
import type { Result } from "./threads/contracts.js";

export interface CapacityEntry extends CapacityCustody { ownerId: string }
export interface CensusEntry extends AgentExecution { ownerId: string }
const fail = <T>(code: "unavailable" | "invalid_request" | "conflict", message: string): Result<T> => ({ ok: false, error: { code, message: `Global agent capacity: ${message}`, ...(code === "unavailable" ? { retryAt: Date.now() + 5_000 } : {}) } });
const nonempty = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 512;
interface Row { agent_id: string; execution_id: string; owner_id: string; lease_id: string | null; state: "queued" | "active" | "released" }

/** No heartbeat eviction: loss of a process, host or acknowledgement is not proof of settlement. */
export class AgentCapacityAuthority {
  private readonly db: DatabaseSync;
  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = openSqlite(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS capacity_meta (id INTEGER PRIMARY KEY CHECK(id=1), authority TEXT NOT NULL, initialized INTEGER NOT NULL CHECK(initialized IN (0,1))) STRICT;
      INSERT OR IGNORE INTO capacity_meta VALUES(1,'${AGENT_CAPACITY_AUTHORITY}',0);
      CREATE TABLE IF NOT EXISTS capacity_request (
        execution_id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, owner_id TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('queued','active','released')), lease_id TEXT,
        requested_at INTEGER NOT NULL, released_at INTEGER,
        CHECK ((state='queued' AND lease_id IS NULL AND released_at IS NULL) OR (state='active' AND lease_id IS NOT NULL AND released_at IS NULL) OR (state='released' AND released_at IS NOT NULL))
      ) STRICT;
      CREATE UNIQUE INDEX IF NOT EXISTS capacity_active_agent ON capacity_request(agent_id) WHERE state='active';`);
    const meta = this.db.prepare("SELECT authority FROM capacity_meta WHERE id=1").get() as { authority: string };
    if (meta.authority !== AGENT_CAPACITY_AUTHORITY) throw new Error("Unknown agent capacity authority database");
  }
  close(): void { this.db.close(); }
  private transaction<T>(operation: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try { const value = operation(); this.db.exec("COMMIT"); return value; }
    catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  status(): AgentCapacityStatus {
    const meta = this.db.prepare("SELECT initialized FROM capacity_meta WHERE id=1").get() as { initialized: number };
    const counts = this.db.prepare("SELECT state,COUNT(*) AS count FROM capacity_request GROUP BY state").all() as { state: Row["state"]; count: number }[];
    return { authority: AGENT_CAPACITY_AUTHORITY, limit: GLOBAL_AGENT_LIMIT, initialized: meta.initialized === 1,
      active: counts.find(row => row.state === "active")?.count ?? 0, queued: counts.find(row => row.state === "queued")?.count ?? 0 };
  }
  entries(): CapacityEntry[] {
    return (this.db.prepare("SELECT * FROM capacity_request WHERE state='active' ORDER BY requested_at,execution_id").all() as unknown as Row[])
      .map(row => ({ agentId: row.agent_id, executionId: row.execution_id, ownerId: row.owner_id, leaseId: row.lease_id! }));
  }
  initialize(entries: CensusEntry[]): Result<void> {
    if (!Array.isArray(entries) || entries.some(entry => !isAgentExecution(entry) || !nonempty(entry.ownerId))) return fail("invalid_request", "Invalid active-execution census");

    if (new Set(entries.map(entry => entry.agentId)).size !== entries.length || new Set(entries.map(entry => entry.executionId)).size !== entries.length) return fail("conflict", "Census contains overlapping identities; resolve actual custody before cutover");
    return this.transaction(() => {
      if (this.status().initialized) return fail("conflict", "Authority already initialized; never replace its active census");
      for (const entry of entries) {
        const row = this.db.prepare("SELECT * FROM capacity_request WHERE execution_id=?").get(entry.executionId) as Row | undefined;
        if (row && (row.agent_id !== entry.agentId || row.owner_id !== entry.ownerId)) return fail("conflict", "Census conflicts with recorded request ownership");
      }
      for (const entry of entries) this.db.prepare(`INSERT INTO capacity_request(execution_id,agent_id,owner_id,state,lease_id,requested_at)
        VALUES(?,?,?,'active',?,?) ON CONFLICT(execution_id) DO UPDATE SET state='active',lease_id=excluded.lease_id,released_at=NULL`)
        .run(entry.executionId, entry.agentId, entry.ownerId, randomUUID(), Date.now());
      this.db.prepare("UPDATE capacity_meta SET initialized=1 WHERE id=1").run();
      return { ok: true, value: undefined };
    });
  }
  acquire(ownerId: string, execution: AgentExecution): CapacityAcquireResult {
    if (!nonempty(ownerId) || !isAgentExecution(execution)) return fail("invalid_request", "Owner, agent and execution identities are required");
    return this.transaction(() => {
      let row = this.db.prepare("SELECT * FROM capacity_request WHERE execution_id=?").get(execution.executionId) as Row | undefined;
      if (row && (row.owner_id !== ownerId || row.agent_id !== execution.agentId)) return fail("unavailable", "Execution custody belongs to another owner; a restart or live handoff cannot take it");
      if (row?.state === "released") return fail("conflict", "Execution already positively released; start a new durable execution identity");
      if (row?.state === "active") return { ok: true, value: { ...execution, leaseId: row.lease_id! } };
      if (!row) {
        this.db.prepare("INSERT INTO capacity_request(execution_id,agent_id,owner_id,state,requested_at) VALUES(?,?,?,'queued',?)")
          .run(execution.executionId, execution.agentId, ownerId, Date.now());
        row = { agent_id: execution.agentId, execution_id: execution.executionId, owner_id: ownerId, state: "queued", lease_id: null };
      }
      const status = this.status();
      if (!status.initialized) return fail("unavailable", "Initial all-owner census cutover is not accepted; runnable work remains queued");
      const held = this.db.prepare("SELECT execution_id FROM capacity_request WHERE agent_id=? AND state='active'").get(execution.agentId) as { execution_id: string } | undefined;
      if (held) return fail("unavailable", `Agent retains uncertain or active execution custody ${held.execution_id}; runnable work remains queued`);

      const leaseId = randomUUID();
      this.db.prepare("UPDATE capacity_request SET state='active',lease_id=? WHERE execution_id=? AND state='queued'").run(leaseId, execution.executionId);
      return { ok: true, value: { ...execution, leaseId } };
    });
  }
  inspect(ownerId: string, execution: AgentExecution): Result<CapacityObservation> {
    if (!nonempty(ownerId) || !isAgentExecution(execution)) return fail("invalid_request", "Owner, agent and execution identities are required");
    const row = this.db.prepare("SELECT * FROM capacity_request WHERE execution_id=?").get(execution.executionId) as Row | undefined;
    if (!row) return { ok: true, value: { state: "absent" } };
    if (row.owner_id !== ownerId || row.agent_id !== execution.agentId) return fail("unavailable", "Execution custody belongs to another owner");
    if (row.state === "active") return { ok: true, value: { state: "active", custody: { ...execution, leaseId: row.lease_id! } } };
    return { ok: true, value: { state: row.state } };
  }
  recordedOwner(execution: AgentExecution, allowedOwners: readonly string[]): Result<{ kind: "absent" } | { kind: "recorded"; ownerId: string }> {
    if (!isAgentExecution(execution)) return fail("invalid_request", "Exact agent and execution identities are required");
    const row = this.db.prepare("SELECT agent_id,owner_id FROM capacity_request WHERE execution_id=?").get(execution.executionId) as Pick<Row, "agent_id" | "owner_id"> | undefined;
    if (!row) return { ok: true, value: { kind: "absent" } };
    if (row.agent_id !== execution.agentId || !allowedOwners.includes(row.owner_id)) return fail("unavailable", "Recorded custody is outside the declared migration host grant");
    return { ok: true, value: { kind: "recorded", ownerId: row.owner_id } };
  }
  withdraw(ownerId: string, execution: AgentExecution): Result<void> {
    return this.transaction(() => {
      const observation = this.inspect(ownerId, execution);
      if (!observation.ok) return observation;
      if (observation.value.state === "active") return fail("conflict", "Active custody cannot be withdrawn without positive release");
      if (observation.value.state === "queued") this.db.prepare("UPDATE capacity_request SET state='released',released_at=? WHERE execution_id=?").run(Date.now(), execution.executionId);
      if (observation.value.state === "absent") this.db.prepare("INSERT INTO capacity_request(execution_id,agent_id,owner_id,state,requested_at,released_at) VALUES(?,?,?,'released',?,?)")
        .run(execution.executionId, execution.agentId, ownerId, Date.now(), Date.now());
      return { ok: true, value: undefined };
    });
  }
  release(ownerId: string, custody: CapacityCustody): Result<void> {
    if (!nonempty(ownerId) || !isCapacityCustody(custody)) return fail("invalid_request", "Complete custody is required for positive release");
    return this.transaction(() => {
      const row = this.db.prepare("SELECT * FROM capacity_request WHERE execution_id=?").get(custody.executionId) as Row | undefined;
      if (!row || row.owner_id !== ownerId || row.agent_id !== custody.agentId || row.lease_id !== custody.leaseId) return fail("conflict", "Release receipt does not match recorded custody");
      if (row.state === "released") return { ok: true, value: undefined };
      this.db.prepare("UPDATE capacity_request SET state='released',released_at=? WHERE execution_id=?").run(Date.now(), custody.executionId);
      return { ok: true, value: undefined };
    });
  }
}

export interface AgentCapacityAuthorityConfig {
  databasePath: string; listenHost: string; port: number;
  owners: { id: string; host: string; tokenFile: string }[];
  migrations?: { ownerId: string; ownerIds: string[] }[];
}
export function readAgentCapacityAuthorityConfig(path: string): AgentCapacityAuthorityConfig {
  const value = JSON.parse(readFileSync(path, "utf8")) as AgentCapacityAuthorityConfig;
  if (!value || !nonempty(value.databasePath) || !value.databasePath.startsWith("/") || !nonempty(value.listenHost)
    || !Number.isSafeInteger(value.port) || value.port < 1024 || value.port > 65535 || !Array.isArray(value.owners) || !value.owners.length
    || value.owners.some(owner => !owner || !nonempty(owner.id) || !nonempty(owner.host) || !nonempty(owner.tokenFile) || !owner.tokenFile.startsWith("/"))
    || new Set(value.owners.map(owner => owner.id)).size !== value.owners.length) throw new Error("Invalid explicit global agent capacity authority configuration");
  if (value.migrations !== undefined && (!Array.isArray(value.migrations) || new Set(value.migrations.map(grant => grant.ownerId)).size !== value.migrations.length
    || value.migrations.some(grant => !grant || !Array.isArray(grant.ownerIds) || !grant.ownerIds.length || new Set(grant.ownerIds).size !== grant.ownerIds.length
      || !value.owners.some(owner => owner.id === grant.ownerId) || grant.ownerIds.some(id => !value.owners.some(owner => owner.id === id && owner.host === value.owners.find(migration => migration.id === grant.ownerId)!.host)))))
    throw new Error("Capacity migrations require explicit same-host registered owner grants");
  return value;
}
const digest = (value: string) => createHash("sha256").update(value).digest();
export function createAgentCapacityServer(authority: AgentCapacityAuthority, owners: { id: string; token: string; host?: string }[], migrations: { ownerId: string; ownerIds: string[] }[] = []): Server {
  if (!owners.length || owners.some(owner => !nonempty(owner.id) || !nonempty(owner.token)) || new Set(owners.map(owner => owner.id)).size !== owners.length || new Set(owners.map(owner => owner.token)).size !== owners.length) throw new Error("Every capacity owner needs a unique identity and credential");
  if (new Set(migrations.map(grant => grant.ownerId)).size !== migrations.length || migrations.some(grant => {
    const migration = owners.find(owner => owner.id === grant.ownerId);
    return !migration || !nonempty(migration.host) || !grant.ownerIds.length || new Set(grant.ownerIds).size !== grant.ownerIds.length
      || grant.ownerIds.some(id => !owners.some(owner => owner.id === id && owner.host === migration.host));
  })) throw new Error("Capacity migration server grants require exact registered same-host ownership");
  const credentials = owners.map(owner => ({ id: owner.id, digest: digest(owner.token) }));
  const send = (response: ServerResponse, status: number, result: Result<unknown>) => { response.writeHead(status, { "content-type": "application/json" }); response.end(JSON.stringify({ authority: AGENT_CAPACITY_AUTHORITY, result: result.ok && result.value === undefined ? { ok: true, value: null } : result })); };
  async function request(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const authorization = request.headers.authorization;
    const presented = typeof authorization === "string" && authorization.startsWith("Bearer ") ? digest(authorization.slice(7)) : undefined;
    const owner = presented && credentials.find(owner => timingSafeEqual(owner.digest, presented));
    if (!owner) { send(response, 403, fail("unavailable", "Owner credential rejected; work remains queued")); return; }
    if (request.method === "GET" && request.url === "/v1/status") { send(response, 200, { ok: true, value: authority.status() }); return; }
    if (request.method !== "POST" || !["/v1/acquire", "/v1/release", "/v1/inspect", "/v1/withdraw", "/v1/recorded-owner"].includes(request.url!)) { send(response, 404, fail("invalid_request", "Unknown capacity operation")); return; }
    let input: unknown;
    try {
      const chunks: Buffer[] = []; let size = 0;
      for await (const chunk of request) { size += Buffer.byteLength(chunk); if (size > 4096) { send(response, 413, fail("invalid_request", "Capacity request too large")); return; } chunks.push(Buffer.from(chunk)); }
      input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch { send(response, 400, fail("invalid_request", "Invalid capacity request JSON")); return; }
    if (!input || typeof input !== "object" || (input as { ownerId?: unknown }).ownerId !== owner.id) { send(response, 403, fail("unavailable", "Owner identity does not match credential")); return; }
    if (request.url === "/v1/recorded-owner") {
      const grant = migrations.find(grant => grant.ownerId === owner.id);
      send(response, grant ? 200 : 403, grant ? authority.recordedOwner(input as AgentExecution, grant.ownerIds) : fail("unavailable", "This owner has no explicit migration grant"));
      return;
    }
    const result = request.url === "/v1/acquire" ? authority.acquire(owner.id, input as AgentExecution)
      : request.url === "/v1/release" ? authority.release(owner.id, input as CapacityCustody)
      : request.url === "/v1/inspect" ? authority.inspect(owner.id, input as AgentExecution)
      : authority.withdraw(owner.id, input as AgentExecution);
    send(response, result.ok ? 200 : result.error.code === "unavailable" ? 503 : 409, result);
  }
  return createServer((req, res) => { void request(req, res).catch(() => send(res, 503, fail("unavailable", "Durable authority transaction failed; custody is retained"))); });
}

export async function runAgentCapacityAuthority(path: string): Promise<void> {
  const config = readAgentCapacityAuthorityConfig(path), authority = new AgentCapacityAuthority(config.databasePath);
  const server = createAgentCapacityServer(authority, config.owners.map(owner => ({ id: owner.id, host: owner.host, token: readFileSync(owner.tokenFile, "utf8").trim() })), config.migrations);
  try {
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(config.port, config.listenHost, resolve); });
    await new Promise<void>(resolve => { for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, resolve); });
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  } finally { authority.close(); }
}

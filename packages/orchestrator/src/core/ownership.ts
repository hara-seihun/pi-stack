import { spawnSync } from "node:child_process";
import { closeSync, existsSync, openSync, readFileSync, statSync } from "node:fs";
import type { CoreScope } from "./contracts.js";
import type { CoreResult } from "./config.js";

export type ScopeOwnership = { close(): void };
export type DatabaseCustody = { id: string; databasePath: string; adoptionReceiptPath: string; uid: number; sessionsDir?: string; requiredTables?: readonly string[] };
type PhysicalOwner = { fd: number; claims: Map<string, readonly string[] | null> };
const physicalOwners = new Map<string, PhysicalOwner>();
function claim(key: string, owner: PhysicalOwner, custody: DatabaseCustody): ScopeOwnership {
  owner.claims.set(custody.id, custody.requiredTables ?? null);
  let open = true;
  return { close() {
    if (!open) return;
    open = false; owner.claims.delete(custody.id);
    if (!owner.claims.size) { physicalOwners.delete(key); closeSync(owner.fd); }
  } };
}
export function acquireDatabaseOwnership(custody: DatabaseCustody, path: (logicalPath: string) => string): CoreResult<ScopeOwnership> {
  let fd: number | undefined;
  try {
    const database = path(custody.databasePath);
    const receiptPath = path(custody.adoptionReceiptPath);
    if (!existsSync(database) || !statSync(database).isFile() || custody.sessionsDir && (!existsSync(path(custody.sessionsDir)) || !statSync(path(custody.sessionsDir)).isDirectory())) {
      return { ok: false, error: { code: "unavailable", message: `Existing storage for ${custody.id} is unavailable; core never initializes an adopted store` } };
    }
    const receiptStat = statSync(receiptPath);
    if (!receiptStat.isFile() || (receiptStat.mode & 0o022) !== 0 || ![0, custody.uid].includes(receiptStat.uid)) return { ok: false, error: { code: "ownership-conflict", message: `Untrusted adoption receipt for ${custody.id}` } };
    const receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
    const identity = statSync(database, { bigint: true });
    if (receipt.version !== 1 || receipt.state !== "detached" || receipt.scopeId !== custody.id
      || receipt.databasePath !== custody.databasePath || custody.sessionsDir !== undefined && receipt.sessionsDir !== custody.sessionsDir
      || receipt.databaseIdentity?.dev !== String(identity.dev) || receipt.databaseIdentity?.ino !== String(identity.ino)
      || typeof receipt.previousOwner?.identity !== "string" || !receipt.previousOwner.identity
      || !Number.isFinite(Date.parse(receipt.previousOwner.detachedAt))) return { ok: false, error: { code: "ownership-conflict", message: `Adoption receipt does not bind detached ${custody.id} storage` } };
    if (custody.requiredTables !== undefined) {
      const tables = custody.requiredTables;
      if (!tables.length || new Set(tables).size !== tables.length || tables.some(table => !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(table))
        || !Array.isArray(receipt.tableNames) || receipt.tableNames.length !== tables.length || !tables.every(table => receipt.tableNames.includes(table))) return { ok: false, error: { code: "ownership-conflict", message: `Adoption table custody differs for ${custody.id}` } };
    }
    const key = `${identity.dev}:${identity.ino}`;
    const existing = physicalOwners.get(key);
    if (existing) {
      if (existing.claims.has(custody.id) || !custody.requiredTables || [...existing.claims.values()].some(tables => tables === null || tables.some(table => custody.requiredTables!.includes(table)))) return { ok: false, error: { code: "ownership-conflict", message: `Database custody overlaps an existing ${custody.id} owner` } };
      return { ok: true, value: claim(key, existing, custody) };
    }
    fd = openSync(`${database}.core-owner.lock`, "a+", 0o600);
    const lock = spawnSync("flock", ["--exclusive", "--nonblock", "3"], { stdio: ["ignore", "pipe", "pipe", fd], timeout: 1_000 });
    if (lock.error || lock.status !== 0) {
      closeSync(fd);
      fd = undefined;
      return { ok: false, error: { code: "ownership-conflict", message: `Store ${custody.id} already has a controller or its lock could not be acquired` } };
    }
    const owner: PhysicalOwner = { fd, claims: new Map() };
    physicalOwners.set(key, owner);
    fd = undefined;
    return { ok: true, value: claim(key, owner, custody) };
  } catch (cause) {
    if (fd !== undefined) closeSync(fd);
    return { ok: false, error: { code: "unavailable", message: `Cannot adopt ${custody.id}: ${cause instanceof Error ? cause.message : String(cause)}` } };
  }
}
export function acquireScopeOwnership(scope: CoreScope, path: (logicalPath: string) => string): CoreResult<ScopeOwnership> {
  return acquireDatabaseOwnership({ id: scope.id, ...scope.storage, uid: scope.custody.uid }, path);
}

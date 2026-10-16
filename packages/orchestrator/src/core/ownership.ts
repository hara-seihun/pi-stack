import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { closeSync, existsSync, openSync, readFileSync, statSync } from "node:fs";
import type { CoreScope, CustodyNamespace } from "./contracts.js";
import type { CoreResult } from "./config.js";

export type ScopeOwnership = { close(): void };
export const WATCH_CUSTODY_TABLES = ["watch_item", "watch_request", "watch_wake", "watch_delivery", "watch_schedule", "watch_markdown_adoption"] as const;
export type DatabaseCustody = { id: string; databasePath: string; adoptionReceiptPath: string; uid: number; sessionsDir?: string; requiredTables?: readonly string[]; owningScopeId?: string; namespaces?: { data: CustodyNamespace; retained: CustodyNamespace } };
type PhysicalClaim = { tables: readonly string[] | null; scopeId?: string; adoptionReceiptPath: string; adoptionReceiptSha256: string };
type PhysicalOwner = { fd: number; claims: Map<string, PhysicalClaim> };
const physicalOwners = new Map<string, PhysicalOwner>();
function claim(key: string, owner: PhysicalOwner, custody: DatabaseCustody, adoptionReceiptSha256: string, scopeId?: string): ScopeOwnership {
  owner.claims.set(custody.id, { tables: custody.requiredTables ? [...custody.requiredTables] : null, scopeId, adoptionReceiptPath: custody.adoptionReceiptPath, adoptionReceiptSha256 });
  let open = true;
  return { close() {
    if (!open) return;
    open = false; owner.claims.delete(custody.id);
    if (!owner.claims.size) { physicalOwners.delete(key); closeSync(owner.fd); }
  } };
}
const object = (value: unknown): value is Record<string, any> => value !== null && typeof value === "object" && !Array.isArray(value);
const exact = (value: unknown, keys: readonly string[]): value is Record<string, any> => object(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const fileIdentity = (value: unknown): boolean => exact(value, ["dev", "ino"]) && [value.dev, value.ino].every(part => typeof part === "string" && /^\d+$/.test(part));
const digest = (value: Record<string, any>): boolean => typeof value.sha256 === "string" && /^[a-f0-9]{64}$/.test(value.sha256) && Number.isSafeInteger(value.size) && value.size >= 0;
function validFiles(value: unknown): boolean {
  if (!exact(value, ["database", "wal"]) || !exact(value.database, ["sha256", "size"]) || !digest(value.database) || !object(value.wal)) return false;
  return value.wal.kind === "absent" ? exact(value.wal, ["kind"])
    : value.wal.kind === "present" && exact(value.wal, ["kind", "sha256", "size", "identity"]) && digest(value.wal) && fileIdentity(value.wal.identity);
}
function samePhysicalRebinding(receipt: Record<string, any>, custody: DatabaseCustody): boolean {
  const binding = receipt.namespaceRebinding;
  if (!custody.namespaces || receipt.generationTransfer !== undefined || !exact(binding, ["version", "kind", "source", "target", "retainedRunnerNamespace"])
    || binding.version !== 1 || binding.kind !== "same-physical-object"
    || !exact(binding.source, ["namespace", "databaseIdentity", "files"]) || !exact(binding.target, ["namespace", "databaseIdentity", "files"])
    || !isDeepStrictEqual(binding.source.namespace, custody.namespaces.retained) || !isDeepStrictEqual(binding.retainedRunnerNamespace, custody.namespaces.retained)
    || !isDeepStrictEqual(binding.target.namespace, custody.namespaces.data) || !fileIdentity(binding.source.databaseIdentity)
    || !isDeepStrictEqual(binding.source.databaseIdentity, binding.target.databaseIdentity) || !isDeepStrictEqual(binding.target.databaseIdentity, receipt.databaseIdentity)
    || !validFiles(binding.source.files) || !isDeepStrictEqual(binding.source.files, binding.target.files)) return false;
  return true;
}
export function acquireDatabaseOwnership(custody: DatabaseCustody, path: (logicalPath: string) => string): CoreResult<ScopeOwnership> {
  return acquire(custody, path);
}
function acquire(custody: DatabaseCustody, path: (logicalPath: string) => string, scopeId?: string): CoreResult<ScopeOwnership> {
  let fd: number | undefined;
  try {
    const database = path(custody.databasePath);
    const receiptPath = path(custody.adoptionReceiptPath);
    if (!existsSync(database) || !statSync(database).isFile() || custody.sessionsDir && (!existsSync(path(custody.sessionsDir)) || !statSync(path(custody.sessionsDir)).isDirectory())) {
      return { ok: false, error: { code: "unavailable", message: `Existing storage for ${custody.id} is unavailable; core never initializes an adopted store` } };
    }
    const receiptStat = statSync(receiptPath);
    if (!receiptStat.isFile() || (receiptStat.mode & 0o022) !== 0 || ![0, custody.uid].includes(receiptStat.uid)) return { ok: false, error: { code: "ownership-conflict", message: `Untrusted adoption receipt for ${custody.id}` } };
    const receiptBytes = readFileSync(receiptPath);
    const receipt = JSON.parse(receiptBytes.toString("utf8"));
    const receiptSha256 = createHash("sha256").update(receiptBytes).digest("hex");
    const identity = statSync(database, { bigint: true });
    if (receipt.version !== 1 || receipt.state !== "detached" || receipt.scopeId !== custody.id
      || receipt.databasePath !== custody.databasePath || custody.sessionsDir !== undefined && receipt.sessionsDir !== custody.sessionsDir
      || receipt.databaseIdentity?.dev !== String(identity.dev) || receipt.databaseIdentity?.ino !== String(identity.ino)
      || typeof receipt.previousOwner?.identity !== "string" || !receipt.previousOwner.identity
      || !Number.isFinite(Date.parse(receipt.previousOwner.detachedAt))) return { ok: false, error: { code: "ownership-conflict", message: `Adoption receipt does not bind detached ${custody.id} storage` } };
    if (custody.namespaces && !isDeepStrictEqual(custody.namespaces.data, custody.namespaces.retained)) {
      const transfer = receipt.generationTransfer;
      const rebind = receiptStat.uid === 0 && samePhysicalRebinding(receipt, custody);
      if (!rebind && (receipt.namespaceRebinding !== undefined || receiptStat.uid !== 0 || transfer?.version !== 1
        || !isDeepStrictEqual(transfer.target?.namespace, custody.namespaces.data)
        || !isDeepStrictEqual(transfer.retainedRunnerNamespace, custody.namespaces.retained)
        || !isDeepStrictEqual(transfer.source?.namespace, custody.namespaces.retained)
        || !transfer.source?.files || !isDeepStrictEqual(transfer.source.files, transfer.target?.files)
        || transfer.target?.databaseIdentity?.dev !== String(identity.dev) || transfer.target?.databaseIdentity?.ino !== String(identity.ino)
        || typeof transfer.registry?.path !== "string" || typeof transfer.registry?.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(transfer.registry.sha256)
        || typeof transfer.cipherDir !== "string" || !transfer.cipherDir.startsWith("/"))) return { ok: false, error: { code: "ownership-conflict", message: `Namespace change for ${custody.id} lacks exact physical rebinding or same-cipher generation custody` } };
    }
    if (custody.requiredTables !== undefined) {
      const tables = custody.requiredTables;
      if (!tables.length || new Set(tables).size !== tables.length || tables.some(table => !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(table))
        || !Array.isArray(receipt.tableNames) || receipt.tableNames.length !== tables.length || !tables.every(table => receipt.tableNames.includes(table))) return { ok: false, error: { code: "ownership-conflict", message: `Adoption table custody differs for ${custody.id}` } };
    }
    const key = `${identity.dev}:${identity.ino}`;
    const existing = physicalOwners.get(key);
    const subdivision = receipt.tableSubdivision;
    const parent = custody.owningScopeId ? existing?.claims.get(custody.owningScopeId) : undefined;
    const borrowing = receiptStat.uid === 0 && parent?.scopeId === custody.owningScopeId && parent?.tables === null
      && custody.id === `${custody.owningScopeId}:watch` && custody.requiredTables?.length === WATCH_CUSTODY_TABLES.length
      && WATCH_CUSTODY_TABLES.every(table => custody.requiredTables!.includes(table))
      && exact(subdivision, ["version", "ownerScopeId", "ownerAdoptionReceiptPath", "ownerAdoptionReceiptSha256"]) && subdivision.version === 1
      && subdivision.ownerScopeId === custody.owningScopeId && subdivision.ownerAdoptionReceiptPath === parent.adoptionReceiptPath
      && subdivision.ownerAdoptionReceiptSha256 === parent.adoptionReceiptSha256;
    if (subdivision !== undefined && !borrowing) return { ok: false, error: { code: "ownership-conflict", message: `Table subdivision for ${custody.id} lacks its exact active adopted scope owner` } };
    if (existing) {
      if (existing.claims.has(custody.id) || !custody.requiredTables || [...existing.claims.values()].some(other => other.tables === null ? !borrowing || other !== parent : other.tables.some(table => custody.requiredTables!.includes(table)))) return { ok: false, error: { code: "ownership-conflict", message: `Database custody overlaps an existing ${custody.id} owner` } };
      return { ok: true, value: claim(key, existing, custody, receiptSha256) };
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
    return { ok: true, value: claim(key, owner, custody, receiptSha256, scopeId) };
  } catch (cause) {
    if (fd !== undefined) closeSync(fd);
    return { ok: false, error: { code: "unavailable", message: `Cannot adopt ${custody.id}: ${cause instanceof Error ? cause.message : String(cause)}` } };
  }
}
export function acquireScopeOwnership(scope: CoreScope, path: (logicalPath: string) => string): CoreResult<ScopeOwnership> {
  return acquire({ id: scope.id, ...scope.storage, uid: scope.custody.uid, namespaces: { data: scope.custody.namespace, retained: scope.custody.retainedRunnerNamespace } }, path, scope.id);
}

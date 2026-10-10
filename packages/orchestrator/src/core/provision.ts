import { createHash, randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chownSync, closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { authorize, type PermissionPolicy, type Principal, type Resource } from "../permissions.js";
import { openSqlite } from "../sqlite.js";
import { ThreadService } from "../threads/service.js";
import { isThinkingLevel, type ThreadSettings } from "../threads/contracts.js";
import type { CoreScope, CoreAdoptionReceipt } from "./contracts.js";
import type { CoreResult } from "./config.js";
import type { CoreImagesSpec } from "./images.js";
import { IMAGE_CUSTODY_TABLES, initializeFreshImageSchema } from "./image-schema.js";

export type FreshAccountImages = { kind: "none" } | { kind: "fresh"; priorOwner: { kind: "none" }; registry: CoreImagesSpec };

/** Authenticated account creation owns these records, not a Remote request body.
 * The account creator registers explicit principals/grants before invoking this helper.
 * Existing/locked accounts continue through adoption; this is only fresh storage.
 */
export type CoreProvisionRegistration = {
  id: string;
  requestId: string;
  creatorPrincipalId: string;
  source: string;
  operation: Resource;
  directory: string;
  scope: CoreScope;
  manager: { cwd: string; settings: ThreadSettings };
  markdown: { kind: "none" } | { kind: "configured"; folder: string; readme: string; agents: string };
  images: FreshAccountImages;
};
export type CoreProvisionInput = { registrationId: string; requestId: string };
export type CoreProvisionReceipt = { scope: CoreScope; managerThreadId: string; receiptPath: string };
export type CoreProvisionOwners = {
  principals: readonly Principal[];
  policy: PermissionPolicy;
  /** Owning host validates the account mount and registered ancestor before creation.
   * This is not an execution runtime: provisioning never creates a runner/model.
   */
  path(scope: CoreScope, logicalPath: string): string;
};
type Reservation = {
  version: 1; registrationId: string; requestId: string; scopeId: string; hash: string;
  rootIdentity: { dev: string; ino: string };
  state: "reserved" | "ready";
  databaseIdentity?: { dev: string; ino: string };
  keySha256?: string;
  images?: { databaseIdentity: { dev: string; ino: string } | null; artifactIdentity: { dev: string; ino: string } | null; state: "reserved" | "ready" };
};
const fail = (code: "invalid-config" | "ownership-conflict" | "unavailable" | "io", message: string): CoreResult<never> => ({ ok: false, error: { code, message } });
const canonical = (path: string) => typeof path === "string" && isAbsolute(path) && resolve(path) === path && !path.includes("\0");
const identifier = (id: string) => typeof id === "string" && /^[a-zA-Z0-9_.:-]+$/.test(id);
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value !== null && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const identity = (path: string) => { const st = statSync(path, { bigint: true }); return { dev: String(st.dev), ino: String(st.ino) }; };
function sync(path: string): void { const fd = openSync(path, "r"); try { fsyncSync(fd); } finally { closeSync(fd); } }
function owned(path: string, scope: CoreScope, directory: boolean): void {
  const st = lstatSync(path);
  if (st.isSymbolicLink() || (directory ? !st.isDirectory() : !st.isFile()) || ![0, scope.custody.uid].includes(st.uid) || (st.mode & 0o022) !== 0) throw new Error(`Untrusted provision storage: ${path}`);
}
function writeOwned(path: string, value: string, scope: CoreScope): void {
  writeFileSync(path, value, { flag: "wx", mode: 0o600 });
  chownSync(path, scope.custody.uid, scope.custody.gid); sync(path);
}
function replaceRecord(path: string, record: unknown, scope: CoreScope): void {
  const temporary = `${path}.${randomBytes(8).toString("hex")}.tmp`;
  writeOwned(temporary, JSON.stringify(record), scope);
  renameSync(temporary, path); sync(dirname(path));
}

/** One bounded preparation in the owning core/registration process, then the normal
 * CoreService adopts the returned scope with its existing controller receipt.
 * No per-person engine, unlock, permission minting, or live session is involved.
 */
export class CoreProvisioner {
  private readonly registrations = new Map<string, CoreProvisionRegistration>();
  private readonly running = new Map<string, Promise<CoreResult<CoreProvisionReceipt>>>();
  constructor(registrations: readonly CoreProvisionRegistration[], private readonly owners: CoreProvisionOwners) {
    for (const registration of registrations) {
      if (this.registrations.has(registration.id)) throw new Error("Duplicate account provision registration");
      this.registrations.set(registration.id, structuredClone(registration));
    }
  }
  async provision(input: CoreProvisionInput, authenticatedPrincipalId: string): Promise<CoreResult<CoreProvisionReceipt>> {
    if (!input || !identifier(input.registrationId) || !identifier(input.requestId) || Object.keys(input).some(key => !["registrationId", "requestId"].includes(key))) return fail("invalid-config", "Provision requests contain only exact registration and request IDs");
    const registration = this.registrations.get(input.registrationId);
    if (!registration || input.requestId !== registration.requestId) return fail("invalid-config", "No exact owning account-creation registration binds this request");
    try {
      const valid = this.validate(registration, authenticatedPrincipalId);
      if (!valid.ok) return valid;
    } catch (cause) { return fail("invalid-config", `Malformed account registration: ${String(cause)}`); }
    const prior = this.running.get(registration.id);
    if (prior) return prior;
    const operation = this.initialize(registration);
    this.running.set(registration.id, operation);
    try { return await operation; } finally { this.running.delete(registration.id); }
  }
  private validate(registration: CoreProvisionRegistration, actorId: string): CoreResult<void> {
    const { scope } = registration;
    if (!identifier(registration.id) || !identifier(registration.requestId) || !registration.source?.trim() || !canonical(registration.directory)
      || !scope || !identifier(scope.id) || scope.manager.kind !== "existing" || !identifier(scope.manager.threadId)) return fail("invalid-config", "Fresh provisioning requires a stable registration, source, storage root and canonical manager ID");
    if (scope.availability.kind !== "adopt") return fail("unavailable", "Locked or inactive accounts must not be provisioned or unlocked");
    const actor = this.owners.principals.find(principal => principal.id === actorId);
    const principal = this.owners.principals.find(principal => principal.id === scope.principalId);
    if (!actor || actor.id !== registration.creatorPrincipalId || !principal || principal.kind !== "person" || scope.resource.owner !== principal.person || scope.resource.kind !== "thread") return fail("invalid-config", "Account creation requires the exact authenticated creator and registered person-owned scope");
    if (registration.operation.kind !== "operation") return fail("invalid-config", "Account creation must name its explicit operation resource");
    const now = Date.now();
    const permission = authorize(this.owners.policy, { principal: actor, resource: registration.operation, action: "execute", now });
    if (!permission.ok) return fail("unavailable", permission.error.message);
    for (const action of ["read", "dispatch", "control"] as const) {
      const allowed = authorize(this.owners.policy, { principal, resource: scope.resource, action, now });
      if (!allowed.ok) return fail("unavailable", `New scope ${action}: ${allowed.error.message}`);
    }
    const paths = Object.values(scope.storage);
    if (paths.some(path => !canonical(path) || dirname(path) !== registration.directory) || new Set(paths).size !== paths.length
      || paths.some(path => [".core-provision.json", ".core-provision.lock"].includes(path.slice(registration.directory.length + 1)))) return fail("invalid-config", "Fresh storage descriptors must be distinct direct children of the exclusive registered directory");
    if (!canonical(registration.manager.cwd) || !scope.resources.some(resource => resource.kind === "directory" && resource.path === registration.manager.cwd)) return fail("invalid-config", "Manager workspace must be an explicitly registered directory");
    const markdown = registration.markdown;
    if (!markdown || !["none", "configured"].includes(markdown.kind) || markdown.kind === "configured" && (!canonical(markdown.folder)
      || !scope.resources.some(resource => resource.kind === "directory" && resource.path === markdown.folder)
      || typeof markdown.readme !== "string" || !markdown.readme.trim() || markdown.readme.length > 100_000
      || typeof markdown.agents !== "string" || !markdown.agents.trim() || markdown.agents.length > 100_000)) return fail("invalid-config", "Markdown bootstrap must be explicitly unset or nonempty source text for an exact declared folder");
    const images = registration.images;
    if (!images || !["none", "fresh"].includes(images.kind)) return fail("invalid-config", "Fresh account images must be explicitly absent or registered with prior owner:none");
    if (images.kind === "fresh") {
      const spec = images.registry;
      const imagePaths = [spec.databasePath, spec.artifactRoot, spec.adoptionReceiptPath];
      if (stable(images.priorOwner) !== stable({ kind: "none" }) || spec.scopeId !== scope.id || !Array.isArray(spec.relatedThreadScopeIds) || spec.relatedThreadScopeIds.length
        || imagePaths.some(path => !canonical(path) || dirname(path) !== registration.directory || paths.includes(path)
          || [".core-provision.json", ".core-provision.lock"].includes(path.slice(registration.directory.length + 1))) || new Set(imagePaths).size !== imagePaths.length
        || !Array.isArray(spec.allowedRoots) || !spec.allowedRoots.length || new Set(spec.allowedRoots).size !== spec.allowedRoots.length
        || spec.allowedRoots.some(root => !canonical(root))
        || spec.dataResource?.kind !== "data" || spec.dataResource.owner !== principal.person || stable(spec.dataResource.subjects) !== stable([principal.person])
        || !["private", "confidential"].includes(spec.dataResource.privacy)) return fail("invalid-config", "Fresh images require distinct reserved own-scope storage, explicit UID-read reference roots and exact person-owned data resource");
      for (const action of ["read", "execute", "use"] as const) {
        const allowed = authorize(this.owners.policy, { principal, resource: spec.dataResource, action, now });
        if (!allowed.ok) return fail("unavailable", `Fresh images ${action}: ${allowed.error.message}`);
      }
    }
    const settings = registration.manager.settings;
    if (!settings || typeof settings.model !== "string" || !settings.model.trim() || !isThinkingLevel(settings.thinkingLevel) || !["standard", "priority", "ultrafast"].includes(settings.speed)) return fail("invalid-config", "Manager model, thinking and speed must be explicit");
    if (!Number.isSafeInteger(scope.custody.uid) || scope.custody.uid < 0 || !Number.isSafeInteger(scope.custody.gid) || scope.custody.gid < 0
      || stable(scope.custody.namespace) !== stable(scope.custody.retainedRunnerNamespace)) return fail("invalid-config", "Fresh account storage ownership and one namespace must be explicit");
    if (process.getuid?.() !== scope.custody.uid || process.getgid?.() !== scope.custody.gid) return fail("unavailable", "Fresh storage preparation must execute as its registered Unix owner");
    return { ok: true, value: undefined };
  }
  private async initialize(registration: CoreProvisionRegistration): Promise<CoreResult<CoreProvisionReceipt>> {
    const { scope } = registration;
    let lock: number | undefined, service: ThreadService | undefined;
    try {
      const path = (logical: string) => this.owners.path(scope, logical);
      const directory = path(registration.directory), recordPath = join(directory, ".core-provision.json"), lockPath = join(directory, ".core-provision.lock");
      const cwd = path(registration.manager.cwd);
      if (!statSync(cwd).isDirectory()) return fail("unavailable", "Registered account workspace is not mounted");
      // Resolving the ancestor belongs to the authenticated host custody source.
      path(dirname(registration.directory));
      const digest = hash(stable(registration));
      let fresh = false;
      try { mkdirSync(directory, { mode: 0o700 }); fresh = true; chownSync(directory, scope.custody.uid, scope.custody.gid); sync(dirname(directory)); }
      catch (cause) { if ((cause as NodeJS.ErrnoException).code !== "EEXIST") throw cause; }
      owned(directory, scope, true);
      if (!fresh && (!existsSync(recordPath) || !existsSync(lockPath))) return fail("ownership-conflict", "Preexisting unregistered account storage cannot be initialized");
      if (fresh) writeOwned(lockPath, "", scope);
      owned(lockPath, scope, false);
      lock = openSync(lockPath, "r+");
      const acquired = spawnSync("flock", ["--exclusive", "--nonblock", "3"], { stdio: ["ignore", "pipe", "pipe", lock], timeout: 1_000 });
      if (acquired.error || acquired.status !== 0) return fail("ownership-conflict", "Account provisioning already has a controller");
      let record: Reservation;
      if (fresh) {
        record = { version: 1, registrationId: registration.id, requestId: registration.requestId, scopeId: scope.id, hash: digest, rootIdentity: identity(directory), state: "reserved" };
        writeOwned(recordPath, JSON.stringify(record), scope); sync(directory);
      } else {
        owned(recordPath, scope, false);
        record = JSON.parse(readFileSync(recordPath, "utf8"));
        if (record.version !== 1 || record.registrationId !== registration.id || record.requestId !== registration.requestId || record.scopeId !== scope.id || record.hash !== digest
          || stable(record.rootIdentity) !== stable(identity(directory)) || !["reserved", "ready"].includes(record.state)) return fail("ownership-conflict", "Storage reservation belongs to a different account request or inode");
      }
      const database = path(scope.storage.databasePath), sessions = path(scope.storage.sessionsDir), key = path(scope.storage.capabilityKeyPath), receipt = path(scope.storage.adoptionReceiptPath);
      const value = { scope, managerThreadId: scope.manager.kind === "existing" ? scope.manager.threadId : "", receiptPath: scope.storage.adoptionReceiptPath };
      if (registration.markdown.kind === "configured") {
        const markdown = registration.markdown;
        const folder = path(markdown.folder);
        owned(folder, scope, true);
        for (const [name, text] of [["README.md", markdown.readme], ["AGENTS.md", markdown.agents]] as const) {
          const file = path(join(markdown.folder, name));
          if (!existsSync(file)) {
            if (record.state === "ready") return fail("ownership-conflict", "Accepted Markdown state is missing; never reconstruct it");
            writeOwned(file, text, scope); sync(folder);
          }
          owned(file, scope, false);
          if (!readFileSync(file, "utf8").trim()) return fail("ownership-conflict", "Existing Markdown bootstrap is empty; preserve it for explicit repair");
        }
      }
      if (registration.images.kind === "fresh") {
        const spec = registration.images.registry;
        const imageDb = path(spec.databasePath), artifact = path(spec.artifactRoot), imageReceipt = path(spec.adoptionReceiptPath);
        if (!record.images) {
          if (record.state === "ready" || existsSync(imageDb) || existsSync(artifact) || existsSync(imageReceipt)) return fail("ownership-conflict", "Fresh image storage already has an unregistered owner");
          record = { ...record, images: { databaseIdentity: null, artifactIdentity: null, state: "reserved" } };
          replaceRecord(recordPath, record, scope);
        }
        if (record.state === "ready" && record.images!.state !== "ready") return fail("ownership-conflict", "Accepted account has an incomplete image reservation");
        if (record.images!.state === "ready" && (!record.images!.databaseIdentity || !record.images!.artifactIdentity)) return fail("ownership-conflict", "Ready image reservation lacks accepted storage identities");
        if (record.images!.databaseIdentity) {
          if (!existsSync(imageDb)) return fail("ownership-conflict", "Accepted image database is missing; never recreate it");
          owned(imageDb, scope, false);
          if (stable(record.images!.databaseIdentity) !== stable(identity(imageDb))) return fail("ownership-conflict", "Reserved image database identity changed");
        } else {
          if (!existsSync(imageDb)) writeOwned(imageDb, "", scope);
          owned(imageDb, scope, false);
          if (statSync(imageDb).size !== 0) return fail("ownership-conflict", "Unaccepted image database is nonempty; preserve it for repair");
          record = { ...record, images: { ...record.images!, databaseIdentity: identity(imageDb) } }; replaceRecord(recordPath, record, scope);
        }
        if (record.images!.artifactIdentity) {
          if (!existsSync(artifact)) return fail("ownership-conflict", "Accepted image artifacts are missing; never recreate them");
          owned(artifact, scope, true);
          if (stable(record.images!.artifactIdentity) !== stable(identity(artifact))) return fail("ownership-conflict", "Reserved image artifact identity changed");
        } else {
          if (!existsSync(artifact)) { mkdirSync(artifact, { mode: 0o700 }); chownSync(artifact, scope.custody.uid, scope.custody.gid); sync(directory); }
          owned(artifact, scope, true);
          if (readdirSync(artifact).length) return fail("ownership-conflict", "Unaccepted image artifacts are nonempty; preserve them for repair");
          record = { ...record, images: { ...record.images!, artifactIdentity: identity(artifact) } }; replaceRecord(recordPath, record, scope);
        }
        const ready = record.images!.state === "ready";
        const db = openSqlite(imageDb, ready);
        try {
          if (!ready) { initializeFreshImageSchema(db); db.exec("PRAGMA wal_checkpoint(TRUNCATE)"); }
          const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[];
          if (tables.length !== IMAGE_CUSTODY_TABLES.length || !IMAGE_CUSTODY_TABLES.every(name => tables.some(table => table.name === name))) return fail("ownership-conflict", "Image registry schema differs from registered table custody");
        } finally { db.close(); }
        sync(imageDb); sync(artifact);
        const prior = { version: 1, scopeId: `${scope.id}:images`, databasePath: spec.databasePath, databaseIdentity: record.images!.databaseIdentity,
          tableNames: [...IMAGE_CUSTODY_TABLES], priorOwner: { kind: "none" }, registrationId: registration.id, requestId: registration.requestId,
          previousOwner: { identity: `account-provision:${registration.id}:images`, detachedAt: new Date().toISOString() }, state: "detached", nativeImageSources: [{ threadId: value.managerThreadId, path: join(scope.storage.sessionsDir, `${value.managerThreadId}.jsonl`),
            revision: `fresh-account:${registration.id}`, lastOffset: -1, lastDigest: "", priorSource: { kind: "absent", observedAt: new Date().toISOString() } }] };
        if (existsSync(imageReceipt)) {
          owned(imageReceipt, scope, false);
          const adopted = JSON.parse(readFileSync(imageReceipt, "utf8"));
          if (adopted.scopeId !== prior.scopeId || adopted.databasePath !== prior.databasePath || stable(adopted.databaseIdentity) !== stable(prior.databaseIdentity)
            || stable(adopted.tableNames) !== stable(prior.tableNames) || stable(adopted.priorOwner) !== stable(prior.priorOwner) || adopted.registrationId !== registration.id
            || adopted.requestId !== registration.requestId || adopted.previousOwner?.identity !== prior.previousOwner.identity || adopted.state !== "detached") return fail("ownership-conflict", "Fresh image receipt conflicts with exact account registration");
        } else {
          if (ready) return fail("ownership-conflict", "Accepted image custody receipt is missing; never regenerate it");
          if (existsSync(path(join(scope.storage.sessionsDir, `${value.managerThreadId}.jsonl`)))) return fail("ownership-conflict", "Fresh manager native source already exists; cannot claim prior absence");
          writeOwned(imageReceipt, JSON.stringify(prior), scope); sync(directory);
        }
        record = { ...record, images: { ...record.images!, state: "ready" } }; replaceRecord(recordPath, record, scope);
      }
      if (record.state === "ready") {
        for (const file of [database, key, receipt]) owned(file, scope, false);
        owned(sessions, scope, true);
        if (stable(record.databaseIdentity) !== stable(identity(database)) || record.keySha256 !== hash(readFileSync(key, "utf8"))) return fail("ownership-conflict", "Provisioned storage identity changed; never reconstruct accepted account state");
        const adopted: CoreAdoptionReceipt = JSON.parse(readFileSync(receipt, "utf8"));
        if (adopted.scopeId !== scope.id || adopted.state !== "detached" || adopted.databasePath !== scope.storage.databasePath || adopted.sessionsDir !== scope.storage.sessionsDir || stable(adopted.databaseIdentity) !== stable(record.databaseIdentity)) return fail("ownership-conflict", "Provisioned account custody receipt changed");
        const db = openSqlite(database, true);
        try {
          const manager = db.prepare("SELECT id,metadata FROM thread WHERE json_extract(metadata,'$.manager')=1").all() as Array<{ id: string; metadata: string }>;
          if (manager.length !== 1 || manager[0]!.id !== value.managerThreadId || JSON.parse(manager[0]!.metadata).role !== "kenaznia") return fail("ownership-conflict", "Provisioned canonical manager identity changed");
        } finally { db.close(); }
        return { ok: true, value };
      }
      if (record.databaseIdentity && !existsSync(database) || record.keySha256 && !existsSync(key) || record.databaseIdentity && !existsSync(sessions)) return fail("ownership-conflict", "Accepted reserved storage is missing; never recreate it");
      if (!existsSync(sessions)) { mkdirSync(sessions, { mode: 0o700 }); chownSync(sessions, scope.custody.uid, scope.custody.gid); sync(directory); }
      owned(sessions, scope, true);
      if (!existsSync(key)) writeOwned(key, randomBytes(32).toString("hex"), scope);
      owned(key, scope, false);
      if (!/^[a-f0-9]{64}$/.test(readFileSync(key, "utf8"))) return fail("ownership-conflict", "Reserved account capability is malformed");
      if (!existsSync(database)) writeOwned(database, "", scope);
      owned(database, scope, false);
      const databaseIdentity = identity(database), keySha256 = hash(readFileSync(key, "utf8"));
      if (record.databaseIdentity && stable(record.databaseIdentity) !== stable(databaseIdentity) || record.keySha256 && record.keySha256 !== keySha256) return fail("ownership-conflict", "Reserved database or capability identity changed");
      record = { ...record, databaseIdentity, keySha256 };
      replaceRecord(recordPath, record, scope);
      service = new ThreadService({ databasePath: database, sessionsDir: sessions, capacity: { mode: "unmanaged" }, openSession: async () => { throw new Error("Fresh account provisioning cannot execute a native session"); } });
      const current = await service.managerThread();
      if (!current.ok) return fail("unavailable", current.error.message);
      if (current.value && current.value.id !== value.managerThreadId) return fail("ownership-conflict", "Reserved scope has a different canonical manager");
      const created = await service.spawn({ requestId: `provision:${registration.requestId}:manager`, id: value.managerThreadId, title: "Kenaznia", cwd, settings: registration.manager.settings, metadata: { manager: true }, createdBy: { kind: "service" } });
      if (!created.ok) return fail("unavailable", created.error.message);
      const detached = await service.detach(); service = undefined;
      if (!detached.ok) return fail("unavailable", detached.error.message);
      // Scope paths are logical even when the owning host maps them into its pinned view.
      const db = openSqlite(database);
      try {
        db.prepare("UPDATE thread SET cwd=?,session_file=? WHERE id=?").run(registration.manager.cwd, join(scope.storage.sessionsDir, `${value.managerThreadId}.jsonl`), value.managerThreadId);
        db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      } finally { db.close(); }
      chownSync(database, scope.custody.uid, scope.custody.gid); sync(database); sync(sessions); sync(directory);
      const adopted: CoreAdoptionReceipt = { version: 1, scopeId: scope.id, databasePath: scope.storage.databasePath, sessionsDir: scope.storage.sessionsDir, databaseIdentity: identity(database), previousOwner: { identity: `account-provision:${registration.id}`, detachedAt: new Date().toISOString() }, state: "detached" };
      if (existsSync(receipt)) {
        owned(receipt, scope, false);
        const previous = JSON.parse(readFileSync(receipt, "utf8"));
        if (previous.scopeId !== adopted.scopeId || previous.databasePath !== adopted.databasePath || previous.sessionsDir !== adopted.sessionsDir || stable(previous.databaseIdentity) !== stable(adopted.databaseIdentity) || previous.previousOwner?.identity !== adopted.previousOwner.identity || previous.state !== "detached") return fail("ownership-conflict", "Reserved custody receipt conflicts with account creation");
      } else writeOwned(receipt, JSON.stringify(adopted), scope);
      record = { ...record, state: "ready", databaseIdentity: adopted.databaseIdentity, keySha256: hash(readFileSync(key, "utf8")) };
      replaceRecord(recordPath, record, scope);
      return { ok: true, value };
    } catch (cause) {
      return fail("io", `Fresh account provisioning retained its reservation: ${cause instanceof Error ? cause.message : String(cause)}`);
    } finally { if (service) await service.detach(); if (lock !== undefined) closeSync(lock); }
  }
}

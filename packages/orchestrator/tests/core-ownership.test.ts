import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chownSync, copyFileSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireDatabaseOwnership, acquireScopeOwnership, WATCH_CUSTODY_TABLES, type DatabaseCustody, type ScopeOwnership } from "../src/core/ownership.js";
import type { CoreScope } from "../src/core/contracts.js";
import { DatabaseSync } from "node:sqlite";
import { ThreadService } from "../src/threads/service.js";
import { CoreDuties } from "../src/core/duties-runtime.js";

const roots: string[] = [], leases: ScopeOwnership[] = [];
afterEach(() => {
  for (const lease of leases.splice(0).reverse()) lease.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
function identity(path: string) { const s = statSync(path, { bigint: true }); return { dev: String(s.dev), ino: String(s.ino) }; }
function file(path: string) { const bytes = readFileSync(path); return { sha256: sha256(bytes), size: bytes.length }; }
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "core-ownership-")); roots.push(root);
  const databasePath = join(root, "threads.sqlite3"), adoptionReceiptPath = join(root, "scope.json");
  writeFileSync(databasePath, "exact original database");
  writeFileSync(`${databasePath}-wal`, "exact original WAL");
  const namespaces = { data: { kind: "pinned" as const, path: "/run/pi-stack/namespaces/common", mountNamespaceInode: "12345" }, retained: { kind: "host" as const } };
  const receipt: any = { version: 1, state: "detached", scopeId: "alice", databasePath, sessionsDir: root,
    databaseIdentity: identity(databasePath), previousOwner: { identity: "original-controller:birth", detachedAt: "2026-10-10T00:00:00Z" } };
  const snapshot = { databaseIdentity: receipt.databaseIdentity, files: { database: file(databasePath), wal: { kind: "present", ...file(`${databasePath}-wal`), identity: identity(`${databasePath}-wal`) } } };
  const rebinding = { version: 1, kind: "same-physical-object", source: { namespace: namespaces.retained, ...snapshot }, target: { namespace: namespaces.data, ...snapshot }, retainedRunnerNamespace: namespaces.retained };
  const custody: DatabaseCustody = { id: "alice", databasePath, adoptionReceiptPath, uid: process.getuid!(), namespaces };
  const save = () => writeFileSync(adoptionReceiptPath, JSON.stringify(receipt), { mode: 0o600 });
  save();
  const own = (value = custody) => {
    const result = acquireDatabaseOwnership(value, path => path);
    if (result.ok) leases.push(result.value);
    return result;
  };
  const scope: CoreScope = { id: "alice", principalId: "alice", availability: { kind: "adopt" },
    storage: { databasePath, adoptionReceiptPath, sessionsDir: root, capabilityKeyPath: join(root, "capability") },
    custody: { uid: process.getuid!(), gid: process.getgid!(), namespace: { kind: "host" }, retainedRunnerNamespace: { kind: "host" }, dataDir: root, socketDir: root },
    resource: { id: "alice-threads", kind: "thread", owner: "alice", privacy: "private", subjects: ["alice"], consent: "not-required" },
    resources: [], environment: {}, callbackGateway: { kind: "none" }, manager: { kind: "none" }, managerRouting: { kind: "none" } };
  return { root, databasePath, adoptionReceiptPath, receipt, rebinding, custody, save, own, scope };
}
const rootTest = process.getuid!() === 0 ? test : test.skip;

test("namespace change without a root custody proof never acquires ownership", () => {
  const f = fixture();
  expect(f.own().ok).toBe(false);
  f.receipt.namespaceRebinding = { version: 1, kind: "content-similarity" }; f.save();
  expect(f.own().ok).toBe(false);
});

rootTest("root physical rebinding admits exact detached DB/WAL and fences a second controller", () => {
  const f = fixture(); f.receipt.namespaceRebinding = f.rebinding; f.save();
  expect(f.own().ok).toBe(true);
  expect(f.own().ok).toBe(false);
});

rootTest("physical rebinding rejects namespace, inode, content, WAL and detached-owner substitutions", () => {
  for (const mutate of [
    (f: ReturnType<typeof fixture>) => { f.receipt.namespaceRebinding.source.namespace = f.custody.namespaces!.data; },
    (f: ReturnType<typeof fixture>) => { f.receipt.namespaceRebinding.target.databaseIdentity = { ...f.receipt.databaseIdentity, ino: "0" }; },
    (f: ReturnType<typeof fixture>) => { const copied = join(f.root, "copy.sqlite3"); copyFileSync(f.databasePath, copied); f.receipt.namespaceRebinding.source.databaseIdentity = identity(copied); },
    (f: ReturnType<typeof fixture>) => { writeFileSync(f.databasePath, "changed database bytes"); },
    (f: ReturnType<typeof fixture>) => { writeFileSync(`${f.databasePath}-wal`, "changed WAL bytes"); },
    (f: ReturnType<typeof fixture>) => { const wal = `${f.databasePath}-wal`; renameSync(wal, join(f.root, "wal-copy")); copyFileSync(join(f.root, "wal-copy"), wal); },
    (f: ReturnType<typeof fixture>) => { rmSync(`${f.databasePath}-wal`); },
    (f: ReturnType<typeof fixture>) => { f.receipt.previousOwner.detachedAt = "not a detachment time"; },
    (f: ReturnType<typeof fixture>) => { f.receipt.namespaceRebinding.extra = "unknown receipt variant field"; },
    (f: ReturnType<typeof fixture>) => { f.receipt.generationTransfer = {}; },
  ]) {
    const f = fixture(); f.receipt.namespaceRebinding = structuredClone(f.rebinding); mutate(f); f.save();
    expect(f.own().ok).toBe(false);
  }
});

rootTest("a person-owned receipt cannot authorize physical namespace rebinding", () => {
  const f = fixture(); f.receipt.namespaceRebinding = f.rebinding; f.save();
  chownSync(f.adoptionReceiptPath, 65534, 65534);
  expect(f.own({ ...f.custody, uid: 65534 }).ok).toBe(false);
});

rootTest("encrypted cross-inode generation transfer still requires its original same-cipher proof", () => {
  const f = fixture(), sourcePath = join(f.root, "original-fuse-generation"); copyFileSync(f.databasePath, sourcePath);
  const files = { database: file(f.databasePath), wal: { kind: "absent" } };
  f.receipt.generationTransfer = { version: 1, registry: { path: "/etc/pi-stack/person.json", sha256: "a".repeat(64) }, cipherDir: "/cipher/alice",
    source: { namespace: f.custody.namespaces!.retained, databaseIdentity: identity(sourcePath), files },
    target: { namespace: f.custody.namespaces!.data, databaseIdentity: f.receipt.databaseIdentity, files }, retainedRunnerNamespace: f.custody.namespaces!.retained };
  f.save(); expect(f.own().ok).toBe(true);
  leases.pop()!.close();
  delete f.receipt.generationTransfer.registry; f.save(); expect(f.own().ok).toBe(false);
});

function watchClaim(f: ReturnType<typeof fixture>) {
  const adoptionReceiptPath = join(f.root, "watch.json");
  const receipt: any = { ...f.receipt, scopeId: "alice:watch", tableNames: WATCH_CUSTODY_TABLES,
    tableSubdivision: { version: 1, ownerScopeId: "alice", ownerAdoptionReceiptPath: f.adoptionReceiptPath, ownerAdoptionReceiptSha256: sha256(readFileSync(f.adoptionReceiptPath)) } };
  const custody: DatabaseCustody = { id: "alice:watch", databasePath: f.databasePath, adoptionReceiptPath, uid: process.getuid!(), requiredTables: WATCH_CUSTODY_TABLES, owningScopeId: "alice" };
  const save = () => writeFileSync(adoptionReceiptPath, JSON.stringify(receipt), { mode: 0o600 }); save();
  return { custody, receipt, save };
}
rootTest("same-scope watch tables borrow one flock, retain exact custody and keep it through parent drain", () => {
  const f = fixture(), w = watchClaim(f);
  const parent = acquireScopeOwnership(f.scope, path => path); expect(parent.ok).toBe(true); if (!parent.ok) return; leases.push(parent.value);
  const child = f.own(w.custody); expect(child.ok).toBe(true); if (!child.ok) return;
  expect(f.own(w.custody).ok).toBe(false);
  parent.value.close();
  expect(f.own({ ...f.custody, namespaces: undefined }).ok).toBe(false);
  expect(f.own(w.custody).ok).toBe(false);
  child.value.close();
  expect(f.own({ ...f.custody, namespaces: undefined }).ok).toBe(true);
});

rootTest("ThreadService and CoreDuties adopt the original co-located watch spool in one scope", async () => {
  const f = fixture(); rmSync(f.databasePath); rmSync(`${f.databasePath}-wal`);
  const options = { databasePath: f.databasePath, sessionsDir: f.root, capacity: { mode: "unmanaged" as const }, openSession: async () => { throw new Error("No native execution in custody proof"); } };
  const original = new ThreadService(options);
  const db = new DatabaseSync(f.databasePath);
  db.exec(`CREATE TABLE watch_item(id TEXT PRIMARY KEY,body TEXT NOT NULL);
    CREATE TABLE watch_request(id TEXT PRIMARY KEY,input TEXT NOT NULL,response TEXT NOT NULL);
    CREATE TABLE watch_wake(id TEXT PRIMARY KEY,input TEXT NOT NULL);
    CREATE TABLE watch_delivery(id TEXT PRIMARY KEY,retryAt INTEGER NOT NULL,error TEXT NOT NULL);
    CREATE TABLE watch_schedule(id INTEGER PRIMARY KEY,nextWakeAt INTEGER NOT NULL);
    INSERT INTO watch_schedule VALUES(1,123);`);
  const occurrence = { id: "accepted-check", requestId: "original-check-request", cwd: f.root, title: "Original accepted watch", message: "Keep this input", createdBy: { kind: "service" } };
  db.prepare("INSERT INTO watch_wake VALUES(?,?)").run(occurrence.id, JSON.stringify(occurrence));
  expect((await original.detach()).ok).toBe(true);
  f.receipt.databaseIdentity = identity(f.databasePath); f.save();
  const w = watchClaim(f), parent = acquireScopeOwnership(f.scope, path => path);
  expect(parent.ok).toBe(true); if (!parent.ok) { db.close(); return; } leases.push(parent.value);
  const service = new ThreadService(options);
  const plugin = new CoreDuties({ kind: "configured", entries: [{ scopeId: "alice", path: join(f.root, "duties.md"),
    watch: { kind: "existing", databasePath: f.databasePath, adoptionReceiptPath: w.custody.adoptionReceiptPath, acceptedSpool: "drain" } }] },
  { scopes: [f.scope], principals: [{ kind: "person", id: "alice", person: "alice" }],
    policy: { revision: 1, grants: [{ id: "dispatch", principal: "alice", resource: { kind: "exact", id: f.scope.resource.id }, actions: ["dispatch"], effect: "allow", validFrom: 0, validUntil: null, issuedBy: "owner", source: "proof grant" }], consents: [] },
    owner: () => ({ ok: true, value: { threads: service, runtime: { path: path => path } } }), enabled: () => true });
  try {
    expect((await plugin.start()).ok).toBe(true);
    expect(service.get(occurrence.id)).toBeNull();
    expect((await plugin.tick()).ok).toBe(true);
    expect(service.pending(occurrence.id).map(message => message.id)).toEqual([occurrence.requestId]);
    expect(db.prepare("SELECT count(*) n FROM watch_wake").get()).toMatchObject({ n: 0 });
    expect(identity(f.databasePath)).toEqual(f.receipt.databaseIdentity);
    expect(f.own({ ...f.custody, namespaces: undefined }).ok).toBe(false);
  } finally { await plugin.close(); await service.detach(); db.close(); }
});

rootTest("subdivision cannot invent a parent, borrow an unrelated full owner, or claim arbitrary tables", () => {
  for (const scenario of ["absent", "generic-full-owner", "scope", "path", "digest", "tables", "feature", "untrusted"] as const) {
    const f = fixture(), w = watchClaim(f);
    if (scenario === "generic-full-owner") expect(f.own({ ...f.custody, namespaces: undefined }).ok).toBe(true);
    else if (scenario !== "absent") {
      const parent = acquireScopeOwnership(f.scope, path => path); expect(parent.ok).toBe(true); if (parent.ok) leases.push(parent.value);
    }
    if (scenario === "scope") w.custody.owningScopeId = "bob";
    if (scenario === "path") w.receipt.tableSubdivision.ownerAdoptionReceiptPath += ".another";
    if (scenario === "digest") w.receipt.tableSubdivision.ownerAdoptionReceiptSha256 = "b".repeat(64);
    if (scenario === "tables") { w.custody.requiredTables = ["thread"]; w.receipt.tableNames = ["thread"]; }
    if (scenario === "feature") { w.custody.id = "alice:unrelated"; w.receipt.scopeId = w.custody.id; }
    w.save();
    if (scenario === "untrusted") { chownSync(w.custody.adoptionReceiptPath, 65534, 65534); w.custody.uid = 65534; }
    expect(f.own(w.custody).ok).toBe(false);
  }
});

import { afterEach, expect, test, vi } from "vitest";
// Host admission rejects this unprivileged fixture before configuration is read.
vi.mock("../src/core/config.js", () => ({ parseCoreConfig: () => { throw new Error("Host configuration must not be reached"); } }));
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openSqlite } from "../src/sqlite.js";
import { CoreProvisioner, type CoreProvisionRegistration } from "../src/core/provision.js";
import { provisionRegisteredAccount } from "../src/core/provision-command.js";
import { prepareRegisteredStorage } from "../src/core/provision-worker.js";
import { acquireScopeOwnership, acquireDatabaseOwnership } from "../src/core/ownership.js";
import { IMAGE_CUSTODY_TABLES } from "../src/core/image-schema.js";
import { ThreadService } from "../src/threads/service.js";
import { type PermissionPolicy, type Principal } from "../src/permissions.js";

const roots: string[] = [];
afterEach(() => { for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "core-provision-")); roots.push(root);
  const directory = join(root, "fresh-thread-owner");
  const principals: Principal[] = [{ id: "registrar", kind: "service" }, { id: "alice", kind: "person", person: "alice" }];
  const registration: CoreProvisionRegistration = { id: "account-alice-v1", requestId: "account-alice-create", creatorPrincipalId: "registrar", source: "Authenticated account creation registration", operation: { id: "register-alice", kind: "operation", owner: "registrar", privacy: "private", subjects: [], consent: "not-required" }, directory,
    scope: { id: "alice-person", principalId: "alice", availability: { kind: "adopt" }, resource: { id: "alice-threads", kind: "thread", owner: "alice", privacy: "private", subjects: ["alice"], consent: "not-required" }, storage: { databasePath: join(directory, "threads.sqlite3"), sessionsDir: join(directory, "sessions"), capabilityKeyPath: join(directory, "capability.key"), adoptionReceiptPath: join(directory, "adoption.json") }, custody: { uid: process.getuid!(), gid: process.getgid!(), namespace: { kind: "host" }, retainedRunnerNamespace: { kind: "host" }, dataDir: directory, socketDir: root }, resources: [{ path: root, kind: "directory" }, { path: `/run/pi-stack/session-writers/${process.getuid!()}`, kind: "directory" }, { path: `/run/pi-stack/native-runner-locks/${process.getuid!()}`, kind: "directory" }],
      environment: { PI_SESSION_WRITER_DIRECTORY: `/run/pi-stack/session-writers/${process.getuid!()}`, PI_SESSION_WRITER_SCOPE: "alice-person", PI_NATIVE_RUNNER_DATA_DIR: directory, PI_NATIVE_RUNNER_UID: String(process.getuid!()) }, callbackGateway: { kind: "none" }, manager: { kind: "existing", threadId: "alice-kenaznia" }, managerRouting: { kind: "none" } },
    manager: { cwd: root, settings: { model: "sol", thinkingLevel: "low", speed: "ultrafast" } }, markdown: { kind: "none" }, images: { kind: "none" } };
  const policy: PermissionPolicy = { revision: 1, consents: [], grants: [
    { id: "register-authority", principal: "registrar", resource: { kind: "exact", id: "register-alice" }, actions: ["execute"], effect: "allow", validFrom: 0, validUntil: null, issuedBy: "account-owner", source: "Explicit account creation grant" },
    { id: "alice-scope", principal: "alice", resource: { kind: "exact", id: "alice-threads" }, actions: ["read", "dispatch", "control"], effect: "allow", validFrom: 0, validUntil: null, issuedBy: "account-owner", source: "Registered person scope grant" },
  ] };
  const input = { registrationId: registration.id, requestId: registration.requestId };
  const build = (path: (logical: string) => string = path => path) => new CoreProvisioner([registration], { principals, policy, path: (_scope, logical) => path(logical) });
  return { root, directory, registration, principals, policy, input, build };
}
function managers(database: string) {
  const db = openSqlite(database, true);
  try { return db.prepare("SELECT id,metadata,session_file FROM thread").all() as Array<{ id: string; metadata: string; session_file: string }>; }
  finally { db.close(); }
}

test("registered fresh scope creates exactly one idle Kenaznia and normal controller custody", async () => {
  const f = fixture();
  const created = await f.build().provision(f.input, "registrar");
  expect(created.ok).toBe(true);
  expect(managers(f.registration.scope.storage.databasePath)).toHaveLength(1);
  const manager = managers(f.registration.scope.storage.databasePath)[0]!;
  expect(manager.id).toBe("alice-kenaznia");
  expect(JSON.parse(manager.metadata)).toMatchObject({ manager: true, role: "kenaznia" });
  expect(manager.session_file).toBe(join(f.registration.scope.storage.sessionsDir, "alice-kenaznia.jsonl"));
  expect(existsSync(manager.session_file)).toBe(false);
  const ownership = acquireScopeOwnership(f.registration.scope, path => path);
  expect(ownership.ok).toBe(true);
  let controller: ThreadService | undefined;
  try {
    controller = new ThreadService({ ...f.registration.scope.storage, openSession: async () => { throw new Error("Provision/adoption must not execute work"); } });
    expect((await controller.managerThread())).toMatchObject({ ok: true, value: { id: "alice-kenaznia", role: "kenaznia", state: "idle" } });
  } finally { await controller?.detach(); if (ownership.ok) ownership.value.close(); }
  const key = readFileSync(f.registration.scope.storage.capabilityKeyPath, "utf8"), ino = statSync(f.registration.scope.storage.databasePath).ino;
  expect(await f.build().provision(f.input, "registrar")).toEqual(created);
  expect(readFileSync(f.registration.scope.storage.capabilityKeyPath, "utf8")).toBe(key);
  expect(statSync(f.registration.scope.storage.databasePath).ino).toBe(ino);
});

test("crash after manager commit before detached receipt resumes original IDs and bytes", async () => {
  const f = fixture();
  expect((await f.build().provision(f.input, "registrar")).ok).toBe(true);
  const recordPath = join(f.directory, ".core-provision.json"), record = JSON.parse(readFileSync(recordPath, "utf8"));
  record.state = "reserved"; writeFileSync(recordPath, JSON.stringify(record));
  unlinkSync(f.registration.scope.storage.adoptionReceiptPath);
  const bytes = readFileSync(f.registration.scope.storage.capabilityKeyPath), ino = statSync(f.registration.scope.storage.databasePath).ino;
  const resumed = await f.build().provision(f.input, "registrar");
  expect(resumed.ok).toBe(true);
  expect(managers(f.registration.scope.storage.databasePath).map(row => row.id)).toEqual(["alice-kenaznia"]);
  expect(readFileSync(f.registration.scope.storage.capabilityKeyPath)).toEqual(bytes);
  expect(statSync(f.registration.scope.storage.databasePath).ino).toBe(ino);
  const db = openSqlite(f.registration.scope.storage.databasePath, true);
  try { expect(db.prepare("SELECT id FROM thread_request WHERE kind='spawn'").all()).toEqual([{ id: "provision:account-alice-create:manager" }]); }
  finally { db.close(); }
});

test("existing unregistered storage and conflicting registration never initialize", async () => {
  const f = fixture(); mkdirSync(f.directory, { mode: 0o700 });
  const sentinel = join(f.directory, "private-evidence"); writeFileSync(sentinel, "keep");
  expect(await f.build().provision(f.input, "registrar")).toMatchObject({ ok: false, error: { code: "ownership-conflict" } });
  expect(readFileSync(sentinel, "utf8")).toBe("keep");
  expect(existsSync(f.registration.scope.storage.databasePath)).toBe(false);
  const g = fixture(); expect((await g.build().provision(g.input, "registrar")).ok).toBe(true);
  const key = readFileSync(g.registration.scope.storage.capabilityKeyPath);
  g.registration.manager.settings.thinkingLevel = "high";
  expect(await g.build().provision(g.input, "registrar")).toMatchObject({ ok: false, error: { code: "ownership-conflict" } });
  expect(readFileSync(g.registration.scope.storage.capabilityKeyPath)).toEqual(key);
});

test("locked accounts, missing grants, wrong creator and wrong stable request do not touch paths", async () => {
  const f = fixture(); let touched = false;
  const build = () => f.build(path => { touched = true; return path; });
  expect((await build().provision(f.input, "alice")).ok).toBe(false);
  expect((await build().provision({ ...f.input, requestId: "different" }, "registrar")).ok).toBe(false);
  f.registration.scope.availability = { kind: "unavailable", reason: "locked" };
  expect((await build().provision(f.input, "registrar")).ok).toBe(false);
  f.registration.scope.availability = { kind: "adopt" };
  f.policy.grants = [];
  expect((await build().provision(f.input, "registrar")).ok).toBe(false);
  expect(touched).toBe(false); expect(existsSync(f.directory)).toBe(false);
});

test("fresh bootstrap rejects missing or wrong executor writer scope before touching storage", async () => {
  for (const field of ["PI_SESSION_WRITER_DIRECTORY", "PI_SESSION_WRITER_SCOPE", "PI_NATIVE_RUNNER_DATA_DIR", "PI_NATIVE_RUNNER_UID"]) {
    const f = fixture(); delete f.registration.scope.environment[field];
    expect(await f.build().provision(f.input, "registrar")).toMatchObject({ ok: false, error: { code: "invalid-config" } }); expect(existsSync(f.directory)).toBe(false);
  }
  const f = fixture(); f.registration.scope.environment.PI_SESSION_WRITER_SCOPE = "foreign";
  expect((await f.build().provision(f.input, "registrar")).ok).toBe(false); expect(existsSync(f.directory)).toBe(false);
  const g = fixture(); g.registration.scope.resources = [{ path: g.root, kind: "directory" }];
  expect((await g.build().provision(g.input, "registrar")).ok).toBe(false); expect(existsSync(g.directory)).toBe(false);
});

test("accepted missing storage is an error, never fresh reconstruction", async () => {
  const f = fixture(); expect((await f.build().provision(f.input, "registrar")).ok).toBe(true);
  const recordPath = join(f.directory, ".core-provision.json"), record = JSON.parse(readFileSync(recordPath, "utf8"));
  record.state = "reserved"; writeFileSync(recordPath, JSON.stringify(record));
  unlinkSync(f.registration.scope.storage.databasePath);
  expect(await f.build().provision(f.input, "registrar")).toMatchObject({ ok: false, error: { code: "ownership-conflict" } });
  expect(existsSync(f.registration.scope.storage.databasePath)).toBe(false);
});

test("explicit Markdown bootstrap never overwrites existing owning text", async () => {
  const f = fixture();
  writeFileSync(join(f.root, "README.md"), "My existing state\n", { mode: 0o600 });
  f.registration.markdown = { kind: "configured", folder: f.root, readme: "Source initial state", agents: "Source account instructions" };
  expect((await f.build().provision(f.input, "registrar")).ok).toBe(true);
  expect(readFileSync(join(f.root, "README.md"), "utf8")).toBe("My existing state\n");
  expect(readFileSync(join(f.root, "AGENTS.md"), "utf8")).toBe("Source account instructions");
  unlinkSync(join(f.root, "AGENTS.md"));
  expect((await f.build().provision(f.input, "registrar")).ok).toBe(false);
  expect(existsSync(join(f.root, "AGENTS.md"))).toBe(false);
});

function withFreshImages(f: ReturnType<typeof fixture>) {
  const registry = { scopeId: f.registration.scope.id, databasePath: join(f.directory, "images.sqlite3"), artifactRoot: join(f.directory, "images"), adoptionReceiptPath: join(f.directory, "image-adoption.json"), allowedRoots: ["/"], relatedThreadScopeIds: [] as string[],
    dataResource: { id: "alice-images", kind: "data" as const, owner: "alice", privacy: "private" as const, subjects: ["alice"], consent: "not-required" as const } };
  f.registration.images = { kind: "fresh", priorOwner: { kind: "none" }, registry };
  f.policy.grants = [...f.policy.grants, { id: "alice-images", principal: "alice", resource: { kind: "exact", id: registry.dataResource.id }, actions: ["read", "execute", "use"], effect: "allow", validFrom: 0, validUntil: null, issuedBy: "registrar", source: "Explicit original account image authority" }];
  return registry;
}

test("fresh registered image store adopts canonical seven tables and conserves data on retry", async () => {
  const f = fixture(), spec = withFreshImages(f);
  const payload = { registration: f.registration, principals: f.principals, policy: f.policy, input: f.input, actor: "registrar", namespaceInode: statSync("/proc/self/ns/mnt", { bigint: true }).ino.toString() };
  const prepared = await prepareRegisteredStorage(payload); expect(prepared.ok).toBe(true);
  const db = openSqlite(spec.databasePath);
  try {
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[];
    expect(tables.map(table => table.name).sort()).toEqual([...IMAGE_CUSTODY_TABLES].sort());
    db.exec("INSERT INTO core_image_threads VALUES('alice-kenaznia'); INSERT INTO inline_image_versions VALUES('alice-kenaznia',42)");
  } finally { db.close(); }
  const ino = statSync(spec.databasePath).ino, receipt = readFileSync(spec.adoptionReceiptPath, "utf8");
  const custody = acquireDatabaseOwnership({ id: `${spec.scopeId}:images`, databasePath: spec.databasePath, adoptionReceiptPath: spec.adoptionReceiptPath, uid: f.registration.scope.custody.uid, requiredTables: IMAGE_CUSTODY_TABLES }, path => path);
  expect(custody.ok).toBe(true); if (custody.ok) custody.value.close();
  expect(await f.build().provision(f.input, "registrar")).toEqual(prepared);
  expect(statSync(spec.databasePath).ino).toBe(ino); expect(readFileSync(spec.adoptionReceiptPath, "utf8")).toBe(receipt);
  const check = openSqlite(spec.databasePath, true);
  try { expect(check.prepare("SELECT version FROM inline_image_versions").get()).toEqual({ version: 42 }); } finally { check.close(); }
  unlinkSync(spec.databasePath);
  expect((await f.build().provision(f.input, "registrar")).ok).toBe(false); expect(existsSync(spec.databasePath)).toBe(false);
});

test("partial image initialization resumes exact reservation without replacing rows or receipt", async () => {
  const f = fixture(), spec = withFreshImages(f);
  expect((await f.build().provision(f.input, "registrar")).ok).toBe(true);
  const db = openSqlite(spec.databasePath);
  try { db.exec("INSERT INTO core_image_threads VALUES('retained'); INSERT INTO inline_image_versions VALUES('retained',7)"); } finally { db.close(); }
  const recordPath = join(f.directory, ".core-provision.json"), record = JSON.parse(readFileSync(recordPath, "utf8"));
  record.state = "reserved"; record.images.state = "reserved"; writeFileSync(recordPath, JSON.stringify(record)); unlinkSync(spec.adoptionReceiptPath);
  const inode = statSync(spec.databasePath).ino;
  expect((await f.build().provision(f.input, "registrar")).ok).toBe(true);
  expect(statSync(spec.databasePath).ino).toBe(inode);
  const check = openSqlite(spec.databasePath, true);
  try { expect(check.prepare("SELECT version FROM inline_image_versions").get()).toEqual({ version: 7 }); } finally { check.close(); }
});

test("image provisioning refuses absent authority, foreign paths and accepted missing receipts", async () => {
  const f = fixture(), spec = withFreshImages(f); f.policy.grants = f.policy.grants.slice(0, -1);
  expect((await f.build().provision(f.input, "registrar")).ok).toBe(false); expect(existsSync(f.directory)).toBe(false);
  const g = fixture(), other = withFreshImages(g); other.relatedThreadScopeIds.push("foreign");
  expect((await g.build().provision(g.input, "registrar")).ok).toBe(false); expect(existsSync(g.directory)).toBe(false);
  const h = fixture(), valid = withFreshImages(h); expect((await h.build().provision(h.input, "registrar")).ok).toBe(true);
  unlinkSync(valid.adoptionReceiptPath); expect((await h.build().provision(h.input, "registrar")).ok).toBe(false); expect(existsSync(valid.adoptionReceiptPath)).toBe(false);
  expect(existsSync(spec.databasePath)).toBe(false);
});

test("same-process concurrent retries conserve one receipt and manager", async () => {
  const f = fixture(), provisioner = f.build();
  const results = await Promise.all([provisioner.provision(f.input, "registrar"), provisioner.provision(f.input, "registrar")]);
  expect(results[0]?.ok).toBe(true); expect(results[1]).toEqual(results[0]);
  expect(managers(f.registration.scope.storage.databasePath)).toHaveLength(1);
});

test("finite preparation worker enforces original namespace and Unix owner", async () => {
  const f = fixture();
  const payload = { registration: f.registration, principals: f.principals, policy: f.policy, input: f.input, actor: "registrar", namespaceInode: "0" };
  expect(await prepareRegisteredStorage(payload)).toMatchObject({ ok: false, error: { code: "ownership-conflict" } });
  expect(existsSync(f.directory)).toBe(false);
  payload.namespaceInode = statSync("/proc/self/ns/mnt", { bigint: true }).ino.toString();
  expect((await prepareRegisteredStorage(payload)).ok).toBe(true);
  const g = fixture(); g.registration.scope.custody.uid += 1;
  expect((await g.build().provision(g.input, "registrar")).ok).toBe(false);
  expect(existsSync(g.directory)).toBe(false);
});

test("host command cannot accept an ordinary user actor or caller-supplied scope", async () => {
  if (process.getuid?.() === 0) return;
  expect(await provisionRegisteredAccount({ configPath: "/absent/config", registrationPath: "/absent/request", requestId: "none" })).toMatchObject({ ok: false, error: { code: "unavailable" } });
});

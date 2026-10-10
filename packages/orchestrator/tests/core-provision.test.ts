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
import { acquireScopeOwnership } from "../src/core/ownership.js";
import { ThreadService } from "../src/threads/service.js";
import { type PermissionPolicy, type Principal } from "../src/permissions.js";

const roots: string[] = [];
afterEach(() => { for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "core-provision-")); roots.push(root);
  const directory = join(root, "fresh-thread-owner");
  const principals: Principal[] = [{ id: "registrar", kind: "service" }, { id: "alice", kind: "person", person: "alice" }];
  const registration: CoreProvisionRegistration = { id: "account-alice-v1", requestId: "account-alice-create", creatorPrincipalId: "registrar", source: "Authenticated account creation registration", operation: { id: "register-alice", kind: "operation", owner: "registrar", privacy: "private", subjects: [], consent: "not-required" }, directory,
    scope: { id: "alice-person", principalId: "alice", availability: { kind: "adopt" }, resource: { id: "alice-threads", kind: "thread", owner: "alice", privacy: "private", subjects: ["alice"], consent: "not-required" }, storage: { databasePath: join(directory, "threads.sqlite3"), sessionsDir: join(directory, "sessions"), capabilityKeyPath: join(directory, "capability.key"), adoptionReceiptPath: join(directory, "adoption.json") }, custody: { uid: process.getuid!(), gid: process.getgid!(), namespace: { kind: "host" }, retainedRunnerNamespace: { kind: "host" }, dataDir: directory, socketDir: root }, resources: [{ path: root, kind: "directory" }], environment: {}, callbackGateway: { kind: "none" }, manager: { kind: "existing", threadId: "alice-kenaznia" }, managerRouting: { kind: "none" } },
    manager: { cwd: root, settings: { model: "sol", thinkingLevel: "low", speed: "ultrafast" } }, markdown: { kind: "none" } };
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

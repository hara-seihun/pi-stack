import { afterEach, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { CoreDuties, WATCH_CUSTODY_TABLES } from "../src/core/duties-runtime.js";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ThreadService } from "../src/threads/service.js";
import { threadCapability } from "../src/threads/caller.js";
import { CoreService, type CoreRuntime } from "../src/core/service.js";
import { serveCore } from "../src/core/main.js";
import * as custodyModule from "../src/core/custody.js";
import { CoreManagerNotices } from "../src/core/manager-notices.js";
import { CoreReloadOwner, validateCoreReload } from "../src/core/reload.js";
import { acquireDatabaseOwnership, acquireScopeOwnership } from "../src/core/ownership.js";
import { bindGatewayRequest, registerGatewaySocket, type GatewayBinding } from "../src/core/gateway.js";
import type { IncomingMessage } from "node:http";
import { createServer } from "node:net";
import type { CoreConfig, CoreScope } from "../src/core/contracts.js";

const roots: string[] = [];
async function fixturePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Synthetic Core needs its allocated TCP port");
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return address.port;
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
async function fixture() {
  const path = mkdtempSync(join(tmpdir(), "core-adoption-")); roots.push(path);
  const sessionsDir = join(path, "sessions"); mkdirSync(sessionsDir);
  const databasePath = join(path, "threads.sqlite3"), capabilityKeyPath = join(path, "capability.key"), adoptionReceiptPath = join(path, "adoption.json");
  const capability = threadCapability(capabilityKeyPath);
  const old = new ThreadService({ databasePath, sessionsDir, capability, capacity: { mode: "unmanaged" }, openSession: async () => { throw new Error("Fixture does not execute native work"); } });
  const spawned = await old.spawn({ requestId: "accepted-before-cutover", cwd: path, title: "Conserved work", message: "Keep the original input" });
  if (!spawned.ok) throw new Error(spawned.error.message);
  capability.issue(spawned.value.id);
  const detached = await old.detach(); if (!detached.ok) throw new Error(detached.error.message);
  const stat = statSync(databasePath, { bigint: true });
  writeFileSync(adoptionReceiptPath, JSON.stringify({ version: 1, state: "detached", scopeId: "alice", databasePath, sessionsDir, databaseIdentity: { dev: String(stat.dev), ino: String(stat.ino) }, previousOwner: { identity: "old-supervisor-generation", detachedAt: new Date().toISOString() } }), { mode: 0o600 });
  const scope: CoreScope = { id: "alice", principalId: "alice", availability: { kind: "adopt" }, resource: { id: "alice-threads", kind: "thread", owner: "alice", privacy: "private", subjects: ["alice"], consent: "not-required" }, storage: { databasePath, sessionsDir, capabilityKeyPath, adoptionReceiptPath }, custody: { uid: process.getuid!(), gid: process.getgid!(), namespace: { kind: "host" }, retainedRunnerNamespace: { kind: "host" }, dataDir: path, socketDir: path }, resources: [], environment: {}, callbackGateway: { kind: "none" }, manager: { kind: "none" }, managerRouting: { kind: "none" } };
  const config: CoreConfig = { version: 1, host: "127.0.0.1", port: 19181, statePath: join(path, "core.sqlite3"), releaseCommit: "a".repeat(40), principals: [{ kind: "person", id: "alice", person: "alice" }, { kind: "person", id: "bob", person: "bob" }], credentials: [{ sha256: createHash("sha256").update("alice-token").digest("hex"), principalId: "alice", scopeIds: ["alice"], purpose: "service", routeCeiling: { kind: "scoped" } }, { sha256: createHash("sha256").update("bob-token").digest("hex"), principalId: "bob", scopeIds: ["alice"], purpose: "person", routeCeiling: { kind: "scoped" } }], policy: { revision: 1, grants: [{ id: "alice-own", principal: "alice", resource: { kind: "exact", id: "alice-threads" }, actions: ["read", "write", "dispatch", "control"], effect: "allow", validFrom: 0, validUntil: null, issuedBy: "owner", source: "existing person grant" }], consents: [] }, scopes: [scope], broker: { kind: "disabled" }, root: { kind: "disabled" }, memory: { kind: "disabled" }, images: { kind: "disabled" }, duties: { kind: "disabled" }, callbacks: { kind: "none" }, gatewayTransport: { kind: "none" }, gatewayBindings: [] };
  const runtime: CoreRuntime = { openSession: async () => { throw new Error("No execution during adoption"); }, attachSession: async () => null, recoverSession: async () => null, detach() {}, path: value => value, readImage: async () => ({ ok: false, error: { code: "unavailable", message: "No image reader in adoption fixture" } }) };
  return { scope, config, runtime, threadId: spawned.value.id, capability };
}

test("Core becomes healthy while manager notice callback is pending and still drains its original delivery on close", async () => {
  const f = await fixture();
  f.config.port = await fixturePort();
  f.scope.managerRouting = { kind: "configured", relay: { scopeId: "alice", environmentId: "remote",
    callbackUrl: "http://synthetic-callback.invalid", canonicalManager: null, remoteEnvironments: [], adoptedOrigins: [] },
    notices: { notificationOwnerId: "original-owner", adoptedCursors: { settlements: 0, attention: 0, questions: 0 } } };
  let release!: (value: import("../src/threads/contracts.js").Result<import("../src/threads/contracts.js").ManagerNotificationPolicy>) => void;
  let entered!: () => void;
  const pending = new Promise<import("../src/threads/contracts.js").Result<import("../src/threads/contracts.js").ManagerNotificationPolicy>>(resolve => { release = resolve; });
  const called = new Promise<void>(resolve => { entered = resolve; });
  const factory = spyOn(custodyModule, "createCoreCustodyFactory").mockReturnValue(async () => ({ ok: true, value: f.runtime }));
  const predecessor = process.env.PI_CORE_STARTUP_PROBE_PREDECESSOR;
  const activation = predecessor ? spyOn(CoreService.prototype, "activate").mockImplementation((await import(predecessor)).CoreService.prototype.activate) : null;
  const originalStart = CoreManagerNotices.prototype.start;
  const policy = spyOn(CoreManagerNotices.prototype, "start").mockImplementation(function(this: CoreManagerNotices) {
    const directory = (this as unknown as { directory: Pick<import("../src/threads/contracts.js").ThreadApi, "managerNotificationPolicy"> }).directory;
    directory.managerNotificationPolicy = () => { entered(); return pending; };
    return originalStart.call(this);
  });
  let running: Awaited<ReturnType<typeof serveCore>> | undefined;
  let serving: ReturnType<typeof serveCore> | undefined;
  try {
    serving = serveCore(f.config);
    await called;
    let completed = false;
    void serving.then(() => { completed = true; });
    for (let n = 0; n < 10 && !completed; n++) await new Promise<void>(resolve => setImmediate(resolve));
    expect(completed).toBe(true);
    running = await serving;
    if (!running.ok) throw new Error(running.error.message);
    const health = await fetch(`${running.value.service.url}/v1/health`);
    expect(health.status).toBe(200);
    expect(await health.json()).toMatchObject({ ready: true, startup: { phase: "ready" } });
    let drained = false;
    const closing = running.value.close().then(result => { drained = true; return result; });
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(drained).toBe(false);
    release({ ok: true, value: { view: "classic" } });
    expect((await closing).ok).toBe(true);
  } finally {
    release({ ok: true, value: { view: "classic" } });
    if (!running && serving) running = await serving;
    if (running?.ok) await running.value.close();
    policy.mockRestore(); factory.mockRestore(); activation?.mockRestore();
  }
}, 3000);

test("one adopted writer preserves original thread, queue identity and scoped disclosure", async () => {
  const f = await fixture();
  f.config.credentials.push({ sha256: createHash("sha256").update("root-admin-token").digest("hex"), principalId: "alice", scopeIds: ["alice"], purpose: "service", routeCeiling: { kind: "root-admin" } });
  const core = new CoreService(f.config, async () => ({ ok: true, value: f.runtime }));
  try {
    expect(await core.start()).toEqual({ ok: true, value: undefined });
    const lock = acquireScopeOwnership(f.scope, path => path);
    expect(lock.ok).toBe(false);
    const projection = core.projection("alice", []);
    expect(projection.ok).toBe(true);
    if (!projection.ok) return;
    expect(projection.value.threads[0]?.id).toBe(f.threadId);
    expect(projection.value.pending[f.threadId]?.map(message => message.id)).toEqual(["accepted-before-cutover"]);
    const forbidden = await core.request(new Request(`${core.url}/v1/scopes/alice/projection`, { headers: { authorization: "Bearer bob-token" } }));
    expect(forbidden?.status).toBe(403);
    const allowed = await core.request(new Request(`${core.url}/v1/scopes/alice/projection`, { headers: { authorization: "Bearer alice-token" } }));
    expect(allowed?.status).toBe(200);
    const mismatched = await core.request(new Request(`${core.url}/v1/scopes/alice/projection`, { headers: { authorization: "Bearer bob-token", "x-pi-thread-token": f.capability.issue(f.threadId) } }));
    expect(mismatched?.status).toBe(401);
    const nativeReplies = await core.request(new Request(`${core.url}/v1/scopes/alice/thread-owner/managerReplies`, { method: "POST", headers: { "x-pi-thread-token": f.capability.issue(f.threadId) }, body: JSON.stringify({ after: null, limit: 10 }) }));
    expect(nativeReplies?.status).toBe(403);
    const unsetManager = await core.request(new Request(`${core.url}/v1/scopes/alice/thread-owner/managerReplies`, { method: "POST", headers: { authorization: "Bearer alice-token" }, body: JSON.stringify({ after: null, limit: 10 }) }));
    expect(unsetManager?.status).toBe(503);
    const adminProjection = await core.request(new Request(`${core.url}/v1/scopes/alice/projection`, { headers: { authorization: "Bearer root-admin-token" } }));
    expect(adminProjection?.status).toBe(401);
    expect(core.authorizeIngress(new Request(`${core.url}/v1/admin/root-sessions`, { headers: { "x-pi-kenan-admin": "root-admin-token" } })).ok).toBe(true);
    expect(core.authorizeIngress(new Request(`${core.url}/v1/memory`, { method: "POST", headers: { "x-pi-kenan-admin": "root-admin-token", authorization: "Bearer alice-token" } })).ok).toBe(false);
    expect(core.authorizeIngress(new Request(`${core.url}/v1/admin/root-sessions/not-a-session/transcript`, { headers: { authorization: "Bearer root-admin-token" } })).ok).toBe(false);
    const events = await core.request(new Request(`${core.url}/v1/scopes/alice/events`, { headers: { authorization: "Bearer alice-token" } }));
    const reader = events!.body!.getReader();
    expect((await reader.read()).done).toBe(false);
    expect((await core.close()).ok).toBe(true);
    expect((await reader.read()).done).toBe(true);
  } finally { expect((await core.close()).ok).toBe(true); }
  const reowned = acquireScopeOwnership(f.scope, path => path); expect(reowned.ok).toBe(true); if (reowned.ok) reowned.value.close();
});

test("manager-less adopted watch is routed by both Core directories without contacting the canonical manager", async () => {
  const f = await fixture(), path = f.scope.custody.dataDir;
  const watchPath = join(path, "watch.sqlite3"), receiptPath = join(path, "watch.json");
  const db = new DatabaseSync(watchPath);
  db.exec(`CREATE TABLE watch_item(id TEXT PRIMARY KEY,body TEXT NOT NULL);
    CREATE TABLE watch_request(id TEXT PRIMARY KEY,input TEXT NOT NULL,response TEXT NOT NULL);
    CREATE TABLE watch_wake(id TEXT PRIMARY KEY,input TEXT NOT NULL);
    CREATE TABLE watch_delivery(id TEXT PRIMARY KEY,retryAt INTEGER NOT NULL,error TEXT NOT NULL);
    CREATE TABLE watch_schedule(id INTEGER PRIMARY KEY,nextWakeAt INTEGER NOT NULL);
    INSERT INTO watch_schedule VALUES(1,123);`);
  const item = { id: "original-duty", what: "Read owning notes", why: "Retained duty", nextDueAt: 13, addedBy: "alice", createdAt: 1, updatedAt: 1 };
  const occurrence = { id: "original-occurrence", requestId: "original-occurrence-request", cwd: path, title: "Accepted check", message: "Keep exact accepted input" };
  db.prepare("INSERT INTO watch_item VALUES(?,?)").run(item.id, JSON.stringify(item));
  db.prepare("INSERT INTO watch_wake VALUES(?,?)").run(occurrence.id, JSON.stringify(occurrence));
  const stat = statSync(watchPath, { bigint: true });
  writeFileSync(receiptPath, JSON.stringify({ version: 1, state: "detached", scopeId: "alice:watch", databasePath: watchPath,
    databaseIdentity: { dev: String(stat.dev), ino: String(stat.ino) }, tableNames: WATCH_CUSTODY_TABLES,
    previousOwner: { identity: "original-watch-controller", detachedAt: new Date().toISOString() } }), { mode: 0o600 });
  f.scope.managerRouting = { kind: "configured", relay: { scopeId: "alice", environmentId: "remote",
    callbackUrl: "http://unreachable-manager.test/v1/core/manager-relay", canonicalManager: { environmentId: "personal", threadId: "canonical-manager" },
    remoteEnvironments: [{ id: "personal", resource: f.scope.resource }], adoptedOrigins: [] },
    notices: { notificationOwnerId: "alice", adoptedCursors: { settlements: 0, attention: 0, questions: 0 } } };
  f.config.duties = { kind: "configured", entries: [{ scopeId: "alice", path: join(path, "duties.md"),
    watch: { kind: "existing", databasePath: watchPath, adoptionReceiptPath: receiptPath, acceptedSpool: "hold" } }] };
  const core = new CoreService(f.config, async () => ({ ok: true, value: f.runtime }));
  const plugin = new CoreDuties(f.config.duties, { scopes: f.config.scopes, principals: f.config.principals, policy: f.config.policy,
    owner: id => core.owner(id), enabled: () => true });
  const wiring = spyOn(ThreadService.prototype, "setDirectory");
  const input = { action: "list" as const, threadId: f.threadId };
  const request = (body: unknown, token = "alice-token") => core.request(new Request(`${core.url}/v1/scopes/alice/thread-owner/watch`, {
    method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body) }));
  try {
    expect((await core.start()).ok).toBe(true);
    const directory = wiring.mock.calls[0]![0];
    expect(await directory.watch(input)).toMatchObject({ ok: false, error: { code: "unavailable" } });
    expect((await plugin.start()).ok).toBe(true);
    const owner = core.owner("alice"); if (!owner.ok) throw new Error(owner.error.message);
    expect((await owner.value.threads.control({ action: "close", threadId: f.threadId })).ok).toBe(true);
    expect((await core.activate()).ok).toBe(true);
    expect(await directory.watch(input)).toEqual({ ok: true, value: { items: [item] } });
    expect(await (await request(input))!.json()).toEqual({ ok: true, value: { items: [item] } });
    expect(await (await request({ ...input, action: "update", requestId: "new-update", id: item.id, patch: { nextDueAt: 99 } }))!.json())
      .toMatchObject({ ok: false, error: { code: "invalid_request", message: expect.stringContaining("Markdown") } });
    expect((await request(input, "bob-token"))?.status).toBe(403);
    expect(db.prepare("SELECT id FROM watch_wake").get()).toMatchObject({ id: occurrence.id });
    expect(db.prepare("SELECT body FROM watch_item").get()).toMatchObject({ body: JSON.stringify(item) });
    expect(db.prepare("SELECT count(*) n FROM watch_request").get()).toMatchObject({ n: 0 });
    expect(owner.value.threads.get(occurrence.id)).toBeNull();
    expect(owner.value.threads.pending(f.threadId).map(message => message.id)).toEqual(["accepted-before-cutover"]);
    await plugin.close();
    expect(await directory.watch(input)).toMatchObject({ ok: false, error: { code: "unavailable" } });
    expect(await (await request(input))!.json()).toMatchObject({ ok: false, error: { code: "unavailable" } });
  } finally { wiring.mockRestore(); await plugin.close(); await core.close(); db.close(); }
});

test("kernel-admitted gateway identity and route ceilings bound native capabilities", async () => {
  const f = await fixture();
  const core = new CoreService(f.config, async () => ({ ok: true, value: f.runtime }));
  const binding: GatewayBinding = { gatewayId: "alice-ui", purpose: "core-ingress", peerUid: process.getuid!(), principalId: "alice", scopeIds: ["alice"], routeCeiling: [{ method: "GET", kind: "exact", path: "/v1/scopes/alice/projection" }] };
  const socket = {};
  expect(registerGatewaySocket(socket, binding, { uid: binding.peerUid + 1 }).ok).toBe(false);
  expect(registerGatewaySocket(socket, binding, { uid: binding.peerUid }).ok).toBe(true);
  const request = (path: string, headers: Record<string, string> = {}) => {
    const value = new Request(`${core.url}${path}`, { headers });
    bindGatewayRequest({ socket } as IncomingMessage, value);
    return value;
  };
  try {
    expect((await core.start()).ok).toBe(true);
    expect((await core.request(request("/v1/scopes/alice/projection")))?.status).toBe(200);
    expect((await core.request(request("/v1/scopes/alice/projection", { authorization: "Bearer bob-token" })))?.status).toBe(401);
    expect((await core.request(request("/v1/scopes/alice/projection", { "x-pi-thread-token": f.capability.issue(f.threadId) })))?.status).toBe(200);
    expect(core.authorizeIngress(request("/v1/scopes/alice/events", { "x-pi-thread-token": f.capability.issue(f.threadId) })).ok).toBe(false);
  } finally { await core.close(); }
});

test("unavailable partitions are not read, initialized or resumed", async () => {
  const f = await fixture();
  f.scope.availability = { kind: "unavailable", reason: "locked" };
  let touched = false;
  const core = new CoreService(f.config, async () => { touched = true; return { ok: true, value: f.runtime }; });
  try {
    expect((await core.start()).ok).toBe(true); expect(touched).toBe(false);
    const response = await core.request(new Request(`${core.url}/v1/scopes/alice/projection`, { headers: { authorization: "Bearer alice-token" } }));
    expect(response?.status).toBe(503);
  } finally { await core.close(); }
});

test("distinct table custodians share a physical lock but never overlapping authority", async () => {
  const f = await fixture(), original = JSON.parse(readFileSync(f.scope.storage.adoptionReceiptPath, "utf8"));
  const claims = ["images", "watch"].map(name => {
    const adoptionReceiptPath = join(f.scope.custody.dataDir, `${name}.json`);
    writeFileSync(adoptionReceiptPath, JSON.stringify({ ...original, scopeId: name, tableNames: [name] }), { mode: 0o600 });
    return { id: name, databasePath: f.scope.storage.databasePath, adoptionReceiptPath, uid: f.scope.custody.uid, requiredTables: [name] };
  });
  const first = acquireDatabaseOwnership(claims[0]!, path => path), second = acquireDatabaseOwnership(claims[1]!, path => path);
  expect(first.ok).toBe(true); expect(second.ok).toBe(true);
  expect(acquireDatabaseOwnership(claims[0]!, path => path).ok).toBe(false);
  if (first.ok) first.value.close();
  expect(acquireScopeOwnership(f.scope, path => path).ok).toBe(false);
  if (second.ok) second.value.close();
  const all = acquireScopeOwnership(f.scope, path => path); expect(all.ok).toBe(true); if (all.ok) all.value.close();
});

test("the unified HTTP host serves health without opening unavailable partitions", async () => {
  const f = await fixture();
  f.scope.availability = { kind: "unavailable", reason: "locked" };
  f.config.port = await fixturePort();
  const started = await serveCore(f.config);
  if (!started.ok) throw new Error(started.error.message);
  expect(started.ok).toBe(true);
  if (!started.ok) throw new Error(started.error.message);
  try {
    const response = await fetch(`${started.value.service.url}/v1/health`);
    expect(response.status).toBe(200);
    expect((await response.json()).releaseCommit).toBe(f.config.releaseCommit);
    const locked = await fetch(`${started.value.service.url}/v1/scopes/alice/projection`, { headers: { authorization: "Bearer alice-token" } });
    expect(locked.status).toBe(503);
  } finally { expect((await started.value.close()).ok).toBe(true); }
});


test("trusted reload preserves custody and drains before replacing plugins", async () => {
  const { config } = await fixture();
  const next = structuredClone(config); next.policy.revision += 1;
  const changed = structuredClone(next); changed.scopes[0]!.storage.databasePath += ".other";
  expect(validateCoreReload(config, changed).ok).toBe(false);
  let desired = changed;
  const events: string[] = [];
  const owner = new CoreReloadOwner(config, { close: async () => { events.push("old-drained"); return { ok: true, value: undefined }; } },
    () => ({ ok: true, value: desired }), async () => {
      events.push("new-adopted");
      return { ok: true, value: { close: async () => { events.push("new-drained"); return { ok: true, value: undefined }; } } };
    });
  expect((await owner.reload()).ok).toBe(false); expect(events).toEqual([]);
  desired = next;
  expect((await owner.reload()).ok).toBe(true);
  expect((await owner.reload()).ok).toBe(true);
  expect(events).toEqual(["old-drained", "new-adopted"]);
  expect((await owner.stop()).ok).toBe(true);
  expect(events).toEqual(["old-drained", "new-adopted", "new-drained"]);
});

test("shutdown during reload drain never admits a replacement", async () => {
  const { config } = await fixture();
  const next = structuredClone(config); next.policy.revision += 1;
  let release!: () => void;
  const barrier = new Promise<void>(resolve => { release = resolve; });
  let entered!: () => void;
  const draining = new Promise<void>(resolve => { entered = resolve; });
  let starts = 0;
  const owner = new CoreReloadOwner(config, { close: async () => { entered(); await barrier; return { ok: true, value: undefined }; } },
    () => ({ ok: true, value: next }), async () => { starts++; return { ok: false, error: { code: "unavailable", message: "Must not start" } }; });
  const reload = owner.reload(); await draining;
  const stop = owner.stop(); release();
  expect((await reload).ok).toBe(true); expect((await stop).ok).toBe(true); expect(starts).toBe(0);
});

test("adoption substage observation is aggregate-only and preserves custody refusal", async () => {
  const f = await fixture();
  const records: string[] = [];
  const report = spyOn(console, "info").mockImplementation(value => { records.push(String(value)); });
  const core = new CoreService(f.config, async () => ({ ok: true, value: f.runtime }));
  try {
    expect((await core.start()).ok).toBe(true);
    const rows = records.map(value => JSON.parse(value)).filter(value => value.type === "core-adoption");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({ type: "core-adoption", releaseCommit: f.config.releaseCommit, outcome: "adopted", declaredScopeCount: 1, adoptedScopeCount: 1,
      durationsMs: { runtimeCustody: expect.any(Number), threadDatabase: expect.any(Number), scopeAdoption: expect.any(Number), directoryWiring: expect.any(Number) } });
    expect(Object.values(rows[0].durationsMs).every(value => Number.isFinite(value) && Number(value) >= 0)).toBe(true);
    expect(JSON.stringify(rows[0])).not.toContain(f.scope.id);
    expect(JSON.stringify(rows[0])).not.toContain(f.scope.storage.databasePath);
    expect((await core.start()).ok).toBe(false);
    expect(records.map(value => JSON.parse(value)).filter(value => value.type === "core-adoption")).toHaveLength(1);
  } finally { await core.close(); report.mockRestore(); }
});

test("failed runtime custody retains its typed result and emits no private adoption fields", async () => {
  const f = await fixture(), records: string[] = [];
  const report = spyOn(console, "info").mockImplementation(value => { records.push(String(value)); });
  const refused = { ok: false as const, error: { code: "unavailable" as const, message: "Synthetic custody refusal" } };
  const core = new CoreService(f.config, async () => refused);
  try {
    expect(await core.start()).toEqual(refused);
    const row = records.map(value => JSON.parse(value)).find(value => value.type === "core-adoption");
    expect(row).toMatchObject({ outcome: "failed", declaredScopeCount: 1, adoptedScopeCount: 0 });
    expect(Object.keys(row).sort()).toEqual(["adoptedScopeCount", "declaredScopeCount", "durationsMs", "outcome", "releaseCommit", "type"]);
    expect(JSON.stringify(row)).not.toContain(f.scope.id);
    expect(JSON.stringify(row)).not.toContain(refused.error.message);
  } finally { await core.close(); report.mockRestore(); }
});

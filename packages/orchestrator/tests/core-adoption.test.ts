import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ThreadService } from "../src/threads/service.js";
import { threadCapability } from "../src/threads/caller.js";
import { CoreService, type CoreRuntime } from "../src/core/service.js";
import { serveCore } from "../src/core/main.js";
import { acquireDatabaseOwnership, acquireScopeOwnership } from "../src/core/ownership.js";
import { bindGatewayRequest, registerGatewaySocket, type GatewayBinding } from "../src/core/gateway.js";
import type { IncomingMessage } from "node:http";
import type { CoreConfig, CoreScope } from "../src/core/contracts.js";

const roots: string[] = [];
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
  const runtime: CoreRuntime = { openSession: async () => { throw new Error("No execution during adoption"); }, attachSession: async () => null, recoverSession: async () => null, detach() {}, path: value => value };
  return { scope, config, runtime, threadId: spawned.value.id, capability };
}

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
  } finally { expect((await core.close()).ok).toBe(true); }
  const reowned = acquireScopeOwnership(f.scope, path => path); expect(reowned.ok).toBe(true); if (reowned.ok) reowned.value.close();
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
  f.config.port = 20_000 + Math.floor(Math.random() * 30_000);
  const started = await serveCore(f.config);
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

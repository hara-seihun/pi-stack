import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ThreadService } from "../src/threads/service.js";
import { threadCapability } from "../src/threads/caller.js";
import { CoreService, type CoreRuntime } from "../src/core/service.js";
import type { CoreConfig, CoreScope } from "../src/core/contracts.js";

test("manager reply route serves only owning authenticated service and exact configured manager", async () => {
  const path = mkdtempSync(join(tmpdir(), "manager-reply-route-"));
  const sessionsDir = join(path, "sessions"); mkdirSync(sessionsDir);
  const databasePath = join(path, "threads.sqlite3"), keyPath = join(path, "capability.key"), receiptPath = join(path, "adoption.json");
  const capability = threadCapability(keyPath);
  const old = new ThreadService({ databasePath, sessionsDir, capability, capacity: { mode: "unmanaged" }, openSession: async () => { throw new Error("Fixture does not execute native work"); } });
  const manager = await old.spawn({ requestId: "retained-manager", cwd: path, title: "Manager", metadata: { manager: true } });
  if (!manager.ok) throw new Error(manager.error.message);
  const nativeToken = capability.issue(manager.value.id);
  await old.detach();
  const identity = statSync(databasePath, { bigint: true });
  writeFileSync(receiptPath, JSON.stringify({ version: 1, state: "detached", scopeId: "alice", databasePath, sessionsDir, databaseIdentity: { dev: String(identity.dev), ino: String(identity.ino) }, previousOwner: { identity: "retained-controller", detachedAt: new Date().toISOString() } }));
  const resource: CoreScope["resource"] = { id: "alice-threads", kind: "thread", owner: "alice", privacy: "private", subjects: ["alice"], consent: "not-required" };
  const scope: CoreScope = { id: "alice", principalId: "alice", availability: { kind: "adopt" }, resource, storage: { databasePath, sessionsDir, capabilityKeyPath: keyPath, adoptionReceiptPath: receiptPath }, custody: { uid: process.getuid!(), gid: process.getgid!(), namespace: { kind: "host" }, retainedRunnerNamespace: { kind: "host" }, dataDir: path, socketDir: path }, resources: [], environment: {}, callbackGateway: { kind: "none" }, manager: { kind: "existing", threadId: manager.value.id }, managerRouting: { kind: "none" } };
  const config: CoreConfig = { version: 1, host: "127.0.0.1", port: 19181, statePath: join(path, "core.sqlite3"), releaseCommit: "a".repeat(40), principals: [{ kind: "person", id: "alice", person: "alice" }, { kind: "person", id: "bob", person: "bob" }], credentials: ["alice", "bob"].map(person => ({ sha256: createHash("sha256").update(`${person}-token`).digest("hex"), principalId: person, scopeIds: ["alice"], purpose: "service", routeCeiling: { kind: "scoped" } })), policy: { revision: 1, grants: ["alice", "bob"].map(person => ({ id: `${person}-read`, principal: person, resource: { kind: "exact", id: resource.id }, actions: ["read"], effect: "allow", validFrom: 0, validUntil: null, issuedBy: "owner", source: "explicit route fixture grant" })), consents: [] }, scopes: [scope], broker: { kind: "disabled" }, root: { kind: "disabled" }, memory: { kind: "disabled" }, images: { kind: "disabled" }, duties: { kind: "disabled" }, callbacks: { kind: "none" }, gatewayTransport: { kind: "none" }, gatewayBindings: [] };
  const runtime: CoreRuntime = { openSession: async () => { throw new Error("No execution during reply projection"); }, attachSession: async () => null, recoverSession: async () => null, detach() {}, path: value => value };
  const core = new CoreService(config, async () => ({ ok: true, value: runtime }));
  const request = (token: string, body: unknown, native = false) => new Request(`${core.url}/v1/scopes/alice/thread-owner/managerReplies`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...(native ? { "x-pi-thread-token": nativeToken } : {}) }, body: JSON.stringify(body) });
  try {
    expect((await core.start()).ok).toBe(true);
    const own = await core.request(request("alice-token", { after: null, limit: 100 }));
    expect(own?.status).toBe(200);
    expect(await own!.json()).toEqual({ ok: true, value: { managerThreadId: manager.value.id, cursor: 0, replies: [] } });
    expect((await core.request(request("bob-token", { after: null, limit: 100 })))?.status).toBe(403);
    expect((await core.request(request("alice-token", { after: null, limit: 100 }, true)))?.status).toBe(403);
    expect(await (await core.request(request("alice-token", { after: 0, limit: 100, threadId: "another-scope" })))!.json()).toMatchObject({ ok: false, error: { code: "invalid_request" } });
  } finally { await core.close(); rmSync(path, { recursive: true, force: true }); }
});

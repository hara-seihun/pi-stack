import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ThreadService } from "../src/threads/service.js";
import { threadCapability } from "../src/threads/caller.js";
import { CoreService, type CoreRuntime } from "../src/core/service.js";
import type { CoreConfig, CoreScope } from "../src/core/contracts.js";
import { AgentCapacityAuthority, createAgentCapacityServer } from "../src/agent-capacity-authority.js";
import { configuredAgentCapacitySettings } from "../src/agent-capacity.js";

test("adopted capacity uses the scope UID manifest, never the core process credentials", async () => {
  const root = mkdtempSync(join(tmpdir(), "core-capacity-")), env = { ...process.env };
  const databasePath = join(root, "threads.sqlite3"), capabilityKeyPath = join(root, "capability.key"), adoptionReceiptPath = join(root, "adoption.json");
  const capability = threadCapability(capabilityKeyPath);
  const old = new ThreadService({ databasePath, sessionsDir: root, capability, capacity: { mode: "unmanaged" }, openSession: async () => { throw new Error("No native in custody test"); } });
  const spawned = await old.spawn({ id: "agent", requestId: "accepted-before-cutover", cwd: root, message: "retained" });
  if (!spawned.ok) throw new Error(spawned.error.message);
  capability.issue(spawned.value.id);
  await old.detach();
  const stat = statSync(databasePath, { bigint: true });
  writeFileSync(adoptionReceiptPath, JSON.stringify({ version: 1, state: "detached", scopeId: "alice", databasePath, sessionsDir: root,
    databaseIdentity: { dev: String(stat.dev), ino: String(stat.ino) }, previousOwner: { identity: "original", detachedAt: new Date().toISOString() } }), { mode: 0o600 });
  const scope: CoreScope = { id: "alice", principalId: "alice", availability: { kind: "adopt" }, resource: { id: "alice-threads", kind: "thread", owner: "alice", privacy: "private", subjects: ["alice"], consent: "not-required" },
    storage: { databasePath, sessionsDir: root, capabilityKeyPath, adoptionReceiptPath }, custody: { uid: process.getuid!(), gid: process.getgid!(), namespace: { kind: "host" }, retainedRunnerNamespace: { kind: "host" }, dataDir: root, socketDir: root },
    resources: [], environment: {}, callbackGateway: { kind: "none" }, manager: { kind: "none" }, managerRouting: { kind: "none" } };
  const config: CoreConfig = { version: 1, host: "127.0.0.1", port: 19181, statePath: join(root, "core.sqlite3"), releaseCommit: "a".repeat(40),
    principals: [{ kind: "person", id: "alice", person: "alice" }], credentials: [], policy: { revision: 1, grants: [], consents: [] }, scopes: [scope],
    broker: { kind: "disabled" }, root: { kind: "disabled" }, memory: { kind: "disabled" }, images: { kind: "disabled" }, duties: { kind: "disabled" }, callbacks: { kind: "none" }, gatewayTransport: { kind: "none" }, gatewayBindings: [] };
  const runtime: CoreRuntime = { openSession: async () => { throw new Error("No native in custody test"); }, attachSession: async () => null, recoverSession: async () => null,
    detach() {}, path: value => value, readImage: async () => ({ ok: false, error: { code: "unavailable", message: "No image reader" } }) };
  const authority = new AgentCapacityAuthority(":memory:"); expect(authority.initialize([]).ok).toBe(true);
  const server = createAgentCapacityServer(authority, [{ id: "scope-owner", token: "scope-token" }, { id: "core-owner", token: "core-token" }]);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const manifest = join(root, "capacity.json"), scopeToken = join(root, "scope-token"), coreToken = join(root, "core-token");
  writeFileSync(scopeToken, "scope-token"); writeFileSync(coreToken, "core-token");
  writeFileSync(manifest, JSON.stringify({ authorityUrl: url, owners: [{ uid: scope.custody.uid, ownerId: "scope-owner", tokenFile: scopeToken }] }));
  process.env.PI_AGENT_CAPACITY_CONFIG = manifest;
  process.env.PI_AGENT_CAPACITY_URL = url; process.env.PI_AGENT_CAPACITY_OWNER = "core-owner"; process.env.PI_AGENT_CAPACITY_TOKEN_FILE = coreToken;
  expect(configuredAgentCapacitySettings({ PI_AGENT_CAPACITY_CONFIG: manifest }, { uid: scope.custody.uid + 100_000 }).ok).toBe(false);
  expect(configuredAgentCapacitySettings(process.env, { uid: scope.custody.uid }).ok).toBe(false);
  const core = new CoreService(config, async () => ({ ok: true, value: runtime }));
  try {
    const started = await core.start(); if (!started.ok) throw new Error(started.error.message);
    expect(started.ok).toBe(true);
    const adopted = core.owner("alice"); if (!adopted.ok) throw new Error(adopted.error.message);
    expect((await (adopted.value.threads as any).acquireCapacity("agent", "scope-execution", "accepted-before-cutover", "work")).ok).toBe(true);
    expect(authority.entries()).toMatchObject([{ ownerId: "scope-owner", executionId: "scope-execution" }]);
    expect(authority.acquire("core-owner", { agentId: "agent", executionId: "scope-execution" }).ok).toBe(false);
    await (adopted.value.threads as any).releaseUnenteredCapacity("agent", "scope-execution");
    expect(authority.status().active).toBe(0);
  } finally {
    await core.close();
    for (const key of Object.keys(process.env)) if (!(key in env)) delete process.env[key];
    Object.assign(process.env, env);
    await new Promise<void>(resolve => server.close(() => resolve())); authority.close(); rmSync(root, { recursive: true, force: true });
  }
});

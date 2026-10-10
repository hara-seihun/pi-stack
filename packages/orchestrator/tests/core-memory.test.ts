import { expect, test } from "bun:test";
import { createCoreMemory, parseCoreMemoryConfig, type CoreMemoryConfig } from "../src/core/memory.js";
import type { Principal } from "../src/permissions.js";
const principals: Principal[] = [{ kind: "person", id: "alice", person: "alice" }, { kind: "service", id: "private-consultation" }];
const config: CoreMemoryConfig = {
  kind: "configured", id: "memory", uid: 1001, custodyScopeId: "custody", databasePath: "/fixture/memory.sqlite3", adoptionReceiptPath: "/fixture/memory-adoption.json", authFile: "/fixture/auth.json",
  roomAudience: { kind: "none" }, timezones: { kind: "none" }, datasets: [],
  identities: [{ kind: "supervisor", person: "alice", principalId: "alice" }, { kind: "person-role", person: "alice", role: "person", threadId: null, principalId: "alice" }, { kind: "root-service", principalId: "private-consultation" }, { kind: "person-role", person: "alice", role: "root", threadId: null, principalId: "private-consultation" }],
  resources: [{ id: "alice-memory", kind: "memory", owner: "alice", privacy: "private", subjects: ["alice"], consent: "not-required" }],
  routes: [{ principalId: "alice", route: "/v1/memory", operation: "read", resourceId: "alice-memory", action: "read" }, { principalId: "alice", route: "/v1/sessions", operation: null, resourceId: "alice-memory", action: "execute" }],
};
test("core memory requires explicit identity/resource/action/old-custody mapping", () => {
  expect(parseCoreMemoryConfig(undefined, principals).ok).toBe(false);
  expect(parseCoreMemoryConfig({ kind: "disabled" }, principals).ok).toBe(true);
  expect(parseCoreMemoryConfig(config, principals).ok).toBe(true);
  expect(parseCoreMemoryConfig({ ...config, adoptionReceiptPath: undefined }, principals).ok).toBe(false);
  expect(parseCoreMemoryConfig({ ...config, identities: [{ kind: "person-role", person: "bob", role: "person", threadId: null, principalId: "alice" }] }, principals).ok).toBe(false);
  expect(parseCoreMemoryConfig({ ...config, routes: [{ ...config.routes[0], operation: "write", action: "read" }] }, principals).ok).toBe(false);
  expect(parseCoreMemoryConfig({ ...config, routes: [...config.routes, config.routes[0]] }, principals).ok).toBe(false);
  expect(parseCoreMemoryConfig({ ...config, identities: [...config.identities, { kind: "person-role", person: "alice", role: "person", threadId: "thread", principalId: "alice" }] }, principals).ok).toBe(false);
});
test("an existing store is never invented when adoption storage is unavailable", async () => {
  const result = await createCoreMemory({ config, principals, policy: { revision: 1, grants: [], consents: [] }, enabled: () => true, scopes: [{ id: "custody", principalId: "private-consultation", availability: { kind: "adopt" }, resource: { id: "custody", kind: "data", owner: "custody", privacy: "confidential", subjects: [], consent: "not-required" }, storage: { databasePath: "/fixture/threads.sqlite3", sessionsDir: "/fixture/sessions", capabilityKeyPath: "/fixture/key", adoptionReceiptPath: "/fixture/adopt" }, custody: { uid: 1001, gid: 1001, namespace: { kind: "host" }, retainedRunnerNamespace: { kind: "host" }, dataDir: "/fixture", socketDir: "/fixture" }, resources: [], environment: {}, manager: { kind: "none" }, managerRouting: { kind: "none" } }], owner: () => ({ ok: true, value: { runtime: { path: path => path } } }) });
  expect(result).toMatchObject({ ok: false, error: { code: "unavailable" } });
});

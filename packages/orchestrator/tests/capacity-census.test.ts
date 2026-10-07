import { afterEach, expect, it, vi } from "vitest";
import { createServer } from "node:net";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AgentCapacityAuthority, createAgentCapacityServer } from "../src/agent-capacity-authority.js";
import { collectAgentCapacityCensus } from "../src/agent-capacity-census.js";
import { ThreadService } from "../src/threads/service.js";
import { ThreadCapacityLedger } from "../src/threads/capacity-ledger.js";
import type { AgentCapacity } from "../src/agent-capacity.js";
import type { Result } from "../src/threads/contracts.js";

const unwrap = <T>(result: Result<T>): T => { if (!result.ok) throw new Error(result.error.message); return result.value; };
const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); vi.unstubAllEnvs(); });
const capacity: AgentCapacity = {
  acquire: async () => ({ ok: false, error: { code: "unavailable", message: "Uninitialized" } }),
  release: async () => ({ ok: true, value: undefined }), inspect: async () => ({ ok: true, value: { state: "absent" } }), withdraw: async () => ({ ok: true, value: undefined }),
};

it("census distinguishes queued admission from legacy/native custody, preserving uncertainty even for idle rows", async () => {
  const root = mkdtempSync(join(tmpdir(), "capacity-census-")); cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const authority = new AgentCapacityAuthority(":memory:"), server = createAgentCapacityServer(authority, [{ id: "operator", token: "fixture-credential" }]);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(async () => { await new Promise<void>(resolve => server.close(() => resolve())); authority.close(); });
  const token = join(root, "token"); writeFileSync(token, "fixture-credential");
  vi.stubEnv("PI_AGENT_CAPACITY_URL", `http://127.0.0.1:${(server.address() as { port: number }).port}`); vi.stubEnv("PI_AGENT_CAPACITY_OWNER", "operator"); vi.stubEnv("PI_AGENT_CAPACITY_TOKEN_FILE", token);
  const control = join(root, "control.sock"), native = createServer(socket => socket.on("data", () => socket.end('{"ok":true,"activeSessions":1,"activeThreadIds":["retained"]}\n')));
  await new Promise<void>(resolve => native.listen(control, resolve)); cleanups.push(async () => { await new Promise<void>(resolve => native.close(() => resolve())); });
  const path = join(root, "threads.sqlite3"), owner = new ThreadService({ capacity: { mode: "unmanaged" }, databasePath: path, sessionsDir: root, openSession: async () => { throw new Error("Census must never execute"); } });
  cleanups.push(async () => { await owner.detach(); });
  const settings = { model: "openai-codex/gpt-6.1-sol", thinkingLevel: "medium", speed: "standard" } as const;
  for (const [id, metadata] of [["queued", {}], ["legacy", {}], ["provider", { providerWait: { phase: "waiting" } }], ["retained", { runnerReference: { control, socketPath: join(root, "retained.sock") } }], ["cached", { runnerReference: { control, socketPath: join(root, "cached.sock") } }]] as const)
    unwrap(owner.importThread({ id, title: id, cwd: root, sessionFile: join(root, `${id}.jsonl`), settings, metadata }));
  for (const id of ["queued", "legacy", "provider"]) unwrap(owner.importMessage({ id: `${id}-work`, threadId: id, text: "work", state: "dispatched", executionId: `${id}-execution` }));
  const db = (owner as any).db;
  new ThreadCapacityLedger(db, capacity);
  db.prepare("INSERT INTO thread_capacity(execution_id,logical_execution_id,thread_id,source_id,kind,state,entered_native) VALUES('queued-execution','queued-execution','queued','queued-work','work','requested',0)").run();
  const direct = join(root, "standalone"); mkdirSync(direct);
  for (const state of ["acquiring", "held", "settled", "released"]) {
    const directory = join(direct, state); mkdirSync(directory);
    writeFileSync(join(directory, "capacity.json"), JSON.stringify({ version: 1, ownerId: "host-a/alice", agentId: state, executionId: `${state}-execution`, state, pid: 9999999, processStart: "irrelevant-dead-process", ...(state !== "acquiring" ? { leaseId: "fixture-custody" } : {}) }));
  }
  const result = await collectAgentCapacityCensus({ host: "host-a", barrierId: "cutover", owners: [{ ownerId: "host-a/alice", threadDatabases: [path], standaloneDirectories: [direct], standaloneRecords: [] }] });
  expect(result.entries.map(entry => entry.agentId).sort()).toEqual(["held", "legacy", "retained", "settled"]);
  expect(result.entries.find(entry => entry.agentId === "retained")).toMatchObject({ executionId: "native-census:retained", uncertain: true });
  expect(result.entries.find(entry => entry.agentId === "held")?.uncertain).toBe(true);
  expect(result.entries.find(entry => entry.agentId === "settled")?.uncertain).toBe(false);
  expect(authority.status()).toMatchObject({ initialized: false, active: 0 });
});

it("named unreadable census sources are errors, never empty owner execution inventories", async () => {
  await expect(collectAgentCapacityCensus({ host: "host-a", barrierId: "cutover", owners: [{ ownerId: "host-a/alice", threadDatabases: ["/nonexistent-capacity-census-fixture.sqlite3"], standaloneDirectories: [], standaloneRecords: [] }] })).rejects.toThrow();
});

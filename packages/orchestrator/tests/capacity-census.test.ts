import { afterEach, expect, it } from "vitest";
import { createServer } from "node:net";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { collectAgentCapacityCensus } from "../src/agent-capacity-census.js";
import { ThreadService } from "../src/threads/service.js";
import { ThreadCapacityLedger } from "../src/threads/capacity-ledger.js";
import type { AgentCapacity } from "../src/agent-capacity.js";
import type { Result } from "../src/threads/contracts.js";

const unwrap = <T>(result: Result<T>): T => { if (!result.ok) throw new Error(result.error.message); return result.value; };
const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const capacity: AgentCapacity = {
  acquire: async () => ({ ok: false, error: { code: "unavailable", message: "Uninitialized" } }),
  release: async () => ({ ok: true, value: undefined }), inspect: async () => ({ ok: true, value: { state: "absent" } }), withdraw: async () => ({ ok: true, value: undefined }),
};

it("census distinguishes queued admission from legacy/native custody, preserving uncertainty even for idle rows", async () => {
  const root = mkdtempSync(join(tmpdir(), "capacity-census-")); cleanups.push(() => rmSync(root, { recursive: true, force: true }));
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
  for (const state of ["held", "releasing", "released"]) db.prepare("INSERT INTO thread_capacity(execution_id,logical_execution_id,thread_id,source_id,kind,state,entered_native,lease_id) VALUES(?,?,?,?,'work',?,1,'fixture-custody')").run(`${state}-execution`, `${state}-execution`, state, `${state}-work`, state);
  const requests = join(root, "requests"), directory = join(requests, "request-uuid", "private"); mkdirSync(directory, { recursive: true });
  const privatePath = join(directory, "threads.sqlite3"), privateOwner = new ThreadService({ capacity: { mode: "unmanaged" }, databasePath: privatePath, sessionsDir: directory, openSession: async () => { throw new Error("Census must never execute"); } });
  cleanups.push(async () => { await privateOwner.detach(); });
  unwrap(privateOwner.importThread({ id: "root-request", title: "Private title", cwd: directory, sessionFile: join(directory, "private.jsonl"), settings, metadata: { private: "Never export this" } }));
  unwrap(privateOwner.importMessage({ id: "root-work", threadId: "root-request", text: "Private request text", state: "dispatched", executionId: "root-execution" }));
  writeFileSync(join(directory, "private.jsonl"), "Unreadable native trace is not a census source");
  const result = await collectAgentCapacityCensus({ host: "host-a", barrierId: "cutover", owners: [{ ownerId: "host-a/alice", threadDatabases: [path, privatePath], threadDatabaseDirectories: [requests] }] });
  expect(result.entries.map(entry => entry.agentId).sort()).toEqual(["held", "legacy", "releasing", "retained", "root-request"]);
  expect(result.entries.find(entry => entry.agentId === "retained")).toMatchObject({ executionId: "native-census:retained", uncertain: true });
  expect(result.entries.find(entry => entry.agentId === "root-request")).toMatchObject({ executionId: "root-execution", source: privatePath });
  expect(JSON.stringify(result)).not.toContain("Private");
  expect(JSON.stringify(result)).not.toContain("Never export");
});

it("named unreadable or linked census sources are errors; an accessible empty directory is explicit empty custody", async () => {
  for (const sources of [{ threadDatabases: ["/nonexistent-capacity-census-fixture.sqlite3"], threadDatabaseDirectories: [] }, { threadDatabases: [], threadDatabaseDirectories: ["/nonexistent-capacity-census-fixture"] }])
    await expect(collectAgentCapacityCensus({ host: "host-a", barrierId: "cutover", owners: [{ ownerId: "host-a/alice", ...sources }] })).rejects.toThrow();
  const root = mkdtempSync(join(tmpdir(), "capacity-empty-")); cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const plan = { host: "host-a", barrierId: "cutover", owners: [{ ownerId: "host-a/alice", threadDatabases: [], threadDatabaseDirectories: [root] }] };
  expect((await collectAgentCapacityCensus(plan)).entries).toEqual([]);
  symlinkSync(root, join(root, "external"));
  await expect(collectAgentCapacityCensus(plan)).rejects.toThrow(/symbolic links/);
});

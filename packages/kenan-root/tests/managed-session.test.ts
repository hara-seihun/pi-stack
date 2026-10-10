import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ThreadService, type AgentCapacity } from "pi-orchestrator/api";
import { createCoreInProcessRuntime } from "pi-orchestrator/core-native";
import { createRootExecutor, type RootConfig } from "../src/root-runtime.js";

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "shared-private-root-"));
  const config: RootConfig = { version: 1, provider: "fixture", model: "root", thinkingLevel: "high",
    cwd: root, agentDir: root, sessionsDir: join(root, "requests"), promptFile: "unused", brokerUrl: "http://127.0.0.1:19888/" };
  mkdirSync(config.sessionsDir);
  const admission = { person: "alice", threadId: "ordinary-thread", rootSessionId: randomUUID(),
    recipients: ["alice"], subjects: ["alice"], memoryToken: "TRANSIENT_ROOT_SECRET" };
  const releases: string[] = [];
  const capacity: AgentCapacity = {
    acquire: async execution => ({ ok: true, value: { ...execution, leaseId: "private-lease" } }),
    release: async custody => { releases.push(custody.executionId); return { ok: true, value: undefined }; },
    withdraw: async () => ({ ok: true, value: undefined }), inspect: async () => ({ ok: true, value: { state: "absent" } }),
  };
  const runtime = createCoreInProcessRuntime();
  const databasePath = join(root, "threads.sqlite3"), sessionsDir = join(root, "native");
  const threads = new ThreadService({ databasePath, sessionsDir, capacity, workersOnly: true, ...runtime });
  const started = await threads.start();
  if (!started.ok) throw new Error(started.error.message);
  const consultationOwner = { threads, runtime };
  return { root, config, admission, releases, consultationOwner, databasePath, sessionsDir,
    async close() { await runtime.drain(); const closed = await threads.close(); if (!closed.ok) throw new Error(closed.error.message); runtime.detach(); rmSync(root, { recursive: true, force: true }); } };
}

test("root judgments use the already-started shared owner and never create per-request thread databases", async () => {
  const f = await fixture();
  try {
    let called = 0;
    const executor = createRootExecutor(f.config, { prompt: "PRIVATE_ROOT_POLICY", consultationOwner: f.consultationOwner,
      factory: async spec => {
        const db = new Database(f.databasePath, { readonly: true });
        expect(db.query("SELECT state,entered_native FROM thread_capacity").get()).toEqual({ state: "held", entered_native: 1 });
        db.close();
        expect(spec.sessionFile).toBe(join(f.sessionsDir, `${spec.id}.jsonl`));
        writeFileSync(spec.sessionFile, JSON.stringify({ type: "session", version: 3, id: spec.id, cwd: spec.config.cwd, timestamp: new Date().toISOString() }) + "\n");
        return { prompt: async () => { called++; }, reply: () => "Only chosen disclosure", dispose() {} };
      } });
    expect(await executor(f.admission, "PRIVATE_REQUEST")).toEqual({ ok: true, value: { reply: "Only chosen disclosure", subjects: ["alice"] } });
    expect(await executor(f.admission, "PRIVATE_REQUEST")).toEqual({ ok: true, value: { reply: "Only chosen disclosure", subjects: ["alice"] } });
    expect(called).toBe(1); expect(f.releases).toHaveLength(1);
    expect(readFileSync(f.databasePath).includes(Buffer.from("TRANSIENT_ROOT_SECRET"))).toBe(false);
    const db = new Database(f.databasePath, { readonly: true });
    expect(db.query("SELECT outcome FROM thread_execution").get()).toEqual({ outcome: "complete" }); db.close();
  } finally { await f.close(); }
});

test("failed admitted construction cannot replay and releases only its own shared capacity", async () => {
  const f = await fixture();
  try {
    let creations = 0;
    const executor = createRootExecutor(f.config, { prompt: "PRIVATE_ROOT_POLICY", consultationOwner: f.consultationOwner, report() {},
      factory: async () => { creations++; throw new Error("Native root initialization failed"); } });
    expect((await executor(f.admission, "Private request")).ok).toBe(false);
    expect((await executor(f.admission, "Private request")).ok).toBe(false);
    expect(creations).toBe(1); expect(f.releases).toHaveLength(1);
  } finally { await f.close(); }
});

test("missing shared owner is typed unavailable, not a second native engine", async () => {
  const root = mkdtempSync(join(tmpdir(), "root-no-owner-"));
  try {
    const config: RootConfig = { version: 1, provider: "fixture", model: "root", thinkingLevel: "high", cwd: root,
      agentDir: root, sessionsDir: root, promptFile: "unused", brokerUrl: "http://127.0.0.1:19888/" };
    const execute = createRootExecutor(config, { prompt: "fixed", factory: async () => { throw new Error("Must not construct"); } });
    const result = await execute({ rootSessionId: randomUUID(), person: "alice", threadId: "a", recipients: ["alice"], subjects: [], memoryToken: "token" }, "request");
    expect(result).toEqual({ ok: false, error: "unavailable", message: "Private consultations require the shared core owner" });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("old queued root input resumes its exact adopted owner without replacing spawn identity", async () => {
  const f = await fixture();
  try {
    const request = "Original admitted request";
    const text = `A person asked Kenan the following. Consider it on its merits and answer only what you choose to disclose.\n\n${JSON.stringify({ request })}`;
    const directory = join(f.config.sessionsDir, f.admission.rootSessionId);
    mkdirSync(directory);
    writeFileSync(join(directory, "admission.json"), JSON.stringify(f.admission));
    const spawned = await f.consultationOwner.threads.spawn({ requestId: `root:${f.admission.rootSessionId}`, id: f.admission.rootSessionId,
      cwd: f.root, title: "Private root judgment", message: text, settings: { model: "fixture/root", thinkingLevel: "high", speed: "standard" } });
    expect(spawned.ok).toBe(true);
    let origin: string | undefined;
    const execute = createRootExecutor(f.config, { prompt: "fixed", consultationOwnerFor: (id, state) => {
      expect(id).toBe(f.admission.rootSessionId); origin = state; return { ok: true, value: f.consultationOwner };
    }, factory: async spec => {
      writeFileSync(spec.sessionFile, JSON.stringify({ type: "session", version: 3, id: spec.id, cwd: f.root, timestamp: new Date().toISOString() }) + "\n");
      return { prompt: async () => {}, reply: () => "Chosen result", dispose() {} };
    } });
    expect((await execute(f.admission, request)).ok).toBe(true);
    expect(origin).toBe("existing");
    expect(f.consultationOwner.threads.get(f.admission.rootSessionId)?.title).toBe("Private root judgment");
    expect(f.consultationOwner.threads.snapshot()).toHaveLength(1);
  } finally { await f.close(); }
});

test("unregistered old owner is not respawned, and terminal chosen replies need no new native owner", async () => {
  const f = await fixture();
  try {
    const directory = join(f.config.sessionsDir, f.admission.rootSessionId);
    mkdirSync(directory); writeFileSync(join(directory, "admission.json"), JSON.stringify(f.admission));
    let resolved = 0, constructed = 0;
    const execute = createRootExecutor(f.config, { prompt: "fixed", consultationOwnerFor: () => { resolved++; return { ok: false, message: "Original owner unavailable" }; },
      factory: async () => { constructed++; throw new Error("Must not run"); } });
    expect(await execute(f.admission, "request")).toEqual({ ok: false, error: "unavailable", message: "Original owner unavailable" });
    expect(constructed).toBe(0); expect(f.consultationOwner.threads.snapshot()).toHaveLength(0);
    writeFileSync(join(directory, "reply.json"), JSON.stringify({ reply: "Already chosen", subjects: ["alice"] }));
    expect(await execute(f.admission, "request")).toEqual({ ok: true, value: { reply: "Already chosen", subjects: ["alice"] } });
    expect(resolved).toBe(1);
  } finally { await f.close(); }
});

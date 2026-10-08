import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentCapacity } from "pi-orchestrator/api";
import { createRootExecutor, type RootConfig } from "../src/root-runtime.js";
import { recoverRootOwners } from "../src/managed-session.js";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "private-root-owner-"));
  const config: RootConfig = { version: 1, provider: "fixture", model: "root", thinkingLevel: "high",
    cwd: root, agentDir: root, sessionsDir: join(root, "sessions"), promptFile: "unused", brokerUrl: "http://127.0.0.1:19888/" };
  mkdirSync(config.sessionsDir);
  const admission = { person: "alice", threadId: "ordinary-thread", rootSessionId: randomUUID(),
    recipients: ["alice"], subjects: ["alice"], memoryToken: "TRANSIENT_ROOT_SECRET" };
  const releases: string[] = [];
  const capacity: AgentCapacity = {
    acquire: async execution => ({ ok: true, value: { ...execution, leaseId: "private-lease" } }),
    release: async custody => { releases.push(custody.executionId); return { ok: true, value: undefined }; },
    withdraw: async () => ({ ok: true, value: undefined }), inspect: async () => ({ ok: true, value: { state: "absent" } }),
  };
  return { root, config, admission, releases, capacity };
}

test("root native construction and model work have one private managed capacity owner", async () => {
  const f = fixture();
  try {
    let constructed = false, called = 0;
    const executor = createRootExecutor(f.config, { prompt: "PRIVATE_ROOT_POLICY", capacity: f.capacity,
      factory: async spec => {
        const db = new Database(join(spec.directory, "threads.sqlite3"), { readonly: true });
        expect(db.query("SELECT state,entered_native FROM thread_capacity").get()).toEqual({ state: "held", entered_native: 1 });
        db.close(); constructed = true;
        expect(spec.sessionFile).toBe(join(spec.directory, `${spec.id}.jsonl`));
        writeFileSync(spec.sessionFile!, JSON.stringify({ type: "session", version: 3, id: spec.id, cwd: spec.config.cwd, timestamp: new Date().toISOString() }) + "\n");
        return { prompt: async () => {
          const active = new Database(join(spec.directory, "threads.sqlite3"), { readonly: true });
          expect(active.query("SELECT count(*) n FROM thread_execution WHERE ended_at IS NULL").get()).toEqual({ n: 1 });
          active.close(); called++;
        }, reply: () => "Only chosen disclosure", dispose() {} };
      } });
    expect(await executor(f.admission, "PRIVATE_REQUEST")).toEqual({ ok: true, value: { reply: "Only chosen disclosure", subjects: ["alice"] } });
    expect(constructed).toBe(true); expect(called).toBe(1); expect(f.releases).toHaveLength(1);
    const directory = join(f.config.sessionsDir, f.admission.rootSessionId);
    expect(readFileSync(join(directory, "threads.sqlite3")).includes(Buffer.from("TRANSIENT_ROOT_SECRET"))).toBe(false);
    const db = new Database(join(directory, "threads.sqlite3"));
    expect(db.query("SELECT outcome FROM thread_execution").get()).toEqual({ outcome: "complete" });
    db.run("UPDATE thread_execution SET ended_at=NULL,outcome=NULL,settlement_seq=NULL");
    db.run("UPDATE thread_work SET status='dispatched'");
    db.close();
    await recoverRootOwners(f.config, f.capacity);
    const recovered = new Database(join(directory, "threads.sqlite3"), { readonly: true });
    expect(recovered.query("SELECT outcome FROM thread_execution").get()).toEqual({ outcome: "cancelled" });
    recovered.close();
    expect(called).toBe(1);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("failed private native construction releases its managed slot and cannot replay", async () => {
  const f = fixture();
  try {
    let creations = 0;
    const executor = createRootExecutor(f.config, { prompt: "PRIVATE_ROOT_POLICY", capacity: f.capacity, report() {},
      factory: async () => { creations++; throw new Error("Native root initialization failed"); } });
    expect((await executor(f.admission, "Private request")).ok).toBe(false);
    expect(f.releases).toHaveLength(1);
    expect((await executor(f.admission, "Private request")).ok).toBe(false);
    expect(creations).toBe(1);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

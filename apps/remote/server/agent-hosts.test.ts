import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { OrchestratorClient, type OrchestratorObserver } from "pi-orchestrator/api";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentHost } from "./agent-hosts";

const roots: string[] = [];
afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

function fixture(): { ledgerPath: string; runsRoot: string } {
  const root = mkdtempSync(join(tmpdir(), "pi-remote-agent-hosts-"));
  roots.push(root);
  const ledgerPath = join(root, "ledger.sqlite3");
  const runsRoot = join(root, "runs");
  mkdirSync(runsRoot, { recursive: true });
  // The package owns schema creation. The fixture only supplies facts.
  new OrchestratorClient({ ledgerPath, runsRoot }).close();
  const database = new Database(ledgerPath, { strict: true });
  const insert = database.query(`INSERT INTO run
    (id,task_id,tier,account_id,state,started_at,provider,model,thinking)
    VALUES(?,?,?,?,?,?,?,?,?)`);
  insert.run("live", "repair-lane", "standard", "openai-codex", "running", 1000, "openai-codex", "gpt-5.6-sol", "high");
  insert.run("quiet", "slack-lane", "light", "openai-codex", "running", 900, "openai-codex", "gpt-5.6-luna", null);
  insert.run("settled", "slack-lane", "light", "openai-codex", "done", 700, "openai-codex", "gpt-5.6-luna", null);
  database.query("UPDATE run SET ended_at=800 WHERE id='settled'").run();
  database.close();
  return { ledgerPath, runsRoot };
}

function writeEvents(runsRoot: string, runId: string, events: unknown[]) {
  mkdirSync(join(runsRoot, runId), { recursive: true });
  for (const event of events) appendFileSync(join(runsRoot, runId, "events.jsonl"), `${JSON.stringify(event)}\n`);
}

function event(seq: number, text: string) {
  return { seq, time: "2026-08-21T00:00:00.000Z", type: "assistant", payload: { text } };
}

function host(observer: OrchestratorObserver, key = "local", options = {}) {
  return new AgentHost(observer, {
    key,
    label: key.toUpperCase(),
    name: key === "work" ? "Cloud" : "This machine",
    ...options,
  });
}

function local(ledgerPath: string, runsRoot: string): OrchestratorClient {
  return new OrchestratorClient({ ledgerPath, runsRoot });
}

test("a host lists working agents from the orchestrator read model", async () => {
  const { ledgerPath, runsRoot } = fixture();
  writeEvents(runsRoot, "live", [event(1, "claiming a unit")]);
  const reader = host(local(ledgerPath, runsRoot));
  const snapshot = await reader.runs();

  expect(snapshot.error).toBeNull();
  expect(snapshot.running).toBe(2);
  expect(snapshot.runs.map((run) => run.id)).toEqual(["local:live", "local:quiet"]);
  expect(snapshot.runs[0]).toMatchObject({ taskId: "repair-lane", status: "running", observable: true, thinking: "high" });
  expect(snapshot.runs[1]!.observable).toBe(false);
  expect(snapshot.models).toEqual([
    { model: "gpt-5.6-luna", count: 1 },
    { model: "gpt-5.6-sol", count: 1 },
  ]);
  reader.close();
});

test("an unreachable host reports its error instead of claiming no agents", async () => {
  const failing: OrchestratorObserver = {
    listRuns: async () => { throw new Error("cloud-host did not answer within 10s"); },
    tailRun: async () => { throw new Error("unreachable"); },
    close: () => {},
  };
  const snapshot = await host(failing, "work").runs();
  expect(snapshot.running).toBe(0);
  expect(snapshot.error).toBe("cloud-host did not answer within 10s");
});

test("a transcript streams incrementally and asks its owner for a live tail", async () => {
  const { ledgerPath, runsRoot } = fixture();
  writeEvents(runsRoot, "live", [event(1, "first"), event(2, "second")]);
  writeFileSync(join(runsRoot, "live", "live.json"), JSON.stringify({ activity: "THINKING", liveText: "partial", liveThinking: "weighing" }));
  const reader = host(local(ledgerPath, runsRoot));

  const first = await reader.events("live", 0);
  expect(first.run).toMatchObject({ id: "local:live", activity: "THINKING" });
  expect(first.events.map((entry) => entry.seq)).toEqual([1, 2]);
  expect(first.liveText).toBe("partial");
  expect(first.liveThinking).toBe("weighing");
  expect(Date.now() - statSync(join(runsRoot, "live", "watch")).mtimeMs).toBeLessThan(5_000);

  appendFileSync(join(runsRoot, "live", "events.jsonl"), `${JSON.stringify(event(3, "third"))}\n`);
  expect((await reader.events("live", 2)).events.map((entry) => entry.seq)).toEqual([3]);
  expect((await reader.events("live", 3)).events).toEqual([]);
  reader.close();
});

test("a settled run stays addressable and stops publishing a live tail", async () => {
  const { ledgerPath, runsRoot } = fixture();
  writeEvents(runsRoot, "settled", [event(1, "done")]);
  writeFileSync(join(runsRoot, "settled", "live.json"), JSON.stringify({ activity: "WORKING", liveText: "stale" }));
  const reader = host(local(ledgerPath, runsRoot));

  const settled = await reader.events("settled", 0);
  expect(settled.run).toMatchObject({ id: "local:settled", status: "done", activity: "IDLE" });
  expect(settled.liveText).toBe("");
  expect(existsSync(join(runsRoot, "settled", "watch"))).toBe(false);
  expect((await reader.events("missing", 0)).run).toBeNull();
  reader.close();
});

test("a long or rotated transcript is read from a complete-line tail", async () => {
  const { ledgerPath, runsRoot } = fixture();
  writeEvents(runsRoot, "live", Array.from({ length: 200 }, (_, index) => event(index + 1, `line ${index + 1}`)));
  const reader = host(local(ledgerPath, runsRoot), "work", { maxTailBytes: 400 });
  const first = await reader.events("live", 0);
  expect(first.events.length).toBeGreaterThan(0);
  expect(first.events.at(-1)!.seq).toBe(200);
  expect(first.events.every((entry) => Number.isFinite(entry.seq))).toBe(true);

  writeFileSync(join(runsRoot, "live", "events.jsonl"), `${JSON.stringify(event(999, "after rotation"))}\n`);
  const rotated = await reader.events("live", 0);
  expect(rotated.events.map((entry) => entry.text)).toEqual(["after rotation"]);
  reader.close();
});

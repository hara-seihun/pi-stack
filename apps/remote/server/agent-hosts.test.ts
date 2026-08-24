import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentHost, LocalLedger, REMOTE_SCRIPT, RemoteLedger, type RemoteRunner } from "./agent-hosts";
import { loadProviderManifest } from "./provider-manifest";

const MANIFEST = loadProviderManifest();
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
  const database = new Database(ledgerPath, { create: true, strict: true });
  database.exec(`
    CREATE TABLE run(id TEXT PRIMARY KEY,task_id TEXT NOT NULL,tier TEXT,account_id TEXT,state TEXT NOT NULL,
      started_at INTEGER NOT NULL DEFAULT 0,ended_at INTEGER,detail TEXT,productive INTEGER,complete INTEGER,
      provider TEXT,model TEXT,thinking TEXT);
    INSERT INTO run(id,task_id,state,started_at,provider,model,thinking)
      VALUES('live','repair-lane','running',1000,'openai-codex-3','openai-codex/gpt-5.6-sol','high');
    INSERT INTO run(id,task_id,state,started_at,model)
      VALUES('quiet','slack-lane','running',900,'openai-codex/gpt-5.6-luna');
    INSERT INTO run(id,task_id,state,started_at,ended_at,model,detail,productive)
      VALUES('settled','slack-lane','done',700,800,'openai-codex/gpt-5.6-luna','task complete',1);
  `);
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

// The remote ledger's whole implementation is the script it feeds to the agent
// host's python3. Running that exact script here, without SSH in the way, is
// what proves the remote reader and the local reader agree.
function pythonRunner(): RemoteRunner {
  return async (args) => {
    const proc = Bun.spawn(["python3", "-", ...args], { stdin: Buffer.from(REMOTE_SCRIPT), stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited,
    ]);
    if (code !== 0) throw new Error(stderr.trim() || `python exited ${code}`);
    return stdout;
  };
}

function host(ledger: LocalLedger | RemoteLedger, key = "local", options = {}) {
  return new AgentHost(ledger, {
    key, label: key.toUpperCase(), name: key === "work" ? "Cloud" : "This machine",
    manifest: MANIFEST, ...options,
  });
}

test("a host lists only its working agents, with model counts for the whole ledger", async () => {
  const { ledgerPath, runsRoot } = fixture();
  writeEvents(runsRoot, "live", [event(1, "claiming a unit")]);
  const snapshot = await host(new LocalLedger(ledgerPath, runsRoot)).runs();

  expect(snapshot.error).toBeNull();
  expect(snapshot.running).toBe(2);
  expect(snapshot.runs.map((run) => run.id)).toEqual(["local:live", "local:quiet"]);
  expect(snapshot.runs[0]).toMatchObject({ taskId: "repair-lane", status: "running", observable: true, thinking: "high" });
  // A run whose host has not written a transcript is listed and marked as such.
  expect(snapshot.runs[1]!.observable).toBe(false);
  expect(snapshot.models).toEqual([
    { model: "openai-codex/gpt-5.6-luna", count: 1 },
    { model: "openai-codex/gpt-5.6-sol", count: 1 },
  ]);
});

test("an unreachable host reports its error instead of claiming no agents", async () => {
  const failing = host(new RemoteLedger("/nowhere/ledger.sqlite3", "/nowhere/runs", async () => {
    throw new Error("cloud-host did not answer within 10s");
  }), "work");
  const snapshot = await failing.runs();
  expect(snapshot.running).toBe(0);
  expect(snapshot.error).toBe("cloud-host did not answer within 10s");
});

test("a transcript streams incrementally and asks its owner for a live tail", async () => {
  const { ledgerPath, runsRoot } = fixture();
  writeEvents(runsRoot, "live", [event(1, "first"), event(2, "second")]);
  writeFileSync(join(runsRoot, "live", "live.json"), JSON.stringify({ activity: "THINKING", liveText: "partial", liveThinking: "weighing" }));
  const reader = host(new LocalLedger(ledgerPath, runsRoot));

  const first = await reader.events("live", 0);
  expect(first.run).toMatchObject({ id: "local:live", activity: "THINKING" });
  expect(first.events.map((entry) => entry.seq)).toEqual([1, 2]);
  expect(first.liveText).toBe("partial");
  expect(first.liveThinking).toBe("weighing");
  expect(Date.now() - statSync(join(runsRoot, "live", "watch")).mtimeMs).toBeLessThan(5_000);

  appendFileSync(join(runsRoot, "live", "events.jsonl"), `${JSON.stringify(event(3, "third"))}\n`);
  expect((await reader.events("live", 2)).events.map((entry) => entry.seq)).toEqual([3]);
  expect((await reader.events("live", 3)).events).toEqual([]);
});

test("a settled run stays addressable and stops publishing a live tail", async () => {
  const { ledgerPath, runsRoot } = fixture();
  writeEvents(runsRoot, "settled", [event(1, "done")]);
  writeFileSync(join(runsRoot, "settled", "live.json"), JSON.stringify({ activity: "WORKING", liveText: "stale" }));
  const reader = host(new LocalLedger(ledgerPath, runsRoot));

  const settled = await reader.events("settled", 0);
  expect(settled.run).toMatchObject({ id: "local:settled", status: "done", activity: "IDLE", summary: "task complete" });
  expect(settled.liveText).toBe("");
  expect(existsSync(join(runsRoot, "settled", "watch"))).toBe(false);
  expect((await reader.events("missing", 0)).run).toBeNull();
});

test("the remote host reads exactly what the local reader reads", async () => {
  const { ledgerPath, runsRoot } = fixture();
  writeEvents(runsRoot, "live", [event(1, "first"), event(2, "second")]);
  writeFileSync(join(runsRoot, "live", "live.json"), JSON.stringify({ activity: "WORKING", liveText: "partial", liveThinking: "" }));
  const remote = host(new RemoteLedger(ledgerPath, runsRoot, pythonRunner()), "work");
  const local = host(new LocalLedger(ledgerPath, runsRoot), "work");

  const remoteRuns = await remote.runs();
  const localRuns = await local.runs();
  // Elapsed time is measured when each listing is taken, so it is the one field
  // two readings of the same ledger are expected to disagree about.
  const comparable = (runs: typeof localRuns.runs) => runs.map(({ elapsedMs, ...rest }) => rest);
  expect(comparable(remoteRuns.runs)).toEqual(comparable(localRuns.runs));
  expect(remoteRuns.running).toBe(localRuns.running);
  expect(remoteRuns.models).toEqual(localRuns.models);

  const first = await remote.events("live", 0);
  expect(first.events.map((entry) => entry.text)).toEqual(["first", "second"]);
  expect(first.liveText).toBe("partial");
  expect(first.run).toMatchObject({ id: "work:live", hostName: "Cloud" });
  expect(Date.now() - statSync(join(runsRoot, "live", "watch")).mtimeMs).toBeLessThan(5_000);

  appendFileSync(join(runsRoot, "live", "events.jsonl"), `${JSON.stringify(event(3, "third"))}\n`);
  expect((await remote.events("live", 2)).events.map((entry) => entry.text)).toEqual(["third"]);
  expect((await remote.events("missing", 0)).run).toBeNull();
});

// A transcript that has been running for hours must not be shipped whole to
// open it, and a poll must never re-send what the reader already has.
test("both readers join a long transcript at its tail, on line boundaries", async () => {
  const { ledgerPath, runsRoot } = fixture();
  writeEvents(runsRoot, "live", Array.from({ length: 200 }, (_, index) => event(index + 1, `line ${index + 1}`)));
  const readers = [
    host(new LocalLedger(ledgerPath, runsRoot), "work", { maxTailBytes: 400 }),
    host(new RemoteLedger(ledgerPath, runsRoot, pythonRunner()), "work", { maxTailBytes: 400 }),
  ];
  for (const reader of readers) {
    const first = await reader.events("live", 0);
    // Every delivered event parsed, so no chunk began or ended mid-line.
    expect(first.events.length).toBeGreaterThan(0);
    expect(first.events.at(-1)!.seq).toBe(200);
    expect(first.events.every((entry) => Number.isFinite(entry.seq))).toBe(true);
    const seen = first.events.at(-1)!.seq;
    expect((await reader.events("live", seen)).events).toEqual([]);

    appendFileSync(join(runsRoot, "live", "events.jsonl"), `${JSON.stringify(event(201, "after"))}\n`);
    expect((await reader.events("live", seen)).events.map((entry) => entry.seq)).toEqual([201]);
    rmSync(join(runsRoot, "live", "events.jsonl"));
    writeEvents(runsRoot, "live", Array.from({ length: 200 }, (_, index) => event(index + 1, `line ${index + 1}`)));
  }
});

// A truncated transcript is a new file, not a continuation of the old cursor.
test("a rotated transcript restarts the reader instead of stalling it", async () => {
  const { ledgerPath, runsRoot } = fixture();
  writeEvents(runsRoot, "live", [event(1, "before"), event(2, "before")]);
  const reader = host(new LocalLedger(ledgerPath, runsRoot));
  expect((await reader.events("live", 0)).events.length).toBe(2);

  writeFileSync(join(runsRoot, "live", "events.jsonl"), `${JSON.stringify(event(9, "after rotation"))}\n`);
  const rotated = await reader.events("live", 0);
  expect(rotated.events.map((entry) => entry.text)).toEqual(["after rotation"]);
});

import { afterEach, beforeEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { ensureSupervisorSchema } from "./database";
import { CapturedTranscriptSource } from "./captured-transcript-source";
import { ThreadTranscriptSource } from "./thread-transcript-source";
import { SourceTranscripts } from "./source-transcripts";
import { messageFinalizationKey } from "./sync";
import type { ToolProgress } from "./tool-progress";
import { ClientStream } from "./stream";

let db: Database;
beforeEach(() => { db = new Database(":memory:"); ensureSupervisorSchema(db); db.query("INSERT INTO thread_views(id) VALUES('s')").run(); });
afterEach(() => db.close());
const value = (result: any): any => { if (!result.ok) throw new Error(JSON.stringify(result.error)); return result.value; };
function capture(messages: any[]) {
  db.query("INSERT OR REPLACE INTO session_contexts VALUES('s',1,?)").run(JSON.stringify({ systemPrompt: "", tools: [], messages }));
}
function pipeline(progress: Map<string, ToolProgress>, inspect: any = async () => { throw new Error("A captured source must not inspect native history"); }, reactions: any = () => []) {
  const captured = new CapturedTranscriptSource(db, () => [], () => ({ ok: false, error: { code: "missing", message: "No receipts" } }));
  const source = new ThreadTranscriptSource(db, captured, inspect, () => progress, reactions);
  return { source, items: new SourceTranscripts(db, source.read, source.project, (id, hash) => `/image/${id}/${hash}`) };
}
const tool = (id: string): ToolProgress => ({ id, name: "bash", args: { command: "work" }, startedAt: 2, output: "Partial output" });

test("an unstarted source produces a real empty transcript and acknowledges the selected fresh thread", async () => {
  const { items } = pipeline(new Map(), async () => ({ ok: true, value: { contextWindow: {
    source: { kind: "unstarted", context: "native-history", path: "/sessions/s.jsonl", generation: "fresh", revision: "fresh", size: 0, leafId: null },
    total: 0, records: [], knownToolCallIds: [],
  } } }));
  const events: any[] = [];
  const stream = new ClientStream({ write: chunk => events.push(JSON.parse(chunk.split("data: ")[1])), close() {} });
  stream.declare({ session: "s", viewing: true, selectionId: "opening" });
  await stream.synchronizeSelection(async () => {}, async () => {
    stream.publish({ type: "transcript", ...value(await items.page("s", undefined, 60)) });
    stream.publish({ type: "live", sessionId: "s", text: "" });
    stream.publish({ type: "state", sessions: [], archivedTotal: 0, ownerErrors: [] });
  });
  expect(events[0]).toMatchObject({ type: "reconcile", resource: "transcript:s", kind: "full", value: { total: 0, items: [], generation: "fresh" } });
  expect(events.at(-1)).toMatchObject({ type: "selection-ready", sessionId: "s", selectionId: "opening" });
  expect(Object.keys(events.at(-1).have).sort()).toEqual(["live:s", "state", "transcript:s"]);
});

test("a native source failure remains a failed selection, never an empty acknowledged transcript", async () => {
  const failure = { ok: false as const, error: { code: "unavailable", message: "Required native history is missing" } };
  const { items } = pipeline(new Map(), async () => failure);
  expect(await items.page("s", undefined, 60)).toEqual(failure);
  const events: any[] = [];
  const stream = new ClientStream({ write: chunk => events.push(JSON.parse(chunk.split("data: ")[1])), close() {} });
  stream.declare({ session: "s", viewing: true, selectionId: "opening" });
  await stream.synchronizeSelection(async () => {}, async () => {
    stream.publish({ type: "transcript", ...value(await items.page("s", undefined, 60)) });
  });
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({ type: "error" });
  expect(events[0].message).toContain("Required native history is missing");
});

test("new tools appear before a capture and their body is source-owned until canonical replacement", async () => {
  capture([{ role: "user", timestamp: 1, content: "Run it" }]);
  const progress = new Map([["call", tool("call")]]);
  const { items } = pipeline(progress);
  const page = value(await items.page("s", undefined, 1));
  expect(page.total).toBe(3);
  expect(page.items).toHaveLength(1);
  expect(page.items[0]).toMatchObject({ seq: 2, kind: "toolCall", callId: "call", partialOutput: "Partial output" });
  expect(JSON.parse(value(await items.body("s", page.items[0].id)))).toEqual({ kind: "toolCall", arguments: { command: "work" }, result: null });
  expect(value(await items.page("s", 1, 1)).items[0]).toMatchObject({ seq: 0, kind: "system" });
});

test("canonical calls stay paired and original finalization joins survive partial-output overlays", async () => {
  const message = { role: "assistant", timestamp: 2, content: [{ type: "thinking", thinking: "" }, { type: "toolCall", id: "call", name: "bash", arguments: { command: "work" } }] };
  capture([{ role: "user", timestamp: 1, content: "Run it" }, message]);
  db.query("INSERT INTO message_facts(session_id,finalizes_message,thinking,metrics) VALUES('s',?,?,?)")
    .run(messageFinalizationKey(message), "Restored thought", JSON.stringify({ ttftMs: 10, generationMs: 100, outputTokens: 10, tokensPerSecond: 100 }));
  const progress = new Map([["call", tool("call")]]);
  const { items } = pipeline(progress);
  const page = value(await items.page("s", undefined, 60));
  expect(page.total).toBe(4);
  expect(page.items.map((item: any) => item.kind)).toEqual(["system", "user", "thinking", "toolCall"]);
  expect(page.items.at(-1)).toMatchObject({ responseMetrics: { ttftMs: 10 }, partialOutput: "Partial output" });
  expect(JSON.parse(value(await items.body("s", page.items[2].id))).text).toBe("Restored thought");
});

test("result metadata clears completed live tools even when an older page is requested", async () => {
  capture([{ role: "user", timestamp: 1, content: "Run it" }, { role: "assistant", timestamp: 2, content: [{ type: "toolCall", id: "call", name: "bash", arguments: {} }] },
    { role: "toolResult", timestamp: 3, toolCallId: "call", content: "Result" }]);
  const progress = new Map([["call", tool("call")]]);
  const { items } = pipeline(progress);
  const page = value(await items.page("s", 1, 1));
  expect(page.total).toBe(3);
  expect(progress.size).toBe(0);
});

test("native reads request only item windows and bounded tool-presence metadata", async () => {
  const calls: any[] = [];
  const progress = new Map([["call", tool("call")]]);
  const inspect = async (id: string, options: any) => {
    calls.push([id, options]);
    return { ok: true, value: { contextWindow: { source: { revision: "r", generation: "g", context: "native-history" }, total: 1,
      records: [{ seq: 0, count: 1, entryId: "system", message: { role: "system", content: "" }, results: [] }], knownToolCallIds: [] } } };
  };
  const { items } = pipeline(progress, inspect);
  expect(value(await items.page("s", undefined, 60)).items.map((item: any) => item.kind)).toEqual(["system", "toolCall"]);
  expect(calls).toEqual([["s", { contextWindow: { limit: 60, toolCallIds: ["call"] } }]]);
});

test("identities and reactions are attached per hydrated message", async () => {
  capture([{ role: "user", timestamp: 1, content: "Hello", identity: { id: "pi/s/one", sender: { id: "person", name: "Person" } } }]);
  const { items } = pipeline(new Map(), undefined, (id: string) => { expect(id).toBe("pi/s/one"); return [{ emoji: "👍", sender: { id: "person" }, timestamp: 1 }]; });
  expect(value(await items.page("s", undefined, 60)).items[1]).toMatchObject({ identity: { id: "pi/s/one" }, reactions: [{ emoji: "👍" }] });
});

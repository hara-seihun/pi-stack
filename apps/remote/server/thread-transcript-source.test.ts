import { afterEach, beforeEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { ensureSupervisorSchema } from "./database";
import { ThreadTranscriptSource } from "./thread-transcript-source";
import { SourceTranscripts } from "./source-transcripts";
import type { ToolProgress } from "./tool-progress";
import { ClientStream } from "./stream";

let db: Database;
beforeEach(() => { db = new Database(":memory:"); ensureSupervisorSchema(db); db.query("INSERT INTO thread_views(id) VALUES('s')").run(); });
afterEach(() => db.close());
const value = (result: any): any => { if (!result.ok) throw new Error(JSON.stringify(result.error)); return result.value; };
function pipeline(progress: Map<string, ToolProgress>, inspect: any, reactions: any = () => []) {
  const source = new ThreadTranscriptSource(db, inspect, () => progress, reactions);
  return { source, items: new SourceTranscripts(db, source.read, source.project, (id, hash) => `/image/${id}/${hash}`) };
}
const source = (records: any[], total: number, knownToolCallIds: string[] = [], completedToolCallIds: string[] = []) => async () => ({ ok: true,
  value: { contextWindow: { source: { kind: "native-jsonl", context: "native-history", generation: "g", revision: "r" }, total,
    records, knownToolCallIds, completedToolCallIds } } });
const tool = (id: string): ToolProgress => ({ id, name: "bash", args: { command: "work" }, startedAt: 2, output: "Partial output" });

test("fresh empty native history acknowledges selection; missing required history remains a failed selection", async () => {
  for (const valid of [true, false]) {
    const { items } = pipeline(new Map(), valid ? source([], 0) : async () => ({ ok: false, error: { code: "unavailable", message: "Required native history is missing" } }));
    const events: any[] = [];
    const stream = new ClientStream({ write: chunk => events.push(JSON.parse(chunk.split("data: ")[1])), close() {} });
    stream.declare({ session: "s", viewing: true, selectionId: "opening" });
    await stream.synchronizeSelection(async () => {}, async () => {
      stream.publish({ type: "transcript", ...value(await items.page("s", undefined, 60)) });
      stream.publish({ type: "live", sessionId: "s", text: "" });
      stream.publish({ type: "state", sessions: [], archivedTotal: 0, ownerErrors: [] });
    });
    if (valid) expect(events.at(-1)).toMatchObject({ type: "selection-ready", sessionId: "s", selectionId: "opening" });
    else { expect(events).toHaveLength(1); expect(events[0]).toMatchObject({ type: "error" }); expect(events[0].message).toContain("Required native history is missing"); }
  }
});

test("native thinking/tool bodies and exact identities hydrate per record, never a captured document", async () => {
  const message = { role: "assistant", timestamp: 2, content: [{ type: "thinking", thinking: "Native thought" },
    { type: "toolCall", id: "call", name: "bash", arguments: { command: "work" } }], identity: { id: "pi/s/reply", timestamp: 2, sender: { id: "assistant", name: "Kenan" } } };
  const progress = new Map([["call", tool("call")]]);
  const { items } = pipeline(progress, source([{ seq: 0, count: 2, entryId: "reply", message, results: [] }], 2, ["call"]),
    (id: string) => { expect(id).toBe("pi/s/reply"); return [{ emoji: "👍", sender: { id: "person" }, timestamp: 1 }]; });
  const page = value(await items.page("s", undefined, 60));
  expect(page.items.map((item: any) => item.kind)).toEqual(["thinking", "toolCall"]);
  expect(page.items[1]).toMatchObject({ partialOutput: "Partial output" });
  expect(JSON.parse(value(await items.body("s", page.items[0].id))).text).toBe("Native thought");
});

test("completed tool metadata clears disposable cards even when its native result is outside the requested page", async () => {
  const progress = new Map([["call", tool("call")]]);
  const calls: any[] = [];
  const { items } = pipeline(progress, async (id: string, options: any) => {
    calls.push([id, options]); return source([], 3, ["call"], ["call"])();
  });
  expect(value(await items.page("s", 1, 1)).total).toBe(3);
  expect(progress.size).toBe(0);
  expect(calls).toEqual([["s", { contextWindow: { before: 1, limit: 1, toolCallIds: ["call"] } }]]);
});

test("new tools are bounded live records until native message persistence", async () => {
  const progress = new Map([["call", tool("call")]]);
  const { items } = pipeline(progress, source([], 0));
  const page = value(await items.page("s", undefined, 1));
  expect(page.items[0]).toMatchObject({ seq: 0, kind: "toolCall", callId: "call" });
  expect(JSON.parse(value(await items.body("s", page.items[0].id)))).toEqual({ kind: "toolCall", arguments: { command: "work" }, result: null });
  for (let index = 0; index < 64; index++) progress.set(`extra${index}`, tool(`extra${index}`));
  expect(await items.page("s", undefined, 1)).toMatchObject({ ok: false, error: { code: "oversized" } });
});

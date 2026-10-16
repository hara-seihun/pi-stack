import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { indexedThreadHistory } from "../../../packages/orchestrator/src/threads/history.mjs";
import { SourceTranscripts } from "../server/source-transcripts";
import { displayContextMessage } from "../server/context-display";
import { entriesFromHeads } from "./src/features/conversation/transcript-entries";
import { capturedPromptIds, reconcilePromptEntries } from "./src/features/conversation/optimistic-prompts";
import { buildStableTranscript } from "./src/features/conversation/transcript-model";
import type { PromptOutboxEntry } from "./src/prompt-outbox";
import { ThreadService } from "../../../packages/orchestrator/src/threads/service";
import { ThreadTranscriptSource } from "../server/thread-transcript-source";

const content = [
  { type: "text", text: JSON.stringify({ workId: "machine-before", inputOrigin: "machine", message: "Background notice" }) },
  { type: "text", text: JSON.stringify({ workId: "human-test", inputOrigin: "human", message: "Test, can you see this" }) },
  { type: "image", mimeType: "image/png", data: "image-custody" },
  { type: "text", text: JSON.stringify({ workId: "human-identical", inputOrigin: "human", message: "Test, can you see this" }) },
];

test("native batch humans keep durable entry/block sequence before their reply and consume only exact optimistic receipt IDs", async () => {
  const root = mkdtempSync(join(tmpdir(), "native-batch-order-")), path = join(root, "native.jsonl");
  const records = [
    { type: "session", id: "session", timestamp: "2026-10-11T06:00:00Z" },
    { type: "custom_message", id: "batch-native-id", parentId: null, customType: "thread_input_batch", timestamp: "2026-10-11T06:04:24.894Z",
      content, display: true, details: { batchId: "BATCH-exact", workIds: ["machine-before", "human-test", "human-identical"] } },
    // Deliberately backwards clock: chronology is native custody order, not timestamp or delivery metadata.
    { type: "message", id: "reply-native-id", parentId: "batch-native-id", message: { role: "assistant", timestamp: 1, content: [{ type: "text", text: "Yes, loud and clear." }] } },
  ];
  writeFileSync(path, records.map(record => JSON.stringify(record)).join("\n") + "\n");
  const bytes = readFileSync(path);
  const db = new Database(":memory:");
  try {
    const history = indexedThreadHistory(path, undefined, { managerWakeVisibility: true });
    if (!history.ok) throw new Error(history.error.message);
    expect(history.value.messages.map(record => [record.id, record.displayedItemCount])).toEqual([["batch-native-id", 3], ["reply-native-id", 1]]);
    let seq = 0;
    const source = history.value.messages.map(descriptor => {
      const read = history.value.read(descriptor); if (!read.ok) throw new Error(read.error.message);
      const entry = read.value, message = entry.type === "message" ? entry.message : { role: "custom", customType: entry.customType,
        content: entry.content, details: entry.details, timestamp: Date.parse(entry.timestamp) };
      const record = { seq, count: descriptor.displayedItemCount, entryId: descriptor.id, message, results: [] };
      seq += record.count; return record;
    });
    const transcripts = new SourceTranscripts(db, async () => ({ ok: true, value: { source: { generation: "native-generation", revision: "native-revision", context: "native-history" }, total: seq, records: source } }),
      (_id, message, image) => displayContextMessage(message, image), (_id, hash) => `/image/${hash}`);
    const page = await transcripts.page("thread", undefined, 4); if (!page.ok) throw new Error(page.error.message);
    expect(page.value.items.map(head => [head.seq, head.sourceKey, head.kind])).toEqual([
      [0, "batch-native-id:0", "user"], [1, "batch-native-id:1", "user"], [2, "batch-native-id:2", "user"], [3, "reply-native-id:0", "assistant"],
    ]);
    const prompts = ["human-test", "human-identical"].map(requestId => ({ requestId, bodyJson: JSON.stringify({ text: "Test, can you see this" }), createdAt: 9999999999999,
      outcome: { kind: "accepted", workId: requestId } } as PromptOutboxEntry));
    const entries = entriesFromHeads(page.value.items);
    expect(capturedPromptIds(entries, prompts)).toEqual(["human-test", "human-identical"]);
    const reconciled = reconcilePromptEntries(entries, prompts, new Set());
    expect(reconciled).toHaveLength(4);
    const visible = buildStableTranscript([...reconciled].reverse(), true).filter(item => item.kind !== "work");
    expect(visible.map(item => item.entry.inputId ?? item.entry.text)).toEqual(["human-test", "human-identical", "Yes, loud and clear."]);
    const middle = await transcripts.page("thread", 2, 1); if (!middle.ok) throw new Error(middle.error.message);
    expect(middle.value.items.map(head => head.sourceKey)).toEqual(["batch-native-id:1"]);
    expect(readFileSync(path)).toEqual(bytes);
  } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
});

test("canonical owner window preserves batch timestamp and exact receipt state through the Remote adapter", async () => {
  const root = mkdtempSync(join(tmpdir(), "owner-batch-order-")), db = new Database(":memory:");
  const service = new ThreadService({ capacity: { mode: "unmanaged" }, databasePath: join(root, "threads.sqlite3"), sessionsDir: root,
    openSession: async () => { throw new Error("Ordering proof does not start models"); } });
  try {
    expect((await service.spawn({ requestId: "create", id: "thread", title: "Ordering proof", cwd: root })).ok).toBe(true);
    expect((await service.send({ requestId: "human-test", threadId: "thread", text: "Test, can you see this", humanActivity: true })).ok).toBe(true);
    writeFileSync(join(root, "thread.jsonl"), [
      { type: "session", id: "native-session", timestamp: "2026-10-11T06:00:00Z" },
      { type: "custom_message", id: "native-batch", parentId: null, customType: "thread_input_batch", timestamp: "2026-10-11T06:04:24.894Z",
        content: [content[1]], details: { workIds: ["human-test"], batchId: "BATCH-proof" }, display: true },
      { type: "message", id: "native-reply", parentId: "native-batch", message: { role: "assistant", timestamp: 1, content: [{ type: "text", text: "Yes" }] } },
    ].map(entry => JSON.stringify(entry)).join("\n") + "\n");
    db.exec("CREATE TABLE message_facts(session_id TEXT,finalizes_message TEXT,metrics TEXT)");
    const source = new ThreadTranscriptSource(db, service.inspect.bind(service), () => undefined, () => []);
    const transcripts = new SourceTranscripts(db, source.read, source.project, (_id, hash) => `/image/${hash}`);
    const page = await transcripts.page("thread", undefined, 5); if (!page.ok) throw new Error(page.error.message);
    expect(page.value.items.map(head => head.sourceKey)).toEqual(["native-batch:0", "native-reply:0"]);
    expect(page.value.items[0]).toMatchObject({ kind: "user", inputId: "human-test", inputOrigin: "human", timestamp: 1791698664894,
      inputState: { id: "human-test", state: "queued" } });
    expect(page.value.items[1]).toMatchObject({ kind: "assistant", seq: 1, timestamp: 1 });
  } finally { await service.close(); db.close(); rmSync(root, { recursive: true, force: true }); }
});

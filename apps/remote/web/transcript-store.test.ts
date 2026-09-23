import { expect, test } from "bun:test";
import type { TranscriptItemHead } from "../server/protocol";
import { applyTranscriptEvent, hasEarlier, loadEarlier, mergeHeads, transcriptCursor } from "./src/features/conversation/transcript-store";
import { entriesFromHeads, entryFromHead } from "./src/features/conversation/transcript-entries";

const user = (seq: number, text = `message ${seq}`): TranscriptItemHead => ({ seq, id: `u${seq}`, kind: "user", size: text.length, timestamp: 1_000 + seq, text });
const call = (seq: number, patch: Partial<Extract<TranscriptItemHead, { kind: "toolCall" }>> = {}): TranscriptItemHead => ({
  seq, id: `t${seq}`, kind: "toolCall", size: 2_000, timestamp: 2_000 + seq,
  callId: `call-${seq}`, name: "bash", arguments: { command: "pwd" }, argumentsTruncated: false, ...patch,
});

test("a transcript event upserts by seq and keeps the window ordered", () => {
  const first = applyTranscriptEvent(null, { generation: "g1", total: 2, reset: true, items: [user(0), call(1)] });
  expect(first.items.map(item => item.seq)).toEqual([0, 1]);

  const landed = applyTranscriptEvent(first, {
    generation: "g1", total: 3, reset: false,
    items: [call(1, { result: { isError: false, size: 40, preview: "/home/kenan", imageCount: 0, timestamp: 2_500 } }), user(2)],
  });
  expect(landed.items.map(item => item.seq)).toEqual([0, 1, 2]);
  expect(landed.total).toBe(3);
  expect((landed.items[1] as any).result.preview).toBe("/home/kenan");
  expect(transcriptCursor(landed)).toEqual({ generation: "g1", after: 2 });
});

test("a reset, or a new generation, replaces the window instead of merging into it", () => {
  const held = applyTranscriptEvent(null, { generation: "g1", total: 3, reset: true, items: [user(0), user(1), user(2)] });
  const compacted = applyTranscriptEvent(held, { generation: "g2", total: 1, reset: false, items: [user(0, "after compaction")] });
  expect(compacted.generation).toBe("g2");
  expect(compacted.items).toHaveLength(1);
  expect((compacted.items[0] as any).text).toBe("after compaction");

  const replaced = applyTranscriptEvent(compacted, { generation: "g2", total: 1, reset: true, items: [user(0, "replaced")] });
  expect((replaced.items[0] as any).text).toBe("replaced");
});

test("earlier items exist only while the window starts above the first item", () => {
  expect(hasEarlier(null)).toBe(false);
  expect(hasEarlier({ generation: "g", total: 2, items: [user(0), user(1)] })).toBe(false);
  expect(hasEarlier({ generation: "g", total: 9, items: [user(7), user(8)] })).toBe(true);
  expect(transcriptCursor({ generation: "", total: 0, items: [] })).toBeNull();
  expect(mergeHeads([user(3)], [])).toEqual([user(3)]);
});

test("Show earlier pages older heads into the window", async () => {
  const window = { generation: "g1", total: 40, items: [user(38), user(39)] };
  const paths: string[] = [];
  const result = await loadEarlier("thread", window, {
    limit: 2,
    fetcher: async (path) => {
      paths.push(path);
      return new Response(JSON.stringify({ sessionId: "thread", generation: "g1", total: 40, items: [user(36), user(37)] }), { status: 200 });
    },
  });
  expect(paths[0]).toContain("before=38");
  expect(paths[0]).toContain("generation=g1");
  expect(result.reset).toBe(false);
  expect(result.window.items.map(item => item.seq)).toEqual([36, 37, 38, 39]);
});

test("a 409 that carries the newest window uses it without asking again", async () => {
  const window = { generation: "stale", total: 40, items: [user(38), user(39)] };
  let requests = 0;
  const result = await loadEarlier("thread", window, {
    limit: 2,
    fetcher: async () => {
      requests += 1;
      return new Response(JSON.stringify({
        error: "The transcript generation has been replaced", sessionId: "thread",
        generation: "g2", total: 2, items: [user(0), user(1)],
      }), { status: 409 });
    },
  });
  expect(requests).toBe(1);
  expect(result.reset).toBe(true);
  expect(result.window).toEqual({ generation: "g2", total: 2, items: [user(0), user(1)] });
});

test("a 409 without a window takes the generation from the answer and reloads", async () => {
  const window = { generation: "stale", total: 40, items: [user(38), user(39)] };
  const requests: string[] = [];
  const result = await loadEarlier("thread", window, {
    limit: 2,
    fetcher: async (path) => {
      requests.push(path);
      if (requests.length === 1) return new Response(JSON.stringify({ error: "generation moved", generation: "g2" }), { status: 409 });
      return new Response(JSON.stringify({ sessionId: "thread", generation: "g2", total: 2, items: [user(0), user(1)] }), { status: 200 });
    },
  });
  expect(requests[1]).toContain("generation=g2");
  expect(requests[1]).not.toContain("before=");
  expect(result.reset).toBe(true);
  expect(result.window).toEqual({ generation: "g2", total: 2, items: [user(0), user(1)] });
});

test("heads become the entries the transcript renders", () => {
  const entries = entriesFromHeads([
    user(0, "do the thing"),
    { seq: 1, id: "s1", kind: "system", size: 40_000, preview: "You are Pi" },
    { seq: 2, id: "h2", kind: "thinking", size: 900, label: "Thinking", preview: "Consider the file" },
    call(3, { partialOutput: "running…" }),
    { seq: 4, id: "sc4", kind: "tool", size: 1_200, label: "bash", preview: "Run a command" },
  ]);

  expect(entries[0]).toMatchObject({ key: "user:0", signature: "u0", kind: "user", text: "do the thing", messageTimestamp: 1_000, itemId: "u0", bodyLoaded: false });
  expect(entries[1]).toMatchObject({ key: "system:1", kind: "system", preview: "You are Pi", size: 40_000 });
  expect(entries[1].text).toBeUndefined();
  expect(entries[2]).toMatchObject({ kind: "thinking", label: "Thinking", preview: "Consider the file" });
  expect(entries[3]).toMatchObject({
    key: "toolCall:3", kind: "toolCall", time: 2_003,
    toolCall: { id: "call-3", name: "bash", arguments: { command: "pwd" }, partialOutput: "running…" },
  });
  expect(entries[3].toolResult).toBeUndefined();
  expect(entries[4]).toMatchObject({ kind: "tool", label: "bash" });

  const landed = entryFromHead(call(3, { result: { isError: true, size: 90, preview: "boom", imageCount: 1, timestamp: 2_900 } }), true);
  expect(landed.signature).toBe("t3:body");
  expect(landed.toolResult).toMatchObject({ isError: true, preview: "boom", imageCount: 1 });
});

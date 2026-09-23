import { expect, test } from "bun:test";
import type { TranscriptItemHead } from "../server/protocol";
import { applyTranscriptEvent, hasEarlier, loadEarlier } from "./src/features/conversation/transcript-store";

const item = (seq: number, text = String(seq)): TranscriptItemHead => ({ seq, id: text, kind: "user", size: text.length, text });

test("recent snapshots replace corrections while preserving explicitly loaded older heads", () => {
  const held = { generation: "g", total: 100, items: Array.from({ length: 100 }, (_, seq) => item(seq)) };
  const recent = applyTranscriptEvent(held, { generation: "g", total: 101, items: Array.from({ length: 60 }, (_, n) => item(n + 41, n === 0 ? "corrected" : String(n + 41))) });
  expect(recent.items).toHaveLength(101);
  expect(recent.items[40]).toEqual(item(40));
  expect(recent.items[41]).toEqual(item(41, "corrected"));
  expect(hasEarlier(recent)).toBe(false);
  expect(applyTranscriptEvent(recent, { generation: "next", total: 0, items: [] }).items).toEqual([]);
  expect(applyTranscriptEvent(recent, { generation: "g", total: 0, items: [] }).items).toEqual([]);
});

test("paging loads older heads and a generation change replaces them", async () => {
  const window = { generation: "g", total: 100, items: [item(60), item(61)] };
  const result = await loadEarlier("thread", window, { fetcher: async () => new Response(JSON.stringify({ sessionId: "thread", generation: "g", total: 100, items: [item(59)] })) });
  expect(result.window.items.map(head => head.seq)).toEqual([59, 60, 61]);
  const compacted = await loadEarlier("thread", window, { fetcher: async () => new Response(JSON.stringify({ sessionId: "thread", generation: "next", total: 1, items: [item(0)] }), { status: 409 }) });
  expect(compacted).toMatchObject({ reset: true, window: { generation: "next", total: 1, items: [item(0)] } });
});

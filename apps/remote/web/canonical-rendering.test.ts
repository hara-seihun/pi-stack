import { expect, test } from "bun:test";
import type { TranscriptItemHead } from "../server/protocol";
import { applyTranscriptEvent, loadEarlier, mergeHeads } from "./src/features/conversation/transcript-store";
import { entriesFromHeads, entryFromHead } from "./src/features/conversation/transcript-entries";
import { createLiveText, visibleLiveText } from "./src/features/conversation/live-text";

const head = (seq: number, sourceKey: string, text = "same words", timestamp = seq + 100): TranscriptItemHead =>
  ({ seq, sourceKey, id: "identical-body-hash", size: text.length, kind: "assistant", text, timestamp });

test("append, replay, overlapping pagination and reconnect render each source block once without deduplicating identical text", async () => {
  const a = head(1, "entry-a:0"), b = head(2, "entry-b:0"), c = head(3, "entry-b:1");
  let window = applyTranscriptEvent(null, { generation: "g", total: 4, items: [b, c, c] });
  window = (await loadEarlier("thread", window, { fetcher: async () => new Response(JSON.stringify({ generation: "g", total: 4, items: [a, b] })) })).window;
  for (let i = 0; i < 3; i++) window = applyTranscriptEvent(window, { generation: "g", total: 4, items: [b, c] });
  expect(entriesFromHeads(window.items).map(entry => entry.key)).toEqual(["entry-a:0", "entry-b:0", "entry-b:1"]);
  expect(window.items.map(item => item.id)).toEqual([a.id, a.id, a.id]);
  const restarted = applyTranscriptEvent(null, { generation: "g", total: 4, items: window.items });
  expect(restarted.items).toEqual(window.items);
  expect(applyTranscriptEvent(window, { generation: "fork", total: 1, items: [head(0, "new-entry:0")] }).items).toHaveLength(1);
});

test("native key survives position changes while body/sequence corrections replace exactly one source", () => {
  const first = head(1, "native:0");
  const changed = { ...first, seq: 2, id: "new-body", text: "corrected" };
  expect(mergeHeads([first], [changed])).toEqual([changed]);
  expect(entryFromHead(changed).key).toBe(entryFromHead(first).key);
  expect(entryFromHead(changed).signature).not.toBe(entryFromHead(first).signature);
});

test("final transcript arriving before live clear never renders the same native assistant twice", () => {
  const store = createLiveText();
  const finalized = entriesFromHeads([head(1, "native:0", "final answer", 500)]);
  store.apply({ text: "final answer", messageTimestamp: 500 });
  expect(visibleLiveText(store.snapshot(), []).text).toBe("final answer");
  expect(visibleLiveText(store.snapshot(), finalized).text).toBe("");
  store.apply({ text: "final answer", messageTimestamp: 500 });
  expect(visibleLiveText(store.snapshot(), finalized).text).toBe("");
  store.apply({ text: "final answer", messageTimestamp: 501 });
  expect(visibleLiveText(store.snapshot(), finalized).text).toBe("final answer");
  store.apply({ text: "", messageTimestamp: null });
  expect(visibleLiveText(store.snapshot(), finalized).text).toBe("");
});

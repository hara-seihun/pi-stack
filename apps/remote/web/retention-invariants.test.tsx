import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { TranscriptItemBody, TranscriptItemHead } from "../server/protocol";
import { ClientCache } from "./src/client-cache";
import { ItemBodies } from "./src/features/conversation/item-bodies";
import { appendLiveThinking, buildStableTranscript } from "./src/features/conversation/transcript-model";
import { applyTranscriptEvent, boundTranscriptHeads, hasEarlier, hasNewer, loadEarlier, loadLatest, loadNewer, TRANSCRIPT_HEAD_BUDGET, TRANSCRIPT_HEAD_BYTES } from "./src/features/conversation/transcript-store";
import { transcriptRange, TRANSCRIPT_DOM_BUDGET, VirtualTranscript } from "./src/features/conversation/VirtualTranscript";
import type { ContextEntry } from "./src/types";

const head = (seq: number): TranscriptItemHead => ({ seq, id: `head-${seq}`, kind: "user", size: 3, text: `message ${seq}` });
const page = (from: number, count: number, total = from + count) => ({ generation: "g", total, items: Array.from({ length: count }, (_, n) => head(from + n)) });
const flush = async () => { for (let n = 0; n < 12; n++) await Promise.resolve(); };

test("automatic tail remains bounded through long-open appends; an older displayed head is never evicted", () => {
  let held = applyTranscriptEvent(null, page(0, 60));
  for (let total = 120; total <= 6_000; total += 60) held = applyTranscriptEvent(held, page(total - 60, 60));
  expect(held.items).toHaveLength(TRANSCRIPT_HEAD_BUDGET);
  expect(held.items.at(-1)?.seq).toBe(5_999);
  expect(hasEarlier(held)).toBe(true);
  const protectedHead = held.items[0];
  const frozen = applyTranscriptEvent(held, page(5_940, 120), { from: protectedHead.seq, to: protectedHead.seq + 3 });
  expect(frozen.items).toHaveLength(TRANSCRIPT_HEAD_BUDGET);
  expect(frozen.items[0]).toBe(protectedHead);
  expect(hasNewer(frozen)).toBe(true);
  const stillReading = applyTranscriptEvent(frozen, page(9_940, 60, 10_000));
  expect(stillReading.items.map(item => item.seq)).toEqual(frozen.items.map(item => item.seq));
  expect(stillReading.total).toBe(10_000);
});

test("older and newer paging stay contiguous within the head budget, and Jump latest restores the tail", async () => {
  const held = page(600, 600, 1_200);
  const fetcher = async (path: string) => {
    const query = new URL(path, "https://fixture.test").searchParams;
    const before = Number(query.get("before") ?? 1_200);
    return Response.json({ sessionId: "thread", ...page(before - 60, 60, 1_200) });
  };
  const older = (await loadEarlier("thread", held, { fetcher })).window;
  expect(older.items[0].seq).toBe(540);
  expect(older.items.at(-1)?.seq).toBe(1_139);
  expect(hasNewer(older)).toBe(true);
  const newer = (await loadNewer("thread", older, fetcher)).window;
  expect(newer.items.map(item => item.seq)).toEqual(held.items.map(item => item.seq));
  expect(hasNewer(newer)).toBe(false);
  const latest = await loadLatest("thread", fetcher);
  expect(latest.items).toHaveLength(60);
  expect(latest.items.at(-1)?.seq).toBe(1_199);
});

test("head payloads obey a byte budget; obsolete inline bodies are not a second body cache", () => {
  const large = Array.from({ length: 12 }, (_, seq) => ({ ...head(seq), text: "x".repeat(512 * 1024) }));
  const retained = boundTranscriptHeads(large, "newer");
  expect(JSON.stringify(retained).length * 2).toBeLessThanOrEqual(TRANSCRIPT_HEAD_BYTES);
  expect(retained.at(-1)?.seq).toBe(11);
  const inline: TranscriptItemHead = { seq: 0, id: "thinking", kind: "thinking", size: 100, preview: "thought", body: { kind: "thinking", text: "complete thought" } };
  const changed = applyTranscriptEvent({ generation: "g", total: 1, items: [inline] }, page(1, 1));
  expect(changed.items[0].body).toBeUndefined();
});

test("live thinking reuses settled items and the trailing work array, including same-length revisions", () => {
  const entries: ContextEntry[] = [{ key: "user", signature: "user", kind: "user", text: "hello" }, { key: "tool", signature: "tool", kind: "toolCall", toolCall: { name: "read", arguments: {} }, toolResult: { isError: false } }];
  const stable = buildStableTranscript(entries);
  const first = appendLiveThinking(stable, "abc", true);
  const second = appendLiveThinking(stable, "def", true);
  expect(first[0]).toBe(stable[0]);
  expect(second[0]).toBe(stable[0]);
  if (stable[1].kind !== "work" || first[1].kind !== "work" || second[1].kind !== "work") throw new Error("expected work");
  expect(first[1].entries).toBe(stable[1].entries);
  expect(second[1].entries).toBe(stable[1].entries);
  expect(first[1].latest.signature).not.toBe(second[1].latest.signature);
});

test("virtual windows stay bounded at every scroll offset, including initial and ever-growing tails", () => {
  const offsets = Array.from({ length: 10_001 }, (_, n) => n * 50);
  for (const top of [0, 500, 50_000, 499_500]) {
    const range = transcriptRange(offsets, top, 5_000);
    expect(range.end - range.start).toBeLessThanOrEqual(TRANSCRIPT_DOM_BUDGET);
    expect(range.start * 50).toBeLessThanOrEqual(top);
  }
  for (const count of [61, 600, 10_000]) {
    const html = renderToStaticMarkup(<VirtualTranscript items={Array.from({ length: count }, (_, n) => n)} itemKey={String} render={value => <p>{value}</p>} />);
    expect(html.match(/data-virtual-key=/g)).toHaveLength(TRANSCRIPT_DOM_BUDGET);
  }
});

test("only displayed body leases survive shared-cache eviction; release removes the independent reference", () => {
  const cache = new ClientCache(async () => "retention-test");
  const owner = new ItemBodies("thread", async () => { throw new Error("unexpected fetch"); }, cache);
  const body: TranscriptItemBody = { kind: "thinking", text: "leased body" };
  const release = owner.retain("leased");
  cache.acceptBody("leased", body, 11);
  for (let index = 0; index < 2_001; index++) cache.acceptBody(`other-${index}`, { kind: "thinking", text: `${index}` }, 1);
  expect(owner.get("leased")).toBe(body);
  release(); release();
  expect(owner.get("leased")).toBeUndefined();
  cache.dispose();
});

test("locking fences late body results from the next cache lifetime", async () => {
  const cache = new ClientCache(async () => "retention-test");
  let finish!: (body: TranscriptItemBody) => void;
  const old = cache.loadBody("late", 1, () => new Promise(resolve => { finish = resolve; }));
  await flush();
  cache.dispose();
  finish({ kind: "thinking", text: "late" });
  await old;
  expect(cache.getBody("late")).toBeUndefined();
});

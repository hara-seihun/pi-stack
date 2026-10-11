import { expect, test } from "bun:test";
import type { TranscriptItemHead } from "../server/protocol";
import { applyTranscriptEvent, hasEarlier, type TranscriptWindow } from "./src/features/conversation/transcript-store";
import { conversationCount, conversationHead, loadVisibleEarlier } from "./src/features/conversation/visible-history";
import { entriesFromHeads } from "./src/features/conversation/transcript-entries";
import { buildStableTranscript, messengerWork } from "./src/features/conversation/transcript-model";
import { SILENT_TURN_TEXT } from "pi-orchestrator/manager-turn";

const human = (seq: number): TranscriptItemHead => ({ seq, id: `human${seq}`, kind: "user", inputOrigin: "human", text: `human ${seq}`, size: 10 });
const hidden = (seq: number): TranscriptItemHead => ({ seq, id: `hidden${seq}`, kind: "user", inputOrigin: "machine", text: `wake ${seq}`, monoVisibility: "hidden", size: 10 });
function fixture(items: TranscriptItemHead[], count = 60) {
  const cursors: number[] = [];
  const initial: TranscriptWindow = { generation: "g", total: items.length, items: items.slice(-count) };
  const fetcher = async (path: string) => {
    const before = Number(new URL(path, "https://fixture.test").searchParams.get("before"));
    cursors.push(before);
    return Response.json({ sessionId: "thread", generation: "g", total: items.length, items: items.slice(Math.max(0, before - 60), before) });
  };
  return { initial, fetcher, cursors };
}
const options = (fetcher: (path: string) => Promise<Response>, budget = 60) => ({ mono: true, budget, signal: new AbortController().signal, fetcher, onPage() {} });

test("cold conversation reaches sixty visible messages through more than600 hidden records and retains the raw span", async () => {
  const items = [...Array.from({ length: 60 }, (_, seq) => human(seq)), ...Array.from({ length: 720 }, (_, n) => hidden(n + 60))];
  const f = fixture(items);
  const accepted: TranscriptWindow[] = [];
  const result = await loadVisibleEarlier("thread", f.initial, { ...options(f.fetcher), onPage: window => accepted.push(window) });
  expect(result.ok).toBe(true);
  expect(conversationCount(result.window, true)).toBe(60);
  expect(result.window.items).toEqual(items);
  expect(f.cursors).toEqual(Array.from({ length: 12 }, (_, n) => 720 - n * 60));
  const streamed = applyTranscriptEvent(result.window, { generation: "g", total: 781, items: [...items.slice(-59), hidden(780)] }, null, head => conversationHead(head, true));
  expect(conversationCount(streamed, true)).toBe(60);
  expect(streamed.items.map(head => head.seq)).toEqual(Array.from({ length: 781 }, (_, seq) => seq));
  expect(accepted).toHaveLength(12);
});

test("mixed earlier pages count newly loaded human and meaningful assistant messages, not old messages or disclosures", async () => {
  const items = Array.from({ length: 300 }, (_, seq) => seq % 3 === 0 ? human(seq) : hidden(seq));
  items[147] = { seq: 147, id: "action", kind: "assistant", text: "The deployment failed. Retry the original request.", size: 50 };
  const f = fixture(items);
  const result = await loadVisibleEarlier("thread", f.initial, options(f.fetcher));
  expect(result.ok).toBe(true);
  expect(result.window.items[0].seq).toBe(60);
  expect(conversationCount(result.window, true)).toBe(80);
  expect(result.window.items).toContainEqual(items[147]);
  expect(f.cursors).toEqual([240, 180, 120]);
  expect(hasEarlier(result.window)).toBe(true);
});

test("hidden-only history reaches actual start; empty pages above start are errors, not completion", async () => {
  const items = Array.from({ length: 125 }, (_, seq) => hidden(seq));
  const f = fixture(items);
  const complete = await loadVisibleEarlier("thread", f.initial, options(f.fetcher));
  expect(complete.ok).toBe(true);
  expect(complete.window.items).toEqual(items);
  expect(hasEarlier(complete.window)).toBe(false);
  const invalid = await loadVisibleEarlier("thread", f.initial, options(async () => Response.json({ generation: "g", total: 125, items: [] })));
  expect(invalid.ok).toBe(false);
  expect(invalid.window).toBe(f.initial);
  expect(hasEarlier(invalid.window)).toBe(true);
});

test.each(["failure", "cancel"] as const)("%s after an accepted page preserves every previously acquired record", async mode => {
  const f = fixture(Array.from({ length: 240 }, (_, seq) => hidden(seq)));
  const controller = new AbortController();
  let accepted: TranscriptWindow | null = null;
  let calls = 0;
  const fetcher = async (path: string) => {
    if (++calls === 2) {
      if (mode === "cancel") controller.abort();
      throw new Error("owner unavailable");
    }
    return f.fetcher(path);
  };
  const result = await loadVisibleEarlier("thread", f.initial, { ...options(fetcher), signal: controller.signal, onPage: window => { accepted = window; } });
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("expected failure");
  expect(result.error.kind).toBe(mode === "cancel" ? "cancelled" : "unavailable");
  expect(result.window).toBe(accepted);
  expect(result.window.items.map(head => head.seq)).toEqual(Array.from({ length: 120 }, (_, n) => n + 120));
  expect(hasEarlier(result.window)).toBe(true);
});

test("cancellation fences an in-flight page from a replaced selection", async () => {
  const f = fixture(Array.from({ length: 120 }, (_, seq) => hidden(seq)));
  const controller = new AbortController();
  let accepted = 0;
  const result = await loadVisibleEarlier("thread", f.initial, { ...options(async path => { const response = await f.fetcher(path); controller.abort(); return response; }), signal: controller.signal, onPage: () => { accepted++; } });
  expect(result).toMatchObject({ ok: false, window: f.initial, error: { kind: "cancelled" } });
  expect(accepted).toBe(0);
});

test("generation reset backfills its own visible budget without merging the previous branch", async () => {
  const f = fixture(Array.from({ length: 180 }, (_, seq) => hidden(seq)));
  const next = [...Array.from({ length: 60 }, (_, seq) => human(seq)), ...Array.from({ length: 60 }, (_, n) => hidden(n + 60))];
  let calls = 0;
  const result = await loadVisibleEarlier("thread", f.initial, options(async path => {
    if (++calls === 1) return Response.json({ generation: "next", total: next.length, items: next.slice(-60) }, { status: 409 });
    expect(new URL(path, "https://fixture.test").searchParams.get("generation")).toBe("next");
    return Response.json({ generation: "next", total: next.length, items: next.slice(0, 60) });
  }));
  expect(result).toMatchObject({ ok: true, reset: true, window: { generation: "next", total: 120, items: next } });
  expect(calls).toBe(2);
});

test("classification excludes machine/agent traffic and silent replies but keeps action-changing answers", () => {
  const agent: TranscriptItemHead = { ...human(1), inputOrigin: "machine", agentSender: { threadId: "worker" } };
  const silent: TranscriptItemHead = { seq: 2, id: "silent", kind: "assistant", text: SILENT_TURN_TEXT, size: 5 };
  const answer: TranscriptItemHead = { seq: 3, id: "answer", kind: "assistant", text: "The operation failed; resend the original request.", size: 10 };
  for (const mono of [false, true]) {
    expect(conversationHead(agent, mono)).toBe(false);
    expect(conversationHead(silent, mono)).toBe(false);
    expect(conversationHead(answer, mono)).toBe(true);
    expect(conversationHead({ ...answer, monoVisibility: "hidden" }, mono)).toBe(!mono);
  }
  const heads = [hidden(0), silent, { ...answer, monoVisibility: "hidden" as const }];
  const work = messengerWork(buildStableTranscript(entriesFromHeads(heads), true), false);
  expect(work).toHaveLength(1);
  expect(work[0].kind).toBe("work");
  if (work[0].kind !== "work") throw new Error("expected disclosure");
  expect(work[0].entries.map(entry => entry.itemId)).toEqual(heads.map(head => head.id));
});

test("a short real conversation stops at native start rather than fabricating sixty messages", async () => {
  const items = Array.from({ length: 130 }, (_, seq) => [0, 1].includes(seq) ? human(seq) : hidden(seq));
  const f = fixture(items);
  const result = await loadVisibleEarlier("thread", f.initial, options(f.fetcher));
  expect(result.ok).toBe(true);
  expect(result.window.items).toEqual(items);
  expect(conversationCount(result.window, true)).toBe(2);
  expect(hasEarlier(result.window)).toBe(false);
});

test("gapped or repeated cursor responses preserve the held page and report a retryable error", async () => {
  const f = fixture(Array.from({ length: 180 }, (_, seq) => hidden(seq)));
  for (const incoming of [[hidden(0), hidden(119)], [hidden(120), hidden(121)]]) {
    const result = await loadVisibleEarlier("thread", f.initial, options(async () => Response.json({ generation: "g", total: 180, items: incoming })));
    expect(result).toMatchObject({ ok: false, window: f.initial, error: { kind: "unavailable" } });
    expect(hasEarlier(result.window)).toBe(true);
  }
});

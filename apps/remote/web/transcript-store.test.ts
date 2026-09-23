import { expect, test } from "bun:test";
import type { TranscriptItemHead } from "../server/protocol";
import { ReconcilePublisher, ReconcileReplica } from "../shared/reconcile";
import { applyTranscriptEvent, hasEarlier, loadEarlier, type TranscriptEvent } from "./src/features/conversation/transcript-store";
import { entriesFromHeads, entryFromHead } from "./src/features/conversation/transcript-entries";

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

test("heads become the entries the transcript renders", () => {
  const user: TranscriptItemHead = { ...item(0, "do the thing"), timestamp: 1_000 };
  const call: Extract<TranscriptItemHead, { kind: "toolCall" }> = {
    seq: 3, id: "t3", kind: "toolCall", size: 2_000, timestamp: 2_003,
    callId: "call-3", name: "bash", arguments: { command: "pwd" }, argumentsTruncated: false, partialOutput: "running…",
  };
  const entries = entriesFromHeads([
    user,
    { seq: 1, id: "s1", kind: "system", size: 40_000, preview: "You are Pi" },
    { seq: 2, id: "h2", kind: "thinking", size: 900, label: "Thinking", preview: "Consider the file" },
    call,
    { seq: 4, id: "sc4", kind: "tool", size: 1_200, label: "bash", preview: "Run a command" },
  ]);
  expect(entries[0]).toMatchObject({ key: "user:0", kind: "user", text: "do the thing", messageTimestamp: 1_000, itemId: user.id, bodyLoaded: false });
  expect(entries[0].signature).toBe(entryFromHead(user).signature);
  expect(entries[1]).toMatchObject({ key: "system:1", kind: "system", preview: "You are Pi", size: 40_000 });
  expect(entries[1].text).toBeUndefined();
  expect(entries[2]).toMatchObject({ kind: "thinking", label: "Thinking", preview: "Consider the file" });
  expect(entries[3]).toMatchObject({
    key: "toolCall:3", kind: "toolCall", time: 2_003,
    toolCall: { id: "call-3", name: "bash", arguments: { command: "pwd" }, partialOutput: "running…" },
  });
  expect(entries[3].toolResult).toBeUndefined();
  expect(entries[4]).toMatchObject({ kind: "tool", label: "bash" });
  const landed = entryFromHead({ ...call, result: { isError: true, size: 90, preview: "boom", imageCount: 1, timestamp: 2_900 } }, true);
  expect(landed.signature).toBe("t3:body");
  expect(landed.toolResult).toMatchObject({ isError: true, preview: "boom", imageCount: 1 });
});

test.each(["user", "assistant"] as const)("%s identity and reaction changes invalidate rendering without changing the body ID", kind => {
  const head: TranscriptItemHead = { seq: 0, id: "body-hash", kind, size: 5, timestamp: 1_000, text: "Hello" };
  const initial = entryFromHead(head);
  const identity = { id: "pi/thread/native-entry", timestamp: 1_000, sender: { id: kind } };
  const addressed = entryFromHead({ ...head, identity });
  expect(addressed.identity).toEqual(identity);
  expect(addressed.signature).not.toBe(initial.signature);

  const reactions = [{ emoji: "❤️", sender: { id: "reader", name: "Reader" }, timestamp: 2_000, own: true }];
  const reacted = entryFromHead({ ...head, identity, reactions });
  expect(reacted.reactions).toEqual(reactions);
  expect(reacted.signature).not.toBe(addressed.signature);
  expect(entryFromHead({ ...head, identity, reactions: structuredClone(reactions) }).signature).toBe(reacted.signature);
  expect(entryFromHead({ ...head, identity, reactions: [] }).signature).toBe(addressed.signature);

  for (const entry of [addressed, reacted]) {
    expect(entry).toMatchObject({ key: initial.key, itemId: initial.itemId, text: initial.text, messageTimestamp: initial.messageTimestamp });
  }
});

test.each(["user", "assistant"] as const)("%s reactions reconcile through the held transcript without replacing its body", kind => {
  const publisher = new ReconcilePublisher();
  const replica = new ReconcileReplica();
  const head: TranscriptItemHead = {
    seq: 1, id: "body-hash", kind, size: 2_000, text: "x".repeat(2_000), timestamp: 1_000,
    identity: { id: "pi/thread/native-entry", timestamp: 1_000, sender: { id: kind } },
  };
  const recent = { generation: "g", total: 2, items: [head] };
  const resource = "transcript:thread";
  publisher.publish(resource, recent);
  expect(replica.apply(publisher.reconcile(resource, null)!).ok).toBe(true);
  let window = applyTranscriptEvent({ generation: "g", total: 2, items: [item(0)] }, recent);
  const initial = entryFromHead(window.items[1]);
  const reactions = [{ emoji: "❤️", sender: { id: "reader" }, timestamp: 2_000, own: true }];
  for (const nextReactions of [reactions, []]) {
    const next = { ...recent, items: [{ ...head, reactions: nextReactions }] };
    publisher.publish(resource, next);
    const frame = publisher.reconcile(resource, replica.have()[resource])!;
    expect(frame.kind).toBe("patch");
    const applied = replica.apply(frame);
    expect(applied.ok).toBe(true);
    if (!applied.ok) throw new Error(applied.reason);
    window = applyTranscriptEvent(window, applied.value as unknown as TranscriptEvent);
    expect(window.items).toEqual([item(0), ...next.items]);
    const rendered = entryFromHead(window.items[1]);
    expect(rendered).toMatchObject({ itemId: initial.itemId, text: initial.text, identity: head.identity, reactions: nextReactions });
    if (nextReactions.length) expect(rendered.signature).not.toBe(initial.signature);
    else expect(rendered.signature).toBe(initial.signature);
  }
});

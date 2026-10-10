import { expect, test } from "bun:test";
import { IDBFactory } from "fake-indexeddb";
import { PromptOutbox, type PromptOutboxEntry } from "./src/prompt-outbox";
import { capturedPromptIds, reconcilePromptEntries } from "./src/features/conversation/optimistic-prompts";
import type { ContextEntry } from "./src/types";

const requestId = "674a1517-411d-4b98-a29c-e5f59636cacc";
const body = { requestId, text: "same exact message", delivery: "steer" as const };
const intent: PromptOutboxEntry = { requestId, sessionId: "thread", createdAt: 100, bodyJson: JSON.stringify(body),
  outcome: { kind: "pending", reason: "saved", message: "Saving" } };
const captured: ContextEntry = { key: "native-source", signature: "native-content-hash", kind: "user", text: body.text,
  inputOrigin: "human", inputId: requestId, seq: 10, identity: { id: `pi/thread/${requestId}`, timestamp: 100, sender: { id: "person", name: "Hara", own: true } } };
const accepted: PromptOutboxEntry = { ...intent, outcome: { kind: "accepted", workId: requestId } };

test("intent is visible before storage or network; later acceptance has the same row key and words", () => {
  const first = reconcilePromptEntries([], [intent], new Set([requestId]));
  expect(first).toHaveLength(1);
  expect(first[0]?.text).toBe(body.text);
  expect(first[0]?.promptDelivery).toEqual({ state: "sending" });
  const acknowledged = reconcilePromptEntries([], [accepted], new Set());
  expect(acknowledged[0]?.key).toBe(first[0]?.key);
  expect(acknowledged[0]?.promptDelivery).toEqual({ state: "delivered" });
  const durable = reconcilePromptEntries([captured], [accepted], new Set());
  expect(durable).toHaveLength(1);
  expect(durable[0]?.key).toBe(first[0]?.key);
  expect(durable[0]?.identity).toEqual(captured.identity);
  expect(reconcilePromptEntries([captured], [], new Set())[0]?.key).toBe(first[0]?.key);
});

test("capture arriving before HTTP acknowledgement replaces the pending row without duplication", () => {
  const rows = reconcilePromptEntries([captured], [intent], new Set([requestId]));
  expect(rows).toHaveLength(1);
  expect(rows[0]?.promptDelivery).toEqual({ state: "delivered" });
  expect(capturedPromptIds([captured], [intent])).toEqual([]);
  expect(capturedPromptIds([captured], [accepted])).toEqual([requestId]);
  expect(capturedPromptIds([], [accepted])).toEqual([]);
});

test("lost acknowledgement remains visible and retry keeps the exact identity; authoritative rejection is not replayable", () => {
  const unconfirmed: PromptOutboxEntry = { ...intent, outcome: { kind: "pending", reason: "transport", message: "Acknowledgement lost" } };
  const failed = reconcilePromptEntries([], [unconfirmed], new Set())[0]!;
  expect(failed.promptDelivery).toEqual({ state: "failed", message: "Acknowledgement lost", retryRequestId: requestId });
  expect(reconcilePromptEntries([], [unconfirmed], new Set([requestId]))[0]?.key).toBe(failed.key);
  const rejected: PromptOutboxEntry = { ...intent, outcome: { kind: "rejected", message: "Reply target unavailable" } };
  expect(reconcilePromptEntries([], [rejected], new Set())[0]?.promptDelivery).toEqual({ state: "failed", message: "Reply target unavailable" });
});

test("delivery becomes read only when the owner records landing, not on acceptance", () => {
  const input = { id: requestId, threadId: "thread", senderId: null, source: "explicit" as const, state: "dispatched" as const, delivery: "steer" as const, priority: "human" as const, createdAt: 100, insertedAt: 101, landedAt: null };
  expect(reconcilePromptEntries([{ ...captured, inputState: input }], [], new Set())[0]?.promptDelivery).toEqual({ state: "delivered" });
  expect(reconcilePromptEntries([{ ...captured, inputState: { ...input, landedAt: 102 } }], [], new Set())[0]?.promptDelivery).toEqual({ state: "read" });
});

test("identical text from a separate input never consumes an optimistic intent", () => {
  const other = { ...captured, inputId: "other", key: "other" };
  const rows = reconcilePromptEntries([other], [intent], new Set([requestId]));
  expect(rows).toHaveLength(2);
  expect(new Set(rows.map(entry => entry.key)).size).toBe(2);
});

test("persist before transport; retry a lost acknowledgement with one server-side effect and retain until capture", async () => {
  const scope = { person: "person", environment: "local", bootstrap: "https://router.example/" };
  const store = new PromptOutbox({ scope, currentScope: () => scope, database: new IDBFactory() });
  const saved = await store.enqueue("thread", body);
  expect(saved.ok).toBe(true);
  const effects = new Set<string>();
  const transmitted: string[] = [];
  const lost = await store.submit(requestId, async entry => {
    effects.add(entry.requestId); transmitted.push(entry.bodyJson);
    throw new Error("Response lost after admission");
  });
  expect(lost.ok && lost.value.outcome.kind).toBe("pending");
  await Promise.all([store.submit(requestId, async entry => {
    effects.add(entry.requestId); transmitted.push(entry.bodyJson);
    return { status: 202, body: { accepted: true, workId: requestId, delivery: "steer" } };
  }), store.submit(requestId, async () => { throw new Error("Concurrent duplicate transport"); })]);
  expect(effects.size).toBe(1);
  expect(transmitted).toEqual([JSON.stringify(body), JSON.stringify(body)]);
  const retained = await store.list();
  expect(retained.ok && retained.value[0]?.outcome.kind).toBe("accepted");
  expect(capturedPromptIds([captured], retained.ok ? retained.value : [])).toEqual([requestId]);
  expect((await store.acknowledge(requestId)).ok).toBe(true);
  store.dispose();
});

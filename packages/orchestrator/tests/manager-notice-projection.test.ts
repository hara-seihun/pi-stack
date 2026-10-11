import { expect, test } from "bun:test";
import { CoreManagerNotices } from "../src/core/manager-notices.js";
import { openSqlite } from "../src/sqlite.js";
import { agentMessagePresentation, formatThreadMessage, serializeThreadSettlementNotification } from "../src/threads/message-format.js";
import type { SendThread, ThreadApi, ThreadMessage } from "../src/threads/contracts.js";

const report = 'Result: repaired.\n<pi-remote-file src="/synthetic/report.pdf" />\n![Evidence](/synthetic/evidence.png)';
const finalMessage = { role: "assistant", api: "openai-responses", provider: "openai-codex", model: "synthetic-model", timestamp: 123,
  usage: { input: 999, output: 1, cost: { total: 10 } }, stopReason: "stop", content: [
    { type: "thinking", thinking: "Opaque private reasoning", thinkingSignature: "opaque-signature".repeat(1000), encrypted_content: "encrypted-envelope".repeat(1000) },
    { type: "text", text: report, textSignature: "opaque-text-signature", providerMetadata: { encrypted_content: "opaque-text-envelope" } },
  ] };
const notification = { type: "thread_settled", threadId: "origin", title: "Original task title", outcome: "complete", finalMessage, error: "Original actionable error" };
const originalText = JSON.stringify(notification);
const forbidden = /finalMessage|thinking|Signature|encrypted_content|usage|providerMetadata|synthetic-model|openai-responses|Opaque private reasoning/;

function message(text: string): ThreadMessage {
  return { id: "manager-notice:original-owner:settlement:original-execution", threadId: "manager", senderId: "origin", senderName: "Original task title", source: "notification", text, delivery: "queue", priority: "normal", createdAt: 123, state: "queued", replyTo: "original-request" };
}

test("historical model projection preserves exact notice identity, sender, report/artifacts and appended context without rewriting storage", () => {
  const stored = message(originalText), before = structuredClone(stored);
  const model = formatThreadMessage(stored, stored.text + "\nOriginal meeting context");
  expect(model).not.toMatch(forbidden);
  expect(JSON.parse(model.split("\n")[2]!)).toEqual({ senderThreadId: "origin", senderName: "Original task title", recipientThreadId: "manager", messageId: stored.id, source: "notification", replyTo: "original-request" });
  const body = JSON.parse(model.split("\n\n")[1]!.split("\n")[0]!);
  expect(body).toEqual({ type: "thread_settled", threadId: "origin", title: "Original task title", outcome: "complete", finalText: report, error: "Original actionable error" });
  expect(agentMessagePresentation(model)?.text).toBe(report + "\n\nOriginal actionable error\nOriginal meeting context");
  expect(stored).toEqual(before); expect(stored.text).toBe(originalText);
  expect(JSON.stringify(finalMessage)).toContain("opaque-signature");
});

test("reasoning-only, failed and cancelled result projections never turn opaque blocks into usable results", () => {
  const reasoning = { role: "assistant", errorMessage: "Exact provider failure", content: [finalMessage.content[0]] };
  expect(JSON.parse(serializeThreadSettlementNotification({ threadId: "origin", outcome: "failed", finalMessage: reasoning }))).toEqual({ type: "thread_settled", threadId: "origin", outcome: "failed", finalText: null, error: "Exact provider failure" });
  expect(JSON.parse(serializeThreadSettlementNotification({ outcome: "cancelled", finalMessage: null }))).toEqual({ type: "thread_settled", outcome: "cancelled", finalText: null });
  const explicit = { ...message(originalText), source: "explicit" as const };
  expect(formatThreadMessage(explicit, explicit.text)).toContain(originalText);
  const attention = message("Attention: original text and artifact /synthetic/file");
  expect(formatThreadMessage(attention, attention.text)).toContain(attention.text);
});

test("real future manager outbox strips envelopes while accepted original outbox input and receipt IDs survive restart unchanged", async () => {
  const db = openSqlite(":memory:"), receipts = [{ seq: 9, threadId: "origin", executionId: "future-execution", workId: "future-work", outcome: "complete", time: 123, finalMessage, error: "Original actionable error" }], before = structuredClone(receipts);
  const api = { settlements: async (after: number) => ({ ok: true, value: { cursor: 9, items: after < 9 ? receipts : [] } }),
    attentionEvents: async (after: number) => ({ ok: true, value: { cursor: after, items: [] } }),
    questionEvents: async (after: number) => ({ ok: true, value: { cursor: after, items: [] } }),
    list: async () => ({ ok: true, value: { threads: [{ id: "origin", title: "Original task title" }], nextCursor: null } }),
  } as unknown as ThreadApi;
  let acknowledged = false; const sent: SendThread[] = [];
  const directory = { managerNotificationPolicy: async () => ({ ok: true as const, value: { view: "mono" as const, managerThreadId: "manager" } }),
    send: async (input: SendThread) => { sent.push(structuredClone(input)); return acknowledged ? { ok: true as const, value: { id: input.requestId, state: "queued" as const } } : { ok: false as const, error: { code: "unavailable" as const, message: "Synthetic lost acknowledgement" } }; } };
  const config = { scopeId: "synthetic", notificationOwnerId: "original-owner", adoptedCursors: { settlements: 8, attention: 0, questions: 0 }, subscribe: () => () => {}, feedback: () => {} };
  const first = new CoreManagerNotices(config, db, api, directory);
  const original: SendThread = { requestId: "manager-notice:original-owner:settlement:original-execution", threadId: "manager", senderId: "origin", source: "notification", text: originalText };
  const raw = JSON.stringify(original);
  db.prepare("INSERT INTO core_manager_notice_outbox VALUES(?,?,?,NULL)").run(config.scopeId, original.requestId, raw);
  try {
    expect((await first.start()).ok).toBe(false);
    expect(db.prepare("SELECT input FROM core_manager_notice_outbox WHERE request_id=?").get(original.requestId)).toEqual({ input: raw });
    expect(sent).toEqual([original]);
    const next = db.prepare("SELECT input FROM core_manager_notice_outbox WHERE request_id=?").get("manager-notice:original-owner:settlement:future-execution") as { input: string };
    const future = JSON.parse(next.input) as SendThread;
    expect(future).toMatchObject({ requestId: "manager-notice:original-owner:settlement:future-execution", threadId: "manager", senderId: "origin", source: "notification" });
    expect(future.text).not.toMatch(forbidden); expect(JSON.parse(future.text)).toEqual({ type: "thread_settled", threadId: "origin", title: "Original task title", outcome: "complete", finalText: report, error: "Original actionable error" });
    expect(future.text.length).toBeLessThan(500); expect(receipts).toEqual(before);
    await first.close(); acknowledged = true;
    const restarted = new CoreManagerNotices(config, db, api, directory);
    try { expect((await restarted.start()).ok).toBe(true); expect(sent).toEqual([original, original, future]); expect(db.prepare("SELECT count(*) count FROM core_manager_notice_outbox").get()).toEqual({ count: 0 }); }
    finally { await restarted.close(); }
    expect(receipts).toEqual(before);
  } finally { await first.close(); db.close(); }
});

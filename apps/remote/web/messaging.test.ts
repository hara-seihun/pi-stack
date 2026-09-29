import { expect, test } from "bun:test";
import type { MessagingMessage } from "../server/messaging/protocol";
import { beginHumanSend, draftFromHumanMessage, emptyHumanDraft, mergeHumanMessages, requestFromHumanMessage, unconfirmedHumanSend, type HumanDraft } from "./src/messaging-state";

const attachment = { id: "file-a", name: "notes.txt", mimeType: "text/plain", size: 12 };
const draft: HumanDraft = { text: " Keep spacing \n", attachments: [attachment] };
const message = (status: MessagingMessage["status"], extra: Partial<MessagingMessage> = {}): MessagingMessage => ({
  id: "request-a", requestId: "request-a", conversationId: "conversation-a", externalId: null,
  direction: "outgoing", sender: "You", text: draft.text, attachments: draft.attachments, timestamp: 1, status, error: null, ...extra,
});

test("concurrent sends settle independently without duplicating messages or changing the next draft", () => {
  const first = beginHumanSend(draft, "conversation-a", "request-a", 1);
  const nextDraft = { ...emptyHumanDraft(), text: "Next message" };
  const second = beginHumanSend(nextDraft, "conversation-a", "request-b", 2);
  const pending = mergeHumanMessages([first.message], [second.message]);
  const received = mergeHumanMessages(pending, [{ ...second.message, status: "sent" }, message("sending")]);
  expect(received.map(item => [item.id, item.status])).toEqual([["request-a", "sending"], ["request-b", "sent"]]);
  const settled = mergeHumanMessages(received, [message("failed", { error: "refused" })]);
  expect(settled).toHaveLength(2);
  expect(draftFromHumanMessage(settled[0])).toEqual(draft);
  expect(nextDraft).toEqual({ text: "Next message", attachments: [] });
});

test("lost acknowledgements stay on the message, and a check uses the exact original request", () => {
  const first = beginHumanSend(draft, "conversation-a", "request-a", 1);
  const [unknown] = unconfirmedHumanSend([first.message], first.message, "Connection lost");
  expect(unknown.status).toBe("unknown");
  expect(unknown.text).toBe(draft.text);
  expect(unknown.attachments).toEqual(draft.attachments);
  expect(requestFromHumanMessage(unknown)).toEqual(first.request);
  const failed = message("failed");
  const resend = beginHumanSend(draftFromHumanMessage(failed), "conversation-a", "request-b");
  expect(resend.request.requestId).not.toBe(first.request.requestId);
  expect(resend.request.attachmentIds).toEqual(first.request.attachmentIds);
  expect(requestFromHumanMessage(message("received", { requestId: null }))).toBeNull();
});

test("reply references survive unknown send checks and failed draft recovery", () => {
  const target = { identity: { id: "messaging/original", sender: { id: "sam", name: "Sam" }, timestamp: 4 }, text: "Earlier" };
  const first = beginHumanSend({ ...draft, reply: target }, "conversation-a", "request-a", 5);
  expect(first.request.replyTo).toBe(target.identity.id);
  expect(first.message.reply).toEqual({ messageId: target.identity.id, sender: target.identity.sender, text: "Earlier", timestamp: 4 });
  expect(requestFromHumanMessage(unconfirmedHumanSend([first.message], first.message, "Connection lost")[0])).toEqual(first.request);
  const restored = draftFromHumanMessage({ ...first.message, status: "failed" });
  expect(beginHumanSend(restored, "conversation-a", "request-b").request.replyTo).toBe(target.identity.id);
});

test("a transport failure cannot overwrite a receipt already received from history", () => {
  const first = beginHumanSend(draft, "conversation-a", "request-a", 1);
  for (const status of ["sending", "sent", "failed", "unknown"] as const) {
    const receipt = message(status);
    const received = mergeHumanMessages([first.message], [receipt]);
    expect(unconfirmedHumanSend(received, first.message, "Connection lost")).toEqual([receipt]);
  }
});

test("server receipts reconstruct a check after a lock without browser draft storage", () => {
  const receipt = message("unknown", { attachments: [attachment, { ...attachment, id: "file-b" }] });
  expect(requestFromHumanMessage(receipt)).toEqual({ requestId: "request-a", text: draft.text, attachmentIds: ["file-a", "file-b"] });
});

test("history merges older pages and receipts without downgrading a confirmed send", () => {
  const sent = message("sent");
  const earlier = message("received", { id: "incoming", requestId: null, timestamp: 0 });
  const merged = mergeHumanMessages([sent], [message("sending"), earlier]);
  expect(merged.map(item => [item.id, item.status])).toEqual([["incoming", "received"], ["request-a", "sent"]]);
});

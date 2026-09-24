import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { MessagingMessage } from "../server/messaging/protocol";
import { beginHumanSend, draftFromHumanMessage, emptyHumanDraft, groupHumanMessages, HUMAN_MESSAGE_GROUP_GAP_MS, mergeHumanMessages, requestFromHumanMessage, unconfirmedHumanSend, type HumanDraft } from "./src/messaging-state";
import { ChatMessage, ChatMessageGroup, messagingMessageProps, messagingMessageSegment } from "./src/chat-message";

const attachment = { id: "file-a", name: "notes.txt", mimeType: "text/plain", size: 12 };
const draft: HumanDraft = { text: " Keep spacing \n", attachments: [attachment] };
const message = (status: MessagingMessage["status"], extra: Partial<MessagingMessage> = {}): MessagingMessage => ({
  id: "request-a", requestId: "request-a", conversationId: "conversation-a", externalId: null,
  direction: "outgoing", sender: "You", text: draft.text, attachments: draft.attachments, timestamp: 1, status, error: null, ...extra,
});

test("pending sends render exactly like sent messages except for the delivery marker", () => {
  const previous = globalThis.window;
  globalThis.window = { PiRemotePerson: { href: (path: string) => path }, KenanRemote: { resolveApiUrl: (path: string) => path } } as unknown as Window & typeof globalThis;
  try {
    for (const value of [draft, { text: "", attachments: [attachment] }]) {
      const pending = beginHumanSend(value, "conversation-a", "request-a", 1);
      const render = (item: MessagingMessage) => renderToStaticMarkup(createElement(ChatMessageGroup, {
        kind: "user", label: "You", segments: [messagingMessageSegment(item, { onCheck: () => {}, onRetry: () => {} })],
      }));
      const html = render(pending.message);
      expect(html.replaceAll("sending", "sent")).toBe(render({ ...pending.message, status: "sent" }));
      expect(html).not.toContain("<button");
      expect(requestFromHumanMessage(pending.message)).toEqual(pending.request);
    }
  } finally { globalThis.window = previous; }
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

test("human text stays literal and uploaded SVG/HTML are downloads, not active content", () => {
  const previous = globalThis.window;
  globalThis.window = { PiRemotePerson: { href: (path: string) => path }, KenanRemote: { resolveApiUrl: (path: string) => path } } as unknown as Window & typeof globalThis;
  try {
    const html = renderToStaticMarkup(createElement(ChatMessage, messagingMessageProps(message("sent", {
      text: '<script>alert(1)</script> <image src="https://evil.test/pixel"> **not markdown**',
      attachments: [
        { ...attachment, id: "svg", name: "drawing.svg", mimeType: "image/svg+xml" },
        { ...attachment, id: "html", name: "page.html", mimeType: "text/html" },
        { ...attachment, id: "png", name: "photo.png", mimeType: "image/png" },
      ],
    }))));
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("**not markdown**");
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<image ");
    expect(html.match(/<img /g)).toHaveLength(1);
    expect(html).toContain('download="drawing.svg"');
    expect(html).toContain('download="page.html"');
    expect(html).toContain('/v1/messaging/attachments/png');
    expect(html).not.toContain("/uploads");
  } finally { globalThis.window = previous; }
});

test("contiguous messages from one sender form one block; a sender change or a long pause starts another", () => {
  const sam = (id: string, timestamp: number, extra: Partial<MessagingMessage> = {}) => message("received", { id, requestId: null, direction: "incoming", sender: "+44123456", senderName: "Sam", text: id, timestamp, ...extra });
  const mine = (id: string, timestamp: number, status: MessagingMessage["status"] = "sent") => message(status, { id, requestId: id, text: id, timestamp });
  const groups = groupHumanMessages([
    sam("s1", 1_000), sam("s2", 2_000), sam("s3", 3_000),
    mine("m1", 4_000), mine("m2", 5_000),
    sam("s4", 6_000),
    sam("s5", 6_000 + HUMAN_MESSAGE_GROUP_GAP_MS + 1),
    sam("s6", 6_000 + HUMAN_MESSAGE_GROUP_GAP_MS + 2, { sender: "+44999" }),
  ]);
  expect(groups.map(group => group.map(item => item.id))).toEqual([["s1", "s2", "s3"], ["m1", "m2"], ["s4"], ["s5"], ["s6"]]);
  expect(groupHumanMessages([])).toEqual([]);

  const previous = globalThis.window;
  globalThis.window = { PiRemotePerson: { href: (path: string) => path }, KenanRemote: { resolveApiUrl: (path: string) => path } } as unknown as Window & typeof globalThis;
  try {
    const props = messagingMessageProps({ ...groups[0][0], senderAvatar: 1700 }, "signal");
    expect(props.avatar).toBe("/v1/messaging/backends/signal/avatars/%2B44123456?v=1700");
    expect(messagingMessageProps(groups[0][0], "signal").avatar).toBeUndefined();
    expect(messagingMessageProps({ ...mine("m9", 9), senderAvatar: 1700 }, "signal").avatar).toBeUndefined();
    const incoming = renderToStaticMarkup(createElement(ChatMessageGroup, { kind: "assistant", label: "Sam", avatar: props.avatar, segments: groups[0].map(item => messagingMessageSegment(item)) }));
    expect(incoming.match(/class="message-avatar"/g)).toHaveLength(1);
    expect(incoming.match(/<article /g)).toHaveLength(1);
    expect(incoming.match(/class="message-header"/g)).toHaveLength(1);
    expect(incoming).toContain('class="message-label">SAM</span>');
    expect(incoming.match(/<p class="message-text">/g)).toHaveLength(3);
    expect(incoming).toContain('data-message-id="s2"');
    expect(incoming.indexOf(">s1<")).toBeLessThan(incoming.indexOf(">s2<"));

    // A run of delivered sends reports "sent" once; a failed send keeps its own footer and recovery button.
    const outgoing = renderToStaticMarkup(createElement(ChatMessageGroup, { kind: "user", label: "You", checking: false, segments: [mine("m1", 1), mine("m2", 2, "failed"), mine("m3", 3)].map(item => messagingMessageSegment(item, { onRetry: () => {}, onCheck: () => {} })) }));
    expect(outgoing.match(/class="message-status sent"/g)).toHaveLength(1);
    expect(outgoing.match(/class="message-status failed"/g)).toHaveLength(1);
    expect(outgoing.match(/Use failed draft/g)).toHaveLength(1);
    expect(outgoing.indexOf("message-status failed")).toBeLessThan(outgoing.indexOf(">m3<"));
  } finally { globalThis.window = previous; }
});

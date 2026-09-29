import { afterEach, beforeEach, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { MessagingMessage } from "../server/messaging/protocol";
import { chatTimeLabel, emojiOnly, MessagingChat, type MessagingChatProps } from "./src/messaging-chat";
import { beginHumanSend, CHAT_TIME_GAP_MS, chatRows } from "./src/messaging-state";
import { senderName } from "./src/message-reply";

const previous = globalThis.window;
beforeEach(() => {
  globalThis.window = { PiRemotePerson: { href: (path: string) => path, get: () => "kenan" }, KenanRemote: { resolveApiUrl: (path: string) => path } } as unknown as Window & typeof globalThis;
});
afterEach(() => { globalThis.window = previous; });

const minute = 60_000;
const base = new Date(2026, 8, 28, 18, 0).getTime();
const sam = (id: string, at: number, extra: Partial<MessagingMessage> = {}): MessagingMessage => ({
  id, requestId: null, conversationId: "chat", externalId: id, direction: "incoming", sender: "+44123456", senderName: "Sam",
  text: id, timestamp: base + at, status: "received", error: null, attachments: [], ...extra,
});
const mine = (id: string, at: number, extra: Partial<MessagingMessage> = {}): MessagingMessage => ({
  id, requestId: id, conversationId: "chat", externalId: id, direction: "outgoing", sender: "You",
  text: id, timestamp: base + at, status: "sent", error: null, attachments: [], ...extra,
});
const render = (messages: MessagingMessage[], props: Partial<MessagingChatProps> = {}) =>
  renderToStaticMarkup(<MessagingChat messages={messages} backendId="signal" group now={base + 5 * minute} {...props} />);

test("time markers appear where the conversation paused, and runs know their first and last line", () => {
  const rows = chatRows([
    sam("s1", 0), sam("s2", minute), mine("m1", 2 * minute), mine("m2", 3 * minute, { sender: "+1555" }),
    sam("s3", 3 * minute + CHAT_TIME_GAP_MS + 1), sam("s4", 3 * minute + CHAT_TIME_GAP_MS + 2, { sender: "+44999" }),
  ]);
  expect(rows.map(row => row.kind === "time" ? "time" : `${row.message.id}${row.head ? "^" : ""}${row.tail ? "$" : ""}`))
    .toEqual(["time", "s1^", "s2$", "m1^", "m2$", "time", "s3^$", "s4^$"]);
  expect(chatRows([])).toEqual([]);
});

test("theirs are named once per run in groups, never in direct chats; yours are never labelled", () => {
  const messages = [sam("s1", 0, { senderAvatar: 1700 }), sam("s2", minute), mine("m1", 2 * minute), mine("m2", 3 * minute)];
  const html = render(messages);
  expect(html.match(/class="chat-sender"/g)).toHaveLength(1);
  expect(html).toContain("<span>Sam</span>");
  expect(html).toContain('src="/v1/messaging/backends/signal/avatars/%2B44123456?v=1700"');
  expect(html).not.toContain(">You<");
  expect(html).toContain('class="chat-line own head"');
  expect(html).toContain('class="chat-line own tail"');
  // Newest first in the DOM; the column-reverse container restores reading order.
  expect(html.indexOf('data-message-id="m2"')).toBeLessThan(html.indexOf('data-message-id="s1"'));
  expect(html).toContain('class="chat-time"');
  expect(render(messages, { group: false })).not.toContain("chat-sender");
  expect(render([sam("s1", 0, { senderName: undefined })])).toContain("<span>+44123456</span>");
});

test("text stays literal and uploaded SVG or HTML are downloads, not active content", () => {
  const html = render([mine("m1", 0, {
    text: '<script>alert(1)</script> <image src="https://evil.test/pixel"> **not markdown**',
    attachments: [
      { id: "svg", name: "drawing.svg", mimeType: "image/svg+xml", size: 12 },
      { id: "html", name: "page.html", mimeType: "text/html", size: 12 },
      { id: "png", name: "photo.png", mimeType: "image/png", size: 2048 },
      { id: "audio", name: "voice.mp3", mimeType: "audio/mpeg", size: 1000 },
    ],
  })]);
  expect(html).toContain("&lt;script&gt;");
  expect(html).toContain("**not markdown**");
  expect(html).not.toContain("<script>");
  expect(html).not.toContain("<image ");
  expect(html).not.toContain("<img ");
  expect(html).toContain('class="attachment-image-frame"');
  expect(html).toContain('download="drawing.svg"');
  expect(html).toContain('download="page.html"');
  expect(html).not.toContain('download="photo.png"');
  expect(html).toContain('class="attachment-playback audio"');
  expect(html).not.toContain("<audio");
});

test("delivery is silent unless something needs attention", () => {
  const pending = beginHumanSend({ text: "hello", attachments: [] }, "chat", "request-a", base).message;
  const sending = render([pending]);
  expect(sending).toContain("pending");
  expect(sending).not.toContain("chat-status");
  expect(render([{ ...pending, status: "sent" }])).not.toContain("chat-status");
  const failed = render([mine("m1", 0, { status: "failed", error: "Delivery refused" })], { onRetry: () => {}, onCheck: () => {} });
  expect(failed).toContain("Not sent · Delivery refused");
  expect(failed).toContain("Use failed draft");
  expect(failed).not.toContain("Check send status");
  const unknown = render([mine("m1", 0, { status: "unknown" })], { onCheck: () => {}, checking: ["m1"] });
  expect(unknown).toContain('disabled="">Check send status');
  expect(render([mine("m1", 0, { status: "unknown", requestId: null })], { onCheck: () => {} })).not.toContain("Check send status");
});

test("replies to your own messages name you, and reactions attach to stable messages only", () => {
  const identity = { id: "messaging/s1", timestamp: base, sender: { id: "+44123456", name: "Sam" } };
  const reply = { messageId: "messaging/m0", sender: { id: "+1555", own: true }, text: "90% chance" };
  const html = render([sam("s1", 0, { identity, reply, reactions: [{ emoji: "❤️", sender: { id: "+1555" }, timestamp: base + 1, own: true }] }), sam("s2", minute, { status: "received" })]);
  expect(html).toContain("<strong>You</strong>");
  expect(html).not.toContain("+1555");
  expect(html).toContain('data-own="true"');
  expect(html.match(/class="message-reactions"/g)).toHaveLength(1);
  expect(senderName({ id: "+1555" })).toBe("+1555");
  expect(senderName({ id: "+1555", name: "Jodie" })).toBe("Jodie");
});

test("link previews wait for confirmed messages", () => {
  const link = "Look: https://example.com/article";
  expect(render([sam("s1", 0, { text: link })])).toContain("message-link-previews");
  expect(render([mine("m1", 0, { text: link })])).toContain("message-link-previews");
  expect(render([mine("m1", 0, { text: link, status: "sending" })])).not.toContain("message-link-previews");
  expect(render([sam("s1", 0, { text: "No links" })])).not.toContain("message-link-previews");
});

test("emoji-only messages read as pictures and time labels stay short", () => {
  expect(emojiOnly("😢")).toBe(true);
  expect(emojiOnly("👍🏽 ❤️")).toBe(true);
  expect(emojiOnly("ok 👍")).toBe(false);
  expect(emojiOnly("1")).toBe(false);
  expect(render([sam("😂", 0)])).toContain('class="chat-emoji"');
  const now = new Date(2026, 8, 28, 20, 0).getTime();
  expect(chatTimeLabel(new Date(2026, 8, 28, 18, 15).getTime(), now)).not.toMatch(/Yesterday|,/);
  expect(chatTimeLabel(new Date(2026, 8, 27, 18, 15).getTime(), now)).toStartWith("Yesterday ");
  expect(chatTimeLabel(new Date(2025, 8, 27, 18, 15).getTime(), now)).toContain("2025");
});

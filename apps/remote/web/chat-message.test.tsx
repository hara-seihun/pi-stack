import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { MessagingMessage } from "../server/messaging/protocol";
import { AttachmentImage, ChatMessage, ChatMessageGroup, messagingMessageProps, messagingMessageSegment } from "./src/chat-message";
import { DrawingCanvas } from "./src/DrawingCanvas";
import { MessageReactions } from "./src/message-reactions";

const message: MessagingMessage = {
  id: "a", conversationId: "chat", externalId: null, requestId: "request",
  direction: "incoming", sender: "+44123456", senderName: "Sam", text: "**literal** <script>no()</script>\nnext line",
  timestamp: 1, attachments: [], status: "received", error: null,
};

function renderMessage(extra: Partial<MessagingMessage> = {}, checking = false) {
  return renderToStaticMarkup(<ChatMessage {...messagingMessageProps({ ...message, ...extra })} checking={checking} onCheck={() => {}} onRetry={() => {}} />);
}

test("human and agent messages use the same header and direction styling, with actions on the long-press menu", () => {
  const agent = renderToStaticMarkup(<ChatMessage kind="assistant" label="Kenan" avatar="/kenan.png" text="answer" contentFormat="markdown" renderMarkdown={text => <p>{text}</p>} />);
  const human = renderMessage();
  for (const html of [agent, human]) {
    expect(html).toContain('class="message assistant');
    expect(html).toContain('class="message-header"');
    expect(html).not.toContain('class="message-actions"');
    expect(html).not.toContain('aria-label="Copy message"');
  }
  expect(agent).toContain('<img class="message-avatar" src="/kenan.png" alt=""');
  expect(agent).toContain('class="message-label">KENAN</span>');
  expect(human).not.toContain("message-avatar");
  expect(human).toContain('class="message-label">SAM</span>');
  expect(human).not.toContain(message.sender);
  expect(human).toContain("**literal** &lt;script&gt;no()&lt;/script&gt;\nnext line");
  expect(human).not.toContain("<script>");
  expect(human).not.toContain("<strong>");
  expect(renderMessage({ senderName: undefined })).toContain(message.sender);
  expect(renderMessage({ senderName: "" })).toContain(message.sender);
  expect(renderMessage({ direction: "outgoing", status: "sent" })).toContain('class="message user"');
});

test("only stable messages show shared per-message reactions, including grouped human messages", () => {
  const identity = { id: "messaging/one", timestamp: 1, sender: { id: "sam", name: "Sam" } };
  const reactions = [{ emoji: "❤️", sender: { id: "me", name: "You" }, timestamp: 2, own: true }];
  const agent = renderToStaticMarkup(<ChatMessage kind="assistant" label="Agent" text="answer" contentFormat="literal" identity={identity} reactions={reactions} />);
  expect(agent).not.toContain('aria-label="Add reaction"');
  expect(agent).toContain('data-own="true"');
  expect(agent).not.toContain('<button');
  expect(agent).toContain("You");
  expect(renderToStaticMarkup(<ChatMessage kind="assistant" label="Agent" text="streaming" contentFormat="literal" />)).not.toContain('aria-label="Add reaction"');
  const group = renderToStaticMarkup(<ChatMessageGroup kind="assistant" label="Sam" segments={[
    messagingMessageSegment({ ...message, id: "one", identity, reactions }),
    messagingMessageSegment({ ...message, id: "two", identity: { ...identity, id: "messaging/two" }, reactions: [] }),
    messagingMessageSegment({ ...message, id: "three", status: "sending" }),
  ]} />);
  expect(group).not.toContain('aria-label="Add reaction"');
  expect(group.match(/class="message-reactions"/g)).toHaveLength(1);
  expect(group).toContain('data-message-id="messaging/one"');
  expect(group).toContain('data-message-id="messaging/two"');
});

test("replies quote the actual target and offer a per-segment action only for stable identities", () => {
  const first = { id: "messaging/one", timestamp: 1, sender: { id: "sam", name: "Sam" } };
  const second = { ...first, id: "messaging/two" };
  const reply = { messageId: first.id, sender: first.sender, text: "the first message" };
  const group = renderToStaticMarkup(<ChatMessageGroup kind="assistant" label="Sam" segments={[
    messagingMessageSegment({ ...message, id: "one", identity: first }, { onReply: () => {} }),
    messagingMessageSegment({ ...message, id: "two", identity: second, reply }, { onReply: () => {} }),
    messagingMessageSegment({ ...message, id: "three", status: "sending" }, { onReply: () => {} }),
  ]} />);
  expect(group).not.toContain('aria-label="Reply to Sam"');
  expect(group).not.toContain('message-reply-action');
  expect(group).not.toContain('message-reaction-add');
  expect(group).toContain('data-message-id="messaging/two"');
  expect(group).toContain("the first message");
  expect(group).toContain('aria-label="Go to message from Sam"');
  expect(renderToStaticMarkup(<ChatMessage kind="user" label="You" text="quoted answer" contentFormat="literal" identity={second} reply={reply} onReply={() => {}} />)).toContain("the first message");
});

test("menu-opened reaction picker includes owned custom emoji for removal", () => {
  const identity = { id: "messaging/one", timestamp: 1, sender: { id: "sam" } };
  const props = { identity, reactions: [{ emoji: "🦦", sender: { id: "me" }, timestamp: 2, own: true }], onOpenChange: () => {} };
  const closed = renderToStaticMarkup(<MessageReactions {...props} open={false} />);
  expect(closed).not.toContain("<button");
  const opened = renderToStaticMarkup(<MessageReactions {...props} open={true} />);
  expect(opened).toContain('aria-label="Choose a reaction"');
  expect(opened).toContain('aria-label="Remove 🦦" aria-pressed="true"');
  expect(opened).toContain('aria-label="React with 👍"');
});

test("unconfirmed receipts retain checking and failed receipts retain explicit draft recovery", () => {
  const unknown = renderMessage({ direction: "outgoing", status: "unknown" }, true);
  expect(unknown).toContain('disabled="">Check send status');
  expect(unknown).not.toContain("Use failed draft");
  // Sending is the supervisor at work; it needs no check and no recovery.
  const sending = renderMessage({ direction: "outgoing", status: "sending" });
  expect(sending).toContain('class="message-status sending"');
  expect(sending).not.toContain("Check send status");
  expect(sending).not.toContain("Use failed draft");
  const failed = renderMessage({ direction: "outgoing", status: "failed", error: "Delivery refused" });
  expect(failed).toContain("Use failed draft");
  expect(failed).toContain("Delivery refused");
  expect(failed).not.toContain("Check send status");
  expect(renderMessage({ status: "sent" })).not.toContain("Check send status");
  expect(renderMessage({ status: "unknown", requestId: null })).not.toContain("Check send status");
});

test("inline image attachments do not repeat their download link", () => {
  const image = renderMessage({ attachments: [{ id: "image", name: "photo.png", mimeType: "image/png", size: 2048 }] });
  expect(image).toContain('class="attachment-image-frame"');
  expect(image).not.toContain('<img');
  expect(image).not.toContain("photo.png · 2 KB");
  expect(image).not.toContain("download=");

  const file = renderMessage({ attachments: [{ id: "file", name: "notes.txt", mimeType: "text/plain", size: 2048 }] });
  expect(file).toContain("notes.txt · 2 KB");
  expect(file).toContain('download="notes.txt"');
});

test("the image editor owns the image download action", () => {
  const editor = renderToStaticMarkup(<DrawingCanvas background={{ src: "/photo.png", downloadSrc: "/photo.png?download=1", alt: "Photo", name: "photo.png" }} onAttach={async () => ({ ok: true })} onClose={() => {}} />);
  expect(editor).toContain('href="/photo.png?download=1"');
  expect(editor).toContain('download="photo.png"');
  expect(editor).toContain(">Download</a>");

  const paper = renderToStaticMarkup(<DrawingCanvas onAttach={async () => ({ ok: true })} onClose={() => {}} />);
  expect(paper).not.toContain(">Download</a>");
});

test("attachment media reserves geometry without starting offscreen downloads", () => {
  const image = renderToStaticMarkup(<AttachmentImage src="/image" alt="A photo" downloadQuery onEditImage={() => {}} />);
  expect(image).toContain('class="attachment-image-frame"');
  expect(image).toContain('class="attachment-placeholder"');
  expect(image).not.toContain('src="/image"');
  const audio = renderMessage({ attachments: [{ id: "audio", name: "voice.mp3", mimeType: "audio/mpeg", size: 1000 }] });
  const video = renderMessage({ attachments: [{ id: "video", name: "clip.mp4", mimeType: "video/mp4", size: 1000 }] });
  expect(audio).toContain('class="attachment-playback audio"');
  expect(video).toContain('class="attachment-playback video"');
  expect(audio).not.toContain('<audio');
  expect(video).not.toContain('<video');
});

test("group segments can prioritize newest messages in DOM without changing their visual order", () => {
  const html = renderToStaticMarkup(<ChatMessageGroup kind="assistant" label="Sam" newestFirstDom segments={[
    { id: "first", text: "first" }, { id: "last", text: "last" },
  ]} />);
  expect(html).toContain('class="message-segments newest-first-dom"');
  expect(html.indexOf('data-message-id="last"')).toBeLessThan(html.indexOf('data-message-id="first"'));
});

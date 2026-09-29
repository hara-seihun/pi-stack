import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { AttachmentImage, ChatMessage } from "./src/chat-message";
import { DrawingCanvas } from "./src/DrawingCanvas";
import { MessageReactions } from "./src/message-reactions";

test("agent messages keep their header and put actions on the long-press menu", () => {
  const agent = renderToStaticMarkup(<ChatMessage kind="assistant" label="Kenan" avatar="/kenan.png" text="answer" contentFormat="markdown" renderMarkdown={text => <p>{text}</p>} />);
  expect(agent).toContain('class="message assistant');
  expect(agent).toContain('class="message-header"');
  expect(agent).not.toContain('class="message-actions"');
  expect(agent).not.toContain('aria-label="Copy message"');
  const avatar = agent.match(/<img\b[^>]*>/)?.[0];
  expect(avatar).toContain('class="message-avatar"');
  expect(avatar).toContain('src="/kenan.png"');
  expect(avatar).toContain('alt=""');
  expect(agent).toContain('class="message-label">KENAN</span>');
  const literal = renderToStaticMarkup(<ChatMessage kind="user" label="You" text={"**literal** <script>no()</script>"} contentFormat="literal" />);
  expect(literal).toContain("**literal** &lt;script&gt;no()&lt;/script&gt;");
  expect(literal).not.toContain("<script>");
});

test("agent messages show stable reactions and quote replies", () => {
  const identity = { id: "messaging/one", timestamp: 1, sender: { id: "sam", name: "Sam" } };
  const reactions = [{ emoji: "❤️", sender: { id: "me", name: "You" }, timestamp: 2, own: true }];
  const agent = renderToStaticMarkup(<ChatMessage kind="assistant" label="Agent" text="answer" contentFormat="literal" identity={identity} reactions={reactions} />);
  expect(agent).not.toContain('aria-label="Add reaction"');
  expect(agent).toContain('data-own="true"');
  expect(agent).not.toContain('<button');
  expect(agent).toContain("You");
  const reply = { messageId: identity.id, sender: identity.sender, text: "the first message" };
  expect(renderToStaticMarkup(<ChatMessage kind="user" label="You" text="quoted answer" contentFormat="literal" identity={{ ...identity, id: "messaging/two" }} reply={reply} onReply={() => {}} />)).toContain("the first message");
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

test("the image editor owns the image download action", () => {
  const editor = renderToStaticMarkup(<DrawingCanvas background={{ src: "/photo.png", downloadSrc: "/photo.png?download=1", alt: "Photo", name: "photo.png" }} onAttach={async () => ({ ok: true })} onClose={() => {}} />);
  expect(editor).toContain('href="/photo.png?download=1"');
  expect(editor).toContain('download="photo.png"');
  expect(editor).toContain(">Download</a>");

  const paper = renderToStaticMarkup(<DrawingCanvas onAttach={async () => ({ ok: true })} onClose={() => {}} />);
  expect(paper).not.toContain(">Download</a>");
});

test("attachment images reserve geometry without starting offscreen downloads", () => {
  const image = renderToStaticMarkup(<AttachmentImage src="/image" alt="A photo" downloadQuery onEditImage={() => {}} />);
  expect(image).toContain('class="attachment-image-frame"');
  expect(image).toContain('class="attachment-placeholder"');
  expect(image).not.toContain('src="/image"');
});

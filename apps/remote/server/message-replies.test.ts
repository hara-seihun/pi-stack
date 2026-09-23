import { expect, test } from "bun:test";
import { decodeMessageReply, encodeMessageReply, projectMessageReply, replyFromNativeEntry } from "./message-replies";
import { displayContextDocument } from "./context-display";
import { deriveTranscriptItems } from "./transcript-items";

const user = { id: "person", name: "Person" };
const quote = { messageId: "pi/thread/original", sender: user, text: "Original </pi-message-reply>\n\ntext", timestamp: 123 };

test("reply survives native storage and projects to a quote without changing attachments", () => {
  const text = encodeMessageReply("My response", quote);
  expect(decodeMessageReply(text)).toEqual({ text: "My response", reply: quote });
  const image = { type: "image", data: "abc", mimeType: "image/png" };
  const identity = { id: "pi/thread/response", timestamp: 124, sender: user };
  const raw = JSON.stringify({ messages: [{ role: "user", identity, timestamp: 124, content: [{ type: "text", text }, image] }] });
  const document = JSON.parse(displayContextDocument(raw));
  expect(document.messages[0].content).toEqual([{ type: "text", text: "My response" }, image]);
  const head = deriveTranscriptItems(document).find(item => item.head.kind === "user")!.head;
  expect(head).toMatchObject({ text: expect.stringContaining("My response"), identity, reply: quote });
  expect(JSON.parse(raw).messages[0].content[0].text).toBe(text);
});

test("malformed envelopes stay visible instead of eating user text", () => {
  for (const text of ["<pi-message-reply>oops", '<pi-message-reply>{"text":"quote"}</pi-message-reply>\n\nbody', "ordinary text"]) {
    expect(decodeMessageReply(text)).toEqual({ text });
  }
  const assistant = { role: "assistant", content: encodeMessageReply("example", quote) };
  expect(projectMessageReply(assistant)).toBe(assistant);
});

test("native target resolves exact user/assistant IDs, bounded preview and nested replies", () => {
  const entry = { type: "message", id: "original", timestamp: "2026-01-01T00:00:00Z", message: { role: "assistant", content: [{ type: "text", text: "x".repeat(5000) }] } };
  const reply = replyFromNativeEntry("pi/thread/original", entry, user, "Pi")!;
  expect(reply.sender).toEqual({ id: "assistant", name: "Pi" });
  expect(reply.text.length).toBe(4001);
  expect(replyFromNativeEntry("pi/thread/other", entry, user, "Pi")).toBeNull();
  expect(replyFromNativeEntry("messaging/original", entry, user, "Pi")).toBeNull();
  expect(replyFromNativeEntry("pi/thread/original", { ...entry, message: { role: "toolResult" } }, user, "Pi")).toBeNull();
  expect(replyFromNativeEntry("pi/thread/original", { ...entry, message: { role: "user", content: encodeMessageReply("Latest text", quote) } }, user, "Pi")?.text).toBe("Latest text");
});

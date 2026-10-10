import { expect, test } from "bun:test";
import { displayContextMessage } from "./context-display";
import { deriveTranscriptItems } from "./transcript-items";

test("native thinking/tools remain visible without provider continuation metadata or mutation", () => {
  const message = { role: "assistant", timestamp: 2, provider: "openai", responseId: "opaque", stopReason: "toolUse", content: [
    { type: "thinking", thinking: "consider", thinkingSignature: "opaque" },
    { type: "text", text: "answer", textSignature: "opaque" },
    { type: "toolCall", id: "call", name: "read", arguments: { path: "/tmp" } },
  ] };
  expect(displayContextMessage(message)).toEqual({ role: "assistant", timestamp: 2, content: [
    { type: "thinking", thinking: "consider" }, { type: "text", text: "answer" },
    { type: "toolCall", id: "call", name: "read", arguments: { path: "/tmp" } },
  ] });
  expect(message.responseId).toBe("opaque");
});

test("empty replies add no assistant items while authored replies and work remain intact", () => {
  const messages = [
    { role: "assistant", content: [], stopReason: "stop" },
    { role: "assistant", content: [{ type: "text", text: " \n" }, { type: "text", text: "" }], stopReason: "stop" },
    { role: "assistant", content: " \n", stopReason: "stop" },
    { role: "assistant", content: [{ type: "thinking", thinking: "Still considering" }, { type: "text", text: "" }] },
    { role: "assistant", content: [{ type: "toolCall", id: "call", name: "read", arguments: {} }, { type: "text", text: " " }] },
    { role: "assistant", content: [{ type: "text", text: "👍" }, { type: "text", text: " Authored reply " }] },
  ];
  const before = structuredClone(messages);
  const items = deriveTranscriptItems({ messages: messages.map(message => displayContextMessage(message)) });
  expect(items.map(item => item.head.kind)).toEqual(["system", "thinking", "toolCall", "assistant", "assistant"]);
  expect(items.slice(-2).map(item => "text" in item.head && item.head.text)).toEqual(["👍", " Authored reply "]);
  expect(messages).toEqual(before);
});

test("signed Anthropic narration projects as an assistant reply after tools and before a durable wait", () => {
  const field = (number: number, bytes: Buffer): Buffer => Buffer.concat([Buffer.from([number * 8 + 2, bytes.length]), bytes]);
  const signature = (channel: string) => field(2, field(1, field(8, Buffer.from(channel)))).toString("base64");
  const reply = { role: "assistant", api: "anthropic-messages", stopReason: "toolUse", timestamp: 4, content: [
    { type: "thinking", thinking: "Reply delivered after tools", thinkingSignature: signature("narration") },
    { type: "thinking", thinking: "Actual reasoning", thinkingSignature: signature("thinking") },
    { type: "toolCall", id: "wait", name: "thread_wait", arguments: { kind: "agents", threadIds: ["peer"] } },
  ] };
  const before = structuredClone(reply);
  const context = { messages: [
    { role: "assistant", timestamp: 1, content: [{ type: "toolCall", id: "read", name: "read", arguments: {} }] },
    { role: "toolResult", timestamp: 2, toolCallId: "read", content: [{ type: "text", text: "Synthetic result" }] },
    reply,
  ].map(message => displayContextMessage(message)) };
  const items = deriveTranscriptItems(context);
  expect(items.map(item => item.head.kind)).toEqual(["system", "toolCall", "assistant", "thinking", "toolCall"]);
  expect(items[2]!.head).toMatchObject({ kind: "assistant", text: "Reply delivered after tools" });
  expect(JSON.stringify(context)).not.toContain("Signature");
  expect(reply).toEqual(before);
  const runtimeText = { ...reply, content: [{ type: "text", text: "Runtime narration", textSignature: JSON.stringify({ type: "anthropic-narration", signature: signature("narration") }) }] };
  expect(displayContextMessage(runtimeText)).toEqual({ role: "assistant", timestamp: 4, content: [{ type: "text", text: "Runtime narration" }] });
});

test("unknown native messages and image bodies have explicit source-preserving projection", () => {
  const unknown = { role: "future", details: { usage: 1 } };
  expect(displayContextMessage(unknown)).toEqual(unknown);
  const image = { role: "user", content: [{ type: "image", data: "abc", mimeType: "image/png" }] };
  expect(displayContextMessage(image, () => "/image/hash")).toEqual({ role: "user", content: [{ type: "image", src: "/image/hash", mimeType: "image/png" }] });
  expect(image.content[0].data).toBe("abc");
});

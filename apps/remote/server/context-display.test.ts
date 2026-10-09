import { expect, test } from "bun:test";
import { displayAssistantMessage, displayContextMessage } from "./context-display";

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

test("empty successful replies receive a display acknowledgement; failure and thinking/tool-only replies do not", () => {
  const blank = { role: "assistant", content: [{ type: "text", text: " \n" }], stopReason: "stop" };
  expect(displayContextMessage(blank)).toEqual({ role: "assistant", content: [{ type: "text", text: "👍" }] });
  for (const message of [
    { ...blank, stopReason: "aborted", errorMessage: "Request aborted" },
    { ...blank, content: [{ type: "thinking", thinking: "Still considering" }] },
    { ...blank, content: [{ type: "toolCall", id: "call", name: "read", arguments: {} }] },
  ]) expect(displayAssistantMessage(message)).toBe(message);
  expect(blank.content[0].text).toBe(" \n");
});

test("unknown native messages and image bodies have explicit source-preserving projection", () => {
  const unknown = { role: "future", details: { usage: 1 } };
  expect(displayContextMessage(unknown)).toEqual(unknown);
  const image = { role: "user", content: [{ type: "image", data: "abc", mimeType: "image/png" }] };
  expect(displayContextMessage(image, () => "/image/hash")).toEqual({ role: "user", content: [{ type: "image", src: "/image/hash", mimeType: "image/png" }] });
  expect(image.content[0].data).toBe("abc");
});

import { describe, expect, test } from "bun:test";
import { displayContextDocument } from "./context-display";

describe("display context projection", () => {
  test("removes provider continuation metadata without changing visible content", () => {
    const context = {
      systemPrompt: "prompt",
      tools: [{ name: "read", description: "Read", parameters: { type: "object" } }],
      messages: [
        { role: "user", content: "hello", timestamp: 1 },
        {
          role: "assistant",
          api: "responses",
          provider: "openai",
          model: "model",
          usage: { cost: { total: 1 } },
          stopReason: "toolUse",
          responseId: "response",
          rawStopReason: "tool_calls",
          timestamp: 2,
          content: [
            { type: "thinking", thinking: "consider", thinkingSignature: "opaque" },
            { type: "text", text: "answer", textSignature: "opaque" },
            { type: "toolCall", id: "call", name: "read", arguments: { path: "/tmp" } },
          ],
        },
        {
          role: "toolResult",
          toolCallId: "call",
          toolName: "read",
          content: [{ type: "text", text: "result", details: "visible nested value" }],
          details: { providerOnly: true },
          isError: false,
          timestamp: 3,
        },
      ],
    };

    const projected = JSON.parse(displayContextDocument(JSON.stringify(context)));
    expect(projected).toEqual({
      systemPrompt: context.systemPrompt,
      tools: context.tools,
      messages: [
        context.messages[0],
        {
          role: "assistant",
          timestamp: 2,
          content: [
            { type: "thinking", thinking: "consider" },
            { type: "text", text: "answer" },
            { type: "toolCall", id: "call", name: "read", arguments: { path: "/tmp" } },
          ],
        },
        {
          role: "toolResult",
          toolCallId: "call",
          toolName: "read",
          content: [{ type: "text", text: "result", details: "visible nested value" }],
          isError: false,
          timestamp: 3,
        },
      ],
    });
    expect(context.messages[1]).toHaveProperty("responseId", "response");
  });

  test("leaves unknown message and content schemas intact", () => {
    const document = JSON.stringify({ messages: [{ role: "future", details: { usage: 1 } }] });
    expect(JSON.parse(displayContextDocument(document))).toEqual(JSON.parse(document));
  });
});

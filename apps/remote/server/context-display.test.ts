import { describe, expect, test } from "bun:test";
import {
  COMPACTION_CONTINUATION_MESSAGE,
  COMPACTION_NOTICE_TYPE,
  displayContextDocument,
} from "./context-display";

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

  test("presents a compacted request as context compaction once the continuation proves it", () => {
    const context = {
      systemPrompt: "prompt",
      tools: [],
      messages: [
        { role: "assistant", content: [], stopReason: "aborted", errorMessage: "Request aborted", timestamp: 10 },
        { role: "user", content: [{ type: "text", text: COMPACTION_CONTINUATION_MESSAGE }], timestamp: 11 },
      ],
    };

    expect(JSON.parse(displayContextDocument(JSON.stringify(context))).messages).toEqual([
      {
        role: "custom",
        customType: COMPACTION_NOTICE_TYPE,
        content: "Context compacted",
        timestamp: 10,
      },
      context.messages[1],
    ]);
  });

  test("does not disguise an ordinary aborted request", () => {
    const message = { role: "assistant", content: [], stopReason: "aborted", errorMessage: "Request aborted", timestamp: 10 };
    const projected = JSON.parse(displayContextDocument(JSON.stringify({ messages: [message] })));
    expect(projected.messages).toEqual([{ role: "assistant", content: [], errorMessage: "Request aborted", timestamp: 10 }]);
  });

  test("leaves unknown message and content schemas intact", () => {
    const document = JSON.stringify({ messages: [{ role: "future", details: { usage: 1 } }] });
    expect(JSON.parse(displayContextDocument(document))).toEqual(JSON.parse(document));
  });
});

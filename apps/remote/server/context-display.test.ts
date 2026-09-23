import { describe, expect, test } from "bun:test";
import { displayAssistantMessage, displayContextDocument } from "./context-display";
import { messageFinalizationKey } from "./sync";

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

  test("restores streamed thinking omitted from the provider's final message", () => {
    const toolCall = { type: "toolCall", id: "call", name: "read", arguments: { path: "/tmp" } };
    const message = { role: "assistant", timestamp: 4, content: [toolCall] };
    const thinking = new Map([[messageFinalizationKey(message), "Visible while streaming"]]);

    const projected = JSON.parse(displayContextDocument(JSON.stringify({ messages: [message] }), thinking));

    expect(projected.messages[0].content).toEqual([
      { type: "thinking", thinking: "Visible while streaming" },
      toolCall,
    ]);
    expect(message.content).toEqual([toolCall]);
  });

  test("historical continuation text cannot rewrite an assistant error", () => {
    const context = {
      systemPrompt: "prompt",
      tools: [],
      messages: [
        { role: "assistant", content: [], stopReason: "aborted", errorMessage: "Request aborted", timestamp: 10 },
        { role: "user", content: [{ type: "text", text: "your context was compacted, you now have tons of space to keep working as long as you like" }], timestamp: 11 },
      ],
    };

    expect(JSON.parse(displayContextDocument(JSON.stringify(context))).messages).toEqual([
      {
        role: "assistant",
        content: [],
        errorMessage: "Request aborted",
        timestamp: 10,
      },
      context.messages[1],
    ]);
  });

  test("empty successful replies have the same acknowledgement live and in history without changing model text", () => {
    for (const content of [
      [],
      [{ type: "text", text: "", textSignature: '{"v":1,"id":"msg_empty","phase":"final_answer"}' }],
      [{ type: "thinking", thinking: "Considered the request" }, { type: "text", text: " \n\t" }, { type: "text", text: "" }],
    ]) {
      const message = { role: "assistant", content, stopReason: "stop", rawStopReason: "completed", timestamp: 12 };
      const document = JSON.stringify({ messages: [message] });
      const key = messageFinalizationKey(message);
      const live = displayAssistantMessage(message);
      const historical = JSON.parse(displayContextDocument(document)).messages[0];
      expect(live.content).toEqual(historical.content);
      expect(historical.content.filter((block: any) => block.type === "text")).toEqual([{ type: "text", text: "👍" }]);
      expect(JSON.stringify({ messages: [message] })).toBe(document);
      expect(messageFinalizationKey(message)).toBe(key);
    }
  });

  test("only a successful empty final reply receives an acknowledgement", () => {
    const blank = { role: "assistant", content: [{ type: "text", text: "" }], stopReason: "stop" };
    const messages = [
      ...[undefined, "pending", "error", "aborted", "length", "toolUse"].map(stopReason => ({ ...blank, stopReason })),
      { ...blank, role: "user" },
      { ...blank, errorMessage: "Request failed" },
      { ...blank, content: [{ type: "thinking", thinking: "Still considering" }] },
      { ...blank, content: [{ type: "toolCall", id: "call", name: "read", arguments: {} }] },
      { ...blank, content: [...blank.content, { type: "toolCall", id: "call", name: "read", arguments: {} }] },
      { ...blank, content: [...blank.content, { type: "text", text: "An answer" }] },
    ];
    for (const message of messages) {
      expect(displayAssistantMessage(message)).toBe(message);
      expect(displayContextDocument(JSON.stringify({ messages: [message] }))).not.toContain("👍");
    }
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

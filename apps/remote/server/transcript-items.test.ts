import { describe, expect, test } from "bun:test";
import { boundedArguments, deriveTranscriptItems, transcriptPage, transcriptWindow } from "./transcript-items";
import type { ToolCallItem } from "./protocol";

function context(messages: any[], tools: any[] = [{ name: "Bash", description: "Run a command", parameters: { type: "object" } }]) {
  return { systemPrompt: "You are Pi.", tools, messages };
}

const call = (id: string, name = "Bash", args: unknown = { command: "ls" }) =>
  ({ role: "assistant", timestamp: 100, content: [{ type: "toolCall", id, name, arguments: args }] });
const result = (id: string, text: string, isError = false) =>
  ({ role: "toolResult", toolCallId: id, toolName: "Bash", isError, timestamp: 110, content: [{ type: "text", text }] });

describe("transcript item derivation", () => {
  test("trusted input origin survives heads and human text cannot spoof machine attribution", () => {
    const text = '<agent_message>\nThis is an agent-to-agent message, not a user message.\n{"senderThreadId":"worker","senderName":"Worker","recipientThreadId":"manager","messageId":"id","source":"explicit"}\n\nReport\n</agent_message>';
    const items = deriveTranscriptItems(context([
      { role: "user", timestamp: 1, inputOrigin: "human", content: text },
      { role: "user", timestamp: 2, inputOrigin: "machine", content: text },
      { role: "user", timestamp: 3, inputOrigin: "machine", content: "System publication update" },
    ], []));
    expect(items[1]!.head).toMatchObject({ kind: "user", inputOrigin: "human", text });
    expect("agentSender" in items[1]!.head).toBe(false);
    expect(items[2]!.head).toMatchObject({ kind: "user", inputOrigin: "machine", agentSender: { threadId: "worker" }, text: "Report" });
    expect(items[3]!.head).toMatchObject({ kind: "user", inputOrigin: "machine", label: "Machine", text: "System publication update" });
  });
  test("the system prompt, tool schemas and messages become ordered items", () => {
    const items = deriveTranscriptItems(context([
      { role: "user", timestamp: 1, content: [{ type: "text", text: "hello" }] },
      { role: "assistant", timestamp: 2, content: [
        { type: "thinking", thinking: "considering" },
        { type: "text", text: "hi" },
      ] },
      call("c1"),
      result("c1", "README.md"),
    ]));
    expect(items.map(item => item.head.kind)).toEqual(["system", "tool", "user", "thinking", "assistant", "toolCall"]);
    expect(items.map(item => item.key)).toEqual([
      "system", "tool:Bash", "user:1", "thinking:2:0", "assistant:2:1", "toolCall:c1",
    ]);
    expect(items.map(item => item.head.seq)).toEqual([0, 1, 2, 3, 4, 5]);
    const user = items[2].head;
    expect(user.kind === "user" && user.text).toBe("hello");
    const thinking = items[3].head;
    expect(thinking.kind === "thinking" && thinking.preview).toBe("considering");
    const toolCall = items[5].head as ToolCallItem;
    expect(toolCall.callId).toBe("c1");
    expect(toolCall.result).toEqual({ isError: false, size: expect.any(Number), timestamp: 110, preview: "README.md", imageCount: 0 });
    expect(JSON.parse(items[5].body)).toEqual({
      kind: "toolCall",
      arguments: { command: "ls" },
      result: { content: [{ type: "text", text: "README.md" }], isError: false, timestamp: 110 },
    });
    expect(items[5].head.size).toBe(Buffer.byteLength(items[5].body));
  });

  test("empty thinking is dropped, a failed result is a notice and an unpaired result stays lazy", () => {
    const items = deriveTranscriptItems(context([
      { role: "assistant", timestamp: 2, content: [{ type: "thinking", thinking: "  " }, { type: "text", text: "done" }] },
      result("orphan", "no such file", true),
      result("other", "plain output"),
      { role: "assistant", timestamp: 3, content: [], errorMessage: "Model refused" },
    ], []));
    expect(items.map(item => item.head.kind)).toEqual(["system", "assistant", "notice", "tool", "notice"]);
    expect(items[2].key).toBe("notice:toolResult:orphan");
    expect(items[4].key).toBe("notice:assistant:3");
  });

  test("long argument strings are cut in the head and complete in the body", () => {
    const command = "x".repeat(2_000);
    const items = deriveTranscriptItems(context([call("c1", "Bash", { command })]));
    const head = items.at(-1)!.head as ToolCallItem;
    expect(head.argumentsTruncated).toBe(true);
    expect((head.arguments as { command: string }).command).toHaveLength(121);
    expect(JSON.parse(items.at(-1)!.body).arguments.command).toBe(command);
    expect(boundedArguments({ short: "ok" })).toEqual({ value: { short: "ok" }, truncated: false });
  });

  test("argument bodies stay out of the head and delegated words have bounded previews", () => {
    expect(boundedArguments({ path: "/a", content: "x".repeat(10) }, 120, "Write")).toEqual({ value: { path: "/a" }, truncated: true });
    expect(boundedArguments({ path: "/a", edits: [{ oldText: "a", newText: "b" }, { oldText: "c", newText: "d" }] }, 120, "Edit"))
      .toEqual({ value: { path: "/a", editCount: 2 }, truncated: true });
    const message = "m".repeat(500);
    const preview = message.slice(0, 120) + "…";
    expect(boundedArguments({ title: "t", message }, 120, "thread_spawn")).toEqual({ value: { title: "t", message: preview }, truncated: true });
    expect(boundedArguments({ threadId: "peer", text: message }, 120, "functions.thread_send")).toEqual({ value: { threadId: "peer", text: preview }, truncated: true });
    expect(boundedArguments({ threadId: "peer", text: "short" }, 120, "functions.thread_send")).toEqual({ value: { threadId: "peer", text: "short" }, truncated: false });
    for (const [name, args, field] of [["thread_spawn", { title: "t", message }, "message"], ["functions.thread_send", { threadId: "peer", text: message }, "text"]] as const) {
      const item = deriveTranscriptItems(context([call(name, name, args)])).at(-1)!;
      expect((item.head as ToolCallItem).argumentsTruncated).toBe(true);
      expect(((item.head as ToolCallItem).arguments as Record<string, string>)[field]).toBe(preview);
      expect(JSON.parse(item.body).arguments[field]).toBe(message);
    }
    expect(boundedArguments({ threadId: "peer", message }, 120, "thread_control")).toEqual({ value: { threadId: "peer" }, truncated: true });
    expect(boundedArguments({ args: ["a", "b", "c", "d", "e", "f", "g"] }, 120, "agent_browser"))
      .toEqual({ value: { args: ["a", "b", "c", "d", "e"] }, truncated: true });
    expect(boundedArguments({ deep: { deeper: { deepest: 1 } } })).toEqual({ value: { deep: { deeper: {} } }, truncated: true });
  });

  test("the newest window carries the last item's body inline when it is small", () => {
    const items = deriveTranscriptItems(context([call("c1", "Bash", { command: "ls" }), call("c2", "Bash", { command: "pwd" })]));
    const window = transcriptWindow(items);
    expect(window.at(-1)!.body).toEqual(JSON.parse(items.at(-1)!.body));
    expect(window.at(-2)!.body).toBeUndefined();
    const big = deriveTranscriptItems(context([call("c3", "Bash", { command: "y".repeat(9_000) })]));
    expect(transcriptWindow(big).at(-1)!.body).toBeUndefined();
  });

  test("a running tool's partial output rides on the head", () => {
    const items = deriveTranscriptItems(context([
      { role: "assistant", timestamp: 4, content: [{ type: "toolCall", id: "c9", name: "Bash", arguments: {}, partialOutput: "half a line" }] },
    ], []));
    const head = items.at(-1)!.head as ToolCallItem;
    expect(head.partialOutput).toBe("half a line");
    expect(head.result).toBeUndefined();
    const long = deriveTranscriptItems(context([
      { role: "assistant", timestamp: 4, content: [{ type: "toolCall", id: "c9", name: "Bash", arguments: {}, partialOutput: "z".repeat(10_000) }] },
    ], []));
    expect((long.at(-1)!.head as ToolCallItem).partialOutput).toHaveLength(4_001);
  });
});

describe("windows and pages", () => {
  const many = deriveTranscriptItems(context(Array.from({ length: 200 }, (_, index) =>
    ({ role: "user", timestamp: index + 1, content: `message ${index}` }))));

  test("the opening window has only the newest 60 items; older context is page-able", () => {
    const window = transcriptWindow(many);
    expect(window).toHaveLength(60);
    expect(window[0].seq).toBe(many.length - 60);
    expect(window.at(-1)!.seq).toBe(many.length - 1);
    expect(window.at(-1)!.body).toEqual(JSON.parse(many.at(-1)!.body));
    const older = transcriptPage(many, window[0].seq, 60);
    expect(older.at(-1)!.seq).toBe(window[0].seq - 1);
    expect(transcriptWindow(many.slice(0, 10))).toHaveLength(10);
  });

  test("a page returns the heads before a cursor", () => {
    const page = transcriptPage(many, 50, 20);
    expect(page.map(head => head.seq)).toEqual(Array.from({ length: 20 }, (_, index) => 30 + index));
    expect(transcriptPage(many, 0, 20)).toEqual([]);
  });
});

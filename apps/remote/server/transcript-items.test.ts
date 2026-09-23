import { describe, expect, test } from "bun:test";
import { boundedArguments, deriveTranscriptItems, transcriptPage, TranscriptItems, transcriptWindow } from "./transcript-items";
import type { ToolCallItem } from "./protocol";

function context(messages: any[], tools: any[] = [{ name: "Bash", description: "Run a command", parameters: { type: "object" } }]) {
  return { systemPrompt: "You are Pi.", tools, messages };
}

const call = (id: string, name = "Bash", args: unknown = { command: "ls" }) =>
  ({ role: "assistant", timestamp: 100, content: [{ type: "toolCall", id, name, arguments: args }] });
const result = (id: string, text: string, isError = false) =>
  ({ role: "toolResult", toolCallId: id, toolName: "Bash", isError, timestamp: 110, content: [{ type: "text", text }] });

describe("transcript item derivation", () => {
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

  test("argument bodies stay out of the head: written content, edit texts, delegated messages", () => {
    expect(boundedArguments({ path: "/a", content: "x".repeat(10) }, 120, "Write")).toEqual({ value: { path: "/a" }, truncated: true });
    expect(boundedArguments({ path: "/a", edits: [{ oldText: "a", newText: "b" }, { oldText: "c", newText: "d" }] }, 120, "Edit"))
      .toEqual({ value: { path: "/a", editCount: 2 }, truncated: true });
    expect(boundedArguments({ title: "t", message: "m".repeat(5) }, 120, "thread_spawn")).toEqual({ value: { title: "t" }, truncated: true });
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

describe("generations", () => {
  const messages = [{ role: "user", timestamp: 1, content: [{ type: "text", text: "hello" }] }, call("c1")];

  test("a landing result keeps the generation without retaining the previous diff", () => {
    const items = new TranscriptItems();
    const first = items.derive("s", "hash-1", () => context(messages));
    const unchanged = items.derive("s", "hash-1", () => { throw new Error("should not rebuild"); });
    expect(unchanged.current).toBe(first.current);
    const second = items.derive("s", "hash-2", () => context([...messages, result("c1", "README.md")]));
    expect(Object.keys(second)).toEqual(["current"]);
    expect(second.current.generation).toBe(first.current.generation);
    expect(second.current.items.at(-1)!.head.id).not.toBe(first.current.items.at(-1)!.head.id);
  });

  test("appended messages extend the generation", () => {
    const items = new TranscriptItems();
    const first = items.derive("s", "hash-1", () => context(messages));
    const second = items.derive("s", "hash-2", () => context([...messages, { role: "user", timestamp: 9, content: "next" }]));
    expect(second.current.generation).toBe(first.current.generation);
    expect(second.current.items).toHaveLength(first.current.items.length + 1);
  });

  test("a compaction or branch replacement mints a new generation", () => {
    const items = new TranscriptItems();
    const first = items.derive("s", "hash-1", () => context(messages));
    const compacted = items.derive("s", "hash-3", () => context([{ role: "user", timestamp: 50, content: "summary" }]));
    expect(compacted.current.generation).not.toBe(first.current.generation);
    const branch = items.derive("s", "hash-4", () => context([{ role: "user", timestamp: 51, content: "another branch" }]));
    expect(branch.current.generation).not.toBe(compacted.current.generation);
  });

  test("bodies are addressed by their hash and forgotten with the session", () => {
    const items = new TranscriptItems(1);
    const derived = items.derive("s", "hash-1", () => context(messages));
    const head = derived.current.items[2].head;
    expect(JSON.parse(derived.current.bodies.get(head.id)!)).toEqual({ kind: "user", text: "hello" });
    items.derive("other", "hash-1", () => context(messages));
    expect(items.get("s")).toBeNull();
  });

  test("the byte budget evicts cold sessions while keeping cached bodies", () => {
    const items = new TranscriptItems(8, 1_000);
    const first = items.derive("first", "h1", () => context([{ role: "user", timestamp: 1, content: "x".repeat(180) }], []));
    items.derive("second", "h2", () => context([{ role: "user", timestamp: 2, content: "y".repeat(180) }], []));
    expect(items.get("first")).toBeNull();
    expect(items.get("second")?.bodies.get(first.current.items[1].head.id)).toBeUndefined();
    const second = items.get("second")!;
    expect(second.bodies.get(second.items[1].head.id)).toBe(second.items[1].body);
  });

  test("oversized contexts stay page-able without occupying the cache", () => {
    const items = new TranscriptItems(8, 100);
    const load = () => context([{ role: "user", timestamp: 1, content: "x".repeat(500) }]);
    const first = items.derive("large", "hash", load);
    const second = items.derive("large", "hash", load);
    expect(items.get("large")).toBeNull();
    expect(second.current.generation).toBe(first.current.generation);
    const appended = items.derive("large", "hash-2", () => context([
      { role: "user", timestamp: 1, content: "x".repeat(500) },
      { role: "user", timestamp: 2, content: "later" },
    ]));
    expect(appended.current.generation).toBe(first.current.generation);
    expect(second.current.bodies.get(second.current.items.at(-1)!.head.id)).toBeTruthy();
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

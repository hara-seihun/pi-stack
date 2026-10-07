import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";

let db: Database;
beforeEach(() => { db = new Database(":memory:"); });
afterEach(() => db.close());
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

  test("argument bodies stay out of the head, except words one agent says to another", () => {
    expect(boundedArguments({ path: "/a", content: "x".repeat(10) }, 120, "Write")).toEqual({ value: { path: "/a" }, truncated: true });
    expect(boundedArguments({ path: "/a", edits: [{ oldText: "a", newText: "b" }, { oldText: "c", newText: "d" }] }, 120, "Edit"))
      .toEqual({ value: { path: "/a", editCount: 2 }, truncated: true });
    const message = "m".repeat(500);
    expect(boundedArguments({ title: "t", message }, 120, "thread_spawn")).toEqual({ value: { title: "t", message }, truncated: false });
    expect(boundedArguments({ threadId: "peer", text: message }, 120, "functions.thread_send")).toEqual({ value: { threadId: "peer", text: message }, truncated: false });
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

describe("generations", () => {
  const messages = [{ role: "user", timestamp: 1, content: [{ type: "text", text: "hello" }] }, call("c1")];

  test("a landing result keeps the generation without retaining the previous diff", () => {
    const items = new TranscriptItems(db);
    const first = items.derive("s", "hash-1", () => context(messages));
    const unchanged = items.derive("s", "hash-1", () => { throw new Error("should not rebuild"); });
    expect(unchanged.current).toBe(first.current);
    const second = items.derive("s", "hash-2", () => context([...messages, result("c1", "README.md")]));
    expect(Object.keys(second)).toEqual(["current"]);
    expect(second.current.generation).toBe(first.current.generation);
    const firstId = deriveTranscriptItems(context(messages)).at(-1)!.head.id;
    expect(items.window("s").at(-1)!.id).not.toBe(firstId);
  });

  test("appended messages extend the generation", () => {
    const items = new TranscriptItems(db);
    const first = items.derive("s", "hash-1", () => context(messages));
    const second = items.derive("s", "hash-2", () => context([...messages, { role: "user", timestamp: 9, content: "next" }]));
    expect(second.current.generation).toBe(first.current.generation);
    expect(second.current.total).toBe(first.current.total + 1);
  });

  test("a compaction or branch replacement mints a new generation", () => {
    const items = new TranscriptItems(db);
    const first = items.derive("s", "hash-1", () => context(messages));
    const compacted = items.derive("s", "hash-3", () => context([{ role: "user", timestamp: 50, content: "summary" }]));
    expect(compacted.current.generation).not.toBe(first.current.generation);
    const branch = items.derive("s", "hash-4", () => context([{ role: "user", timestamp: 51, content: "another branch" }]));
    expect(branch.current.generation).not.toBe(compacted.current.generation);
  });

  test("bodies are addressed by their hash and forgotten with the session", () => {
    const items = new TranscriptItems(db, 1);
    items.derive("s", "hash-1", () => context(messages));
    const head = items.page("s", 3, 1)[0];
    expect(JSON.parse(items.body("s", head.id)!)).toEqual({ kind: "user", text: "hello" });
    items.derive("other", "hash-1", () => context(messages));
    expect(items.get("s")).toBeNull();
    expect(items.body("s", head.id)).toBeUndefined();
    expect(db.query("SELECT COUNT(*) AS count FROM transcript_items WHERE session_id='s'").get()).toEqual({ count: 0 });
  });

  test("oversized heads and bodies remain available with no metadata memory budget", () => {
    const items = new TranscriptItems(db, 8, 0);
    const text = "complete text 🌿".repeat(100_000);
    const messages = Array.from({ length: 200 }, (_, i) => ({ role: "user", timestamp: i + 1, content: `message ${i}` }));
    const source = context([...messages, call("large"), result("large", text)], []);
    const first = items.derive("large", "hash", () => source);
    const second = items.derive("large", "hash", () => { throw new Error("unchanged oversized transcript must not load"); });
    expect(second.current).toEqual(first.current);
    expect(items.byteSize).toBe(0);
    const window = items.window("large");
    const bodyId = window.at(-1)!.id;
    expect(JSON.parse(items.body("large", bodyId)!).result.content[0].text).toBe(text);
    expect(window.at(-1)!.body).toBeUndefined();
    const older = items.page("large", window[0].seq, 60);
    expect(older.at(-1)!.seq).toBe(window[0].seq - 1);
    expect(items.page("large", window[0].seq, 60)).toEqual(older);
    const appended = items.derive("large", "hash-2", () => ({ ...source, messages: [...source.messages,
      { role: "user", timestamp: 999, content: "later" }] }));
    expect(appended.current.generation).toBe(first.current.generation);
    expect(items.page("large", window[0].seq, 60)).toEqual(older);
    expect(JSON.parse(items.body("large", bodyId)!).result.content[0].text).toBe(text);
    expect(items.window("large").at(-1)!.body).toEqual({ kind: "user", text: "later" });
    expect(items.byteSize).toBe(0);
    items.forget("large");
    expect(items.get("large")).toBeNull();
    expect(items.body("large", bodyId)).toBeUndefined();
    expect(items.page("large", 9999, 60)).toEqual([]);
    expect(db.query("SELECT COUNT(*) AS count FROM transcript_items").get()).toEqual({ count: 0 });
    expect(db.query("SELECT COUNT(*) AS count FROM transcript_generations").get()).toEqual({ count: 0 });
  });

  test("metadata eviction and supervisor restart do not require whole-context loading", () => {
    const items = new TranscriptItems(db, 8, 300);
    for (const name of ["a", "b", "c", "d"]) {
      items.derive(name, "hash", () => context(messages));
      expect(items.byteSize).toBeLessThanOrEqual(300);
    }
    const restarted = new TranscriptItems(db, 8, 0);
    const current = restarted.derive("a", "hash", () => { throw new Error("must read materialized transcript"); }).current;
    expect(current.total).toBe(4);
    expect(restarted.window("a")).toEqual(items.window("a"));
    const old = items.get("a")!;
    items.invalidate("a");
    let loaded = 0;
    const refreshed = items.derive("a", "hash", () => { loaded++; return context(messages); });
    expect(loaded).toBe(1);
    expect(refreshed.current.generation).toBe(old.generation);
    items.derive("a", "hash", () => { throw new Error("must reuse after invalidation is consumed"); });
  });

  test("failed materialization rolls back heads, bodies and generation together", () => {
    let generations = 0;
    const items = new TranscriptItems(db, 8, 1000, () => {
      if (++generations === 2) throw new Error("generation failed");
      return "first-generation";
    });
    const first = items.derive("s", "hash-1", () => context(messages));
    const heads = items.window("s");
    const body = items.body("s", heads.at(-1)!.id);
    expect(() => items.derive("s", "hash-2", () => context([]))).toThrow("generation failed");
    expect(items.get("s")).toEqual(first.current);
    expect(items.window("s")).toEqual(heads);
    expect(items.body("s", heads.at(-1)!.id)).toBe(body);
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

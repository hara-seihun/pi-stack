import { describe, expect, test } from "bun:test";
import { ARGUMENT_STRING_LIMIT, boundedArguments } from "../server/transcript-items";
import { duration, shortPath, toolSummary } from "./src/features/conversation/tool-summary";

describe("toolSummary", () => {
  const cases: Array<[string, Record<string, unknown>, string]> = [
    ["bash", { command: "npm test" }, "$ npm test"],
    ["exec_command", { cmd: "npm run build" }, "$ npm run build"],
    ["read", { path: "/home/kenan/app.ts", offset: 5, limit: 3 }, "read ~/app.ts:5-7"],
    ["edit", { path: "/home/kenan/app.ts", edits: [{}, {}] }, "edit ~/app.ts · 2 changes"],
    ["write", { path: "/home/kenan/app.ts" }, "write ~/app.ts"],
    ["agent_browser", { url: "https://example.com/a" }, "agent_browser https://example.com/a"],
    ["thread_spawn", { title: "Check the build" }, "thread_spawn Check the build"],
    ["thread_send", { threadId: "thread-1" }, "thread_send thread-1"],
    ["thread_read", { thread_id: "thread-2" }, "thread_read thread-2"],
    ["thread_await", { threadIds: ["thread-3"] }, "thread_await thread-3"],
    ["thread_control", { threadId: "thread-4" }, "thread_control thread-4"],
    ["image_generation", { prompt: "A graphite drawing of a small observatory" }, "image_generation A graphite drawing of a small observatory"],
    ["grep", { pattern: "needle", path: "/home/kenan/src" }, "grep needle · ~/src"],
    ["find", { path: "/home/kenan/src", pattern: "*.ts" }, "find ~/src · *.ts"],
    ["ls", { path: "/home/kenan/src" }, "ls ~/src"],
  ];

  for (const [name, args, expected] of cases) {
    test(name, () => expect(toolSummary(name, args, "/home/kenan")).toBe(expected));
  }

  test("agent_browser uses the first positional argument when there is no URL", () => {
    expect(toolSummary("agent_browser", { args: ["snapshot", "-i"] })).toBe("agent_browser snapshot");
  });

  test("unknown tools include their original name and no more than a 60-character JSON head", () => {
    const summary = toolSummary("custom_tool", { value: "x".repeat(100) });
    expect(summary.startsWith("custom_tool {")).toBe(true);
    expect(summary.slice("custom_tool ".length)).toHaveLength(60);
  });
});

describe("tool summary helpers", () => {
  test("shortens home paths", () => {
    expect(shortPath("/home/kenan", "/home/kenan")).toBe("~");
    expect(shortPath("/home/kenan/src/a.ts", "/home/kenan")).toBe("~/src/a.ts");
    expect(shortPath("/srv/a.ts", "/home/kenan")).toBe("/srv/a.ts");
  });

  test("formats elapsed durations", () => {
    expect(duration(999)).toBe("0s");
    expect(duration(65_000)).toBe("1m 5s");
    expect(duration(3_660_000)).toBe("1h 1m");
  });

});

// Heads carry only what names the step: strings cut at 120 characters, arrays
// at five entries, and bodies (a written file's content, an edit's edits, a
// delegated message) left out. `boundedArguments` is what the supervisor
// sends, so the summaries are checked against its real output.
describe("summaries of the arguments a head actually carries", () => {
  const slim = (name: string, args: Record<string, unknown>) => boundedArguments(args, ARGUMENT_STRING_LIMIT, name).value;

  test("edit counts its changes without the edits", () => {
    const args = slim("edit", { path: "/home/kenan/app.ts", edits: [{ oldText: "a", newText: "b" }, { oldText: "c", newText: "d" }] });
    expect(args).toEqual({ path: "/home/kenan/app.ts", editCount: 2 });
    expect(toolSummary("edit", args, "/home/kenan")).toBe("edit ~/app.ts · 2 changes");
    expect(toolSummary("edit", slim("edit", { path: "/home/kenan/app.ts", edits: [{ oldText: "a", newText: "b" }] }), "/home/kenan")).toBe("edit ~/app.ts");
  });

  test("every other tool still names its step from the head", () => {
    const cases: Array<[string, Record<string, unknown>, string]> = [
      ["write", { path: "/home/kenan/app.ts", content: "x".repeat(5_000) }, "write ~/app.ts"],
      ["bash", { command: "npm test", timeout: 30 }, "$ npm test"],
      ["read", { path: "/home/kenan/app.ts", offset: 5, limit: 3 }, "read ~/app.ts:5-7"],
      ["grep", { pattern: "needle", path: "/home/kenan/src" }, "grep needle · ~/src"],
      ["ls", { path: "/home/kenan/src" }, "ls ~/src"],
      ["agent_browser", { args: ["open", "https://example.com/a", "snapshot", "-i", "click", "@ref"] }, "agent_browser https://example.com/a"],
      ["thread_send", { threadId: "thread-1", text: "a".repeat(4_000) }, "thread_send thread-1"],
      ["thread_spawn", { title: "Check the build", message: "a".repeat(4_000) }, "thread_spawn Check the build"],
      ["image_generation", { prompt: "A graphite drawing of a small observatory", outputPath: "/tmp/a.png" }, "image_generation A graphite drawing of a small observatory"],
    ];
    for (const [name, args, expected] of cases) expect(toolSummary(name, slim(name, args), "/home/kenan")).toBe(expected);
  });

  test("a command longer than the head's limit is summarised from what arrived", () => {
    const args = slim("bash", { command: `echo ${"x".repeat(400)}` }) as { command: string };
    expect(args.command).toHaveLength(ARGUMENT_STRING_LIMIT + 1);
    expect(toolSummary("bash", args)).toBe(`$ ${args.command}`);
  });
});

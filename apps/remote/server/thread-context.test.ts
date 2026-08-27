import { describe, expect, test } from "bun:test";
import { surfacedInAssistantReply, threadStateInstructions } from "./thread-context-state";

describe("thread lifecycle context", () => {
  test("offers initialization only to a numeric thread", () => {
    const fresh = threadStateInstructions({ name: "83", prompt: "Fix it", fileTag: "pi-file", home: "/home/a" });
    expect(fresh).toContain("new, uninitialized thread");
    expect(fresh).toContain("call initialize_thread once");

    const existing = threadStateInstructions({ name: "Fix Runtime", prompt: "Fix it", fileTag: "pi-file", home: "/home/a" });
    expect(existing).toContain("continuing \"Fix Runtime\"");
    expect(existing).toContain("Do not call initialize_thread");
    expect(existing).not.toContain("new, uninitialized thread");
    expect(existing).toContain('<pi-file src="/home/a/path/to/file" />');
    expect(existing).toContain("download link");
  });

  test("marks an interrupted prompt as the same unfinished task", () => {
    const instructions = threadStateInstructions({
      name: "Fix Runtime",
      prompt: "The previous agent operation was interrupted. Continue its unfinished work.",
      fileTag: "pi-file",
      home: "/home/a",
    });
    expect(instructions).toContain("resumes an interrupted operation in the same task");
    expect(instructions).toContain("without repeating setup or completed actions");
  });
});

describe("alert delivery", () => {
  test("requires alert text in a visible assistant reply before consumption", () => {
    const failed = [
      { role: "toolResult", content: [{ type: "text", text: "Machine overheated" }] },
      { role: "assistant", content: [{ type: "thinking", thinking: "I saw the alert" }] },
    ];
    expect(surfacedInAssistantReply(failed, "Machine overheated")).toBe(false);

    const surfaced = [
      ...failed,
      { role: "assistant", content: [{ type: "text", text: "MACHINE ALERT: Machine overheated" }] },
    ];
    expect(surfacedInAssistantReply(surfaced, "Machine overheated")).toBe(true);
  });
});

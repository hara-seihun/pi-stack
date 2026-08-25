import { describe, expect, test } from "bun:test";
import { retainedSkillContext, surfacedInAssistantReply, threadStateInstructions } from "./thread-context-state";

const skill = {
  name: "software-engineering",
  description: "Mandatory software engineering principles and defaults.",
  filePath: "/skills/software-engineering/SKILL.md",
};

function branchWithSkill(body = "# Engineering\n\nKeep state durable.") {
  return [
    {
      type: "message",
      id: "skill-call-entry",
      message: {
        role: "assistant",
        content: [{
          type: "toolCall",
          id: "read-skill",
          name: "read",
          arguments: { path: skill.filePath },
        }],
      },
    },
    {
      type: "message",
      id: "skill-result-entry",
      message: {
        role: "toolResult",
        toolCallId: "read-skill",
        toolName: "read",
        content: [{ type: "text", text: body }],
        isError: false,
        timestamp: 1234,
      },
    },
  ];
}

describe("thread lifecycle context", () => {
  test("offers initialization only to a numeric thread", () => {
    const fresh = threadStateInstructions({ name: "83", prompt: "Fix it", imageTag: "pi-image", home: "/home/a" });
    expect(fresh).toContain("new, uninitialized thread");
    expect(fresh).toContain("call initialize_thread once");

    const existing = threadStateInstructions({ name: "Fix Runtime", prompt: "Fix it", imageTag: "pi-image", home: "/home/a" });
    expect(existing).toContain("continuing \"Fix Runtime\"");
    expect(existing).toContain("Do not call initialize_thread");
    expect(existing).not.toContain("new, uninitialized thread");
  });

  test("marks an interrupted prompt as the same unfinished task", () => {
    const instructions = threadStateInstructions({
      name: "Fix Runtime",
      prompt: "The previous agent operation was interrupted. Continue its unfinished work.",
      imageTag: "pi-image",
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

describe("mandatory skill retention", () => {
  test("restores exact loaded content after compaction removes the read result", () => {
    const retained = retainedSkillContext({
      branch: branchWithSkill(),
      skills: [skill],
      cwd: "/work",
      readCurrent: () => "# Engineering\n\nKeep state durable.\n",
    });
    const text = (retained?.content as Array<{ text: string }>)[0].text;
    expect(text).toContain("These mandatory skills were already loaded");
    expect(text).toContain("# Engineering\n\nKeep state durable.");
    expect(text).toContain(skill.filePath);
  });

  test("marks the loaded result for state-compactor deduplication and retention", () => {
    const retained = retainedSkillContext({
      branch: branchWithSkill(),
      skills: [skill],
      cwd: "/work",
      readCurrent: () => "# Engineering\n\nKeep state durable.",
    });
    expect(retained?.stateCompactor).toEqual({
      pin: true,
      id: "pi-remote.mandatory-skills",
      replacesToolCallIds: ["read-skill"],
    });
    expect(retained?.timestamp).toBe(1234);
  });

  test("combines paged reads once the whole skill has been loaded", () => {
    const branch = [
      {
        type: "message", id: "page-1-call", message: { role: "assistant", content: [{
          type: "toolCall", id: "page-1", name: "read", arguments: { path: skill.filePath, limit: 2 },
        }] },
      },
      {
        type: "message", id: "page-1-result", message: { role: "toolResult", toolCallId: "page-1", isError: false,
          content: [{ type: "text", text: "one\ntwo\n\n[2 more lines in file. Use offset=3 to continue.]" }], timestamp: 10 },
      },
      {
        type: "message", id: "page-2-call", message: { role: "assistant", content: [{
          type: "toolCall", id: "page-2", name: "read", arguments: { path: skill.filePath, offset: 3 },
        }] },
      },
      {
        type: "message", id: "page-2-result", message: { role: "toolResult", toolCallId: "page-2", isError: false,
          content: [{ type: "text", text: "three\nfour" }], timestamp: 11 },
      },
    ];
    const retained = retainedSkillContext({
      branch,
      skills: [skill],
      cwd: "/work",
      readCurrent: () => "one\ntwo\nthree\nfour",
    });
    const text = (retained?.content as Array<{ text: string }>)[0].text;
    expect(text).toContain("one\ntwo\nthree\nfour");
    expect(retained?.stateCompactor?.replacesToolCallIds).toEqual(["page-1", "page-2"]);
  });

  test("requests the next page when a mandatory skill was only partly loaded", () => {
    const branch = [
      {
        type: "message", id: "page-1-call", message: { role: "assistant", content: [{
          type: "toolCall", id: "page-1", name: "read", arguments: { path: skill.filePath, limit: 2 },
        }] },
      },
      {
        type: "message", id: "page-1-result", message: { role: "toolResult", toolCallId: "page-1", isError: false,
          content: [{ type: "text", text: "one\ntwo\n\n[2 more lines in file. Use offset=3 to continue.]" }], timestamp: 10 },
      },
    ];
    const retained = retainedSkillContext({
      branch,
      skills: [skill],
      cwd: "/work",
      readCurrent: () => "one\ntwo\nthree\nfour",
    });
    const text = (retained?.content as Array<{ text: string }>)[0].text;
    expect(text).toContain(`continue ${skill.filePath} with offset=3`);
  });

  test("requires a fresh read when the skill file changed", () => {
    const retained = retainedSkillContext({
      branch: branchWithSkill(),
      skills: [skill],
      cwd: "/work",
      readCurrent: () => "# Engineering\n\nNew instructions.",
    });
    const text = (retained?.content as Array<{ text: string }>)[0].text;
    expect(text).toContain("Mandatory skill refresh required");
    expect(text).toContain(skill.filePath);
    expect(retained?.stateCompactor?.replacesToolCallIds).toEqual([]);
  });

  test("a current reread supersedes stale historical skill content", () => {
    const branch = [
      ...branchWithSkill(),
      {
        type: "message", id: "reread-call", message: { role: "assistant", content: [{
          type: "toolCall", id: "reread", name: "read", arguments: { path: skill.filePath },
        }] },
      },
      {
        type: "message", id: "reread-result", message: { role: "toolResult", toolCallId: "reread", isError: false,
          content: [{ type: "text", text: "# Engineering\n\nNew instructions." }], timestamp: 2000 },
      },
    ];
    const retained = retainedSkillContext({
      branch,
      skills: [skill],
      cwd: "/work",
      readCurrent: () => "# Engineering\n\nNew instructions.",
    });
    const text = (retained?.content as Array<{ text: string }>)[0].text;
    expect(text).toContain("# Engineering\n\nNew instructions.");
    expect(text).not.toContain("Mandatory skill refresh required");
    expect(retained?.stateCompactor?.replacesToolCallIds).toEqual(["reread"]);
  });

  test("does not pin an ordinary task-specific skill", () => {
    const retained = retainedSkillContext({
      branch: branchWithSkill(),
      skills: [{ ...skill, description: "Use when repairing a specific service." }],
      cwd: "/work",
      readCurrent: () => "# Engineering\n\nKeep state durable.",
    });
    expect(retained).toBeNull();
  });
});

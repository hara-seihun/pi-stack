import { describe, expect, test } from "bun:test";
import { groupTranscriptEntries } from "./src/transcript-groups";
import type { ContextEntry } from "./src/types";

const entry = (key: string, kind: string): ContextEntry => ({ key, kind, signature: key, text: key });

describe("transcript detail groups", () => {
  test("keeps user and assistant messages visible while combining surrounding boxes", () => {
    const grouped = groupTranscriptEntries([
      entry("system", "system"),
      entry("tool-schema", "tool"),
      entry("user", "user"),
      entry("thinking", "thinking"),
      entry("read", "toolCall"),
      entry("assistant", "assistant"),
      entry("notice", "notice"),
    ]);

    expect(grouped.map((item) => item.kind)).toEqual(["details", "message", "details", "message", "details"]);
    expect(grouped[0]?.kind === "details" && grouped[0].entries.map((item) => item.key)).toEqual(["system", "tool-schema"]);
    expect(grouped[2]?.kind === "details" && grouped[2].entries.map((item) => item.key)).toEqual(["thinking", "read"]);
  });

  test("adds new work boxes to the current group", () => {
    const grouped = groupTranscriptEntries([
      entry("user", "user"),
      entry("thinking", "thinking"),
      entry("read", "toolCall"),
      entry("edit", "toolCall"),
    ]);

    expect(grouped).toHaveLength(2);
    expect(grouped[1]?.kind === "details" && grouped[1].entries).toHaveLength(3);
    expect(grouped[1]?.key).toBe("details-after:user");
  });
});

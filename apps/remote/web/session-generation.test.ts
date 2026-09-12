import { describe, expect, test } from "bun:test";
import type { ThreadSettings } from "../server/protocol";
import { documentBase, sameSessionGeneration, settingsForGeneration } from "./src/session-generation";

const generation = (id: string, coreGeneration: string, revision: number) => ({ id, coreGeneration, revision });
const settings = (coreGeneration: string, revision: number): ThreadSettings => ({
  coreGeneration,
  revision,
  core: "pi",
  cores: ["pi", "codex"],
  agents: [],
  bashTimeoutSupported: true,
  models: [],
  model: null,
  thinkingLevels: ["off"],
  thinkingLevel: "off",
  speedModes: [],
  speedMode: null,
  bashTimeoutSeconds: 1800,
});

describe("selected session generation fences", () => {
  test("rejects action completions after selection or core generation changes", () => {
    const captured = generation("thread-1", "generation-1", 4);
    expect(sameSessionGeneration(generation("thread-1", "generation-1", 5), captured)).toBe(true);
    expect(sameSessionGeneration(generation("thread-2", "generation-1", 4), captured)).toBe(false);
    expect(sameSessionGeneration(generation("thread-1", "generation-2", 5), captured)).toBe(false);
  });

  test("does not mix settings or document bases across a core switch", () => {
    const current = generation("thread-1", "generation-2", 5);
    expect(settingsForGeneration(settings("generation-1", 4), current)).toBeNull();
    expect(settingsForGeneration(settings("generation-2", 4), current)).toBeNull();
    expect(settingsForGeneration(settings("generation-2", 5), current)?.coreGeneration).toBe("generation-2");
    expect(documentBase({ hash: "old" }, "generation-1", "generation-2")).toBeNull();
    expect(documentBase({ hash: "current" }, "generation-2", "generation-2")).toEqual({ hash: "current" });
  });
});

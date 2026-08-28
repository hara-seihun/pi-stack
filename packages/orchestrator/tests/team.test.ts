import { describe, expect, it } from "vitest";
import {
  CONDENSED_SESSION_COMMAND,
  teamSystemPrompt,
} from "../src/host/team.js";

describe("native Pi team turns", () => {
  it("tells workers only how idle turns continue", () => {
    const prompt = teamSystemPrompt(
      { role: "worker", slot: 3, workers: 10 },
      "/work/cayley-ci",
    );
    expect(prompt).toContain("worker 3 of 10");
    expect(prompt).toContain("ordinary user message");
    expect(prompt).not.toContain("team_");
    expect(prompt).not.toContain("task_complete");
  });

  it("routes a supervisor response as the worker's next Pi message", () => {
    const prompt = teamSystemPrompt(
      { role: "supervisor", slot: 0, workers: 10 },
      "/work/cayley-ci",
    );
    expect(prompt).toContain("assistant response is delivered verbatim");
    expect(prompt).toContain("incremental compressed context");
    expect(prompt).not.toContain("team_");
  });

  it("uses the deployed condensed-session command", () => {
    expect(CONDENSED_SESSION_COMMAND).toBe("/srv/pi/tools/read-condensed-session/main");
  });
});

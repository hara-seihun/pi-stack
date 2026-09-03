import { describe, expect, it } from "bun:test";
import type { ObservedRun } from "pi-orchestrator/api";
import { summarizeAgentRun } from "./agent-runs";

const host = { key: "local", label: "THIS MACHINE", name: "This machine" };

function run(live: ObservedRun["live"], state = "running"): ObservedRun {
  return {
    id: "run-1",
    taskId: "direct",
    model: "gpt-5.6-sol",
    provider: "openai-codex",
    state,
    startedAt: 1_000,
    observable: true,
    teamRole: null,
    teamSlot: null,
    live,
  };
}

describe("orchestrator agent activity", () => {
  it("normalizes activity from workers started before the canonical activity contract", () => {
    expect(summarizeAgentRun(run({ activity: "responding", liveText: "", liveThinking: "reasoning", activeTool: null }), host, 2_000).activity).toBe("THINKING");
    expect(summarizeAgentRun(run({ activity: "settling", liveText: "", liveThinking: "", activeTool: null }), host, 2_000).activity).toBe("WORKING");
  });

  it("publishes tool activity and the active tool", () => {
    expect(summarizeAgentRun(run({ activity: "tool", liveText: "", liveThinking: "", activeTool: "bash" }), host, 2_000)).toMatchObject({
      activity: "WAITING_ON_TOOL",
      activeTool: "bash",
    });
  });

  it("reports an admitted worker as starting rather than idle before live state arrives", () => {
    expect(summarizeAgentRun(run(null, "starting"), host, 2_000).activity).toBe("STARTING");
  });
});

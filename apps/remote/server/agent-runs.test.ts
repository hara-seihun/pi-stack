import { describe, expect, it } from "bun:test";
import type { ObservedRun } from "pi-orchestrator/api";
import { summarizeAgentRun } from "./agent-runs";

const host = { key: "local", label: "THIS MACHINE", name: "This machine" };

function run(live: ObservedRun["live"], state = "running"): ObservedRun {
  return {
    id: "run-1",
    taskId: "direct",
    model: "gpt-6-astra",
    provider: "openai-codex",
    state,
    startedAt: 1_000,
    observable: true,
    live,
  };
}

describe("orchestrator agent activity", () => {
  it("normalizes activity from workers started before the canonical activity contract", () => {
    expect(summarizeAgentRun(run({ activity: "responding", liveText: "", liveThinking: "reasoning", activeTool: null }), host).activity).toBe("THINKING");
    expect(summarizeAgentRun(run({ activity: "settling", liveText: "", liveThinking: "", activeTool: null }), host).activity).toBe("WORKING");
  });

  it("publishes tool activity and the active tool", () => {
    expect(summarizeAgentRun(run({ activity: "tool", liveText: "", liveThinking: "", activeTool: "bash" }), host)).toMatchObject({
      activity: "WAITING_ON_TOOL",
      activeTool: "bash",
    });
  });

  it("qualifies parent identity on the child's host and preserves waiting and terminal states", () => {
    for (const state of ["waiting", "done", "error", "aborted"]) {
      const child = { ...run(null, state), parentRunId: "parent-1" };
      expect(summarizeAgentRun(child, host)).toMatchObject({ parentRunId: "local:parent-1", status: state, activity: state.toUpperCase() });
      expect(summarizeAgentRun(child, { ...host, key: "converge" }).parentRunId).toBe("converge:parent-1");
    }
    expect(summarizeAgentRun(run(null), host).parentRunId).toBeUndefined();
  });

  it("reports an admitted worker as starting rather than idle before live state arrives", () => {
    expect(summarizeAgentRun(run(null, "starting"), host).activity).toBe("STARTING");
  });
});

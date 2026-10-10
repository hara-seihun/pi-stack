import { expect, test } from "bun:test";
import { createLiveProjection, projectThreadActivity, restoreLiveProjection, settleLiveProjection } from "./live-projection";

test("the owner lifecycle is the only source of execution observation", () => {
  const stale = { activity: "thinking" as const, activitySince: 10, lastActivityAt: 20, activeTools: ["bash"] };
  expect(projectThreadActivity({ lifecycle: { kind: "idle" }, executionActivity: stale })).toEqual({ state: "idle", lifecycle: { kind: "idle" }, activity: "idle", activeTools: [] });
  expect(projectThreadActivity({ lifecycle: { kind: "waiting", target: "job", since: 10 }, executionActivity: stale })).toMatchObject({ state: "waiting", activity: "awaiting", activeTools: [], activitySince: 10 });
  expect(projectThreadActivity({ lifecycle: { kind: "failed", reason: "Missing result", control: "none" }, executionActivity: stale })).toMatchObject({ state: "idle", activity: "status_error", executionError: "Missing result", activeTools: [] });
  expect(projectThreadActivity({ lifecycle: { kind: "failed", reason: "Accepted execution interrupted", control: "stop" }, executionActivity: stale })).toMatchObject({ state: "running", activity: "status_error" });
});
test("native phase evidence projects without a second Remote lifecycle machine", () => {
  const snapshot = { activity: "responding" as const, activitySince: 10, lastActivityAt: 20, activeTools: [] };
  const projected = projectThreadActivity({ lifecycle: { kind: "working", phase: "responding", since: 10 }, executionActivity: snapshot });
  expect(projected).toMatchObject({ ...snapshot, state: "running" });
  expect(projectThreadActivity({ lifecycle: { kind: "cancelling" } })).toMatchObject({ state: "running", activity: "cancelling" });
  expect(projectThreadActivity({ lifecycle: { kind: "archived" } })).toMatchObject({ state: "idle", activity: "idle" });
});
test("settlement clears disposable output and tools; native history owns final messages", () => {
  const live = createLiveProjection("thread");
  restoreLiveProjection(live, { activity: "responding", text: "Final output", thinking: "Thinking", tools: [{ toolCallId: "tool", toolName: "bash" }] });
  settleLiveProjection(live);
  expect(live.liveText).toBe("");
  expect(live.liveThinking).toBe("");
  expect(live.activeTools.size).toBe(0);
  expect(live.activitySince).toBeUndefined();
});

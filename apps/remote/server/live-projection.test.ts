import { expect, test } from "bun:test";
import { createLiveProjection, projectThreadActivity, restoreLiveProjection, runningChildParents, settleLiveProjection, threadActivity } from "./live-projection";

test("awaiting describes child work without inheriting progress or overriding the parent's execution", () => {
  const parent = createLiveProjection("parent");
  const child = createLiveProjection("child");
  child.activeTools.set("tool", "bash");
  parent.thinkingActive = true;
  expect(threadActivity("idle", parent)).toBe("idle");
  expect(threadActivity("idle", parent, true)).toBe("awaiting");
  expect(threadActivity("running", parent, true)).toBe("thinking");
  expect(threadActivity("running", child)).toBe("waiting_on_tool");
  expect(threadActivity("idle", child)).toBe("idle");
});

test("running children from either owner keep a parent awaiting until the last one settles", () => {
  const local = [{ parentId: "parent", state: "running" as const }];
  const fleet = [
    { parentId: "parent", state: "running" as "running" | "idle" },
    { parentId: "other", state: "running" as const },
    { parentId: "settled", state: "idle" as const },
    { parentId: "held", state: "idle" as const },
    { parentId: null, state: "running" as const },
  ];
  expect([...runningChildParents(local, fleet)]).toEqual(["parent", "other"]);
  local.pop();
  expect(threadActivity("idle", undefined, runningChildParents(local, fleet).has("parent"))).toBe("awaiting");
  fleet[0]!.state = "idle";
  expect(threadActivity("idle", undefined, runningChildParents(local, fleet).has("parent"))).toBe("idle");
});

test("local and fleet phase evidence survives reconnect without aging from reads", () => {
  const live = createLiveProjection("thread");
  const snapshot = { activity: "responding" as const, activitySince: 10, lastActivityAt: 20,
    activityDetail: "Response text streaming", activeTools: [], text: "answer", tools: [] };
  restoreLiveProjection(live, snapshot);
  const local = projectThreadActivity("running", live);
  expect(local).toEqual(projectThreadActivity("running", undefined, false, snapshot));
  expect(local).toMatchObject({ activity: "responding", activitySince: 10, lastActivityAt: 20 });
  live.thinkingActive = true;
  live.compacting = true;
  live.retrying = true;
  live.activeTools.set("stale", "bash");
  restoreLiveProjection(live, { text: "answer", thinking: "old", isThinking: false, tools: [] });
  expect(threadActivity("running", live)).toBe("status_error");
  expect(projectThreadActivity("idle", undefined, false, snapshot)).toEqual({ activity: "idle", activitySince: undefined,
    lastActivityAt: 20, activityDetail: undefined, activeTools: [], executionError: undefined });
  restoreLiveProjection(live, snapshot);
  settleLiveProjection(live);
  expect(threadActivity("running", live)).toBe("status_error");
  expect(live.activitySince).toBeUndefined();
});

test("known waits carry evidence, suppress recovering startup errors but preserve cancellation failures", () => {
  const metadata = { executionError: "prior failure", providerWait: { since: 10, retryAt: 1000, failure: "network connection failed" } };
  expect(projectThreadActivity("running", undefined, false, undefined, metadata)).toMatchObject({
    activity: "waiting_to_retry", activitySince: 10, lastActivityAt: 10, executionError: undefined });
  expect(projectThreadActivity("running", undefined, false, undefined, metadata, true).executionError).toBe("prior failure");
  expect(projectThreadActivity("running", undefined, false, undefined, { admissionWait: { since: 20 } })).toMatchObject({ activity: "waiting_for_capacity", activitySince: 20 });
  expect(projectThreadActivity("idle", undefined, false, undefined, { executionError: "actual failure" }).executionError).toBe("actual failure");
});

test("settlement keeps final output until canonical context acknowledges it", () => {
  const live = createLiveProjection("thread");
  live.liveText = "Final output";
  live.pendingContextFinalization = "message-id";
  live.activeTools.set("tool", "bash");
  settleLiveProjection(live);
  expect(live.liveText).toBe("Final output");
  expect(live.activeTools.size).toBe(0);
  live.pendingContextFinalization = null;
  settleLiveProjection(live);
  expect(live.liveText).toBe("");
});

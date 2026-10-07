import { expect, test } from "bun:test";
import { createLiveProjection, projectThreadActivity, restoreLiveProjection, settleLiveProjection, threadActivity } from "./live-projection";

test("a settled parent remains idle without inheriting its worker's activity", () => {
  const parent = createLiveProjection("parent");
  const child = createLiveProjection("child");
  child.activeTools.set("tool", "bash");
  parent.thinkingActive = true;
  expect(threadActivity("idle", parent)).toBe("idle");
  expect(projectThreadActivity("idle", parent)).toMatchObject({ activity: "idle", activeTools: [] });
  expect(projectThreadActivity("idle", parent, undefined, undefined, true).activity).toBe("idle");
  expect(projectThreadActivity("idle", parent, undefined, { archived: true }).activity).toBe("idle");
  expect(threadActivity("running", parent)).toBe("thinking");
  expect(threadActivity("running", child)).toBe("waiting_on_tool");
  expect(threadActivity("idle", child)).toBe("idle");
});

test("idle dependency evidence survives owner replacement but holds and archives override waiting", () => {
  const metadata = { agentWait: { kind: "deployment", reason: "Publication", publicationId: "pub-1", since: 1000 } };
  expect(projectThreadActivity("idle", undefined, undefined, metadata)).toMatchObject({ activity: "awaiting", activitySince: 1000, activityDetail: "Waiting for deployment · Publication" });
  expect(projectThreadActivity("idle", undefined, undefined, metadata, true).activity).toBe("idle");
  expect(projectThreadActivity("idle", undefined, undefined, { ...metadata, archived: true }).activity).toBe("idle");
});

test("launch provenance cannot contribute activity or dependency evidence", () => {
  const snapshot = { activity: "thinking" as const, activitySince: 10, lastActivityAt: 20, activeTools: ["bash"] };
  const metadata = { parentId: "launcher", hasChildren: true };
  for (const held of [false, true]) {
    expect(projectThreadActivity("idle", undefined, snapshot, metadata, held)).toMatchObject({ activity: "idle", activeTools: [] });
  }
  expect(projectThreadActivity("running", undefined, snapshot, metadata).activity).toBe("thinking");
  const dependency = { agentWait: { kind: "message", fromThreadId: "billing-owner", reason: "Rental custody release", since: 10 } };
  expect(projectThreadActivity("idle", undefined, undefined, dependency)).toMatchObject({ activity: "awaiting", activityDetail: "Waiting for message · Rental custody release" });
});

test("local and fleet phase evidence survives reconnect without aging from reads", () => {
  const live = createLiveProjection("thread");
  const snapshot = { activity: "responding" as const, activitySince: 10, lastActivityAt: 20,
    activityDetail: "Response text streaming", activeTools: [], text: "answer", tools: [] };
  restoreLiveProjection(live, snapshot);
  const local = projectThreadActivity("running", live);
  expect(local).toEqual(projectThreadActivity("running", undefined, snapshot));
  expect(local).toMatchObject({ activity: "responding", activitySince: 10, lastActivityAt: 20 });
  live.thinkingActive = true;
  live.compacting = true;
  live.retrying = true;
  live.activeTools.set("stale", "bash");
  restoreLiveProjection(live, { text: "answer", thinking: "old", isThinking: false, tools: [] });
  expect(threadActivity("running", live)).toBe("status_error");
  expect(projectThreadActivity("idle", undefined, snapshot)).toEqual({ activity: "idle", activitySince: undefined,
    lastActivityAt: 20, activityDetail: undefined, activeTools: [], executionError: undefined });
  restoreLiveProjection(live, snapshot);
  settleLiveProjection(live);
  expect(threadActivity("running", live)).toBe("status_error");
  expect(live.activitySince).toBeUndefined();
});

test("known waits carry evidence, suppress recovering startup errors but preserve cancellation failures", () => {
  const metadata = { executionError: "prior failure", providerWait: { since: 10, retryAt: 1000, failure: "network connection failed" } };
  expect(projectThreadActivity("running", undefined, undefined, metadata)).toMatchObject({
    activity: "waiting_to_retry", activitySince: 10, lastActivityAt: 10, executionError: undefined });
  expect(projectThreadActivity("running", undefined, undefined, metadata, true).executionError).toBe("prior failure");
  expect(projectThreadActivity("running", undefined, undefined, { admissionWait: { since: 20 } })).toMatchObject({ activity: "waiting_for_capacity", activitySince: 20 });
  expect(projectThreadActivity("idle", undefined, undefined, { executionError: "actual failure" }).executionError).toBe("actual failure");
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

import { expect, test } from "bun:test";
import { activeWorkerParents, createLiveProjection, projectThreadActivity, restoreLiveProjection, settleLiveProjection, threadActivity } from "./live-projection";
import type { Thread } from "pi-orchestrator/api";

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

test("active workers across both owners keep the parent waiting until the last worker settles", () => {
  const child = (parentId: string, extra: Partial<Thread> = {}): Pick<Thread, "parentId" | "state" | "held" | "metadata"> =>
    ({ parentId, state: "running", held: false, ...extra });
  const local = [child("parent"), child("held", { held: true }), child("archived", { metadata: { archived: true } })];
  const fleet = [child("parent"), child("other")];
  let parents = activeWorkerParents(local, fleet);
  expect([...parents]).toEqual(["parent", "other"]);
  const snapshot = { activity: "thinking" as const, activitySince: 10, lastActivityAt: 20, activeTools: ["bash"] };
  expect(projectThreadActivity("idle", undefined, snapshot, undefined, false, parents.has("parent")))
    .toEqual({ activity: "waiting_on_workers", activeTools: [], executionError: undefined });
  expect(projectThreadActivity("running", undefined, snapshot, undefined, false, true).activity).toBe("thinking");
  expect(projectThreadActivity("idle", undefined, undefined, undefined, true, true).activity).toBe("idle");
  expect(projectThreadActivity("idle", undefined, undefined, { archived: true }, false, true).activity).toBe("idle");
  local[0]!.state = "idle";
  expect(activeWorkerParents(local, fleet).has("parent")).toBe(true);
  fleet[0]!.state = "idle";
  parents = activeWorkerParents(local, fleet);
  expect(projectThreadActivity("idle", undefined, undefined, undefined, false, parents.has("parent")).activity).toBe("idle");
});

test("waiting worker custody is visible without inventing a durable parent dependency", () => {
  const childMetadata = { agentWait: { kind: "message", fromThreadId: "billing-owner", reason: "Rental custody release", since: 10 } };
  const worker = { parentId: "parent", state: "idle" as const, held: false, metadata: childMetadata };
  expect(projectThreadActivity("idle", undefined, undefined, childMetadata)).toMatchObject({ activity: "awaiting", activityDetail: "Waiting for message · Rental custody release" });
  expect(activeWorkerParents([worker]).has("parent")).toBe(true);
  expect(projectThreadActivity("idle", undefined, undefined, undefined, false, true)).toEqual({ activity: "waiting_on_workers", activeTools: [], executionError: undefined });
  expect(projectThreadActivity("idle", undefined, undefined, childMetadata, false, true).activity).toBe("awaiting");
  expect(activeWorkerParents([{ ...worker, held: true }]).size).toBe(0);
  expect(activeWorkerParents([{ ...worker, metadata: { agentWait: { reason: "untyped" } } }]).size).toBe(0);
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

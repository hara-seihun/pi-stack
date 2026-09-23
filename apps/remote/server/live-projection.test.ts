import { expect, test } from "bun:test";
import { createLiveProjection, runningChildParents, settleLiveProjection, threadActivity } from "./live-projection";

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

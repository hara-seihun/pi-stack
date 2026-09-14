import { expect, test } from "bun:test";
import { createLiveProjection, settleLiveProjection, threadActivity } from "./live-projection";

test("an idle parent's display does not inherit active child or stale local progress", () => {
  const parent = createLiveProjection("parent");
  const child = createLiveProjection("child");
  child.activeTools.set("tool", "bash");
  parent.thinkingActive = true;
  expect(threadActivity("IDLE", parent)).toBe("IDLE");
  expect(threadActivity("RUNNING", child)).toBe("WAITING_ON_TOOL");
  expect(threadActivity("STOPPED", child)).toBe("STOPPED");
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

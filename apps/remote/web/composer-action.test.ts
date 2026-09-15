import { expect, test } from "bun:test";
import { composerAction } from "./src/thread-state";
import type { Session } from "./src/types";

test("the composer stops active work and cannot repeat an in-flight stop", () => {
  for (const state of ["QUEUED", "STARTING", "RUNNING"]) {
    expect(composerAction({ state } as Session)).toBe("stop");
  }
  expect(composerAction({ state: "STOPPING" } as Session)).toBe("stopping");
  for (const state of ["IDLE", "STOPPED", "FAILED"]) {
    expect(composerAction({ state } as Session)).toBe("send");
  }
  expect(composerAction(null)).toBe("send");
});

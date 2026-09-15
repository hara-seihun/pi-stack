import { expect, test } from "bun:test";
import { composerAction } from "./src/thread-state";
import type { Session } from "./src/types";

test("running work offers Stop only while the composer has no message", () => {
  const session = { state: "running", lastError: "Cancellation not confirmed" } as Session;
  expect(composerAction(session, "")).toBe("stop");
  expect(composerAction(session, " \n\t")).toBe("stop");
  expect(composerAction(session, "A follow-up")).toBe("send");
  expect(composerAction(session, "")).toBe("stop");
});

test("settled threads offer Send with or without a draft", () => {
  for (const session of [
    { state: "stopped", queuedMessages: [{ state: "held" }] } as Session,
    { state: "idle", lastError: "Provider failed" } as Session,
    null,
  ]) {
    expect(composerAction(session, "")).toBe("send");
    expect(composerAction(session, "A message")).toBe("send");
  }
});

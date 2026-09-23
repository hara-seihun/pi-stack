import { expect, test } from "bun:test";
import { composerAction } from "./src/thread-state";
import type { Session } from "./src/types";

test("running work offers Stop only while the composer has no message", () => {
  const session = { state: "running", held: false } as Session;
  expect(composerAction(session, "")).toBe("stop");
  expect(composerAction(session, " \n\t")).toBe("stop");
  expect(composerAction(session, "A follow-up")).toBe("send");
  expect(composerAction(session, "")).toBe("stop");
});

test("held threads offer Resume until a draft is typed; other settled threads offer Send", () => {
  const held = { state: "idle", held: true, queuedMessages: [{ state: "queued" }] } as Session;
  expect(composerAction(held, "")).toBe("resume");
  expect(composerAction(held, "A message")).toBe("send");
  for (const session of [
    { state: "idle", held: true, queuedMessages: [] } as unknown as Session,
    { state: "idle", held: false } as Session,
    null,
  ]) {
    expect(composerAction(session, "")).toBe("send");
    expect(composerAction(session, "A message")).toBe("send");
  }
});

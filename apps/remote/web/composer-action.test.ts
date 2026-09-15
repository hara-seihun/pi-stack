import { expect, test } from "bun:test";
import { composerAction } from "./src/thread-state";
import type { Session } from "./src/types";

test("running work keeps Stop available regardless of pending messages or errors", () => {
  expect(composerAction({ state: "running", lastError: "Cancellation not confirmed" } as Session)).toBe("stop");
  expect(composerAction({ state: "stopped", queuedMessages: [{ state: "held" }] } as Session)).toBe("send");
  expect(composerAction({ state: "idle", lastError: "Provider failed" } as Session)).toBe("send");
  expect(composerAction(null)).toBe("send");
});

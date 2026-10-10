import { expect, test } from "bun:test";
import { activeThread, composerAction } from "./src/thread-state";
import type { Session } from "./src/types";

const row = (lifecycle: Session["lifecycle"], patch: Partial<Session> = {}): Session => ({ lifecycle, ...patch } as Session);

test("running execution offers Stop only while the composer has no message", () => {
  const session = row({ kind: "working", phase: "thinking", since: 1 }, { state: "idle" });
  expect(activeThread(session)).toBe(true);
  expect(composerAction(session, "")).toBe("stop");
  expect(composerAction(session, " \n\t")).toBe("stop");
  expect(composerAction(session, "A follow-up")).toBe("send");
});

test("durable and scheduling waits offer cancellation, not a false execution Stop", () => {
  for (const target of ["agents", "job", "deployment", "message", "capacity", "retry", "dispatch"] as const) {
    const session = row({ kind: "waiting", target, reason: "Owner receipt", since: 1 }, { state: "running" });
    expect(activeThread(session)).toBe(false);
    expect(composerAction(session, "")).toBe("cancel_wait");
    expect(composerAction(session, "A message")).toBe("send");
  }
});

test("settled and historical holds offer Send without persistent stopped state", () => {
  for (const session of [
    row({ kind: "idle" }, { state: "idle", held: true, queuedMessages: [{ state: "queued" }] as Session["queuedMessages"] }),
    row({ kind: "idle" }, { state: "running" }),
    row({ kind: "archived" }),
    row({ kind: "cancelling" }),
    null,
  ]) {
    expect(composerAction(session, "")).toBe("send");
    expect(composerAction(session, "A message")).toBe("send");
  }
});

test("failed owners retain their explicit control rather than inferring it from state", () => {
  for (const control of ["stop", "cancel_wait", "none"] as const) {
    const session = row({ kind: "failed", reason: "Runner exited", control });
    expect(composerAction(session, "")).toBe(control === "none" ? "send" : control);
    expect(composerAction(session, "A message")).toBe("send");
  }
});

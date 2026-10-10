import { expect, test } from "bun:test";
import { validateSession } from "../shared/state-validation";
import { threadStatus } from "./src/features/status/thread-status";

globalThis.location ??= new URL("https://router.test/") as unknown as Location;
const { conversationSession } = await import("./src/ui-catalogue/conversation");

test("catalogue observations construct explicit canonical lifecycle without flattening non-idle variants", () => {
  const fixtures: Array<[Parameters<typeof conversationSession>[0], string]> = [
    [{ observation: { kind: "idle" } }, "idle"],
    [{ observation: { kind: "held" } }, "idle"],
    [{ observation: { kind: "archived" } }, "archived"],
    [{ observation: { kind: "cancelling" } }, "stopping"],
    [{ observation: { kind: "error", message: "Synthetic error" } }, "error"],
    [{ observation: { kind: "reporting-error" } }, "error"],
    [{ observation: { kind: "running", phase: "responding" } }, "typing"],
    [{ observation: { kind: "running", phase: "thinking" } }, "working"],
    [{ observation: { kind: "running", phase: "waiting_for_capacity" } }, "waiting"],
    [{ observation: { kind: "running", phase: "waiting_to_retry" } }, "waiting"],
    [{ observation: { kind: "tools", tools: ["read", "bash"] } }, "working"],
    [{ observation: { kind: "agent-tool" } }, "working"],
    [{ observation: { kind: "dependency", wait: { kind: "deployment", publicationId: "PUB-synthetic", reason: "Publication receipt", since: 1000 } } }, "waiting"],
  ];
  for (const [patch, key] of fixtures) {
    const row = conversationSession(patch);
    validateSession(row);
    expect(threadStatus(row).key).toBe(key);
  }
  const wait = conversationSession(fixtures.at(-1)![0]);
  expect(wait.lifecycle).toMatchObject({ kind: "waiting", target: "deployment", since: 1000 });
});

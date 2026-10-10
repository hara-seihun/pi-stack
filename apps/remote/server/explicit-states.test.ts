import { expect, test } from "bun:test";
import { parsePresentationEvent } from "./pi-event-presentation";
import { projectThreadActivity } from "./live-projection";
import { deriveThreadLifecycle, type LifecycleObservation } from "../../../packages/orchestrator/src/threads/lifecycle";
import { deriveTranscriptItems } from "./transcript-items";

test("unsupported runtime, assistant and extension variants never enter the display reducer", () => {
  for (const event of [null, { type: "new_state" }, { type: "toString" },
    { type: "message_update", assistantMessageEvent: { type: "new_delta" } },
    { type: "extension_ui_request", method: "new_dialog" }]) {
    expect(parsePresentationEvent(event).ok).toBe(false);
  }
  expect(parsePresentationEvent({ type: "turn_end" })).toMatchObject({ ok: true, project: false });
  expect(parsePresentationEvent({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "answer" } })).toMatchObject({ ok: true, project: true });
});

test("open-ended context preserves unsupported payloads as notices, never tool or assistant states", () => {
  const items = deriveTranscriptItems({ systemPrompt: "", tools: [], messages: [
    { role: "assistant", content: [{ type: "audio", data: "preserved audio" }] },
    { role: "new_role", content: "preserved message" },
  ] });
  expect(items.slice(1).map(item => item.head.kind)).toEqual(["notice", "notice"]);
  expect(items[1]!.body).toContain("preserved audio");
  expect(items[2]!.body).toContain("preserved message");
});

test("wait kinds project one awaiting activity; missing or unknown kinds are reporting errors", () => {
  for (const dependency of [
    { kind: "agents", threadIds: ["child"], after: {} },
    { kind: "job", jobId: "job" },
    { kind: "deployment", publicationId: "pub" },
    { kind: "message", fromThreadId: "collaborator" },
  ] as const) {
    const lifecycle = deriveThreadLifecycle({ archived: false, cancelling: false, execution: null, pending: null, delay: null, subscriptions: [], error: null, updatedAt: 10, dependency: { ...dependency, since: 10 } as LifecycleObservation["dependency"] });
    const projected = projectThreadActivity({ lifecycle });
    expect(projected).toMatchObject({ activity: "awaiting", activitySince: 10 });
    expect(projected.activityDetail).toBeUndefined();
  }
  for (const dependency of [{ threadIds: [], after: {} }, { kind: "other" },
    { kind: "agents", threadIds: [], after: {} }, { kind: "job", jobId: "" },
    { kind: "deployment" }, { kind: "message" }]) {
    const metadata = { agentWait: { ...dependency, reason: "Reason", since: 10 } };
    const observation = { archived: false, cancelling: false, execution: null, pending: null, delay: null, subscriptions: [], error: null, updatedAt: 10, dependency: metadata.agentWait } as LifecycleObservation;
    expect(projectThreadActivity({ lifecycle: deriveThreadLifecycle(observation) })).toMatchObject({ activity: "status_error", executionError: "Invalid owned dependency wait" });
    expect(metadata.agentWait.reason).toBe("Reason");
    expect(projectThreadActivity({ lifecycle: deriveThreadLifecycle({ ...observation, cancelling: true }) }).activity).toBe("idle");
  }
});

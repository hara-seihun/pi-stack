import { expect, test } from "bun:test";
import { parsePresentationEvent } from "./pi-event-presentation";
import { projectThreadActivity } from "./live-projection";
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

test("each wait kind has its own label; missing or unknown kinds are reporting errors", () => {
  for (const [dependency, label] of [
    [{ kind: "agents", threadIds: ["child"], after: {} }, "Waiting on agents"],
    [{ kind: "job", jobId: "job" }, "Waiting for job"],
    [{ kind: "deployment", publicationId: "pub" }, "Waiting for deployment"],
    [{ kind: "message", fromThreadId: "collaborator" }, "Waiting for message"],
  ] as const) {
    const projected = projectThreadActivity("idle", undefined, false, undefined, { agentWait: { ...dependency, reason: "Reason", since: 10 } });
    expect(projected).toMatchObject({ activity: "awaiting", activitySince: 10, activityDetail: `${label} · Reason` });
  }
  for (const dependency of [{ threadIds: [], after: {} }, { kind: "other" },
    { kind: "agents", threadIds: [], after: {} }, { kind: "job", jobId: "" },
    { kind: "deployment" }, { kind: "message" }]) {
    const metadata = { agentWait: { ...dependency, reason: "Reason", since: 10 } };
    expect(projectThreadActivity("idle", undefined, false, undefined, metadata)).toMatchObject({ activity: "status_error", executionError: expect.stringContaining("Wait reporting defect") });
    expect(metadata.agentWait.reason).toBe("Reason");
    expect(projectThreadActivity("idle", undefined, false, undefined, metadata, true).activity).toBe("idle");
  }
});

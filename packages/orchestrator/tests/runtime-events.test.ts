import { expect, it } from "vitest";
import { parseRuntimeEvent, requireRuntimeEvent, requireAssistantStopReason } from "../src/threads/runtime-events.js";
import { requireRunnerChannelRequest, requireRunnerControlRequest, requireRunnerFrame } from "../src/threads/runner-protocol.js";
import { completionHttpStatus, isCompletionExecution, isCompletionRecord } from "../src/completion-contract.js";
import { assistantWorkOutcome } from "../src/threads/pi-session.js";
import { parseResponseEvent } from "../src/response-events.js";

it("diagnoses unknown runtime, nested stream, UI and settlement variants at their boundary", () => {
  for (const [event, diagnostic] of [
    [{ type: "new_sdk_event" }, "Unknown runtime event type"],
    [{ type: "toString" }, "Unknown runtime event type"],
    [{ type: "message_update", assistantMessageEvent: { type: "new_chunk" } }, "Unknown assistant message update type"],
    [{ type: "extension_ui_request", method: "new_method" }, "Unknown extension UI method"],
    [{ type: "agent_settled", outcome: "maybe" }, "Unknown settlement outcome"],
    [{ type: "message_end", message: { role: "assistant", stopReason: "new_stop" } }, "Unknown assistant stop reason"],
    [{ type: "summarization_retry_attempt_start", source: "new_source" }, "Unknown summarization retry source"],
  ] as const) {
    expect(parseRuntimeEvent(event)).toMatchObject({ ok: false, error: expect.stringContaining(diagnostic) });
    expect(() => requireRuntimeEvent(event)).toThrow(diagnostic);
  }
  expect(parseRuntimeEvent({ type: "message_update", assistantMessageEvent: { type: "start" } }).ok).toBe(true);
  expect(parseRuntimeEvent({ type: "agent_settled" }).ok).toBe(true);
});

it("validates runner envelopes before dispatch rather than waiting forever on unknown commands", () => {
  expect(() => requireRunnerFrame({ type: "new_frame" })).toThrow("Invalid runner output frame");
  expect(() => requireRunnerFrame({ type: "output", line: "{}", sequence: -1 })).toThrow();
  expect(() => requireRunnerChannelRequest({ type: "new_command" })).toThrow("Invalid runner channel request");
  expect(() => requireRunnerControlRequest({ type: "new_control" })).toThrow("Invalid runner control request");
  expect(() => requireRunnerControlRequest({ type: "activity", socketPath: "thread.sock", active: "false" })).toThrow();
  expect(requireRunnerFrame({ type: "exit", code: 1 })).toEqual({ type: "exit", code: 1 });
});

it("cannot turn unknown or nonterminal assistant/completion states into success", () => {
  expect(() => assistantWorkOutcome("new_stop")).toThrow("Unknown assistant stop reason");
  expect(() => requireAssistantStopReason(undefined)).toThrow();
  expect(assistantWorkOutcome("pending")).toBe("failed");
  expect(assistantWorkOutcome("deferred")).toBe("failed");
  expect(assistantWorkOutcome("stop")).toBe("complete");
  expect(isCompletionExecution({ state: "new_state", error: { code: "provider", message: "" } })).toBe(false);
  expect(isCompletionRecord({ requestId: "x", runId: "y", model: "luna", createdAt: 1, updatedAt: 1, state: "new_state" })).toBe(false);
  expect(() => completionHttpStatus("new_error" as never)).toThrow("Unknown completion error code");
  expect(completionHttpStatus("unsupported-option")).toBe(422);
});

it("accepts named provider progress but rejects unknown SSE and malformed native evidence", () => {
  expect(parseResponseEvent({ type: "response.image_generation_call.generating" })).toMatchObject({ ok: true, value: { kind: "progress" } });
  expect(parseResponseEvent({ type: "response.new_event" })).toMatchObject({ ok: false, error: expect.stringContaining("Unknown provider response event type") });
  expect(parseResponseEvent({ type: "response.completed" })).toMatchObject({ ok: false, error: expect.stringContaining("Missing response object") });
});

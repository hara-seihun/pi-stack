import { expect, it } from "vitest";
import { createExecutionActivity, executionActivitySnapshot, executionWaitActivity, observeExecutionActivity, restoreExecutionActivity } from "../src/threads/execution-activity.js";

it("distinguishes provider backoff from rate-limit and admission capacity waits", () => {
  expect(executionWaitActivity({ providerWait: { failure: "429 rate limit exceeded", since: 10, retryAt: 20 } })).toMatchObject({ activity: "waiting_for_capacity", activitySince: 10, lastActivityAt: 10 });
  expect(executionWaitActivity({ providerWait: { failure: "Connection reset", since: 10, retryAt: 20 } })).toMatchObject({ activity: "waiting_to_retry" });
  expect(executionWaitActivity({ admissionWait: { since: 10, observedAt: 999 } })).toMatchObject({ activity: "waiting_for_capacity", lastActivityAt: 10 });
  expect(executionWaitActivity({})).toBeUndefined();
});

it("keeps waiting for model output across headers and reads, and names continuation boundaries", () => {
  const state = createExecutionActivity();
  observeExecutionActivity(state, { type: "model_request_start", emittedAt: 10 });
  const waiting = executionActivitySnapshot(state);
  expect(observeExecutionActivity(state, { type: "message_start", message: { role: "assistant" }, emittedAt: 20 })).toBe(false);
  expect(executionActivitySnapshot(state)).toEqual(waiting);
  observeExecutionActivity(state, { type: "message_update", emittedAt: 30, assistantMessageEvent: { type: "thinking_delta" } });
  expect(state.activity).toBe("thinking");
  observeExecutionActivity(state, { type: "message_update", emittedAt: 40, assistantMessageEvent: { type: "thinking_end" } });
  expect(state).toMatchObject({ activity: "preparing", activityDetail: "Processing completed reasoning block" });
  observeExecutionActivity(state, { type: "owner_execution_phase", activity: "cancelling", activityDetail: "Awaiting cancellation", emittedAt: 50 });
  expect(state.activity).toBe("cancelling");
});

it("reports observed phases, not stored text, and does not advance on inspection", () => {
  const state = createExecutionActivity();
  const emit = (type: string, emittedAt: number, extra = {}) => observeExecutionActivity(state, { type, emittedAt, ...extra });
  emit("agent_start", 10);
  expect(state.activity).toBe("preparing");
  emit("message_update", 20, { assistantMessageEvent: { type: "thinking_delta", delta: "reasoning" } });
  emit("message_update", 25, { assistantMessageEvent: { type: "thinking_delta", delta: "more" } });
  expect(executionActivitySnapshot(state)).toMatchObject({ activity: "thinking", activitySince: 20, lastActivityAt: 25 });
  emit("message_update", 30, { assistantMessageEvent: { type: "text_delta", delta: "answer" } });
  expect(state.activity).toBe("responding");
  const restored = createExecutionActivity();
  restoreExecutionActivity(restored, { ...executionActivitySnapshot(state), text: "answer", isThinking: true, tools: [] });
  expect(executionActivitySnapshot(restored)).toEqual(executionActivitySnapshot(state));
  expect(emit("response", 900, { command: "get_state" })).toBe(false);
  expect(state.lastActivityAt).toBe(30);
  emit("message_update", 40, { assistantMessageEvent: { type: "text_end" } });
  expect(state.activity).toBe("preparing");
  restoreExecutionActivity(restored, { text: "previous answer", thinking: "previous reasoning", isThinking: false, tools: [] });
  expect(restored.activity).toBeUndefined();
});

it("names argument dispatch, concurrent tool completion, retry, compaction and final result boundaries", () => {
  const state = createExecutionActivity();
  const emit = (type: string, extra = {}) => observeExecutionActivity(state, { type, ...extra }, 100);
  emit("message_update", { assistantMessageEvent: { type: "toolcall_delta", delta: "secret argument" } });
  expect(state.activity).toBe("preparing_tool");
  expect(state.activityDetail).not.toContain("secret");
  emit("message_update", { assistantMessageEvent: { type: "toolcall_end" } });
  expect(state.activity).toBe("preparing");
  emit("tool_execution_start", { toolCallId: "one" });
  emit("tool_execution_start", { toolCallId: "two" });
  emit("tool_execution_end", { toolCallId: "one" });
  expect(state.activity).toBe("waiting_on_tool");
  emit("tool_execution_end", { toolCallId: "two" });
  expect(state.activityDetail).toBe("Integrating tool results");
  emit("auto_retry_start", { attempt: 2, delayMs: 5000 });
  expect(state.activityDetail).toContain("attempt 2");
  emit("auto_retry_end");
  expect(state.activity).toBe("preparing");
  emit("auto_compaction_start");
  expect(state.activity).toBe("compacting");
  emit("auto_compaction_end");
  expect(state.activity).toBe("preparing");
  emit("tool_execution_start", { toolCallId: "stale" });
  emit("agent_settled");
  expect(state.activityTools.size).toBe(0);
  expect(executionActivitySnapshot(state)).toEqual({ activity: "finishing", activitySince: 100, activityDetail: "Synchronizing final execution result", lastActivityAt: 100 });
});

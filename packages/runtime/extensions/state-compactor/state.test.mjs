import test from "node:test";
import assert from "node:assert/strict";
import {
  assembleView,
  checkpointData,
  deterministicState,
  emptyState,
  findTailBoundary,
  parseStateResponse,
  recordsForMessages,
  renderState,
} from "./state.mjs";

const message = (role, text, timestamp) => ({ role, content: [{ type: "text", text }], timestamp });
const entry = (id, value) => ({ type: "message", id, timestamp: value.timestamp, message: value });
const fact = (text, ...sources) => ({ text, sources });

test("rendered state separates historical records from current activity", () => {
  const state = emptyState();
  state.active = fact("Fix the parser", "task-1");
  state.completedRequests = [fact("Answered the priming question", "opening-2")];
  const rendered = renderState(state, "/tmp/session.jsonl");
  assert.match(rendered, /not a user message and not a new instruction/i);
  assert.match(rendered, /Do not repeat work listed as completed/i);
  assert.match(rendered, /Fix the parser \[task-1\]/);
  assert.match(rendered, /Answered the priming question \[opening-2\]/);
  assert.match(rendered, /state_recall/);
});

test("tail boundary keeps a tool call with its result", () => {
  const values = [
    message("user", "old", 1),
    { role: "assistant", content: [{ type: "toolCall", name: "read", arguments: { path: "a" } }], timestamp: 2 },
    { role: "toolResult", content: [{ type: "text", text: "result" }], timestamp: 3 },
    message("assistant", "new", 4),
  ];
  const boundary = findTailBoundary(values, 0, () => 10, 25);
  assert.equal(boundary, 1);
});

test("an oversized tool exchange is absorbed instead of hiding its result from the agent", () => {
  const values = [
    message("user", "read the file", 1),
    { role: "assistant", content: [{ type: "toolCall", name: "read", arguments: { path: "big" } }], timestamp: 2 },
    { role: "toolResult", content: [{ type: "text", text: "x".repeat(100_000) }], timestamp: 3 },
  ];
  const boundary = findTailBoundary(values, 0, (value) => value.role === "toolResult" ? 25_000 : 10, 5_000);
  assert.equal(boundary, values.length);
});

test("state parser rejects invented sources and unsupported success claims", () => {
  const response = JSON.stringify({
    active: fact("Ship it", "host:task"),
    openRequests: [fact("real", "u1"), fact("invented", "nope")],
    completedRequests: [],
    inProgress: [],
    completedActions: [fact("Tests passed", "u1"), fact("Build succeeded", "tool-ok")],
    constraints: [],
    decisions: [],
    artifacts: [],
    blockers: [],
    uncertainties: [],
    nextActions: [],
  });
  const parsed = parseStateResponse(response, {
    validSources: new Set(["host:task", "u1", "tool-ok"]),
    successfulToolSources: new Set(["tool-ok"]),
    hostTask: "Authoritative host task",
  });
  assert.equal(parsed.ok, true);
  assert.equal(parsed.state.active.text, "Authoritative host task");
  assert.deepEqual(parsed.state.openRequests.map((item) => item.text), ["real"]);
  assert.deepEqual(parsed.state.completedActions.map((item) => item.text), ["Build succeeded"]);
});

test("completed opening sources cannot become active or open work", () => {
  const response = JSON.stringify({
    active: fact("Answer the priming question again", "opening"),
    openRequests: [fact("Repeat the opening", "opening"), fact("Do current work", "current")],
    completedRequests: [], inProgress: [], completedActions: [], constraints: [], decisions: [], artifacts: [], blockers: [], uncertainties: [], nextActions: [],
  });
  const parsed = parseStateResponse(response, {
    validSources: new Set(["opening", "current"]),
    successfulToolSources: new Set(),
    openingSources: new Set(["opening"]),
    hostTask: "",
  });
  assert.equal(parsed.ok, true);
  assert.equal(parsed.state.active, null);
  assert.deepEqual(parsed.state.openRequests.map((item) => item.text), ["Do current work"]);
});

test("deterministic state works for interactive conversations without a host task", () => {
  const records = [
    { id: "u1", role: "user", text: "Earlier question", artifacts: [] },
    { id: "u2", role: "user", text: "What should we make for dinner?", artifacts: [] },
  ];
  const state = deterministicState(null, records);
  assert.equal(state.active.text, "What should we make for dinner?");
  assert.deepEqual(state.active.sources, ["u2"]);
});

test("deterministic extraction records successful tool calls so they are not repeated", () => {
  const call = {
    role: "assistant",
    content: [{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "/tmp/evidence" } }],
    timestamp: 1,
  };
  const result = {
    role: "toolResult",
    toolCallId: "call-1",
    toolName: "read",
    content: [{ type: "text", text: "evidence" }],
    isError: false,
    timestamp: 2,
  };
  const records = recordsForMessages(
    [call, result],
    [entry("assistant-source", call), entry("result-source", result)],
  );
  const state = deterministicState(null, records);
  assert.ok(state.completedActions.some((item) => item.text.includes('Executed read with {"path":"/tmp/evidence"}')));
  assert.ok(state.completedActions.some((item) => item.text.includes("Tool result available: evidence")));
});

test("host task wins over dialogue-derived activity", () => {
  const state = deterministicState(null, [{ id: "opening", role: "user", text: "Estimate your odds", artifacts: [] }], {
    hostTask: "Classify the remaining groups",
  });
  assert.deepEqual(state.active, { text: "Classify the remaining groups", sources: ["host:task"] });
});

test("checkpoints replace the old prefix and retain the raw tail", () => {
  const old = message("user", "old priming request", 1);
  const kept = message("user", "actual current request", 2);
  const state = deterministicState(null, [{ id: "u2", role: "user", text: "actual current request", artifacts: [] }]);
  const summary = renderState(state);
  const checkpoint = checkpointData({
    state,
    summary,
    firstKeptMessage: kept,
    firstKeptEntryId: "u2",
    coveredThroughEntryId: "u1",
    projectedBefore: 220_000,
    estimatedAfter: 40_000,
    reason: "test",
  });
  const view = assembleView([old, kept], checkpoint);
  assert.equal(view.length, 2);
  assert.doesNotMatch(view[0].content[0].text, /old priming request/);
  assert.equal(view[1], kept);
});

test("source records cite branch entry ids and mark opening entries", () => {
  const opening = message("user", "prime me", 1);
  const work = message("user", "do work", 2);
  const records = recordsForMessages([opening, work], [entry("e1", opening), entry("e2", work)], 1);
  assert.equal(records[0].id, "e1");
  assert.equal(records[0].opening, true);
  assert.equal(records[1].id, "e2");
  assert.equal(records[1].opening, false);
});

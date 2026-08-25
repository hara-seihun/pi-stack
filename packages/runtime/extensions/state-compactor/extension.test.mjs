import test from "node:test";
import assert from "node:assert/strict";
import stateCompactor from "./index.mjs";

const makeMessage = (role, text, timestamp, extra = {}) => ({
  role,
  content: [{ type: "text", text }],
  timestamp,
  ...extra,
});

function setup(messages, responseText) {
  const handlers = new Map();
  const tools = new Map();
  const branch = messages.map((message, index) => ({
    type: "message",
    id: `e${index + 1}`,
    parentId: index ? `e${index}` : null,
    timestamp: message.timestamp,
    message,
  }));
  let calls = 0;
  const pi = {
    on(name, handler) {
      handlers.set(name, handler);
    },
    registerTool(tool) {
      tools.set(tool.name, tool);
    },
    appendEntry(customType, data) {
      branch.push({ type: "custom", id: `c${branch.length}`, customType, data });
    },
  };
  stateCompactor(pi);
  const ctx = {
    model: { id: "model", contextWindow: 100_000 },
    modelRegistry: {
      complete: async () => {
        calls++;
        return {
          content: Array.isArray(responseText) ? responseText : [{ type: "text", text: responseText }],
          usage: { input: 100, output: 20 },
        };
      },
    },
    sessionManager: {
      getBranch: () => branch,
      getEntries: () => branch,
      getSessionId: () => "session-test",
      getSessionFile: () => undefined,
      getLeafId: () => branch.at(-1)?.id,
    },
  };
  return { handlers, tools, branch, ctx, calls: () => calls };
}

function validState(activeSource = "e1") {
  return JSON.stringify({
    active: { text: "Continue the current request", sources: [activeSource] },
    openRequests: [{ text: "Current request remains open", sources: [activeSource] }],
    completedRequests: [],
    inProgress: [],
    completedActions: [],
    constraints: [],
    decisions: [],
    artifacts: [],
    blockers: [],
    uncertainties: [],
    nextActions: [{ text: "Continue", sources: [activeSource] }],
  });
}

test("a checkpoint removes old dialogue, keeps a verbatim tail, and is reused", async () => {
  process.env.PI_STATE_COMPACTOR_TRIGGER = "10000";
  try {
    const messages = Array.from({ length: 12 }, (_, index) =>
      makeMessage(index % 2 ? "assistant" : "user", `${index}: ${"x".repeat(3_000)}`, index + 1),
    );
    const harness = setup(messages, validState("e1"));
    const context = harness.handlers.get("context");
    const first = await context({ messages }, harness.ctx);

    assert.equal(harness.calls(), 1);
    assert.ok(first.messages.length < messages.length);
    assert.match(first.messages[0].content[0].text, /^# Working state/);
    assert.doesNotMatch(first.messages[0].content[0].text, /0: xxx/);
    assert.equal(first.messages.at(-1), messages.at(-1));
    assert.equal(harness.branch.at(-1).customType, "state-compactor.checkpoint");

    const second = await context({ messages }, harness.ctx);
    assert.equal(harness.calls(), 1);
    assert.deepEqual(second.messages, first.messages);
  } finally {
    delete process.env.PI_STATE_COMPACTOR_TRIGGER;
  }
});

test("a reasoning-only checkpoint response is accepted", async () => {
  process.env.PI_STATE_COMPACTOR_TRIGGER = "10000";
  try {
    const messages = Array.from({ length: 12 }, (_, index) =>
      makeMessage(index % 2 ? "assistant" : "user", `${index}: ${"r".repeat(3_000)}`, index + 1),
    );
    const harness = setup(messages, [{ type: "thinking", thinking: validState("e1") }]);
    await harness.handlers.get("context")({ messages }, harness.ctx);
    assert.equal(harness.branch.at(-1).data.state.active.text, "Continue the current request");
    assert.equal(harness.branch.at(-1).data.state.completedActions.length, 0);
  } finally {
    delete process.env.PI_STATE_COMPACTOR_TRIGGER;
  }
});

test("an orchestrator task overrides requests in the completed opening", async () => {
  process.env.PI_STATE_COMPACTOR_TRIGGER = "10000";
  globalThis.__piWorkingStateHosts = new Map([
    ["session-test", { activeTask: "Classify the current ledger obligation", openingMessageCount: 4 }],
  ]);
  try {
    const messages = Array.from({ length: 12 }, (_, index) =>
      makeMessage(index % 2 ? "assistant" : "user", `${index}: ${"y".repeat(3_000)}`, index + 1),
    );
    const harness = setup(messages, validState("e1"));
    const result = await harness.handlers.get("context")({ messages }, harness.ctx);
    assert.match(result.messages[0].content[0].text, /Classify the current ledger obligation \[host:task\]/);
  } finally {
    delete process.env.PI_STATE_COMPACTOR_TRIGGER;
    delete globalThis.__piWorkingStateHosts;
  }
});

test("invalid model output takes the deterministic interactive path", async () => {
  process.env.PI_STATE_COMPACTOR_TRIGGER = "10000";
  try {
    const messages = Array.from({ length: 12 }, (_, index) =>
      makeMessage(index % 2 ? "assistant" : "user", `${index}: ${"z".repeat(3_000)}`, index + 1),
    );
    const harness = setup(messages, "not json");
    const result = await harness.handlers.get("context")({ messages }, harness.ctx);
    assert.match(result.messages[0].content[0].text, /## Current activity/);
    assert.match(result.messages[0].content[0].text, /\[e[0-9]+\]/);
    assert.equal(harness.branch.at(-1).data.state.active.sources.length, 1);
  } finally {
    delete process.env.PI_STATE_COMPACTOR_TRIGGER;
  }
});

test("state_recall pages exact branch sources", async () => {
  const source = makeMessage("user", "abcdefghij", 1);
  const harness = setup([source], validState());
  const result = await harness.tools.get("state_recall").execute(
    "call",
    { source_id: "e1", offset: 5, max_chars: 7 },
    undefined,
    undefined,
    harness.ctx,
  );
  assert.equal(result.details.found, true);
  assert.equal(result.details.offset, 5);
  assert.ok(result.details.totalChars > result.content[0].text.length);
});

test("native compaction uses the same working-state format", async () => {
  const messages = [makeMessage("user", "Do the work", 1), makeMessage("assistant", "Working", 2)];
  const harness = setup(messages, validState("e1"));
  const result = await harness.handlers.get("session_before_compact")(
    {
      branchEntries: harness.branch,
      signal: undefined,
      preparation: {
        messagesToSummarize: [messages[0]],
        turnPrefixMessages: [],
        firstKeptEntryId: "e2",
        tokensBefore: 80_000,
      },
    },
    harness.ctx,
  );
  assert.match(result.compaction.summary, /^# Working state/);
  assert.equal(result.compaction.details.type, "state-compactor.checkpoint");
  assert.equal(result.compaction.firstKeptEntryId, "e2");
});

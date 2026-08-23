import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { estimateTokens } from "@earendil-works/pi-coding-agent";

const ALERTS = mkdtempSync(join(tmpdir(), "context-guard-alerts-"));
process.env.PI_CONTEXT_GUARD_ALERTS = ALERTS;
process.on("exit", () => rmSync(ALERTS, { recursive: true, force: true }));
const { default: guard } = await import("./index.mjs");

function alertFiles() {
  return readdirSync(ALERTS);
}

function clearAlerts() {
  for (const file of alertFiles()) rmSync(join(ALERTS, file));
}

function makeHarness({ completeText = "SUMMARY BODY", modelAvailable = true, provider = "test" } = {}) {
  const handlers = new Map();
  const pi = { on: (name, fn) => handlers.set(name, fn) };
  guard(pi);
  let completeCalls = 0;
  let lastCompleteOptions = null;
  let lastCompleteContext = null;
  const ctx = {
    sessionManager: {
      getSessionFile: () => "/tmp/session.jsonl",
      getSessionId: () => "sess-test",
    },
    model: modelAvailable ? { id: "test-model", provider } : null,
    modelRegistry: {
      complete: async (_model, context, options) => {
        completeCalls++;
        lastCompleteContext = context;
        lastCompleteOptions = options;
        return { content: [{ type: "text", text: completeText }], usage: {} };
      },
    },
  };
  return {
    fire: (messages) => handlers.get("context")({ type: "context", messages }, ctx),
    emit: (name, event = { type: name }) => handlers.get(name)?.(event, ctx),
    getCompleteCalls: () => completeCalls,
    getLastCompleteOptions: () => lastCompleteOptions,
    getLastCompleteContext: () => lastCompleteContext,
  };
}

const big = "x".repeat(40_000);
const user = (text) => ({ role: "user", content: [{ type: "text", text }], timestamp: 100 });
const turn = (i, payload = big) => [
  {
    role: "assistant",
    timestamp: 200 + i,
    usage: {},
    stopReason: "toolUse",
    content: [
      { type: "thinking", thinking: payload, thinkingSignature: `sig${i}` },
      { type: "text", text: `step ${i}` },
      { type: "toolCall", id: `call_${i}|fc_${i}`, name: "bash", arguments: { cmd: `c${i}` } },
    ],
  },
  {
    role: "toolResult",
    toolCallId: `call_${i}|fc_${i}`,
    toolName: "bash",
    content: [{ type: "text", text: payload }],
    isError: false,
    timestamp: 200 + i,
  },
];

function session(turns, payload = big) {
  const messages = [user("task packet")];
  for (let i = 0; i < turns; i++) messages.push(...turn(i, payload));
  return messages;
}

let responseTimestamp = 10_000;
function response(promptTokens, stopReason = "stop") {
  return {
    role: "assistant",
    timestamp: responseTimestamp++,
    content: [{ type: "text", text: "response" }],
    usage: {
      input: 2,
      cacheRead: Math.max(0, promptTokens - 2),
      cacheWrite: 0,
      output: 10,
      totalTokens: promptTokens + 10,
      cost: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, total: 0 },
    },
    stopReason,
  };
}

function residueSession(turns = 20, assistantChars = 8_000, toolChars = 40_000) {
  const messages = [user("task packet")];
  for (let i = 0; i < turns; i++) {
    messages.push(
      {
        role: "assistant",
        timestamp: 20_000 + i,
        usage: {},
        stopReason: "toolUse",
        content: [
          { type: "text", text: "a".repeat(assistantChars) },
          { type: "toolCall", id: `residue_${i}`, name: "bash", arguments: { command: `step ${i}` } },
        ],
      },
      {
        role: "toolResult",
        toolCallId: `residue_${i}`,
        toolName: "bash",
        content: [{ type: "text", text: "t".repeat(toolChars) }],
        isError: false,
        timestamp: 20_000 + i,
      },
    );
  }
  return messages;
}

test("a small fresh conversation is untouched", async () => {
  const h = makeHarness();
  const result = await h.fire([user("x".repeat(100_000))]);
  assert.equal(result, undefined);
});

test("a low historical usage anchor cannot suppress the first resumed-session cut", async () => {
  const h = makeHarness();
  const messages = session(5);
  messages.at(-2).usage = response(74_774).usage;
  messages.at(-2).stopReason = "stop";

  const result = await h.fire(messages);
  assert.ok(result?.messages, "the unknown resumed view must use the conservative ratio and cut");
  assert.ok(result.messages.some(
    (message) => message.role === "toolResult" && message.content[0]?.text?.includes("context-guard evicted"),
  ));
});

test("a cut keeps its latest tail byte-identical", async () => {
  const h = makeHarness();
  const messages = session(12);
  const result = await h.fire(messages);
  assert.ok(result?.messages);
  const last = result.messages.at(-1);
  assert.equal(last, messages.at(-1));
  assert.ok(last.content[0].text.length >= big.length);
});

test("handoff summarization receives the already transformed candidate, not the oversized raw history", async () => {
  const h = makeHarness({ completeText: "## Intent\nkeep going" });
  const messages = residueSession();
  const rawEstimate = messages.reduce((sum, message) => sum + estimateTokens(message), 0);
  const result = await h.fire(messages);

  assert.equal(h.getCompleteCalls(), 1);
  assert.equal(h.getLastCompleteOptions()?.reasoningEffort, "low");
  const handoffMessages = h.getLastCompleteContext().messages;
  const handoffEstimate = handoffMessages.reduce((sum, message) => sum + estimateTokens(message), 0);
  assert.ok(handoffEstimate < rawEstimate / 2, `${handoffEstimate} should be far below ${rawEstimate}`);
  assert.ok(handoffMessages.some(
    (message) => message.role === "toolResult" && message.content[0]?.text?.includes("context-guard evicted"),
  ));
  assert.ok(result.messages.some(
    (message) => message.role === "user" && message.content[0]?.text?.includes("Context handoff summary"),
  ));
});

test("an empty handoff response uses deterministic hard compaction", async () => {
  const h = makeHarness({ completeText: "" });
  const messages = residueSession();
  const result = await h.fire(messages);

  assert.equal(h.getCompleteCalls(), 1);
  assert.ok(result.messages.some(
    (message) => message.role === "user" && message.content[0]?.text?.includes("Context hard-compaction fallback"),
  ));
  assert.equal(
    result.messages.some((message) => message.content[0]?.text?.includes("Context handoff summary")),
    false,
  );
});

test("an oversized transformed handoff skips the second provider call", async () => {
  const h = makeHarness();
  const messages = residueSession(30, 24_000, 1);
  const result = await h.fire(messages);
  assert.equal(h.getCompleteCalls(), 0);
  assert.ok(result.messages.some(
    (message) => message.role === "user" && message.content[0]?.text?.includes("Context hard-compaction fallback"),
  ));
});

test("a missing handoff model uses deterministic hard compaction", async () => {
  const h = makeHarness({ modelAvailable: false });
  const messages = residueSession();
  const result = await h.fire(messages);
  assert.equal(h.getCompleteCalls(), 0);
  assert.ok(result.messages.some(
    (message) => message.role === "user" && message.content[0]?.text?.includes("Context hard-compaction fallback"),
  ));
});

test("floor probing uses the cut response even when it was aborted", async () => {
  clearAlerts();
  const h = makeHarness();
  const messages = session(5);
  messages.at(-2).usage = response(407_095).usage;
  messages.at(-2).stopReason = "stop";
  await h.fire(messages);

  messages.push(response(168_759, "aborted"));
  await h.fire(messages);

  assert.equal(alertFiles().length, 1);
  const body = readFileSync(join(ALERTS, alertFiles()[0]), "utf8");
  assert.match(body, /168,759/);
  assert.doesNotMatch(body, /407,095/);
  clearAlerts();
});

test("a measured healthy cut landing does not alert", async () => {
  clearAlerts();
  const h = makeHarness();
  const messages = session(5);
  await h.fire(messages);
  messages.push(response(129_000, "aborted"));
  await h.fire(messages);
  assert.deepEqual(alertFiles(), []);
});

test("Cursor is excluded because server-side continuation does not honor transformed history", async () => {
  const h = makeHarness({ provider: "cursor" });
  assert.equal(await h.fire(session(30)), undefined);
  assert.equal(h.getCompleteCalls(), 0);
});

test("PI_CONTEXT_GUARD=off disables everything", () => {
  process.env.PI_CONTEXT_GUARD = "off";
  try {
    const handlers = new Map();
    guard({ on: (name, fn) => handlers.set(name, fn) });
    assert.equal(handlers.size, 0);
  } finally {
    delete process.env.PI_CONTEXT_GUARD;
  }
});

test("a registered protected head keeps its voice, not its tool payloads", async () => {
  // The orchestrator's opening-pin extension registers the lived opening
  // exchange's span under the session id. The agent has to keep recognizing
  // those words as its own, so they cross byte-identical — thinking and
  // signatures included. The tool results it read while producing them are
  // not its words, and pinning them verbatim is what put the math fleet's
  // floor above the floor alert's own threshold.
  (globalThis.__piContextGuardProtect ??= new Map()).set("sess-test", 5);
  try {
    const h = makeHarness();
    const messages = session(12);
    const result = await h.fire(messages);
    assert.ok(result?.messages, "expected a cut");
    for (let i = 0; i < 5; i++) {
      if (messages[i].role === "toolResult") continue;
      assert.deepEqual(result.messages[i], messages[i], `protected message ${i} lost its voice`);
    }
    const headToolResults = result.messages
      .slice(0, 5)
      .filter((m) => m.role === "toolResult");
    assert.ok(headToolResults.length > 0, "fixture needs a tool result inside the head");
    for (const m of headToolResults) {
      assert.match(m.content[0].text, /context-guard evicted this/);
      assert.notEqual(m.content[0].text, big);
    }
  } finally {
    globalThis.__piContextGuardProtect.delete("sess-test");
  }
});

test("PI_CONTEXT_GUARD_TRIGGER only ever lowers the cap", async () => {
  // The override exists so a deployed cap can be proven in one cheap session
  // instead of a 250k-token one; it must not be able to raise the cap above
  // the price tier the guard defends.
  process.env.PI_CONTEXT_GUARD_TRIGGER = "900000";
  try {
    const h = makeHarness();
    assert.equal(await h.fire(session(2)), undefined, "a small view was cut under a raised trigger");
  } finally {
    delete process.env.PI_CONTEXT_GUARD_TRIGGER;
  }

  process.env.PI_CONTEXT_GUARD_TRIGGER = "not-a-number";
  try {
    const h = makeHarness();
    assert.equal(await h.fire(session(2)), undefined, "an unreadable override changed behavior");
  } finally {
    delete process.env.PI_CONTEXT_GUARD_TRIGGER;
  }

  process.env.PI_CONTEXT_GUARD_TRIGGER = "1000";
  try {
    const h = makeHarness();
    const result = await h.fire(session(6));
    assert.ok(result?.messages, "a lowered trigger did not cut a view it should have");
  } finally {
    delete process.env.PI_CONTEXT_GUARD_TRIGGER;
  }
});

test("the floor threshold scales with a lowered trigger instead of going negative", async () => {
  // A fixed trigger - 100k headroom is negative under any small trigger, which
  // made every cut in a validation session file a floor alert.
  process.env.PI_CONTEXT_GUARD_TRIGGER = "35000";
  clearAlerts();
  try {
    const h = makeHarness();
    const messages = session(5);
    await h.fire(messages);
    // A cut that landed at 3,420 against a 35,000 trigger is as healthy as a
    // landing of 24,000 against the default one. Under a fixed 100k headroom
    // the threshold is negative, so this filed a floor alert.
    messages.push(response(3_420, "aborted"));
    await h.fire(messages);
    assert.deepEqual(alertFiles(), [], "a healthy small-trigger cut was reported as a floor breach");
  } finally {
    delete process.env.PI_CONTEXT_GUARD_TRIGGER;
    clearAlerts();
  }
});

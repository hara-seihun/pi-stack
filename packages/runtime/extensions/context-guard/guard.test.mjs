import assert from "node:assert/strict";
import { test } from "node:test";
import guard from "./index.mjs";

function makeHarness({ completeText = "SUMMARY BODY" } = {}) {
  const handlers = new Map();
  const pi = { on: (name, fn) => handlers.set(name, fn) };
  guard(pi);
  let anchor = null;
  let completeCalls = 0;
  const ctx = {
    sessionManager: {
      getSessionFile: () => "/tmp/session.jsonl",
      getSessionId: () => "sess-test",
    },
    getContextUsage: () => (anchor === null ? undefined : { tokens: anchor, contextWindow: 1_000_000, percent: null }),
    model: { id: "test-model", provider: "test" },
    modelRegistry: {
      complete: async () => {
        completeCalls++;
        return { content: [{ type: "text", text: completeText }], usage: {} };
      },
    },
  };
  return {
    fire: (messages) => handlers.get("context")({ type: "context", messages }, ctx),
    setAnchor: (t) => { anchor = t; },
    getCompleteCalls: () => completeCalls,
  };
}

const big = "x".repeat(40_000); // ~10k estimated tokens
const user = (text) => ({ role: "user", content: [{ type: "text", text }], timestamp: 100 });
const turn = (i, payload) => [
  {
    role: "assistant",
    timestamp: 200 + i,
    usage: {},
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
  const msgs = [user("task packet")];
  for (let i = 0; i < turns; i++) msgs.push(...turn(i, payload));
  return msgs;
}

test("no modification below the trigger", async () => {
  const h = makeHarness();
  h.setAnchor(120_000);
  const result = await h.fire(session(5));
  assert.equal(result, undefined);
});

test("cuts when the usage anchor crosses the trigger, and the view shrinks", async () => {
  const h = makeHarness();
  const msgs = session(12); // ~240k estimated raw
  h.setAnchor(260_000);
  const result = await h.fire(msgs);
  assert.ok(result?.messages, "expected a replacement view");
  assert.ok(result.messages.length <= msgs.length);
  const old = result.messages.filter(
    (m) => m.role === "toolResult" && m.content[0]?.text?.includes("context-guard evicted"),
  );
  assert.ok(old.length > 0, "expected evicted tool results");
  assert.match(old[0].content[0].text, /\/tmp\/session\.jsonl/);
  // Tail survives verbatim: the last toolResult still has its full payload.
  const last = result.messages[result.messages.length - 1];
  assert.equal(last.role, "toolResult");
  assert.ok(last.content[0].text.length >= big.length);
});

test("stale anchor after a cut does not cause a second cut", async () => {
  const h = makeHarness();
  const msgs = session(12);
  h.setAnchor(260_000);
  const first = await h.fire(msgs);
  const firstLen = first.messages.length;
  // Anchor still reports pre-cut usage (no response yet); two new small turns arrive.
  msgs.push(...turn(12, "small"), ...turn(13, "small"));
  const second = await h.fire(msgs);
  // Watermark must not have advanced: same number of placeholder results.
  const placeholders = (v) =>
    v.messages.filter((m) => m.role === "toolResult" && m.content[0]?.text?.includes("evicted")).length;
  assert.equal(placeholders(second), placeholders(first));
  assert.equal(second.messages.length, firstLen + 4);
  // Anchor refreshes low -> pendingCut clears, still no new cut needed.
  h.setAnchor(120_000);
  const third = await h.fire(msgs);
  assert.equal(placeholders(third), placeholders(first));
});

test("escalates to a handoff summary when residue exceeds the cap", async () => {
  const h = makeHarness({ completeText: "## Intent\nkeep going" });
  // Residue-heavy session: large assistant TEXT (unevictable) rather than tool results.
  const msgs = [user("task packet")];
  for (let i = 0; i < 30; i++) {
    msgs.push(
      {
        role: "assistant",
        timestamp: 300 + i,
        usage: {},
        content: [{ type: "text", text: "t".repeat(24_000) }], // ~6k tokens each, unevictable
      },
      ...turn(i, "small"),
    );
  }
  h.setAnchor(300_000);
  const result = await h.fire(msgs);
  assert.equal(h.getCompleteCalls(), 1, "expected exactly one summary call");
  const summary = result.messages.find(
    (m) => m.role === "user" && m.content[0]?.text?.includes("Context handoff summary"),
  );
  assert.ok(summary, "expected the summary message in the view");
  assert.match(summary.content[0].text, /## Intent/);
  // Summarized span dropped: view must be much shorter than the source.
  assert.ok(result.messages.length < msgs.length / 2);
});

test("PI_CONTEXT_GUARD=off disables everything", async () => {
  process.env.PI_CONTEXT_GUARD = "off";
  try {
    const handlers = new Map();
    guard({ on: (name, fn) => handlers.set(name, fn) });
    assert.equal(handlers.size, 0);
  } finally {
    delete process.env.PI_CONTEXT_GUARD;
  }
});

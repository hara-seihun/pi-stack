import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

// The alerts inbox is a real machine surface, so every test in this file writes
// to a throwaway directory instead of `/home/kenan/data/alerts/inbox`.
const ALERTS = mkdtempSync(join(tmpdir(), "context-guard-alerts-"));
process.env.PI_CONTEXT_GUARD_ALERTS = ALERTS;
process.on("exit", () => rmSync(ALERTS, { recursive: true, force: true }));
const { default: guard } = await import("./index.mjs");
const { CFG, planCut } = await import("./plan.mjs");

function alerts() {
  return readdirSync(ALERTS);
}

function makeHarness({ completeText = "SUMMARY BODY" } = {}) {
  const handlers = new Map();
  const pi = { on: (name, fn) => handlers.set(name, fn) };
  guard(pi);
  let anchor = null;
  let completeCalls = 0;
  let lastCompleteOptions = null;
  const ctx = {
    sessionManager: {
      getSessionFile: () => "/tmp/session.jsonl",
      getSessionId: () => "sess-test",
    },
    getContextUsage: () => (anchor === null ? undefined : { tokens: anchor, contextWindow: 1_000_000, percent: null }),
    model: { id: "test-model", provider: "test" },
    modelRegistry: {
      complete: async (model, context, options) => {
        completeCalls++;
        lastCompleteOptions = options;
        return { content: [{ type: "text", text: completeText }], usage: {} };
      },
    },
  };
  return {
    fire: (messages) => handlers.get("context")({ type: "context", messages }, ctx),
    setAnchor: (t) => { anchor = t; },
    getCompleteCalls: () => completeCalls,
    getLastCompleteOptions: () => lastCompleteOptions,
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
  // Rungs 1-2 preserve message count; the view adds at most the one notice.
  assert.ok(result.messages.length <= msgs.length + 1);
  const old = result.messages.filter(
    (m) => m.role === "toolResult" && m.content[0]?.text?.includes("context-guard evicted"),
  );
  assert.ok(old.length > 0, "expected evicted tool results");
  // The transcript path appears once, in the notice — not in every placeholder.
  const notice = result.messages.find(
    (m) => m.role === "user" && m.content[0]?.text?.includes("context-guard notice"),
  );
  assert.ok(notice, "expected the transcript notice");
  assert.match(notice.content[0].text, /\/tmp\/session\.jsonl/);
  assert.ok(
    !old[0].content[0].text.includes("/tmp/session.jsonl"),
    "placeholders must not each repeat the transcript path",
  );
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
  assert.equal(
    h.getLastCompleteOptions()?.reasoningEffort,
    "low",
    "the summary call must request low reasoning effort so reasoning cannot consume the output budget",
  );
  const summary = result.messages.find(
    (m) => m.role === "user" && m.content[0]?.text?.includes("Context handoff summary"),
  );
  assert.ok(summary, "expected the summary message in the view");
  assert.match(summary.content[0].text, /## Intent/);
  // Summarized span dropped: view must be much shorter than the source.
  assert.ok(result.messages.length < msgs.length / 2);
});

test("an empty handoff summary falls back to eviction without corrupting the view", async () => {
  const h = makeHarness({ completeText: "" });
  const msgs = [user("task packet")];
  for (let i = 0; i < 30; i++) {
    msgs.push(
      {
        role: "assistant",
        timestamp: 300 + i,
        usage: {},
        content: [{ type: "text", text: "t".repeat(24_000) }],
      },
      ...turn(i, "small"),
    );
  }
  h.setAnchor(300_000);
  const result = await h.fire(msgs);
  assert.equal(h.getCompleteCalls(), 1, "expected the summary attempt");
  const summary = result.messages.find(
    (m) => m.role === "user" && m.content[0]?.text?.includes("Context handoff summary"),
  );
  assert.equal(summary, undefined, "no summary message may be fabricated from empty text");
  assert.ok(
    result.messages.some((m) => m.role === "toolResult" && m.content[0]?.text?.includes("evicted")),
    "rungs 1-2 must still apply",
  );
});

test("a smaller billed-tail budget moves the boundary later", () => {
  const est = (m) => JSON.stringify(m).length / 4;
  const msgs = session(12);
  const wide = planCut(msgs, { watermark: 1, summary: null }, est, { ...CFG, tailTokens: 50_000 }, "");
  const narrow = planCut(msgs, { watermark: 1, summary: null }, est, { ...CFG, tailTokens: 50_000 / 2 }, "");
  assert.ok(
    narrow.boundary > wide.boundary,
    "dividing tailTokens by the calibration ratio must shrink the verbatim tail",
  );
});

test("a healthy landing does not alert, and a measured floor breach does", async () => {
  const healthy = makeHarness();
  const msgs = session(12);
  healthy.setAnchor(260_000);
  await healthy.fire(msgs);
  // The provider bills the cut prompt on the next call: comfortably under the
  // floor, so the uncalibrated estimate must not raise an alert by itself.
  msgs.push(...turn(12, "small"));
  healthy.setAnchor(129_000);
  await healthy.fire(msgs);
  assert.deepEqual(alerts(), [], "a healthy deep cut must not write an alert");

  const stuck = makeHarness();
  const pinned = session(12);
  stuck.setAnchor(260_000);
  await stuck.fire(pinned);
  // The cut barely helped: the provider still bills above trigger - headroom.
  pinned.push(...turn(12, "small"));
  stuck.setAnchor(210_000);
  await stuck.fire(pinned);
  assert.equal(alerts().length, 1, "a measured floor breach must write exactly one alert");
  assert.match(alerts()[0], /context-guard-floor-too-high/);
  // One-shot per session: a second breach must not fill the inbox.
  pinned.push(...turn(13, "small"));
  stuck.setAnchor(215_000);
  await stuck.fire(pinned);
  assert.equal(alerts().length, 1);
  rmSync(join(ALERTS, alerts()[0]));
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

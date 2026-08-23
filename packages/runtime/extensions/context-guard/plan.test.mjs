import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CFG,
  baseCallId,
  buildView,
  describeView,
  estimateView,
  fallbackMessage,
  findTailBoundary,
  headEnd,
  noticeMessage,
  planCut,
  summaryMessage,
  transformOldMessage,
} from "./plan.mjs";

const est = (m) => Math.ceil(JSON.stringify(m).length / 4);

const user = (text) => ({ role: "user", content: [{ type: "text", text }], timestamp: 1 });
const assistant = (blocks) => ({ role: "assistant", content: blocks, timestamp: 2, usage: {} });
const toolResult = (id, text) => ({
  role: "toolResult",
  toolCallId: id,
  toolName: "bash",
  content: [{ type: "text", text }],
  isError: false,
  timestamp: 3,
});

const bigText = "x".repeat(4000);

function sampleSession(turns) {
  const msgs = [user("task packet")];
  for (let i = 0; i < turns; i++) {
    msgs.push(
      assistant([
        { type: "thinking", thinking: bigText, thinkingSignature: `sig${i}` },
        { type: "text", text: `step ${i}`, textSignature: `{"v":1,"id":"msg_real_${i}"}` },
        { type: "toolCall", id: `call_${i}|fc_${i}`, name: "bash", arguments: { cmd: `run ${i}` } },
      ]),
      toolResult(`call_${i}|fc_${i}`, bigText),
    );
  }
  return msgs;
}

test("baseCallId strips provider item-id suffix only", () => {
  assert.equal(baseCallId("call_1|fc_9"), "call_1");
  assert.equal(baseCallId("toolu_abc"), "toolu_abc");
  assert.equal(baseCallId(undefined), undefined);
});

test("transformOldMessage evicts tool results with a pointer to the notice", () => {
  const t = transformOldMessage(toolResult("call_1|fc_1", bigText), "/tmp/s.jsonl", est);
  assert.equal(t.toolCallId, "call_1");
  assert.equal(t.content.length, 1);
  assert.match(t.content[0].text, /evicted this bash result/);
  // The transcript path lives once in the notice, not in every placeholder.
  assert.match(t.content[0].text, /notice above/);
  assert.ok(!t.content[0].text.includes("/tmp/s.jsonl"));
  assert.ok(est(t) < est(toolResult("call_1|fc_1", bigText)));
});

test("transformOldMessage strips thinking and validation metadata, keeps text and args", () => {
  const t = transformOldMessage(sampleSession(1)[1], "", est);
  assert.equal(t.content.some((b) => b.type === "thinking"), false);
  const text = t.content.find((b) => b.type === "text");
  assert.equal(text.text, "step 0");
  assert.equal(text.textSignature, undefined);
  const call = t.content.find((b) => b.type === "toolCall");
  assert.equal(call.id, "call_0");
  assert.deepEqual(call.arguments, { cmd: "run 0" });
});

test("thinking-only assistant messages get a placeholder, never empty content", () => {
  const t = transformOldMessage(
    assistant([{ type: "thinking", thinking: "...", thinkingSignature: "s" }]),
    "",
    est,
  );
  assert.equal(t.content.length, 1);
  assert.equal(t.content[0].type, "text");
});

test("user-ish messages pass through untouched", () => {
  const u = user("hello");
  assert.equal(transformOldMessage(u, "", est), u);
});

test("findTailBoundary never lands on a toolResult", () => {
  const msgs = sampleSession(20);
  const b = findTailBoundary(msgs, 1, est, 3_000);
  assert.notEqual(msgs[b].role, "toolResult");
  const tailTokens = msgs.slice(b).reduce((a, m) => a + est(m), 0);
  assert.ok(tailTokens >= 3_000);
});

test("compaction notice warmly restores headroom expectations with or without a transcript", () => {
  const withTranscript = noticeMessage("/tmp/s.jsonl", 9).content[0].text;
  assert.match(withTranscript, /Good news/);
  assert.match(withTranscript, /has just been compacted/);
  assert.match(withTranscript, /substantial context headroom again/);
  assert.match(withTranscript, /pre-compaction length doesn't need to limit/);
  assert.match(withTranscript, /good position to keep going/);
  assert.doesNotMatch(withTranscript, /do not|must not/);
  assert.match(withTranscript, /\/tmp\/s\.jsonl/);

  const withoutTranscript = noticeMessage("", 9).content[0].text;
  assert.match(withoutTranscript, /substantial context headroom again/);
  assert.doesNotMatch(withoutTranscript, /greppable at:/);
});

test("buildView returns null when untouched and is deterministic when cut", () => {
  const msgs = sampleSession(10);
  assert.equal(buildView(msgs, { watermark: 1, summary: null }, est, ""), null);
  const state = { watermark: 11, summary: null };
  const a = buildView(msgs, state, est, "/tmp/s.jsonl");
  const b = buildView(msgs, state, est, "/tmp/s.jsonl");
  assert.deepEqual(a, b);
  // Exactly one notice carries the transcript path for all placeholders.
  const notices = a.filter((m) => m.role === "user" && m.content[0]?.text?.includes("context-guard notice"));
  assert.equal(notices.length, 1);
  assert.match(notices[0].content[0].text, /\/tmp\/s\.jsonl/);
  assert.match(notices[0].content[0].text, /substantial context headroom again/);
  // Tail is byte-identical: same object references as the source array.
  assert.equal(a[a.length - 1], msgs[msgs.length - 1]);
  // Old thinking is gone from the view.
  const oldAssistants = a.slice(1, 11).filter((m) => m.role === "assistant");
  assert.ok(oldAssistants.length > 0);
  for (const m of oldAssistants) {
    assert.equal(m.content.some((c) => c.type === "thinking"), false);
  }
});

test("fallback message names the recoverable transcript without claiming a summary", () => {
  const message = fallbackMessage("/tmp/s.jsonl", 9);
  assert.match(message.content[0].text, /hard-compaction fallback/);
  assert.match(message.content[0].text, /\/tmp\/s\.jsonl/);
  assert.doesNotMatch(message.content[0].text, /handoff summary/);
});

test("summary replaces span but preserves user-ish messages verbatim", () => {
  const msgs = sampleSession(10);
  msgs.splice(5, 0, user("steering follow-up"));
  const state = {
    watermark: 12,
    summary: { message: summaryMessage("SUMMARY", "/tmp/s.jsonl", 9), coversUpTo: 12 },
  };
  const view = buildView(msgs, state, est, "");
  assert.match(view[1].content[0].text, /SUMMARY/);
  assert.match(view[1].content[0].text, /greppable at: \/tmp\/s\.jsonl/);
  assert.ok(view.some(
    (m) => m.role === "user" && m.content[0]?.text?.includes("substantial context headroom again"),
  ));
  assert.ok(view.some((m) => m.role === "user" && m.content[0]?.text === "steering follow-up"));
  // Summarized assistants/toolResults are gone entirely: only tail ones remain.
  const tailToolResults = msgs.slice(12).filter((m) => m.role === "toolResult").length;
  assert.equal(view.filter((m) => m.role === "toolResult").length, tailToolResults);
});

test("planCut is monotone and shrinks the view", () => {
  const msgs = sampleSession(40);
  const full = estimateView(msgs, { watermark: 1, summary: null }, est, "");
  const state = { watermark: 17, summary: null };
  const { boundary, landEstimate } = planCut(msgs, state, est, { ...CFG, tailTokens: 3_000 }, "");
  assert.ok(boundary >= state.watermark);
  assert.ok(landEstimate < full * 0.6, `land ${landEstimate} vs full ${full}`);
  // Re-planning after adopting the watermark does not regress.
  const again = planCut(msgs, { watermark: boundary, summary: null }, est, { ...CFG, tailTokens: 3_000 }, "");
  assert.ok(again.boundary >= boundary);
});

test("repeated cuts deplete: residue grows monotonically across cuts", () => {
  const msgs = sampleSession(60);
  const cfg = { ...CFG, tailTokens: 3_000 };
  const s1 = { watermark: 1, summary: null };
  const c1 = planCut(msgs, s1, est, cfg, "");
  const c2 = planCut(msgs, { watermark: c1.boundary, summary: null }, est, cfg, "");
  // Second plan on the same array cannot land lower than the first: the
  // unevictable residue only accumulates.
  assert.ok(c2.landEstimate >= c1.landEstimate - 5);
});

test("protected head keeps its voice across a cut but not its tool payloads", () => {
  const msgs = sampleSession(20);
  // Protect an opening exchange: user, two full turns (assistant+toolResult each).
  const state = { watermark: 1, summary: null, protect: 5 };
  const { boundary } = planCut(msgs, state, est, { ...CFG, tailTokens: 3_000 }, "");
  assert.ok(boundary >= 5, `boundary ${boundary} regressed into the protected span`);
  const view = buildView(msgs, { ...state, watermark: boundary }, est, "/tmp/s.jsonl");
  // The agent's own words cross byte-identical, thinking and signatures included.
  for (let i = 0; i < 5; i++) {
    if (msgs[i].role === "toolResult") continue;
    assert.equal(view[i], msgs[i], `protected message ${i} lost its voice`);
  }
  // What it read while saying them does not: pinning those spent most of the cap.
  const heads = msgs.slice(0, 5).filter((m) => m.role === "toolResult");
  assert.ok(heads.length > 0, "fixture needs a tool result inside the head");
  for (let i = 0; i < 5; i++) {
    if (msgs[i].role !== "toolResult") continue;
    assert.match(view[i].content[0].text, /context-guard evicted this/);
  }
  // The notice lands after the protected span, not inside it.
  const noticeAt = view.findIndex(
    (m) => m.role === "user" && m.content[0]?.text?.includes("context-guard notice"),
  );
  assert.equal(noticeAt, 5);
});

test("a head too large for its budget is honored only as far as it fits", () => {
  const msgs = sampleSession(40);
  const cfg = { ...CFG, headMax: 2_000 };
  const full = headEnd(msgs, { protect: 30 }, est, CFG);
  const clamped = headEnd(msgs, { protect: 30 }, est, cfg);
  assert.equal(full, 30, "the whole span fits the default budget");
  assert.ok(clamped >= 1 && clamped < 30, `clamped head ${clamped} should be a proper prefix`);
  const at = describeView(msgs, { watermark: 35, summary: null, protect: 30 }, est, "", cfg);
  assert.equal(at.headClamped, true);
  assert.equal(at.headRequested, 30);
  assert.ok(at.headTokens <= cfg.headMax + 2_000, `head ${at.headTokens} ignored its budget`);
});

test("evicting the head's tool results is what pulls the floor down", () => {
  // The math fleet's measured shape: a pinned opening that is 87-91%
  // tool-result bytes, because every opening prompt is answered with real
  // unbounded tool use. Honoring that byte-identical spent 84-119k billed
  // tokens of a 250k cap on every request until the session died.
  const opening = [user("read the ledger and tell me what you see")];
  for (let i = 0; i < 10; i++) {
    opening.push(assistant([{ type: "text", text: `looking at ${i}` }]));
    opening.push(toolResult(`call_${i}`, "y".repeat(24_000)));
  }
  const msgs = [...opening, ...sampleSession(30).slice(1)];
  const state = { watermark: msgs.length - 4, summary: null, protect: opening.length };

  const pinnedVerbatim = opening.reduce((sum, m) => sum + est(m), 0);
  const at = describeView(msgs, state, est, "");
  assert.ok(
    at.headTokens < pinnedVerbatim / 10,
    `head ${at.headTokens} vs ${pinnedVerbatim} verbatim: eviction recovered too little`,
  );
  // The words survive; only what the agent read while saying them is gone.
  const view = buildView(msgs, state, est, "");
  for (let i = 0; i < opening.length; i++) {
    if (msgs[i].role === "toolResult") continue;
    assert.equal(view[i], msgs[i]);
  }
});

test("summary escalation never covers the protected head", () => {
  const msgs = sampleSession(20);
  const summary = { message: summaryMessage("handoff", "/tmp/s.jsonl", 9), coversUpTo: 3 };
  // A summary claiming to cover part of the protected span is clamped: the
  // protected messages still cross verbatim, ahead of the summary message.
  const view = buildView(msgs, { watermark: 15, summary, protect: 5 }, est, "");
  for (let i = 0; i < 5; i++) {
    if (msgs[i].role === "toolResult") continue;
    assert.equal(view[i], msgs[i]);
  }
  assert.match(view[5].content[0].text, /handoff summary/);
  // No protected message appears twice (the summarized-span walk starts at
  // the head boundary, not at the summary's claimed start).
  assert.equal(view.filter((m) => m === msgs[1]).length, 1);
});

test("a cut still reaches the head when the watermark cannot pass it", () => {
  // The pathological shape: the pinned head is the bulk, so the tail boundary
  // lands on the head itself and the old span is empty. This used to return
  // null and send the raw view, enforcing nothing at all.
  const msgs = [user("task packet"), assistant([{ type: "text", text: "reading" }]), toolResult("call_0", bigText)];
  msgs.push(assistant([{ type: "text", text: "done" }]));
  const state = { watermark: 3, summary: null, protect: 3, cut: true };
  const view = buildView(msgs, state, est, "/tmp/s.jsonl");
  assert.ok(view, "a cut in effect must produce a view");
  assert.match(view[2].content[0].text, /context-guard evicted this/);
  assert.ok(
    estimateView(msgs, state, est, "") < msgs.reduce((s, m) => s + est(m), 0) / 2,
    "the head's payload survived a cut that had nowhere else to go",
  );
  // Before any cut the head is still sent whole.
  assert.equal(buildView(msgs, { ...state, cut: false, watermark: 1 }, est, ""), null);
});

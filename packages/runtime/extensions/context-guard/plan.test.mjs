import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CFG,
  baseCallId,
  buildView,
  estimateView,
  fallbackMessage,
  findTailBoundary,
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

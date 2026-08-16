import assert from "node:assert/strict";
import test from "node:test";
import {
  conversationLeafText,
  conversationModelEvidence,
  conversationStreamEvidence,
  defaultPoolState,
  normalizePoolState,
} from "./browser.mjs";

function conversation({ resolved = "gpt-5-6-pro", executed = "gpt-5-6-pro", progress = 100, skipped = false } = {}) {
  return {
    current_node: "assistant",
    mapping: {
      user: {
        message: {
          author: { role: "user" },
          metadata: { resolved_model_slug: resolved },
        },
      },
      progress: {
        message: {
          author: { role: "system" },
          metadata: { pro_progress: progress, pro_skipped: skipped, finished_duration_sec: 812 },
        },
      },
      assistant: {
        message: {
          author: { role: "assistant" },
          status: "finished_successfully",
          end_turn: true,
          content: { parts: ["proved text"] },
          metadata: { model_slug: executed, is_complete: true },
        },
      },
    },
  };
}

test("persisted conversation proves the complete GPT-5.6 Pro invariant", () => {
  const data = conversation();
  const evidence = conversationModelEvidence(data);
  assert.equal(evidence.pro_execution_verified, true);
  assert.equal(evidence.finished_duration_sec, 812);
  assert.equal(conversationLeafText(data), "proved text");
});

test("completed conversation SSE supplies the same execution invariant", () => {
  const events = [
    { message: { author: { role: "user" }, metadata: { resolved_model_slug: "gpt-5-6-pro" } } },
    { message: { author: { role: "system" }, metadata: { pro_progress: 100, pro_skipped: false, finished_duration_sec: 44 } } },
    { message: { author: { role: "assistant" }, status: "finished_successfully", end_turn: true, content: { parts: ["answer"] }, metadata: { model_slug: "gpt-5-6-pro", is_complete: true } } },
  ];
  const body = `${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`;
  const parsed = conversationStreamEvidence(body);
  assert.equal(parsed.evidence.pro_execution_verified, true);
  assert.equal(parsed.evidence.finished_duration_sec, 44);
  assert.equal(parsed.text, "answer");
});

test("picker-compatible assistant metadata cannot hide a routed fallback", () => {
  const evidence = conversationModelEvidence(conversation({ resolved: "gpt-5-5-mini" }));
  assert.equal(evidence.model_slug, "gpt-5-6-pro");
  assert.equal(evidence.resolved_model_slug, "gpt-5-5-mini");
  assert.equal(evidence.pro_execution_verified, false);
});

test("skipped or incomplete Pro work is rejected", () => {
  assert.equal(conversationModelEvidence(conversation({ skipped: true })).pro_execution_verified, false);
  assert.equal(conversationModelEvidence(conversation({ progress: 95 })).pro_execution_verified, false);
});

test("browser pool state has one profile entitlement and drops obsolete OAuth shape", () => {
  const initial = defaultPoolState();
  assert.equal(initial.version, 3);
  assert.equal(initial.browserProfile, "kenan-personal");
  assert.equal(initial.inFlightUntil, 0);
  assert.deepEqual(normalizePoolState({ version: 2, cooldowns: { account: 1 } }), initial);
  assert.equal(normalizePoolState({
    version: 3,
    browserProfile: "kenan-personal",
    selectionCount: 4,
    inFlightUntil: 9,
    cooldownUntil: 10,
    cooldownReason: "rate-limit",
    lastVerifiedAt: "2026-08-16T00:00:00.000Z",
  }).selectionCount, 4);
});

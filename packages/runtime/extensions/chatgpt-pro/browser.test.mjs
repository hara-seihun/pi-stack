import assert from "node:assert/strict";
import test from "node:test";
import {
  conversationActivityMarker,
  conversationLeafText,
  conversationModelEvidence,
  browserPoolCapacitySnapshot,
  conversationStreamEvidence,
  defaultPoolState,
  isTerminalConversationEvidence,
  nextFallbackCooldown,
  normalizePoolState,
  PRO_MAX_PARALLEL,
  PRO_TRANSPORT_HORIZONS,
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

test("current persisted schema proves completion without the removed is_complete metadata", () => {
  const data = conversation();
  delete data.mapping.assistant.message.metadata.is_complete;
  data.mapping.assistant.children = [];
  data.async_status = 4;
  const evidence = conversationModelEvidence(data);
  assert.equal(evidence.current_node_is_leaf, true);
  assert.equal(evidence.conversation_async_status, 4);
  assert.equal(evidence.pro_execution_verified, true);

  data.mapping.assistant.children = ["later"];
  assert.equal(conversationModelEvidence(data).pro_execution_verified, false);
});

test("reasoning-completion schema proves Pro work when progress is omitted", () => {
  const turn = "turn-1";
  const data = {
    current_node: "answer",
    async_status: 4,
    mapping: {
      user: {
        message: {
          author: { role: "user" },
          metadata: { resolved_model_slug: "gpt-5-6-pro", working_turn_id: turn },
        },
      },
      work: {
        message: {
          author: { role: "tool" },
          status: "finished_successfully",
          metadata: {
            model_slug: "gpt-5-6-pro",
            pro_skipped: false,
            finished_duration_sec: 7,
            reasoning_start_time: 100,
            working_turn_id: turn,
          },
        },
      },
      reasoning: {
        message: {
          author: { role: "assistant" },
          status: "finished_successfully",
          end_turn: true,
          metadata: {
            reasoning_status: "reasoning_ended",
            reasoning_start_time: 100,
            reasoning_end_time: 107,
            working_turn_id: turn,
          },
        },
      },
      answer: {
        children: [],
        message: {
          author: { role: "assistant" },
          status: "finished_successfully",
          end_turn: true,
          content: { parts: ["answer"] },
          metadata: {
            model_slug: "gpt-5-6-pro",
            default_model_slug: "gpt-5-6-pro",
            working_turn_id: turn,
          },
        },
      },
    },
  };
  const evidence = conversationModelEvidence(data);
  assert.equal(evidence.pro_progress, undefined);
  assert.equal(evidence.pro_execution_verified, true);

  data.mapping.work.message.metadata.pro_skipped = true;
  assert.equal(conversationModelEvidence(data).pro_execution_verified, false);
  data.mapping.work.message.metadata.pro_skipped = false;
  data.mapping.reasoning.message.metadata.working_turn_id = "other-turn";
  assert.equal(conversationModelEvidence(data).pro_execution_verified, false);
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

test("transport horizons accommodate multi-hour Pro reasoning without lease overlap", () => {
  assert.ok(PRO_TRANSPORT_HORIZONS.responseWaitMs >= 60 * 60_000);
  assert.ok(PRO_TRANSPORT_HORIZONS.stalledWorkMs < PRO_TRANSPORT_HORIZONS.responseWaitMs);
  assert.ok(PRO_TRANSPORT_HORIZONS.browserTimeoutSeconds * 1000 > PRO_TRANSPORT_HORIZONS.responseWaitMs);
  assert.ok(PRO_TRANSPORT_HORIZONS.accountLeaseMs >= PRO_TRANSPORT_HORIZONS.browserTimeoutSeconds * 1000);
});

test("async Pro stream updates are not mistaken for a completed turn", () => {
  for (const partial of [
    { message_end_turn: null },
    { message_end_turn: true, pro_progress: 12, pro_work_status: "in_progress", reasoning_status: "is_reasoning" },
  ]) assert.equal(isTerminalConversationEvidence({
    model_slug: "gpt-5-6-pro",
    resolved_model_slug: "gpt-5-6-pro",
    message_status: "finished_successfully",
    current_node_is_leaf: true,
    conversation_async_status: 3,
    pro_execution_verified: false,
    ...partial,
  }), false);
  assert.equal(isTerminalConversationEvidence({
    model_slug: "gpt-5-5-mini",
    resolved_model_slug: "gpt-5-5-mini",
    message_status: "finished_successfully",
    message_end_turn: true,
    current_node_is_leaf: true,
    pro_execution_verified: false,
  }), true);
});

test("persisted activity markers advance on progress or new work nodes", () => {
  const base = {
    current_node: "work-1",
    mapping: {
      "work-1": { message: { create_time: 10, update_time: 11 } },
    },
  };
  const first = conversationActivityMarker(base, { pro_progress: 12, pro_work_status: "in_progress" });
  assert.equal(first, conversationActivityMarker(structuredClone(base), { pro_progress: 12, pro_work_status: "in_progress" }));
  assert.notEqual(first, conversationActivityMarker(base, { pro_progress: 18, pro_work_status: "in_progress" }));
  const advanced = structuredClone(base);
  advanced.current_node = "work-2";
  advanced.mapping["work-2"] = { message: { create_time: 20 } };
  assert.notEqual(first, conversationActivityMarker(advanced, { pro_progress: 12, pro_work_status: "in_progress" }));
});

test("browser pool migrates one entitlement and admits no more than four configured profiles", () => {
  const initial = defaultPoolState(["limmy-google"]);
  assert.equal(initial.version, 4);
  assert.equal(initial.maxParallel, 4);
  assert.equal(initial.profiles[0].browserProfile, "limmy-google");
  assert.equal(initial.profiles[0].inFlightUntil, 0);
  assert.deepEqual(normalizePoolState({ version: 2, cooldowns: { account: 1 } }, ["limmy-google"]), initial);
  const normalized = normalizePoolState({
    version: 3,
    browserProfile: "limmy-google",
    selectionCount: 4,
    inFlightUntil: 9,
    cooldownUntil: 10,
    cooldownReason: "rate-limit",
    fallbackStreak: 2,
    lastFallbackAt: "2026-08-16T00:00:00.000Z",
    lastVerifiedAt: "2026-08-16T00:00:00.000Z",
  }, ["limmy-google"]);
  assert.equal(normalized.profiles[0].selectionCount, 4);
  assert.equal(normalized.profiles[0].fallbackStreak, 2);
  assert.equal(PRO_MAX_PARALLEL, 4);
});

test("browser capacity exposes running Pro agents and never exceeds four", () => {
  const at = 1_000;
  const names = ["pro-1", "pro-2", "pro-3", "pro-4"];
  const state = defaultPoolState(names);
  state.profiles[0].inFlightUntil = 2_000;
  state.profiles[1].inFlightUntil = 2_000;
  state.profiles[2].cooldownUntil = 2_000;
  assert.deepEqual(browserPoolCapacitySnapshot(state, at, names), {
    configured: 4,
    eligible: 3,
    inFlight: 2,
    available: 1,
    maxParallel: 4,
  });
});

test("routed fallbacks back off exponentially and reset after a quiet day", () => {
  const now = Date.parse("2026-08-16T12:00:00.000Z");
  const initial = defaultPoolState(["limmy-google"]).profiles[0];
  assert.deepEqual(nextFallbackCooldown(initial, now), { streak: 1, cooldownMs: 15 * 60_000 });
  const recent = { ...initial, fallbackStreak: 2, lastFallbackAt: "2026-08-16T11:59:00.000Z" };
  assert.deepEqual(nextFallbackCooldown(recent, now), { streak: 3, cooldownMs: 60 * 60_000 });
  const capped = { ...recent, fallbackStreak: 12 };
  assert.deepEqual(nextFallbackCooldown(capped, now), { streak: 13, cooldownMs: 4 * 60 * 60_000 });
  const old = { ...recent, lastFallbackAt: "2026-08-14T11:59:00.000Z" };
  assert.deepEqual(nextFallbackCooldown(old, now), { streak: 1, cooldownMs: 15 * 60_000 });
});

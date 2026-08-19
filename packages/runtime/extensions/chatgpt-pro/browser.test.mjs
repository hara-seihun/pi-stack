import assert from "node:assert/strict";
import test from "node:test";
import {
  conversationActivityMarker,
  conversationLeafText,
  conversationModelEvidence,
  browserPoolCapacitySnapshot,
  defaultPoolState,
  isTerminalConversationEvidence,
  FALLBACK_COOLDOWN_MS,
  normalizePoolState,
  profileNamesAllowedByLifecycle,
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

test("transport closes billable browsers between twenty-minute Pro checks", () => {
  assert.equal(PRO_TRANSPORT_HORIZONS.persistedPollMs, 20 * 60_000);
  assert.equal(PRO_TRANSPORT_HORIZONS.browserTimeoutSeconds, 5 * 60);
  assert.ok(PRO_TRANSPORT_HORIZONS.browserTimeoutSeconds * 1000 < PRO_TRANSPORT_HORIZONS.persistedPollMs);
  assert.equal(PRO_TRANSPORT_HORIZONS.responseWaitMs % PRO_TRANSPORT_HORIZONS.persistedPollMs, 0);
  assert.ok(PRO_TRANSPORT_HORIZONS.persistedPollMs < PRO_TRANSPORT_HORIZONS.stalledWorkMs);
  assert.ok(PRO_TRANSPORT_HORIZONS.stalledWorkMs < PRO_TRANSPORT_HORIZONS.responseWaitMs);
  assert.ok(PRO_TRANSPORT_HORIZONS.accountLeaseMs > PRO_TRANSPORT_HORIZONS.responseWaitMs);
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
    lastFallbackAt: "2026-08-16T00:00:00.000Z",
    lastVerifiedAt: "2026-08-16T00:00:00.000Z",
  }, ["limmy-google"]);
  assert.equal(normalized.profiles[0].selectionCount, 4);
  assert.equal(PRO_MAX_PARALLEL, 4);
});

test("cancelled Codex-backed browser profiles stop taking leases before paid access ends", () => {
  const at = Date.UTC(2026, 7, 23, 12);
  const end = at + PRO_TRANSPORT_HORIZONS.accountLeaseMs;
  const config = { subscriptions: [
    { provider: "openai-codex", index: 6, lifecycle: { state: "cancelled", accessUntil: new Date(end).toISOString() } },
  ] };
  const names = ["unmapped", "codex-06"];
  const mapping = { "codex-06": "openai-codex-6" };
  assert.deepEqual(profileNamesAllowedByLifecycle(names, mapping, config, at), names);
  assert.deepEqual(
    profileNamesAllowedByLifecycle(names, mapping, config, at, PRO_TRANSPORT_HORIZONS.accountLeaseMs),
    ["unmapped"],
  );
  assert.throws(() => profileNamesAllowedByLifecycle(names, mapping, {
    subscriptions: [{ provider: "openai-codex", index: 6, lifecycle: { state: "cancelled", accessUntil: "bad" } }],
  }, at), /invalid subscription accessUntil/);
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

test("an exhausted Pro allowance rests the account for a full day", () => {
  assert.equal(FALLBACK_COOLDOWN_MS, 24 * 60 * 60_000);
});

test("the submission stream reveals a router fallback within seconds", async () => {
  const { streamResolvedModel } = await import("./browser.mjs");
  assert.equal(streamResolvedModel('data: {"resolved_model_slug":"gpt-5-5-mini","x":1}'), "gpt-5-5-mini");
  assert.equal(streamResolvedModel('{"resolved_model_slug": "gpt-5-6-pro"}'), "gpt-5-6-pro");
  assert.equal(streamResolvedModel("no marker here"), null);
  assert.equal(streamResolvedModel(""), null);
});

test("audit history yields exactly the orphaned conversations", async (t) => {
  const { orphanedConversationsFromAudits } = await import("./browser.mjs");
  const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "pro-audit-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const now = new Date(Date.now() - 1000).toISOString();
  const record = (name, value) => writeFileSync(join(dir, name), JSON.stringify(value));
  // Orphan: submitted, aborted, never terminal.
  record("a.json", { at: now, conversation_id: "WEB:orphan", browser_profile: "p1", caller: { taskId: "t" }, prompt_sha256: "abc", error: "Request was aborted" });
  // Verified conversation: not an orphan.
  record("b.json", { at: now, conversation_id: "WEB:done", browser_profile: "p1", evidence: { pro_execution_verified: true } });
  // Fallback-terminal conversation: not an orphan.
  record("c.json", { at: now, conversation_id: "WEB:mini", browser_profile: "p2", evidence: { resolved_model_slug: "gpt-5-5-mini" } });
  // Orphan later recovered: not an orphan.
  record("d1.json", { at: now, conversation_id: "WEB:rec", browser_profile: "p3", error: "Request was aborted" });
  record("d2.json", { at: now, conversation_id: "WEB:rec", browser_profile: "p3", recovered: true });
  const orphans = orphanedConversationsFromAudits(7, dir);
  assert.deepEqual(orphans.map((o) => o.conversationId), ["WEB:orphan"]);
  assert.equal(orphans[0].browserProfile, "p1");
  assert.equal(orphans[0].prompt_sha256, "abc");
  // Old records outside the window are ignored.
  assert.deepEqual(orphanedConversationsFromAudits(0, dir), []);
});

test("a UI-shape failure is loud, distinct, and carries its evidence", async () => {
  const { ProUiChangedError, failureCooldown } = await import("./browser.mjs");
  const error = new ProUiChangedError("send-click-blocked", "backdrop intercepts pointer events", {
    screenshotPath: "/tmp/shot.png",
  });
  assert.equal(error.code, "pro-ui-changed");
  assert.equal(error.stage, "send-click-blocked");
  assert.equal(error.screenshotPath, "/tmp/shot.png");
  assert.match(error.message, /send-click-blocked/);
  assert.match(error.message, /backdrop intercepts/);
  const cooldown = failureCooldown(error, {}, "");
  assert.equal(cooldown.reason, "pro-ui-changed");
  assert.ok(cooldown.cooldownMs > 0 && cooldown.cooldownMs < FALLBACK_COOLDOWN_MS);
});

test("ui-changed classification never masks a router fallback or stall", async () => {
  const { failureCooldown } = await import("./browser.mjs");
  assert.equal(
    failureCooldown(new Error("x"), { resolved_model_slug: "gpt-5-5-mini" }, "").reason,
    "pro-fallback",
  );
  assert.equal(
    failureCooldown(new Error("x"), { transport_stalled: true }, "").reason,
    "pro-stalled",
  );
  assert.equal(failureCooldown(new Error("boring"), {}, "").reason, "browser-operation");
});

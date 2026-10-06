import assert from "node:assert/strict";
import { test } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { ATTEMPT, blockedAttempt, cancellableResponse, operationScope } from "./operation.mjs";

test("unknown stored attempt states remain explicit errors, not retryable terminal failures", () => {
  const entry = { type: "custom", customType: ATTEMPT, timestamp: new Date(1).toISOString(), data: { modelKey: "astra", state: "future", error: "preserved" } };
  const before = JSON.stringify(entry);
  const held = blockedAttempt([entry], "astra", 1_000_000);
  assert.equal(held.kind, "invalid");
  assert.equal(held.state, "future");
  assert.match(held.error, /Unsupported stored compaction attempt state/);
  assert.equal(held.retryAt, undefined);
  assert.equal(JSON.stringify(entry), before);
});

test("deadline distinguishes productive streams, idle stalls, total budget and cancellation", t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const parent = new AbortController();
  const productive = operationScope(parent.signal);
  for (let i = 0; i < 4; i++) { t.mock.timers.tick(100_000); productive.progress("stream"); }
  assert.equal(productive.signal.aborted, false);
  t.mock.timers.tick(180_000);
  assert.equal(productive.signal.reason.code, "idle-timeout");
  assert.equal(productive.snapshot().elapsedMs, 580_000);
  productive.close();
  const endless = operationScope(parent.signal);
  for (let i = 0; i < 6; i++) { t.mock.timers.tick(100_000); endless.progress("stream"); }
  assert.equal(endless.signal.reason.code, "deadline");
  endless.close();
  const cancelled = operationScope(parent.signal);
  parent.abort(new Error("user stop"));
  assert.equal(cancelled.signal.reason.message, "user stop");
  cancelled.close();
});

test("abort cancels a silent response reader even if fetch stopped forwarding its signal", async () => {
  const controller = new AbortController();
  let cancelled = 0;
  const response = cancellableResponse(new Response(new ReadableStream({ cancel() { cancelled++; } })), controller.signal);
  const pending = response.text();
  controller.abort(new Error("idle deadline"));
  await assert.rejects(pending, /idle deadline/);
  assert.equal(cancelled, 1);
});

test("interrupted native requests retry after restart; terminal failures fence with growing, expiring backoff", () => {
  const sm = SessionManager.inMemory();
  const first = sm.appendMessage({ role: "user", content: "fixture", timestamp: 1 });
  sm.appendCustomEntry(ATTEMPT, { state: "started", modelKey: "astra" });
  const branch = JSON.parse(JSON.stringify(sm.getBranch()));
  assert.equal(blockedAttempt(branch, "astra"), undefined);
  sm.appendCustomEntry(ATTEMPT, { state: "failed", modelKey: "astra", error: "provider rejected" });
  const failedAt = Date.parse(sm.getBranch().at(-1).timestamp);
  const held = blockedAttempt(sm.getBranch(), "astra", failedAt);
  assert.equal(held.error, "provider rejected");
  assert.equal(held.retryAt, failedAt + 60_000);
  assert.equal(blockedAttempt(sm.getBranch(), "astra", held.retryAt), undefined);
  assert.equal(blockedAttempt(sm.getBranch(), "luna", failedAt), undefined);
  sm.appendCustomEntry(ATTEMPT, { state: "started", modelKey: "astra", reason: "threshold" });
  assert.equal(blockedAttempt(JSON.parse(JSON.stringify(sm.getBranch())), "astra", failedAt), undefined);
  for (let i = 0; i < 8; i++) sm.appendCustomEntry(ATTEMPT, { state: "failed", modelKey: "astra", error: "overloaded" });
  const repeated = blockedAttempt(sm.getBranch(), "astra", failedAt);
  assert.equal(repeated.failures, 9);
  assert.ok(repeated.retryAt - Date.parse(sm.getBranch().at(-1).timestamp) === 30 * 60_000, "backoff is capped, never permanent");
  sm.appendCompaction("checkpoint", first, 100);
  assert.equal(blockedAttempt(sm.getBranch(), "astra", failedAt), undefined);
  sm.branch(first);
  assert.equal(blockedAttempt(sm.getBranch(), "astra", failedAt), undefined);
});

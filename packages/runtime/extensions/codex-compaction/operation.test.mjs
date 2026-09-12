import assert from "node:assert/strict";
import { test } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { ATTEMPT, blockedAttempt, cancellableResponse, operationScope } from "./operation.mjs";

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

test("in-flight records survive reload and fork, while tree navigation and a committed checkpoint release the fence", () => {
  const sm = SessionManager.inMemory();
  const first = sm.appendMessage({ role: "user", content: "fixture", timestamp: 1 });
  sm.appendCustomEntry(ATTEMPT, { state: "started", modelKey: "astra" });
  const branch = JSON.parse(JSON.stringify(sm.getBranch()));
  assert.equal(blockedAttempt(branch, "astra").state, "started");
  assert.equal(blockedAttempt(branch, "luna"), undefined);
  sm.appendCompaction("checkpoint", first, 100);
  assert.equal(blockedAttempt(sm.getBranch(), "astra"), undefined);
  sm.branch(first);
  assert.equal(blockedAttempt(sm.getBranch(), "astra"), undefined);
});

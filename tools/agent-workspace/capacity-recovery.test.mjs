import assert from "node:assert/strict";
import { test } from "node:test";
import { capacityRecovery } from "./capacity-recovery.mjs";
const old = { state: "failed", error: { code: "source-preparation-failed", message: "92.46 GiB is free; 97.39 GiB is required (source forecast + declared growth + operating headroom + other reservations)" } };
const jobId = "a".repeat(64);
const observation = freeGiB => ({ observedAt: Date.now(), device: "1", freeBytes: Math.floor(freeGiB * 1024 ** 3), freeInodes: 100, totalInodes: 100 });
test("retained pre-typed refusal recovers with fresh evidence, never using historical rounded totals, with original identity and evidence", () => {
  assert.equal(capacityRecovery(old, jobId, observation(92.46)).state, "retry");
  assert.equal(capacityRecovery(old, jobId, observation(97.39)).state, "retry", "historical rounding must not gate a fresh guard");
  const result = capacityRecovery(old, jobId, observation(103));
  assert.equal(result.state, "retry");
  assert.equal(result.value.previousJobId, jobId);
  assert.deepEqual(result.value.originalRefusal, old.error);
  assert.equal(result.value.observation.freeBytes, 103 * 1024 ** 3);
  assert.notEqual(result.value.id, capacityRecovery(old, jobId, observation(103)).value.id);
});
test("new typed capacity failures recover; other terminal failures and malformed evidence never do", () => {
  assert.equal(capacityRecovery({ ...old, error: { ...old.error, code: "workspace-capacity-refused" } }, jobId, observation(103)).state, "retry");
  for (const terminal of [{ state: "ready", value: {} }, { ...old, error: { ...old.error, code: "git-failed" } }, { ...old, error: { code: old.error.code, message: "disk error" } }]) {
    assert.equal(capacityRecovery(terminal, jobId, observation(103)).state, "terminal");
  }
  assert.equal(capacityRecovery(old, jobId, {}).state, "invalid");
});

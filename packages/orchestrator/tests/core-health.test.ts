import { expect, test } from "vitest";
import { coreReadiness, observeCoreReconciliation } from "../src/core/health.js";

const provider = { status: "fulfilled", value: undefined } as const;
const duties = { status: "fulfilled", value: { ok: true, value: undefined } } as const;
const configured = { provider: true, root: true };

test("retained Root delivery failures stay visible without making unrelated host routes unavailable", () => {
  const health = observeCoreReconciliation(provider, { status: "fulfilled", value: { errors: 3 } }, duties, configured);
  expect(health).toMatchObject({ root: { state: "delivery-degraded", retainedDeliveryErrors: 3 } });
  expect(coreReadiness(true, false, health)).toEqual({ ready: true, degraded: true });
  expect(coreReadiness(false, false, health).ready).toBe(false);
  expect(coreReadiness(true, true, health).ready).toBe(false);
});

test("unobserved, broken reconciliation and invalid Root counters never report ready", () => {
  expect(coreReadiness(true, false, { state: "pending" }).ready).toBe(false);
  const rejected = { status: "rejected", reason: new Error("private diagnostic") } as const;
  for (const health of [
    observeCoreReconciliation(rejected, { status: "fulfilled", value: { errors: 0 } }, duties, configured),
    observeCoreReconciliation(provider, rejected, duties, configured),
    observeCoreReconciliation(provider, { status: "fulfilled", value: { errors: -1 } }, duties, configured),
    observeCoreReconciliation(provider, { status: "fulfilled", value: undefined }, duties, configured),
    observeCoreReconciliation(provider, { status: "fulfilled", value: { errors: 0 } }, { status: "fulfilled", value: { ok: false, error: { code: "unavailable", message: "private diagnostic" } } }, configured),
  ]) {
    expect(coreReadiness(true, false, health).ready).toBe(false);
    expect(JSON.stringify(health)).not.toContain("private diagnostic");
  }
  const disabled = observeCoreReconciliation(provider, { status: "fulfilled", value: undefined }, duties, { provider: false, root: false });
  expect(coreReadiness(true, false, disabled)).toEqual({ ready: true, degraded: false });
});

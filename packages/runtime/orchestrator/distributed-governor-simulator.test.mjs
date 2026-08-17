import assert from "node:assert/strict";
import test from "node:test";
import {
  ANTHROPIC_SCENARIOS,
  CALIBRATION_SCENARIOS,
  SCENARIOS,
  anthropicWeeklyMeters,
  runAnthropicScenario,
  runRoutingCalibration,
  runScenario,
} from "./distributed-governor-simulator.mjs";

const scenario = (prefix) => SCENARIOS.find((item) => item.name.startsWith(prefix));
const calibration = (prefix) => CALIBRATION_SCENARIOS.find((item) => item.name.startsWith(prefix));
const anthropic = (prefix) => ANTHROPIC_SCENARIOS.find((item) => item.name.startsWith(prefix));

test("shared-meter control stays within the paced window for twenty unknown peers", () => {
  const result = runScenario(scenario("03"));
  assert.equal(result.exhausted, false);
  assert.ok(result.overshoot <= 0.1);
  assert.ok(result.meanUsed >= 85);
});

test("private account-routing instruments identify two hosts through integer meters", () => {
  const result = runRoutingCalibration(calibration("C2"));
  assert.ok(result.p90AttributionError < 0.2);
  assert.ok(result.p90CoefficientError < 0.35);

  const replications = Array.from({ length: 10 }, (_, seed) =>
    runRoutingCalibration({ ...calibration("C2"), seed: seed + 1 }).p90AttributionError);
  assert.ok(Math.max(...replications) < 0.25);
});

test("private instruments recover a bounded unknown reporting delay", () => {
  const result = runRoutingCalibration(calibration("C6"));
  assert.deepEqual(result.selectedDelayMinutes, [[20, 20], [20, 20]]);
  assert.ok(result.p90AttributionError < 0.2);
});

test("private instruments remain identifiable with overlapping account subsets", () => {
  const result = runRoutingCalibration(calibration("C13"));
  assert.ok(result.p90AttributionError < 0.2);
  assert.ok(result.p90CoefficientError < 0.35);
});

test("ordinary hidden consumption is noise rather than attribution bias", () => {
  const result = runRoutingCalibration(calibration("C7"));
  assert.ok(result.p90AttributionError < 0.2);
});

test("a frozen meter fails closed when local predicted burn is not reflected", () => {
  const result = runScenario(scenario("12"));
  assert.equal(result.exhausted, false);
  assert.ok(result.hosts.every((host) => host.sensorInconsistent));
});

test("no feedback controller can survive an unbounded first pulse", () => {
  const result = runScenario(scenario("14"));
  assert.equal(result.exhausted, true);
});

test("cloned identities and an anti-mimicking consumer are not identifiable", () => {
  const cloned = runRoutingCalibration(calibration("C9"));
  const antiMimic = runRoutingCalibration(calibration("C10"));
  assert.ok(cloned.p90AttributionError > 1);
  assert.ok(antiMimic.p90AttributionError > 0.9);
});

test("Anthropic meters preserve the coupled Fable and Opus limits", () => {
  assert.deepEqual(anthropicWeeklyMeters(0, 50), { sharedPercent: 50, fablePercent: 100 });
  assert.deepEqual(anthropicWeeklyMeters(100, 0), { sharedPercent: 100, fablePercent: 0 });
  const ordinary = runAnthropicScenario(anthropic("A1"));
  const bursty = runAnthropicScenario(anthropic("A2"));
  const manyHosts = runAnthropicScenario(anthropic("A3"));
  assert.ok(ordinary.safe);
  assert.ok(bursty.safe);
  assert.ok(manyHosts.safe);
  assert.ok(Math.min(ordinary.minimumReserve, bursty.minimumReserve, manyHosts.minimumReserve) >= 0);
});

test("simulation is reproducible from its declared seed", () => {
  const definition = calibration("C3");
  assert.deepEqual(runRoutingCalibration(definition).estimates, runRoutingCalibration(definition).estimates);
});

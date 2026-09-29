import assert from "node:assert/strict";
import test from "node:test";
import { observeQueueProgress, queueStallReason, policy } from "../deploy/publication-control.mjs";

const now = Date.parse("2026-09-29T16:54:08Z");
const iso = delta => new Date(now + delta).toISOString();
const request = { requestId: "PUB-0123456789abcdef01234567", status: "queued", updatedAt: iso(-200_000), nextAttemptAt: iso(-170_000),
  waiting: { kind: "live-meeting" } };
const observed = { ...observeQueueProgress(request, undefined, now), since: iso(-100_000), observedAt: iso(-10_000) };

test("queue supervision measures one unchanged request across continuous observations", () => {
  assert.match(queueStallReason(request, observed, now), /Meeting probe was not serviced/);
  assert.match(queueStallReason({ ...request, waiting: undefined }, observed, now), /worker never claimed/);
  for (const changed of [
    { ...request, requestId: "PUB-fedcba9876543210fedcba98" },
    { ...request, updatedAt: iso(-40_000) },
    { ...request, nextAttemptAt: iso(-5_000) },
    { ...request, status: "running" },
    { ...request, status: "failed" },
    { ...request, nextAttemptAt: iso(30_000) },
  ]) assert.equal(queueStallReason(changed, observed, now), null, JSON.stringify(changed));
  assert.equal(observeQueueProgress(undefined, observed, now), undefined);
});

test("watchdog downtime and pre-upgrade global clocks cannot exhaust a request's claim budget", () => {
  for (const previous of [undefined, { since: iso(-100_000) }, { ...observed, observedAt: iso(-policy.betweenStepsMs - 1) },
    { ...observed, observedAt: iso(1) }]) {
    const resumed = observeQueueProgress(request, previous, now);
    assert.equal(resumed.since, iso(0));
    assert.equal(queueStallReason(request, resumed, now), null);
  }
});

test("arbitrarily long meetings stay healthy through probes, but a missing worker still fails", () => {
  let current = request;
  let observation;
  for (let minutes = 0; minutes < 240; minutes += 1) {
    const time = now + minutes * 60_000;
    current = { ...current, updatedAt: new Date(time - 40_000).toISOString(), nextAttemptAt: new Date(time - 10_000).toISOString() };
    observation = observeQueueProgress(current, observation, time);
    assert.equal(queueStallReason(current, observation, time), null);
  }
  const start = Date.parse(observation.observedAt);
  for (let delta = 10_000; delta <= 100_000; delta += 10_000) {
    observation = observeQueueProgress(current, observation, start + delta);
    assert.equal(Boolean(queueStallReason(current, observation, start + delta)), delta > policy.betweenStepsMs);
  }
});

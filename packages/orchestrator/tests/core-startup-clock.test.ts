import { expect, test } from "bun:test";
import { CoreStartupClock, type CoreStartupObservation } from "../src/core/startup.js";

test("startup observations distinguish slow adoption, activation and initial reconciliation without private payloads", () => {
  let time = 10;
  const events: CoreStartupObservation[] = [];
  const clock = new CoreStartupClock(() => time, event => events.push(event));
  time = 20; clock.enter("scope-activation");
  time = 183_020;
  expect(clock.snapshot()).toEqual({ phase: "scope-activation", elapsedMs: 183_010, phaseElapsedMs: 183_000 });
  clock.enter("initial-reconciliation");
  time = 183_025; clock.enter("ready");
  expect(events).toContainEqual({ phase: "scope-activation", elapsedMs: 183_010, phaseElapsedMs: 183_000 });
  expect(events.at(-1)).toEqual({ phase: "ready", elapsedMs: 183_015, phaseElapsedMs: 0 });
  const count = events.length; clock.enter("ready"); expect(events).toHaveLength(count);
  for (const event of events) expect(Object.keys(event).sort()).toEqual(["elapsedMs", "phase", "phaseElapsedMs"]);
});

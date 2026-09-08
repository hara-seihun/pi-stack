/**
 * What the boost states mean, for every surface that offers them as a
 * control rather than a number: `pi-orchestrator boost` and the Pi Remote
 * drawer's per-family buttons both multiply the family's calculated session
 * ceiling. The base account cap is scaled too. Above 1, calendar pacing and
 * single-admission-per-observation throttling do not apply; fresh meters,
 * provider exhaustion, reservations and the machine limit still do. `0` is the
 * background halt state. Operator-requested forced runs bypass these controls;
 * running sessions finish naturally.
 */
export const BOOSTED_MULTIPLIER = 10;
export const HALTED_MULTIPLIER = 0;

/** The drawer button's cycle: off (1x) → green (3x) → blue (10x) → red
 * (halted), then around again. */
export const BOOST_CYCLE = [1, 3, BOOSTED_MULTIPLIER, HALTED_MULTIPLIER] as const;

export function nextBoost(current: number): number {
  const index = BOOST_CYCLE.indexOf(current as (typeof BOOST_CYCLE)[number]);
  return BOOST_CYCLE[(index + 1) % BOOST_CYCLE.length] as number;
}

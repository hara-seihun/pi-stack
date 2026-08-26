/**
 * What the boost states mean, for every surface that offers them as a
 * control rather than a number: `pi-orchestrator boost` and the Pi Remote
 * drawer's per-family buttons both write this multiplier onto the family's
 * paced spend, and both read the ledger row back, so the CLI, the
 * controller, and both clients always agree on the state and the number.
 *
 * A multiplier above 1 is a deliberate overspend against a measured
 * sustainable rate, not a ceiling: meters, per-account capacity, and the
 * machine's concurrent-session limit still bound what it admits. `0` is the
 * halt state — the broker refuses every new launch for the family while
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

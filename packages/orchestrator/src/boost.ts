/**
 * What "boosted" means, for every surface that offers it as a switch rather
 * than a number: `boost <family> on` and the Pi Remote drawer's per-family
 * control both write this multiplier onto the family's paced spend, and both
 * read the ledger row back, so the two can never mean different things.
 *
 * It is a deliberate overspend against a measured sustainable rate, not a
 * ceiling: meters, per-account capacity, and the machine's concurrent-session
 * limit still bound what it admits.
 */
export const BOOSTED_MULTIPLIER = 10;

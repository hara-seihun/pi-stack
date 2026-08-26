export const BOOSTED_MULTIPLIER = 10;
export function nextBoost(value) {
  if (value === 1) return 3;
  if (value === 3) return BOOSTED_MULTIPLIER;
  if (value === BOOSTED_MULTIPLIER) return 0;
  return 1;
}

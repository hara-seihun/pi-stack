/**
 * Hazard-aware pacing. Providers (notably OpenAI) issue surprise resets that
 * restart the window and discard unspent budget. Budget planned for time t
 * from now is only realised with probability exp(-lambda * t), so the
 * sustainable rate divides remaining budget by the expected usable horizon
 * E[min(T, Exp(lambda))] instead of the scheduled horizon T. This front-loads
 * spend exactly in proportion to the measured reset hazard.
 */
export function effectiveHorizonHours(horizonHours: number, hazardPerHour: number): number {
  if (hazardPerHour <= 0) return horizonHours;
  return (1 - Math.exp(-hazardPerHour * horizonHours)) / hazardPerHour;
}

export function hazardPacedPercentPerHour(
  remainingPercent: number,
  horizonHours: number,
  hazardPerDay: number,
): number {
  const teff = effectiveHorizonHours(horizonHours, hazardPerDay / 24);
  if (teff <= 0) return remainingPercent;
  return remainingPercent / teff;
}

export function dailyPercentSchedule(
  remainingPercent: number,
  horizonHours: number,
  hazardPerDay: number,
  maxDays = 28,
): number[] {
  const out: number[] = [];
  let rem = remainingPercent;
  let t = horizonHours;
  while (t > 1e-9 && rem > 1e-9 && out.length < maxDays) {
    const rate = hazardPacedPercentPerHour(rem, t, hazardPerDay);
    const step = Math.min(24, t);
    const spend = Math.min(rem, rate * step);
    out.push(spend);
    rem -= spend;
    t -= step;
  }
  return out;
}

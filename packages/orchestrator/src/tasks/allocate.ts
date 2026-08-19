import type { AllocationResult, Assignment, TaskSnapshot, Tier } from "./types.js";
import { TIERS } from "./types.js";

/**
 * Distributes launch slots across eligible tasks proportional to demand,
 * honouring each task's preference-ordered tier substitution set. Largest
 * remainder keeps proportionality exact; a task never receives more agents
 * than it has work units; leftover capacity from tier-restricted mismatches
 * is redistributed greedily to the highest-demand task that can use it.
 * Deterministic: ties break by demand then task id.
 */
export function allocate(
  tasks: readonly TaskSnapshot[],
  slots: Readonly<Record<Tier, number>>,
): AllocationResult {
  const eligible = tasks
    .filter((t) => t.eligible && t.units !== undefined && t.units > 0)
    .sort((a, b) => (b.units ?? 0) - (a.units ?? 0) || a.taskId.localeCompare(b.taskId));
  const capacity: Record<Tier, number> = { ...slots };
  const totalSlots = TIERS.reduce((s, tier) => s + (capacity[tier] ?? 0), 0);
  const totalUnits = eligible.reduce((s, t) => s + (t.units ?? 0), 0);
  const assigned = new Map<string, Map<Tier, number>>();
  if (totalSlots === 0 || totalUnits === 0) {
    return { assignments: [], unusedSlots: capacity };
  }

  // Proportional quotas by largest remainder, capped at each task's units.
  const quota = new Map<string, number>();
  const remainders: { taskId: string; units: number; frac: number }[] = [];
  let used = 0;
  for (const t of eligible) {
    const units = t.units ?? 0;
    const ideal = (totalSlots * units) / totalUnits;
    const base = Math.min(Math.floor(ideal), Math.ceil(units));
    quota.set(t.taskId, base);
    used += base;
    remainders.push({ taskId: t.taskId, units, frac: ideal - Math.floor(ideal) });
  }
  remainders.sort(
    (a, b) => b.frac - a.frac || b.units - a.units || a.taskId.localeCompare(b.taskId),
  );
  for (const r of remainders) {
    if (used >= totalSlots) break;
    if ((quota.get(r.taskId) ?? 0) < Math.ceil(r.units)) {
      quota.set(r.taskId, (quota.get(r.taskId) ?? 0) + 1);
      used++;
    }
  }

  const give = (taskId: string, tier: Tier, n: number): void => {
    const byTier = assigned.get(taskId) ?? new Map<Tier, number>();
    byTier.set(tier, (byTier.get(tier) ?? 0) + n);
    assigned.set(taskId, byTier);
    capacity[tier] -= n;
  };
  const assignedCount = (taskId: string): number =>
    [...(assigned.get(taskId)?.values() ?? [])].reduce((a, b) => a + b, 0);

  // First pass: satisfy quotas along each task's tier preference order.
  for (const t of eligible) {
    let want = quota.get(t.taskId) ?? 0;
    for (const tier of t.tiers) {
      if (want <= 0) break;
      const take = Math.min(want, capacity[tier] ?? 0);
      if (take > 0) {
        give(t.taskId, tier, take);
        want -= take;
      }
    }
  }

  // Second pass: leftover capacity goes one slot at a time to the
  // highest-demand task that allows the tier and still has work headroom.
  let progressed = true;
  while (progressed) {
    progressed = false;
    for (const t of eligible) {
      if (assignedCount(t.taskId) >= Math.ceil(t.units ?? 0)) continue;
      const tier = t.tiers.find((candidate) => (capacity[candidate] ?? 0) > 0);
      if (tier === undefined) continue;
      give(t.taskId, tier, 1);
      progressed = true;
    }
  }

  const assignments: Assignment[] = [];
  for (const t of eligible) {
    for (const tier of t.tiers) {
      const count = assigned.get(t.taskId)?.get(tier) ?? 0;
      if (count > 0) assignments.push({ taskId: t.taskId, tier, count });
    }
  }
  return { assignments, unusedSlots: capacity };
}

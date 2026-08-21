import type { AllocationResult, Assignment, TaskSnapshot, Tier } from "./types.js";
import { TIERS } from "./types.js";

/**
 * Which tier a task's next slot should come from, given what it has already
 * been launched on inside the fairness window.
 *
 * Weighted fair queueing: the winner is the tier whose next launch falls
 * earliest in virtual time, `(served + 1) / weight`. A 20:1 mix therefore
 * comes out as twenty light launches and then a standard one, out of a long
 * run of cycles that each hand out a single slot and could never express a
 * ratio individually. Sharing out each cycle's slots by proportion instead
 * would round the minority tier to zero every time and it would never launch
 * at all.
 *
 * The mix is a ceiling, not merely a preference: a tier is passed over once
 * it holds its rounded-up share of the launches so far. That is what stops a
 * light-heavy lane from quietly becoming a standard lane whenever light
 * capacity is short — the free standard slot goes to a lane that actually
 * wants standard sessions instead. Within the ceiling the list is still a
 * substitution set: a tier with no free capacity loses its turn rather than
 * holding the lane up. Ties break by weight then declaration order, so the
 * choice is deterministic.
 */
function tierForNextSlot(
  task: TaskSnapshot,
  assigned: ReadonlyMap<Tier, number>,
  capacity: Readonly<Record<Tier, number>>,
): Tier | undefined {
  const totalWeight = task.tiers.reduce((sum, share) => sum + share.weight, 0);
  const servedOf = (tier: Tier): number =>
    (task.recentLaunchesByTier?.[tier] ?? 0) + (assigned.get(tier) ?? 0);
  const totalServed = task.tiers.reduce((sum, share) => sum + servedOf(share.tier), 0);
  let best: { tier: Tier; virtualTime: number; weight: number } | undefined;
  for (const share of task.tiers) {
    if ((capacity[share.tier] ?? 0) <= 0 || share.weight <= 0) continue;
    const served = servedOf(share.tier);
    const ceiling = Math.ceil(((totalServed + 1) * share.weight) / totalWeight);
    if (served + 1 > ceiling) continue;
    const virtualTime = (served + 1) / share.weight;
    if (
      best === undefined ||
      virtualTime < best.virtualTime - 1e-9 ||
      (virtualTime < best.virtualTime + 1e-9 && share.weight > best.weight)
    ) {
      best = { tier: share.tier, virtualTime, weight: share.weight };
    }
  }
  return best?.tier;
}

/**
 * Distributes launch slots across eligible tasks in proportion to their
 * declared shares, honouring each task's weighted tier set. Largest remainder
 * keeps proportionality exact; a task never receives more agents than it has
 * work units; leftover capacity — from tier mismatches, or from lanes with
 * less demand than share — is redistributed greedily to the task furthest
 * behind. Deterministic: ties break by demand then task id.
 *
 * Share, not demand, is the basis. Demand answers whether a lane can absorb
 * another agent and caps how many; it is a work-unit count in whatever unit
 * each probe chose, so using it to divide the fleet made a lane that counts
 * problems in sixes outrank a lane that counts review items singly — a split
 * no operator ever chose. An operator who wants the frontier lane to hold
 * most of the fleet now says so, and the lanes that cannot use their share
 * still give it back rather than idling capacity.
 *
 * Proportionality has to be measured across cycles, not inside one. Slots
 * free one session at a time, and with a single slot every task's integer
 * quota floors to zero, so the whole decision is the remainder order — which,
 * on one cycle's arithmetic alone, is the largest lane every time. A 60% lane
 * took 100% of the common cycle and a 15% lane launched only when three slots
 * happened to free together. So each task's recent launch history comes in
 * with it, and the ordering key is its shortfall: target share minus served
 * share. With no history supplied the shortfall is zero everywhere and the
 * order falls back to demand, which is what the pure-function tests pin.
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
  const shareOf = (t: TaskSnapshot): number => t.share ?? 1;
  const totalShare = eligible.reduce((s, t) => s + shareOf(t), 0);
  const assigned = new Map<string, Map<Tier, number>>();
  if (totalSlots === 0 || totalUnits === 0) {
    return { assignments: [], unusedSlots: capacity };
  }

  // Proportional quotas by largest remainder, capped at each task's units.
  const totalServed = eligible.reduce((s, t) => s + (t.recentLaunches ?? 0), 0);
  const shortfallOf = (t: TaskSnapshot): number =>
    totalServed === 0 ? 0 : shareOf(t) / totalShare - (t.recentLaunches ?? 0) / totalServed;

  const quota = new Map<string, number>();
  const remainders: { taskId: string; units: number; frac: number; shortfall: number }[] = [];
  let used = 0;
  for (const t of eligible) {
    const units = t.units ?? 0;
    const ideal = (totalSlots * shareOf(t)) / totalShare;
    const base = Math.min(Math.floor(ideal), Math.ceil(units));
    quota.set(t.taskId, base);
    used += base;
    remainders.push({
      taskId: t.taskId,
      units,
      frac: ideal - Math.floor(ideal),
      shortfall: shortfallOf(t),
    });
  }
  remainders.sort(
    (a, b) =>
      b.shortfall - a.shortfall ||
      b.frac - a.frac ||
      b.units - a.units ||
      a.taskId.localeCompare(b.taskId),
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

  // First pass: satisfy quotas one slot at a time, each going to the tier
  // furthest behind the task's declared mix.
  for (const t of eligible) {
    let want = quota.get(t.taskId) ?? 0;
    while (want > 0) {
      const tier = tierForNextSlot(t, assigned.get(t.taskId) ?? new Map(), capacity);
      if (tier === undefined) break;
      give(t.taskId, tier, 1);
      want--;
    }
  }

  // Second pass: leftover capacity goes one slot at a time to the task
  // furthest behind its share that allows the tier and still has work headroom.
  const byShortfall = [...eligible].sort(
    (a, b) =>
      shortfallOf(b) - shortfallOf(a) ||
      (b.units ?? 0) - (a.units ?? 0) ||
      a.taskId.localeCompare(b.taskId),
  );
  let progressed = true;
  while (progressed) {
    progressed = false;
    for (const t of byShortfall) {
      if (assignedCount(t.taskId) >= Math.ceil(t.units ?? 0)) continue;
      const tier = tierForNextSlot(t, assigned.get(t.taskId) ?? new Map(), capacity);
      if (tier === undefined) continue;
      give(t.taskId, tier, 1);
      progressed = true;
    }
  }

  const assignments: Assignment[] = [];
  for (const t of eligible) {
    for (const share of t.tiers) {
      const count = assigned.get(t.taskId)?.get(share.tier) ?? 0;
      if (count > 0) assignments.push({ taskId: t.taskId, tier: share.tier, count });
    }
  }
  return { assignments, unusedSlots: capacity };
}

import type { AllocationResult, Assignment, TaskSnapshot, Tier } from "./types.js";
import { TIERS } from "./types.js";

/**
 * A lane's claim on one tier: its share times that tier's weight in its mix.
 *
 * This product is the whole allocation model. A lane's share scales a bundle
 * whose shape is its tier mix, so `share 10, light:20 standard:1` claims 200
 * light and 10 standard, and `share 5, standard:1` claims 5 standard. Sharing
 * the fleet out in proportion to those claims puts 43 sessions at 40 light and
 * 2 standard for the first lane and 1 standard for the second: the shares
 * divide each tier (10:5 of the standard sessions) and the mix holds inside
 * the lane (20 light per standard).
 */
interface Claim {
  readonly taskId: string;
  readonly tier: Tier;
  readonly claim: number;
  /** Sessions this lane holds in this tier: running now, or run recently
   * enough to still count in the fleet it is composing. */
  readonly held: number;
  assigned: number;
}

const tierRank = (tier: Tier): number => TIERS.indexOf(tier);

function claims(tasks: readonly TaskSnapshot[]): Claim[] {
  const out: Claim[] = [];
  for (const t of tasks) {
    const share = t.share ?? 1;
    for (const tier of t.tiers) {
      const claim = share * tier.weight;
      if (claim <= 0) continue;
      out.push({
        taskId: t.taskId,
        tier: tier.tier,
        claim,
        held: t.heldByTier?.[tier.tier] ?? 0,
        assigned: 0,
      });
    }
  }
  return out;
}

/**
 * Distributes launch slots so that the fleet's *composition* converges on the
 * declared claims: each (lane, tier) pair should hold sessions in proportion
 * to `share × tier weight`, counting the sessions it already has.
 *
 * Composition, not launch history, is the target. The operator's question is
 * "what should be running right now", and a lane whose sessions are short
 * (a queue lane that exits when drained) launches many times more often than
 * a research lane holding warm context for hours. Allocating the flow of
 * launches let that turnover decide the fleet; allocating the standing
 * population makes the declared claims mean what they say.
 *
 * Slots go one at a time to the pair with the lowest virtual time,
 * `(held + 1) / claim` — weighted fair queueing over pairs rather than over
 * lanes. Choosing per pair is what fixed the failure that prompted it: a
 * light-heavy lane at share 14 was losing every standard slot to a share-2
 * review lane, because the mix was applied as a per-lane ceiling after the
 * lane's total was decided, so 20-of-21 light left it asking for a single
 * standard session however large its share. A tier is now contested by
 * `share × weight` directly, so that lane holds 14/16 of the standard
 * sessions and the review lane 2/16 — and it cannot flood a tier it did not
 * ask for either, because its claim there is exactly what it declared.
 *
 * A claim is also a ceiling, which is the half that stops the flooding: no
 * pair may hold more than its proportional slice of the fleet it would
 * create, so free capacity that no claim wants is left unused rather than
 * poured into whichever lane happens to be able to take it. That is how a
 * share-2 review lane ends up holding one session next to a share-14
 * research lane instead of thirteen, and how a lane whose cheap tier is
 * short does not quietly become an expensive-tier lane.
 *
 * The exception is a lane with no work left: its claim leaves the
 * denominator entirely, so share stays a claim on contested capacity rather
 * than a reservation, and the lanes with a backlog divide what an idle lane
 * is not using. Work units also cap a lane directly — never more agents than
 * units. Ties break by claim, then task id, then tier order, so the choice
 * is deterministic.
 */
export function allocate(
  tasks: readonly TaskSnapshot[],
  slots: Readonly<Record<Tier, number>>,
  /** Cap on slots handed out across every tier; the tier capacities alone by
   * default. `desiredByTier` uses it to ask what a fleet of a given size
   * should look like. */
  totalCap = Number.POSITIVE_INFINITY,
): AllocationResult {
  const eligible = tasks.filter((t) => t.eligible && t.units !== undefined && t.units > 0);
  const capacity: Record<Tier, number> = { ...slots };
  const pairs = claims(eligible);
  const headroom = new Map<string, number>(
    eligible.map((t) => [t.taskId, Math.ceil(t.units ?? 0)]),
  );
  const total = Math.min(
    totalCap,
    TIERS.reduce((sum, tier) => sum + Math.max(0, capacity[tier] ?? 0), 0),
  );

  for (let given = 0; given < total; given++) {
    // Recomputed each slot: lanes that run out of work leave the composition,
    // and their claim stops counting against the lanes that still have a
    // backlog.
    const contending = pairs.filter((p) => (headroom.get(p.taskId) ?? 0) > 0);
    const totalClaim = contending.reduce((sum, p) => sum + p.claim, 0);
    const fleet = contending.reduce((sum, p) => sum + p.held + p.assigned, 0);
    if (totalClaim <= 0) break;
    let best: Claim | undefined;
    let bestTime = Number.POSITIVE_INFINITY;
    for (const pair of contending) {
      if ((capacity[pair.tier] ?? 0) <= 0) continue;
      const held = pair.held + pair.assigned;
      if (held + 1 > Math.ceil(((fleet + 1) * pair.claim) / totalClaim)) continue;
      const virtualTime = (held + 1) / pair.claim;
      if (
        best === undefined ||
        virtualTime < bestTime - 1e-9 ||
        (virtualTime < bestTime + 1e-9 &&
          (pair.claim > best.claim ||
            (pair.claim === best.claim &&
              (pair.taskId < best.taskId ||
                (pair.taskId === best.taskId && tierRank(pair.tier) < tierRank(best.tier))))))
      ) {
        best = pair;
        bestTime = virtualTime;
      }
    }
    if (best === undefined) break;
    best.assigned++;
    capacity[best.tier]--;
    headroom.set(best.taskId, (headroom.get(best.taskId) ?? 0) - 1);
  }

  const assignments: Assignment[] = pairs
    .filter((p) => p.assigned > 0)
    .map((p) => ({ taskId: p.taskId, tier: p.tier, count: p.assigned }));
  return { assignments, unusedSlots: capacity };
}

/**
 * The (lane, tier) pairs holding more than their claim while some other pair
 * is starved, worst surplus first: what to give up when the fleet is full and
 * mis-composed.
 *
 * A ranked list rather than one answer, because the biggest surplus may have
 * nothing live to give. Composition counts sessions a lane held anywhere in
 * the window, so a lane whose sessions all ended an hour ago still shows a
 * surplus — and shedding it is a no-op. The caller walks the list to the
 * first pair with a session actually running.
 *
 * A full machine cannot converge by allocation alone. Slots only appear as
 * sessions end, so a lane's declared mix takes effect at the speed of
 * turnover — and a research fleet whose sessions run for hours will hold a
 * composition the operator has already changed. Naming the surplus lets the
 * controller give one session back per cycle, which is what makes a mix
 * change mean anything before tomorrow.
 *
 * `admissible` filters the tiers that could actually take the freed slot:
 * shedding a session for a tier whose quota is spent buys nothing and costs
 * an hour of somebody's work.
 */
export function surpluses(
  tasks: readonly TaskSnapshot[],
  admissible: (tier: Tier) => boolean,
): { readonly taskId: string; readonly tier: Tier }[] {
  const pairs = claims(tasks.filter((t) => t.eligible));
  const totalClaim = pairs.reduce((sum, p) => sum + p.claim, 0);
  const fleet = pairs.reduce((sum, p) => sum + p.held, 0);
  if (totalClaim <= 0 || fleet <= 0) return [];
  const share = (p: Claim): number => (fleet * p.claim) / totalClaim;
  // Starved: a pair a whole session below its share, whose tier could take
  // the slot and whose lane still has work for it.
  const starved = pairs.some(
    (p) =>
      p.held + 1 <= share(p) &&
      admissible(p.tier) &&
      (tasks.find((t) => t.taskId === p.taskId)?.units ?? 0) > p.held,
  );
  if (!starved) return [];
  return pairs
    // Only a pair holding a whole session more than its share is asked to
    // give one up, so rounding alone never costs a session.
    .filter((p) => p.held - share(p) >= 1)
    .sort((a, b) => b.held - share(b) - (a.held - share(a)))
    .map((p) => ({ taskId: p.taskId, tier: p.tier }));
}

/**
 * How many sessions of each tier the claims want on top of what is running,
 * for a hypothetical `budget` of free slots. The broker advertises slots per
 * tier, and needs both a cap (never hoard a scarce account for a tier nothing
 * claims) and a weight (which tier gets the next turn). Deriving both from
 * the same claim arithmetic the allocator uses keeps the advertisement and
 * the allocation from disagreeing — the earlier split, where the broker
 * weighted tiers by demand units spread over the mix, offered slots in a
 * shape no lane had asked for.
 */
export function desiredByTier(
  tasks: readonly TaskSnapshot[],
  budget: number,
): Partial<Record<Tier, number>> {
  const open: Record<Tier, number> = { light: budget, standard: budget, expert: budget };
  const out: Partial<Record<Tier, number>> = {};
  for (const a of allocate(tasks, open, budget).assignments) {
    out[a.tier] = (out[a.tier] ?? 0) + a.count;
  }
  return out;
}

import type { Ledger } from "../ledger/ledger.js";
import type { CalibratorConfig, MeterSpec } from "../calibrator/types.js";
import { TIERS, type Tier } from "../tasks/types.js";

/**
 * The broker owns account custody: which account and model a launch runs on,
 * how many concurrent sessions each account sustains, and where a failing
 * session moves. It is the only component that reads calibration for
 * admission decisions; everything it knows is derived from ledger facts at
 * decision time (calibration by replay, burn by measurement), never from
 * hand-configured burn constants.
 */

export interface ModelCandidate {
  readonly provider: string;
  readonly model: string;
  /** pi thinking level for launches of this candidate. */
  readonly thinking?: string;
}

export interface BrokerConfig {
  /** Preference-ordered model substitution set per tier. */
  readonly tiers: Readonly<Record<Tier, readonly ModelCandidate[]>>;
  /** Meter topology per provider, keyed by the provider of its accounts. */
  readonly meters: Readonly<Record<string, readonly MeterSpec[]>>;
  /** Assumed per-session percent/hour before enough measured session-hours
   * exist. Deliberately pessimistic: bootstrap admits little, measurement
   * then earns concurrency. */
  readonly bootstrapSessionPercentPerHour: number;
  /** Window for measuring per-session burn from readings and run history. */
  readonly measurementWindowMs: number;
  /** Hard ceiling on concurrent sessions across the whole machine. The
   * estimator paces provider quota; it knows nothing about the RAM a session
   * occupies, and the sessions are hosted in-process. */
  readonly maxConcurrentSessions: number;
  /** Session-hours inside the window required before trusting measurement. */
  readonly minMeasuredSessionHours: number;
  /** How long a failed-over account stays out of admission. */
  readonly cooldownMs: number;
  /** Upper bound on advertised slots per tier per cycle. */
  readonly maxSlotsPerTier: number;
  /** Interactive lease heartbeat age after which a crashed session releases
   * capacity and stops accruing session-hours. */
  readonly sessionLeaseTimeoutMs: number;
  readonly calibrator?: Partial<CalibratorConfig>;
  /** Maps stored usage classes onto calibration classes at replay time,
   * per provider family (weights are family-specific prices). */
  readonly transform?: (
    provider: string,
    classId: string,
    tokens: number,
  ) => { classId: string; tokens: number };
}

export const BROKER_DEFAULTS = {
  bootstrapSessionPercentPerHour: 1,
  measurementWindowMs: 48 * 3_600_000,
  minMeasuredSessionHours: 6,
  cooldownMs: 10 * 60_000,
  maxSlotsPerTier: 8,
  maxConcurrentSessions: 40,
  sessionLeaseTimeoutMs: 2 * 60_000,
};

export interface Admission {
  readonly accountId: string;
  readonly provider: string;
  readonly model: string;
  readonly thinking?: string;
}

interface AccountView {
  readonly id: string;
  readonly provider: string;
  /** Sustainable percent/hour; undefined = no calibration yet (bootstrap). */
  readonly sustainable: number | undefined;
  /** Measured (or bootstrap) percent/hour one session burns. */
  readonly sessionBurn: number;
  /** Concurrent sessions this account supports right now. */
  readonly capacity: number;
  active: number;
}

/** Scarcer capacity wins ties when advertising slots. */
const SLOT_ORDER: readonly Tier[] = [...TIERS].reverse();

export class Broker {
  private readonly cfg: BrokerConfig;

  constructor(
    private readonly ledger: Ledger,
    cfg: Partial<BrokerConfig> & Pick<BrokerConfig, "tiers" | "meters">,
  ) {
    this.cfg = { ...BROKER_DEFAULTS, ...cfg };
  }

  /**
   * Admits one session for a tier: walks the tier's candidates in preference
   * order and picks the usable account with the most free capacity. Returns
   * undefined when no account can take another session.
   */
  admit(tier: Tier, now: number, exclude?: ReadonlySet<string>): Admission | undefined {
    return this.pick(this.views(now), tier, exclude);
  }

  /**
   * Advertises launch slots per tier for one allocation cycle by virtually
   * admitting until refusal, so shared accounts are never double-counted
   * across tiers. `demand` caps each tier at what eligible tasks can actually
   * use, so a tier never hoards an account that nothing wants.
   *
   * Slots are handed out in demand-proportional turns — weighted fair
   * queueing over the tiers, ties to the scarcer tier — rather than filling
   * the scarcest tier to exhaustion first. Draining in strict tier order was
   * fine while tiers meant separate account pools, but tiers now share
   * accounts: with light and standard both drawing on the same Codex
   * subscriptions, filling standard first took every account every cycle and
   * the light tier was advertised zero slots forever, whatever any task
   * asked for.
   */
  slotsByTier(now: number, demand?: Readonly<Partial<Record<Tier, number>>>): Record<Tier, number> {
    const views = this.views(now);
    const slots = { light: 0, standard: 0, expert: 0 } as Record<Tier, number>;
    /** Hard ceiling: never advertise a slot no task could use. */
    const limit = (tier: Tier): number =>
      Math.min(
        this.cfg.maxSlotsPerTier,
        demand === undefined ? Number.POSITIVE_INFINITY : (demand[tier] ?? 0),
      );
    /** Share of the turns. A caller that names no demand wants plain
     * round-robin, scarcer tier first. */
    const weight = (tier: Tier): number => (demand === undefined ? 1 : (demand[tier] ?? 0));
    const exhausted = new Set<Tier>();
    for (;;) {
      let next: Tier | undefined;
      let bestTime = Number.POSITIVE_INFINITY;
      for (const tier of SLOT_ORDER) {
        if (exhausted.has(tier) || slots[tier] >= limit(tier) || weight(tier) <= 0) continue;
        const virtualTime = (slots[tier] + 1) / weight(tier);
        if (virtualTime < bestTime - 1e-9) {
          next = tier;
          bestTime = virtualTime;
        }
      }
      if (next === undefined) return slots;
      const admission = this.pick(views, next);
      if (admission === undefined) {
        exhausted.add(next);
        continue;
      }
      for (const v of views) if (v.id === admission.accountId) v.active++;
      slots[next]++;
    }
  }

  /**
   * Admission facts for an external launcher (a process that starts its own
   * sessions on this machine's accounts instead of enqueuing orchestrator
   * runs). Eligible accounts only — cooling, expired-access, and
   * non-shareable accounts are already filtered — with each account's
   * measured concurrent-session capacity and current active count (fleet
   * runs plus interactive session leases). The machine ceiling bounds any
   * slot sum a reader derives, exactly as it bounds `admit`.
   */
  externalCapacity(now: number): {
    readonly accounts: readonly {
      readonly id: string;
      readonly provider: string;
      readonly capacity: number;
      readonly active: number;
    }[];
    readonly machineCeiling: number;
    readonly totalActive: number;
  } {
    const views = this.views(now);
    return {
      accounts: views.map((v) => ({
        id: v.id,
        provider: v.provider,
        capacity: v.capacity,
        active: v.active,
      })),
      machineCeiling: this.cfg.maxConcurrentSessions,
      totalActive: views.reduce((sum, v) => sum + v.active, 0),
    };
  }

  /**
   * Moves a failing run to another account: the old account cools down (its
   * failure is likely exhaustion or an outage that a retry would just re-hit)
   * and the run is re-admitted excluding it. Returns the new assignment, or
   * undefined when nothing else can take the session.
   */
  failover(runId: string, now: number): Admission | undefined {
    const run = this.ledger.run(runId);
    if (run === undefined || run.state !== "running") return undefined;
    this.ledger.setAccountCooldown(run.accountId, now + this.cfg.cooldownMs);
    const admission = this.admit(run.tier, now, new Set([run.accountId]));
    if (admission !== undefined) this.ledger.reassignRun(runId, admission);
    return admission;
  }

  /** Sustainable percent/hour for an account: the most binding meter's
   * hazard-paced plan rate, scaled by the family's operator boost. Undefined
   * until calibration exists — an uncalibrated account stays in bootstrap
   * whatever the boost, because there is nothing measured to spend faster. */
  sustainableRate(accountId: string, provider: string, now: number): number | undefined {
    const paced = this.pacedRate(accountId, provider, now);
    return paced === undefined ? undefined : paced * this.ledger.boost(provider);
  }

  private pacedRate(accountId: string, provider: string, now: number): number | undefined {
    const specs = this.cfg.meters[provider];
    if (specs === undefined || specs.length === 0) return undefined;
    const transform = this.cfg.transform;
    const cal = this.ledger.replayCalibrator(
      accountId,
      specs,
      this.cfg.calibrator,
      transform === undefined ? undefined : (c, t) => transform(provider, c, t),
    );
    let min: number | undefined;
    for (const spec of specs) {
      if (this.ledger.latestReading(accountId, spec.id) === undefined) continue;
      const plan = cal.plan(spec.id, now);
      if (!plan.ok) return undefined;
      if (min === undefined || plan.value.percentPerHour < min) min = plan.value.percentPerHour;
    }
    return min;
  }

  /** Measured percent/hour one session burns on this account, from observed
   * meter drain over recorded session-hours; bootstrap value until enough
   * hours exist. */
  sessionBurn(accountId: string, now: number): number {
    return this.measuredSessionBurn(accountId, now) ?? this.cfg.bootstrapSessionPercentPerHour;
  }

  /** The measurement itself, or undefined while the account has too few
   * recorded session-hours to have measured anything. */
  private measuredSessionBurn(accountId: string, now: number): number | undefined {
    const since = now - this.cfg.measurementWindowMs;
    const hours = this.ledger.sessionHours(accountId, since, now, this.cfg.sessionLeaseTimeoutMs);
    if (hours < this.cfg.minMeasuredSessionHours) return undefined;
    const burn = this.ledger.drainSince(accountId, since) / hours;
    return burn > 0 ? burn : undefined;
  }

  private views(now: number): AccountView[] {
    return this.ledger
      .accounts()
      .filter(
        (a) =>
          // Shared accounts are authenticated from the central credential
          // store and can fund both interactive and orchestrated sessions.
          (a.shared || a.domain === "orchestrator") &&
          (a.accessUntil === undefined || a.accessUntil > now) &&
          (a.cooldownUntil === undefined || a.cooldownUntil <= now),
      )
      .map((a) => {
        const sustainable = this.sustainableRate(a.id, a.provider, now);
        const measured = this.measuredSessionBurn(a.id, now);
        const sessionBurn = measured ?? this.cfg.bootstrapSessionPercentPerHour;
        // Concurrency is a measurement, not a constant: what the plan
        // sustains, divided by what one session actually costs. Both halves
        // have to be observed for the quotient to mean anything, so an
        // account missing either one runs a single session until it has
        // earned the evidence. That bootstrap is a floor for the unmeasured,
        // never a cap on the measured — and never a floor under a measured
        // account that plainly cannot afford another session, which is why a
        // fully measured quotient of zero is honoured.
        const capacity =
          sustainable === undefined || measured === undefined
            ? 1
            : Math.floor(sustainable / sessionBurn);
        return {
          id: a.id,
          provider: a.provider,
          sustainable,
          sessionBurn,
          capacity,
          active:
            this.ledger.activeRunCount(a.id) +
            this.ledger.activeSessionLeaseCount(a.id, now, this.cfg.sessionLeaseTimeoutMs),
        };
      });
  }

  private pick(
    views: readonly AccountView[],
    tier: Tier,
    exclude?: ReadonlySet<string>,
  ): Admission | undefined {
    // Quota is not the only finite resource: sessions are hosted in the
    // runner's own process, and 24 of them once reached 22.8 GiB and were
    // OOM-killed. The estimator cannot see that, so the machine ceiling is
    // enforced here, over every tier and account at once.
    const active = views.reduce((sum, v) => sum + v.active, 0);
    if (active >= this.cfg.maxConcurrentSessions) return undefined;
    for (const candidate of this.cfg.tiers[tier] ?? []) {
      let best: AccountView | undefined;
      for (const v of views) {
        if (v.provider !== candidate.provider) continue;
        if (exclude?.has(v.id)) continue;
        if (v.capacity - v.active <= 0) continue;
        if (best === undefined || v.capacity - v.active > best.capacity - best.active) best = v;
      }
      if (best !== undefined) {
        return {
          accountId: best.id,
          provider: candidate.provider,
          model: candidate.model,
          thinking: candidate.thinking,
        };
      }
    }
    return undefined;
  }
}

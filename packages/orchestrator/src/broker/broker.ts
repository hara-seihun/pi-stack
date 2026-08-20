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
  /** Session-hours inside the window required before trusting measurement. */
  readonly minMeasuredSessionHours: number;
  /** How long a failed-over account stays out of admission. */
  readonly cooldownMs: number;
  /** Upper bound on advertised slots per tier per cycle. */
  readonly maxSlotsPerTier: number;
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

/** Scarcer capacity is reserved first when advertising slots. */
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
   * admitting until refusal, scarcest tier first, so shared accounts are
   * never double-counted across tiers. `demand` caps each tier at what
   * eligible tasks can actually use, so a scarce tier never hoards an
   * account that nothing wants.
   */
  slotsByTier(now: number, demand?: Readonly<Partial<Record<Tier, number>>>): Record<Tier, number> {
    const views = this.views(now);
    const slots = { light: 0, standard: 0, expert: 0 } as Record<Tier, number>;
    for (const tier of SLOT_ORDER) {
      const cap = Math.min(
        this.cfg.maxSlotsPerTier,
        demand === undefined ? Number.POSITIVE_INFINITY : (demand[tier] ?? 0),
      );
      while (slots[tier] < cap) {
        const admission = this.pick(views, tier);
        if (admission === undefined) break;
        for (const v of views) if (v.id === admission.accountId) v.active++;
        slots[tier]++;
      }
    }
    return slots;
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
   * hazard-paced plan rate. Undefined until calibration exists. */
  sustainableRate(accountId: string, provider: string, now: number): number | undefined {
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
      const plan = cal.plan(spec.id, now);
      if (!plan.ok) continue;
      if (min === undefined || plan.value.percentPerHour < min) min = plan.value.percentPerHour;
    }
    return min;
  }

  /** Measured percent/hour one session burns on this account, from observed
   * meter drain over recorded session-hours; bootstrap value until enough
   * hours exist. */
  sessionBurn(accountId: string, now: number): number {
    const since = now - this.cfg.measurementWindowMs;
    const hours = this.ledger.runHours(accountId, since, now);
    if (hours < this.cfg.minMeasuredSessionHours) return this.cfg.bootstrapSessionPercentPerHour;
    const burn = this.ledger.drainSince(accountId, since) / hours;
    return burn > 0 ? burn : this.cfg.bootstrapSessionPercentPerHour;
  }

  private views(now: number): AccountView[] {
    return this.ledger
      .accounts()
      .filter(
        (a) =>
          // Broker custody covers only orchestrator-domain accounts: the
          // runner can only authenticate credentials in its own auth.json.
          a.domain === "orchestrator" &&
          (a.accessUntil === undefined || a.accessUntil > now) &&
          (a.cooldownUntil === undefined || a.cooldownUntil <= now),
      )
      .map((a) => {
        const sustainable = this.sustainableRate(a.id, a.provider, now);
        const sessionBurn = this.sessionBurn(a.id, now);
        // Without calibration the account is in bootstrap: one session, so
        // the calibrator gets data without risking a multi-session stampede.
        const capacity =
          sustainable === undefined ? 1 : Math.floor(sustainable / sessionBurn);
        return {
          id: a.id,
          provider: a.provider,
          sustainable,
          sessionBurn,
          capacity,
          active: this.ledger.activeRunCount(a.id),
        };
      });
  }

  private pick(
    views: readonly AccountView[],
    tier: Tier,
    exclude?: ReadonlySet<string>,
  ): Admission | undefined {
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

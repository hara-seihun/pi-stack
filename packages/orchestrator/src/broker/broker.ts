import type { Ledger } from "../ledger/ledger.js";
import type { AccountCalibrator } from "../calibrator/calibrator.js";
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
  /** model id -> usage class, per provider family; a model absent here is
   * `default`. Names which meters a launch of that model can drain. */
  readonly modelClasses?: Readonly<Record<string, Readonly<Record<string, string>>>>;
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
  /** Measured (or bootstrap) percent/hour one session burns, blended over
   * whatever models have been running here. */
  readonly sessionBurn: number;
  /** True once session burn is measured rather than assumed. */
  readonly measured: boolean;
  /** Concurrent sessions this account supports at its blended burn; what an
   * external launcher is told, and the bootstrap bound before burn is
   * measured. */
  readonly capacity: number;
  /** Percent/hour the account's live sessions have already committed, each
   * priced at what its own model burns. */
  committed: number;
  active: number;
}

/** Scarcer capacity wins ties when advertising slots. */
const SLOT_ORDER: readonly Tier[] = [...TIERS].reverse();

export class Broker {
  private readonly cfg: BrokerConfig;
  /** Everything derived from a full calibration replay, memoised for one
   * decision instant. A replay reads the account's whole reading and usage
   * history, and one allocation cycle asks the same questions once per
   * advertised slot, per account, per candidate model. */
  private readonly rates = new Map<string, number | undefined>();
  private readonly burns = new Map<string, number>();
  private readonly cals = new Map<string, AccountCalibrator>();
  private ratesAt: number | undefined;

  constructor(
    private readonly ledger: Ledger,
    cfg: Partial<BrokerConfig> & Pick<BrokerConfig, "tiers" | "meters">,
  ) {
    this.cfg = { ...BROKER_DEFAULTS, ...cfg };
  }

  /** The most slots one cycle can advertise across every tier. What a caller
   * asking "how should the next batch of launches be shaped" should size its
   * answer to; smaller and the shape is clipped before the broker sees it. */
  get maxSlotsPerCycle(): number {
    return this.cfg.maxSlotsPerTier * TIERS.length;
  }

  /**
   * Admits one session for a tier: walks the tier's candidates in preference
   * order and picks the usable account with the most free capacity. Returns
   * undefined when no account can take another session.
   */
  admit(tier: Tier, now: number, exclude?: ReadonlySet<string>): Admission | undefined {
    return this.pick(this.views(now), tier, now, exclude);
  }

  /**
   * Whether some account could fund a session of this tier if the machine
   * had room — quota only, with the session ceiling left out.
   *
   * The question a full machine has to answer before giving a session up:
   * freeing a slot for a tier whose quota is already spent costs real work
   * and buys nothing.
   */
  hasQuotaFor(tier: Tier, now: number): boolean {
    const views = this.views(now).map((v) => ({ ...v, active: 0 }));
    return this.pick(views, tier, now) !== undefined;
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
      const admission = this.pick(views, next, now);
      if (admission === undefined) {
        exhausted.add(next);
        continue;
      }
      // The provisional slot commits its model's burn, so the next tier is
      // priced against what this one just took.
      const burn = this.sessionBurn(admission.accountId, now, admission.provider, admission.model);
      for (const v of views) {
        if (v.id !== admission.accountId) continue;
        v.active++;
        v.committed += burn;
      }
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
  sustainableRate(accountId: string, provider: string, now: number, model?: string): number | undefined {
    const paced = this.pacedRate(accountId, provider, now, model);
    return paced === undefined ? undefined : paced * this.ledger.boost(provider);
  }

  /**
   * The meters a launch of `model` can actually drain, from the topology's
   * `drainedBy` classes.
   *
   * A model-scoped meter must not pace work that cannot touch it. Anthropic's
   * scoped weekly bucket is Fable's alone, so an account whose Fable week is
   * spent still has whatever its session and all-models meters say for an
   * Opus launch — and pacing that launch against the exhausted bucket would
   * strand a working plan at zero capacity. Naming no model asks the
   * account-wide question and keeps every meter, which is the conservative
   * answer for a caller that has not said what it will run.
   */
  private metersFor(provider: string, model: string | undefined): readonly MeterSpec[] {
    const specs = this.cfg.meters[provider] ?? [];
    if (model === undefined) return specs;
    const prefix = `${this.cfg.modelClasses?.[provider]?.[model] ?? "default"}:`;
    const drained = specs.filter((spec) => spec.drainedBy.some((classId) => classId.startsWith(prefix)));
    // A topology that names no class for this model says nothing about which
    // meters it spares; pace against all of them rather than none.
    return drained.length > 0 ? drained : specs;
  }

  /** One replay of an account's whole history, shared by everything that
   * asks a calibration question at the same instant. */
  private calibration(accountId: string, provider: string, now: number): AccountCalibrator | undefined {
    const specs = this.cfg.meters[provider];
    if (specs === undefined || specs.length === 0) return undefined;
    if (this.ratesAt !== now) {
      this.rates.clear();
      this.burns.clear();
      this.cals.clear();
      this.ratesAt = now;
    }
    const cached = this.cals.get(accountId);
    if (cached !== undefined) return cached;
    const transform = this.cfg.transform;
    const cal = this.ledger.replayCalibrator(
      accountId,
      specs,
      this.cfg.calibrator,
      transform === undefined ? undefined : (c, t) => transform(provider, c, t),
    );
    this.cals.set(accountId, cal);
    return cal;
  }

  private pacedRate(accountId: string, provider: string, now: number, model?: string): number | undefined {
    const specs = this.cfg.meters[provider];
    if (specs === undefined || specs.length === 0) return undefined;
    // Replay always carries the family's whole topology — every stored
    // reading has to land on a meter it knows — and the model narrows only
    // which of the calibrated meters get a say in the rate.
    const cal = this.calibration(accountId, provider, now);
    if (cal === undefined) return undefined;
    let min: number | undefined;
    for (const spec of this.metersFor(provider, model)) {
      if (this.ledger.latestReading(accountId, spec.id) === undefined) continue;
      const plan = cal.plan(spec.id, now);
      if (!plan.ok) return undefined;
      if (min === undefined || plan.value.percentPerHour < min) min = plan.value.percentPerHour;
    }
    return min;
  }

  /** Measured percent/hour one session burns on this account, from observed
   * meter drain over recorded session-hours; bootstrap value until enough
   * hours exist. Naming a model asks the sharper question — what a session
   * *of that model* costs — and falls back to the account's blended burn
   * when that model has not run long enough here to have been measured. */
  sessionBurn(accountId: string, now: number, provider?: string, model?: string): number {
    if (this.ratesAt !== now) {
      this.rates.clear();
      this.burns.clear();
      this.cals.clear();
      this.ratesAt = now;
    }
    const key = `${accountId}\u0000${provider ?? ""}\u0000${model ?? ""}`;
    const cached = this.burns.get(key);
    if (cached !== undefined) return cached;
    const burn =
      (provider !== undefined && model !== undefined
        ? this.measuredModelBurn(accountId, provider, model, now)
        : undefined) ??
      this.measuredSessionBurn(accountId, now) ??
      this.cfg.bootstrapSessionPercentPerHour;
    this.burns.set(key, burn);
    return burn;
  }

  /**
   * Percent/hour a session of one model burns: what an hour of it costs in
   * usage, priced at what the meter charges that usage class.
   *
   * Both halves are measured. The calibrator already fits a coefficient per
   * usage class — percent of the meter per token — so classing the models
   * apart is what makes the difference between them visible; the ledger
   * supplies the cost an hour of each model's sessions actually recorded.
   * A class the fit prices at zero is a real answer: the fleet ran thousands
   * of session-hours of a cheap model against a meter that did not move, and
   * pacing those sessions as if they cost what the expensive model costs held
   * the machine at a fraction of the concurrency the plan sustains.
   */
  private measuredModelBurn(
    accountId: string,
    provider: string,
    model: string,
    now: number,
  ): number | undefined {
    const since = now - this.cfg.measurementWindowMs;
    const usage = this.ledger
      .modelUsage(accountId, since, now)
      .find((row) => row.model === model);
    if (usage === undefined || usage.hours < this.cfg.minMeasuredSessionHours) return undefined;
    const transform = this.cfg.transform;
    let cost = 0;
    let costClass: string | undefined;
    for (const [classId, tokens] of Object.entries(usage.tokensByClass)) {
      const priced = transform?.(provider, classId, tokens) ?? { classId, tokens };
      cost += priced.tokens;
      costClass ??= priced.classId;
    }
    if (cost <= 0 || costClass === undefined) return undefined;
    const percentPerToken = this.classCoefficient(accountId, provider, model, costClass, now);
    if (percentPerToken === undefined) return undefined;
    return (percentPerToken * cost) / usage.hours;
  }

  /** The fitted percent-per-cost-unit for a model's usage class, from the
   * meter that paces it most tightly. Undefined until that meter has
   * observed the class at all; zero once it has and found no drain. */
  private classCoefficient(
    accountId: string,
    provider: string,
    model: string,
    costClass: string,
    now: number,
  ): number | undefined {
    const cal = this.calibration(accountId, provider, now);
    if (cal === undefined) return undefined;
    let binding: number | undefined;
    for (const spec of this.metersFor(provider, model)) {
      const stats = cal.stats(spec.id);
      const cls = stats.classes.find((c) => c.classId === costClass);
      if (cls?.percentPerToken === undefined) continue;
      if (binding === undefined || cls.percentPerToken > binding) binding = cls.percentPerToken;
    }
    return binding;
  }

  /** The measurement itself, or undefined while the account has too few
   * observed session-hours to have measured anything.
   *
   * Numerator and denominator are taken over the same interval: the span the
   * account's meters actually reported across, not the whole measurement
   * window. Session-hours the meters never priced would otherwise dilute
   * observed drain into a burn several times too low, and concurrency is its
   * reciprocal. */
  private measuredSessionBurn(accountId: string, now: number): number | undefined {
    const observed = this.ledger.drainWindow(accountId, now - this.cfg.measurementWindowMs, now);
    if (observed === undefined) return undefined;
    const hours = this.ledger.sessionHours(
      accountId,
      observed.from,
      observed.to,
      this.cfg.sessionLeaseTimeoutMs,
    );
    if (hours < this.cfg.minMeasuredSessionHours) return undefined;
    const burn = observed.percent / hours;
    return burn > 0 ? burn : undefined;
  }

  /**
   * Percent/hour an account's live sessions already commit: each run priced
   * at what a session of *its* model burns here, plus interactive leases at
   * the account's blended rate, since a lease carries no model.
   */
  private committedBurn(
    accountId: string,
    provider: string,
    blended: number,
    now: number,
  ): number {
    let committed = 0;
    for (const { model, count } of this.ledger.activeRunModels(accountId)) {
      committed += count * this.sessionBurn(accountId, now, provider, model);
    }
    return (
      committed +
      this.ledger.activeSessionLeaseCount(accountId, now, this.cfg.sessionLeaseTimeoutMs) * blended
    );
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
        const sustainable = this.cachedRate(a.id, a.provider, now);
        const measured = this.measuredSessionBurn(a.id, now);
        const sessionBurn = measured ?? this.cfg.bootstrapSessionPercentPerHour;
        return {
          id: a.id,
          provider: a.provider,
          sustainable,
          sessionBurn,
          measured: measured !== undefined,
          capacity: this.capacity(sustainable, sessionBurn, measured !== undefined),
          committed: this.committedBurn(a.id, a.provider, sessionBurn, now),
          active:
            this.ledger.activeRunCount(a.id) +
            this.ledger.activeSessionLeaseCount(a.id, now, this.cfg.sessionLeaseTimeoutMs),
        };
      });
  }

  /**
   * Concurrency is a measurement, not a constant: what the plan sustains,
   * divided by what one session actually costs. Both halves have to be
   * observed for the quotient to mean anything, so an account missing either
   * one runs a single session until it has earned the evidence. That
   * bootstrap is a floor for the unmeasured, never a cap on the measured —
   * and never a floor under a measured account that plainly cannot afford
   * another session, which is why a fully measured quotient of zero is
   * honoured.
   */
  private capacity(sustainable: number | undefined, sessionBurn: number, measured: boolean): number {
    if (sustainable === undefined || !measured) return 1;
    // A model measured as free against the meter has no quota bound at all,
    // and the quotient says so. What still bounds it is the machine: sessions
    // are hosted in the runner's process, so the ceiling is the answer rather
    // than an infinity that would flow into every free-capacity comparison.
    if (sessionBurn <= 0) return this.cfg.maxConcurrentSessions;
    return Math.min(this.cfg.maxConcurrentSessions, Math.floor(sustainable / sessionBurn));
  }

  private cachedRate(accountId: string, provider: string, now: number, model?: string): number | undefined {
    if (this.ratesAt !== now) {
      this.rates.clear();
      this.burns.clear();
      this.cals.clear();
      this.ratesAt = now;
    }
    const key = `${accountId}\u0000${provider}\u0000${model ?? ""}`;
    if (!this.rates.has(key)) this.rates.set(key, this.sustainableRate(accountId, provider, now, model));
    return this.rates.get(key);
  }

  private pick(
    views: readonly AccountView[],
    tier: Tier,
    now: number,
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
      let bestFree = 0;
      for (const v of views) {
        if (v.provider !== candidate.provider) continue;
        if (exclude?.has(v.id)) continue;
        // What an account can take is a rate budget, not a session count.
        // Every live session commits what its own model burns, and a
        // candidate is admitted if the account's meter can sustain the sum.
        // Counting sessions instead let a cheap model starve an expensive
        // one: forty-six light sessions on an account filled its session
        // count, so the standard tier — costing a fraction of the account's
        // sustainable rate, and asked for by an operator running a 1:5 mix —
        // was refused every account on the machine and the fleet ran with a
        // single standard session.
        const rate = this.cachedRate(v.id, candidate.provider, now, candidate.model);
        const burn = this.sessionBurn(v.id, now, candidate.provider, candidate.model);
        let free: number;
        if (rate === undefined || !v.measured) {
          // Bootstrap: nothing is measured, so one session at a time until
          // the meters have priced this account.
          free = v.active >= 1 ? 0 : 1;
        } else {
          // A model measured as free against every meter it drains costs the
          // account nothing; the machine ceiling above is what bounds it.
          free = burn <= 0 ? this.cfg.maxConcurrentSessions - v.active : (rate - v.committed) / burn;
        }
        if (free < 1) continue;
        if (best === undefined || free > bestFree) {
          best = v;
          bestFree = free;
        }
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

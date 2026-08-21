import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Ledger } from "../ledger/ledger.js";

/**
 * Anthropic meter sampling.
 *
 * Anthropic does publish rate-limit headers, which is why this provider had
 * no poller for so long — the usage-logger extension records them for free
 * from every response. Two structural blind spots make that source
 * incomplete, and both of them silently *overstate* headroom, which is the
 * dangerous direction:
 *
 * - **The scoped weekly header is model-conditional.** A response carries
 *   `anthropic-ratelimit-unified-7d_oi-*` only when the request was scoped
 *   to that model (Fable). An account running Opus emits the 5h and 7d
 *   headers and nothing else, so its Fable meter simply does not exist in
 *   the ledger — and a consumer that averages the accounts that *do* have
 *   one reports the healthy accounts as if they were the fleet.
 * - **Headers only see this machine.** An account shared with an off-machine
 *   client (Claude Code on the work laptop) drains meters no local response
 *   ever reports. A locally idle account looks unchanged rather than drained.
 *
 * The account usage endpoint has neither problem: `GET /api/oauth/usage`
 * returns every bucket of the plan, on every call, whatever the account has
 * been running and wherever it ran. This sampler polls it beside the Cursor
 * and Codex samplers, writing the same ordinary meter readings the header
 * path writes, so calibration, broker admission, and Pi Remote's plan cards
 * read one complete set of facts.
 *
 * The same two constraints from docs/provider-meter-notes.md apply here as
 * for Cursor and Codex: only percentages are recorded, and a sampler must
 * never refresh OAuth — refresh tokens are single-use and an independent
 * refresh revokes the token family out from under every pi session using
 * that account. An expired access token is recorded as a gap by not sampling.
 */

export const ANTHROPIC_PROVIDER = "anthropic";
const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const USER_AGENT = "pi-orchestrator";

/**
 * Ledger meter id for each bucket the usage endpoint reports.
 *
 * These are the ids the usage-logger extension derives from the header
 * window names (`anthropic-${window}`), and they must stay identical: one
 * meter is one fact, whether a response header or this poller observed it.
 */
export const ANTHROPIC_METER_IDS = {
  session: "anthropic-5h",
  weekly_all: "anthropic-7d",
  weekly_scoped: "anthropic-7d_oi",
} as const;

/**
 * The model the `7d_oi` meter is scoped to. Verified against production
 * traffic: readings on that meter begin exactly when an account starts
 * running Fable, and never appear for Opus-only accounts, while the usage
 * endpoint labels the same bucket `weekly_scoped` on model "Fable". Opus has
 * no weekly bucket of its own — it drains the session and all-models meters.
 */
const SCOPED_MODEL = "fable";

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

/** One plan bucket, already mapped to the ledger meter that records it. */
export interface AnthropicBucketUsage {
  readonly meterId: string;
  readonly usedPercent: number;
  readonly resetAt: number | undefined;
}

export interface AnthropicUsageReading {
  readonly buckets: AnthropicBucketUsage[];
  /** Scoped weekly buckets no meter is declared for, by model display name. */
  readonly unmappedScopes: string[];
}

export type AnthropicSampleOutcome =
  | "recorded"
  | "not-due"
  | "no-credential"
  | "expired-credential"
  | "request-failed"
  | "unreadable-response"
  | "unmapped-scope"
  | "stale-reading";

export interface AnthropicSampleReport {
  readonly accountId: string;
  readonly meterId?: string;
  readonly outcome: AnthropicSampleOutcome;
  readonly usedPercent?: number;
  readonly detail?: string;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
}

function scopedModelName(limit: Record<string, unknown>): string | undefined {
  const model = record(record(limit.scope)?.model);
  const name = model?.display_name;
  return typeof name === "string" && name.length > 0 ? name : undefined;
}

function bucket(limit: Record<string, unknown>, meterId: string): AnthropicBucketUsage | undefined {
  const raw = limit.percent ?? limit.utilization;
  if (typeof raw !== "number" || !Number.isFinite(raw)) return undefined;
  const resetsAt = typeof limit.resets_at === "string" ? Date.parse(limit.resets_at) : Number.NaN;
  return {
    meterId,
    usedPercent: raw,
    resetAt: Number.isFinite(resetsAt) ? resetsAt : undefined,
  };
}

/**
 * Reads the plan buckets out of a usage response.
 *
 * Only the `limits` array is read. The response also carries older
 * top-level fields (`five_hour`, `seven_day`), but they express no scoped
 * weekly bucket at all — `seven_day_opus` is null on these plans — so
 * falling back to them would silently reintroduce exactly the hole this
 * sampler exists to close. No usable `limits` array is a gap in evidence,
 * reported as such, never a zero reading.
 */
export function parseAnthropicUsage(value: unknown): AnthropicUsageReading {
  const limits = record(value)?.limits;
  if (!Array.isArray(limits)) return { buckets: [], unmappedScopes: [] };
  const buckets: AnthropicBucketUsage[] = [];
  const unmappedScopes: string[] = [];
  const scoped = limits.map(record).filter((limit): limit is Record<string, unknown> =>
    limit !== undefined && limit.kind === "weekly_scoped");
  // One scoped bucket needs no name to be identified; several do, and a
  // scope this deployment declares no meter for is reported rather than
  // guessed at, because a mis-named meter would calibrate one model's drain
  // against another's allowance.
  const chosen = scoped.length === 1
    ? scoped[0]
    : scoped.find((limit) => (scopedModelName(limit) ?? "").toLowerCase() === SCOPED_MODEL);
  for (const limit of limits) {
    const raw = record(limit);
    if (raw === undefined) continue;
    if (raw.kind === "session") {
      const usage = bucket(raw, ANTHROPIC_METER_IDS.session);
      if (usage) buckets.push(usage);
    } else if (raw.kind === "weekly_all") {
      const usage = bucket(raw, ANTHROPIC_METER_IDS.weekly_all);
      if (usage) buckets.push(usage);
    } else if (raw.kind === "weekly_scoped") {
      if (raw !== chosen) {
        unmappedScopes.push(scopedModelName(raw) ?? "unnamed");
        continue;
      }
      const usage = bucket(raw, ANTHROPIC_METER_IDS.weekly_scoped);
      if (usage) buckets.push(usage);
    }
  }
  return { buckets, unmappedScopes };
}

export async function fetchAnthropicUsage(
  accessToken: string,
  fetchFn: FetchLike,
  requestTimeoutMs: number,
): Promise<AnthropicUsageReading> {
  const response = await fetchFn(USAGE_URL, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
      "anthropic-version": "2023-06-01",
      "anthropic-beta": "oauth-2025-04-20",
      "User-Agent": USER_AGENT,
    },
    signal: AbortSignal.timeout(requestTimeoutMs),
  });
  if (!response.ok) throw new Error(`anthropic usage HTTP ${response.status}`);
  return parseAnthropicUsage(await response.json());
}

export interface AnthropicMeterSamplerOptions {
  /** pi agent directory whose auth.json holds this domain's credentials. */
  readonly agentDir: string;
  /** Minimum age of the stalest meter before an account is polled again. */
  readonly intervalMs?: number;
  readonly requestTimeoutMs?: number;
  readonly fetch?: FetchLike;
}

const DEFAULT_INTERVAL_MS = 10 * 60_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;

export class AnthropicMeterSampler {
  private readonly agentDir: string;
  private readonly intervalMs: number;
  private readonly requestTimeoutMs: number;
  private readonly fetchFn: FetchLike;

  constructor(
    private readonly ledger: Ledger,
    options: AnthropicMeterSamplerOptions,
  ) {
    this.agentDir = options.agentDir;
    this.intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.fetchFn = options.fetch ?? fetch;
  }

  /** Access token for `accountId`, read without ever refreshing it. */
  private accessToken(accountId: string, now: number): { token: string } | { gap: AnthropicSampleOutcome } {
    let auth: Record<string, unknown>;
    try {
      auth = JSON.parse(readFileSync(join(this.agentDir, "auth.json"), "utf8")) as Record<string, unknown>;
    } catch {
      return { gap: "no-credential" };
    }
    const credential = record(auth[accountId]) as { access?: unknown; expires?: unknown } | undefined;
    if (credential === undefined) return { gap: "no-credential" };
    if (typeof credential.access !== "string" || credential.access.length === 0) return { gap: "no-credential" };
    if (typeof credential.expires === "number" && credential.expires <= now) return { gap: "expired-credential" };
    return { token: credential.access };
  }

  /**
   * Due-ness is judged on the **stalest** of the account's meters, not the
   * freshest. Response headers keep the session and all-models meters
   * current for an account that is running right now while leaving its
   * scoped weekly meter missing or hours old, and it is precisely that meter
   * this poll exists to supply; judging on the freshest reading would make a
   * busy account permanently "not due" and never close the hole.
   */
  private due(accountId: string, now: number): boolean {
    return Object.values(ANTHROPIC_METER_IDS).some((meterId) => {
      const last = this.ledger.latestReading(accountId, meterId);
      return last === undefined || now - last.at >= this.intervalMs;
    });
  }

  /**
   * Samples every Anthropic account whose credential lives in this agent dir
   * and whose meters are due. Accounts credentialed in another custody
   * domain are skipped, not failed: their own owner polls them. Never
   * throws — a provider outage is a gap in evidence, not a controller fault.
   */
  async sample(now = Date.now()): Promise<AnthropicSampleReport[]> {
    const reports: AnthropicSampleReport[] = [];
    for (const account of this.ledger.accounts()) {
      if (account.provider !== ANTHROPIC_PROVIDER) continue;
      if (account.accessUntil !== undefined && account.accessUntil <= now) continue;
      if (!this.due(account.id, now)) {
        reports.push({ accountId: account.id, outcome: "not-due" });
        continue;
      }
      const credential = this.accessToken(account.id, now);
      if ("gap" in credential) {
        reports.push({ accountId: account.id, outcome: credential.gap });
        continue;
      }
      let usage: AnthropicUsageReading;
      try {
        usage = await fetchAnthropicUsage(credential.token, this.fetchFn, this.requestTimeoutMs);
      } catch (thrown) {
        reports.push({ accountId: account.id, outcome: "request-failed", detail: String(thrown) });
        continue;
      }
      for (const scope of usage.unmappedScopes) {
        reports.push({
          accountId: account.id,
          outcome: "unmapped-scope",
          detail: `no meter declared for the weekly bucket scoped to ${scope}`,
        });
      }
      if (usage.buckets.length === 0) {
        reports.push({ accountId: account.id, outcome: "unreadable-response" });
        continue;
      }
      for (const value of usage.buckets) {
        const previous = this.ledger.latestReading(account.id, value.meterId);
        const at = Date.now();
        // A header reading is not this fact: it reports the windows one
        // response was metered against, which is why this poll exists. So an
        // equal instant is a correction the ledger applies, and only a
        // genuinely newer stored reading makes this one stale.
        if (previous && at < previous.at) {
          reports.push({ accountId: account.id, meterId: value.meterId, outcome: "stale-reading" });
          continue;
        }
        try {
          this.ledger.recordReading(account.id, value.meterId, {
            at,
            usedPercent: Math.round(Math.max(0, Math.min(100, value.usedPercent))),
            resetAt: value.resetAt,
          });
        } catch (thrown) {
          // A session recorded a header reading between the check and the
          // write. The fact is stored either way; drop the redundant loser.
          reports.push({
            accountId: account.id,
            meterId: value.meterId,
            outcome: "stale-reading",
            detail: String(thrown),
          });
          continue;
        }
        reports.push({
          accountId: account.id,
          meterId: value.meterId,
          outcome: "recorded",
          usedPercent: value.usedPercent,
        });
      }
    }
    return reports;
  }
}

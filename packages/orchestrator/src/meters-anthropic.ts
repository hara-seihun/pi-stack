import type { OAuthCredential } from "@earendil-works/pi-ai";
import type { SharedOAuthAuth } from "./auth/shared-oauth.js";
import { meterCredential } from "./auth/meter-credential.js";
import type { Store } from "./store.js";

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
 * been running and wherever it ran. This sampler polls it beside the Codex
 * sampler, writing the same ordinary meter readings the header path writes,
 * so calibration, broker admission, and Pi Remote's plan cards read one
 * complete set of facts.
 *
 * Credentials resolve through SharedOAuthAuth, using the same lock and
 * atomic write as interactive and fleet sessions. Idle accounts can refresh
 * without racing another consumer's single-use refresh token.
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
  | "credential-failed"
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

function requestHeaders(accessToken: string): Record<string, string> {
  return {
    Authorization: `Bearer ${accessToken}`,
    Accept: "application/json",
    "anthropic-version": "2023-06-01",
    "anthropic-beta": "oauth-2025-04-20",
    "User-Agent": USER_AGENT,
  };
}

/** A usage request the provider refused on the credential, not the request. */
export class AnthropicUnauthorizedError extends Error {
  constructor(label: string, readonly status: number) {
    super(`anthropic ${label} HTTP ${status}`);
    this.name = "AnthropicUnauthorizedError";
  }
}

async function fetchAnthropicJson(
  url: string,
  label: string,
  accessToken: string,
  fetchFn: FetchLike,
  requestTimeoutMs: number,
): Promise<unknown> {
  const response = await fetchFn(url, {
    headers: requestHeaders(accessToken),
    signal: AbortSignal.timeout(requestTimeoutMs),
  });
  if (response.status === 401) throw new AnthropicUnauthorizedError(label, response.status);
  if (!response.ok) throw new Error(`anthropic ${label} HTTP ${response.status}`);
  return response.json();
}

export async function fetchAnthropicUsage(
  accessToken: string,
  fetchFn: FetchLike,
  requestTimeoutMs: number,
): Promise<AnthropicUsageReading> {
  return parseAnthropicUsage(
    await fetchAnthropicJson(USAGE_URL, "usage", accessToken, fetchFn, requestTimeoutMs),
  );
}

export interface AnthropicMeterSamplerOptions {
  readonly auth: SharedOAuthAuth;
  /** Minimum age of the stalest meter before an account is polled again. */
  readonly intervalMs?: number;
  readonly requestTimeoutMs?: number;
  readonly fetch?: FetchLike;
}

const DEFAULT_INTERVAL_MS = 10 * 60_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;

export class AnthropicMeterSampler {
  private readonly auth: SharedOAuthAuth;
  private readonly attemptedAt = new Map<string, number>();
  private readonly intervalMs: number;
  private readonly requestTimeoutMs: number;
  private readonly fetchFn: FetchLike;

  constructor(
    private readonly ledger: Store,
    options: AnthropicMeterSamplerOptions,
  ) {
    this.auth = options.auth;
    this.intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.fetchFn = options.fetch ?? fetch;
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
    const attempted = this.attemptedAt.get(accountId);
    if (attempted !== undefined && now - attempted < this.intervalMs) return false;
    return Object.values(ANTHROPIC_METER_IDS).some((meterId) => {
      const last = this.ledger.latestReading(accountId, meterId);
      return last === undefined || now - last.at >= this.intervalMs;
    });
  }

  /**
   * One usage read, repairing the credential if the provider rejects it.
   *
   * A provider can invalidate an access token before its stated expiry, and
   * expiry-driven refresh alone then leaves the account permanently
   * unauthenticated with a working refresh token in hand. This poll is the
   * one thing that touches every account on a schedule, so it is where that
   * is caught and repaired. A 401 that survives a fresh token is a real
   * authorization problem and is reported.
   */
  private async read(accountId: string, credential: OAuthCredential): Promise<AnthropicUsageReading> {
    try {
      return await fetchAnthropicUsage(credential.access, this.fetchFn, this.requestTimeoutMs);
    } catch (error) {
      if (!(error instanceof AnthropicUnauthorizedError)) throw error;
      const repaired = await this.auth.refreshRejected(
        accountId,
        credential.access,
        AbortSignal.timeout(this.requestTimeoutMs),
      );
      return await fetchAnthropicUsage(repaired.access, this.fetchFn, this.requestTimeoutMs);
    }
  }

  /**
   * Samples every Anthropic account whose credential lives in the shared
   * auth store and whose meters are due. Accounts credentialed in another
   * custody domain are skipped, not failed: their own owner polls them. Never
   * throws — a provider outage is a gap in evidence, not a controller fault.
   */
  async sample(now = Date.now()): Promise<AnthropicSampleReport[]> {
    const reports: AnthropicSampleReport[] = [];
    for (const account of this.ledger.accounts()) {
      if (account.provider !== ANTHROPIC_PROVIDER) continue;
      // Disabled accounts are unschedulable, so sampling them buys no
      // evidence and their failures would linger in status forever.
      if (!account.enabled) continue;
      if (!this.due(account.id, now)) {
        reports.push({ accountId: account.id, outcome: "not-due" });
        continue;
      }
      this.attemptedAt.set(account.id, now);
      const credential = await meterCredential(this.auth, account.id, this.requestTimeoutMs);
      if (!credential.ok) {
        reports.push({ accountId: account.id, outcome: credential.outcome, detail: credential.detail });
        continue;
      }
      let usage: AnthropicUsageReading;
      try {
        usage = await this.read(account.id, credential.credential);
      } catch (error) {
        reports.push({ accountId: account.id, outcome: "request-failed", detail: String(error) });
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

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Ledger } from "../ledger/ledger.js";

/**
 * Cursor meter sampling.
 *
 * Anthropic publishes rate-limit state on every response, so the
 * usage-logger extension records its meters for free. Cursor's Connect
 * stream carries no meter headers at all, so its one monthly meter has no
 * source unless something polls the dashboard RPC. This sampler is that
 * source (Codex has the same problem and its own sampler beside this one): it runs inside the controller daemon, which already runs as the
 * credential-custody user for orchestrator-domain accounts, and writes
 * ordinary meter readings into the ledger — the same facts the calibrator,
 * the broker, and Pi Remote's plan cards read for every other provider.
 *
 * Two constraints from docs/provider-meter-notes.md are load-bearing here:
 * only the percentage is a limit (the dollar figure Cursor calls "included
 * usage" is a retail-value estimate that gates nothing), and a sampler must
 * never refresh OAuth — refresh tokens are single-use, and an independent
 * refresh revokes the token family out from under pi. An expired access
 * token is recorded as a gap by simply not sampling.
 */

export const CURSOR_PROVIDER = "cursor";
const USAGE_URL = "https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage";

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface CursorUsage {
  /** Percent of the monthly plan consumed, as Cursor reports it. */
  readonly usedPercent: number;
  /** End of the current billing cycle, when the meter rolls over. */
  readonly resetAt: number | undefined;
}

export type CursorSampleOutcome =
  | "recorded"
  | "not-due"
  | "no-credential"
  | "expired-credential"
  | "request-failed"
  | "unreadable-response"
  | "stale-reading";

export interface CursorSampleReport {
  readonly accountId: string;
  readonly outcome: CursorSampleOutcome;
  readonly usedPercent?: number;
  readonly detail?: string;
}

function epochMs(value: unknown): number | undefined {
  const parsed = typeof value === "string" || typeof value === "number" ? Number(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * Reads the percentage meter out of a `GetCurrentPeriodUsage` response.
 * Undefined means the response carried no usable percentage — a reporting
 * gap, not a zero reading.
 */
export function parseCursorPeriodUsage(value: unknown): CursorUsage | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const body = value as Record<string, unknown>;
  const plan = body.planUsage;
  if (plan === null || typeof plan !== "object") return undefined;
  const usedPercent = (plan as Record<string, unknown>).totalPercentUsed;
  if (typeof usedPercent !== "number" || !Number.isFinite(usedPercent)) return undefined;
  return { usedPercent, resetAt: epochMs(body.billingCycleEnd) };
}

export async function fetchCursorUsage(
  accessToken: string,
  fetchFn: FetchLike,
  requestTimeoutMs: number,
): Promise<CursorUsage | undefined> {
  const response = await fetchFn(USAGE_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: "{}",
    signal: AbortSignal.timeout(requestTimeoutMs),
  });
  if (!response.ok) throw new Error(`cursor usage HTTP ${response.status}`);
  return parseCursorPeriodUsage(await response.json());
}

export interface CursorMeterSamplerOptions {
  /** pi agent directory whose auth.json holds this domain's credentials. */
  readonly agentDir: string;
  /** Ledger meter id for Cursor's monthly cycle (from operator config). */
  readonly meterId: string;
  /** Minimum spacing between readings for one account. */
  readonly intervalMs?: number;
  readonly requestTimeoutMs?: number;
  readonly fetch?: FetchLike;
}

const DEFAULT_INTERVAL_MS = 10 * 60_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;

export class CursorMeterSampler {
  private readonly agentDir: string;
  private readonly meterId: string;
  private readonly intervalMs: number;
  private readonly requestTimeoutMs: number;
  private readonly fetchFn: FetchLike;

  constructor(
    private readonly ledger: Ledger,
    options: CursorMeterSamplerOptions,
  ) {
    this.agentDir = options.agentDir;
    this.meterId = options.meterId;
    this.intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.fetchFn = options.fetch ?? fetch;
  }

  /** Access token for `accountId`, read without ever refreshing it. */
  private accessToken(accountId: string, now: number): { token: string } | { gap: CursorSampleOutcome } {
    let auth: Record<string, unknown>;
    try {
      auth = JSON.parse(readFileSync(join(this.agentDir, "auth.json"), "utf8")) as Record<string, unknown>;
    } catch {
      return { gap: "no-credential" };
    }
    const entry = auth[accountId];
    if (entry === null || typeof entry !== "object") return { gap: "no-credential" };
    const credential = entry as { access?: unknown; expires?: unknown };
    if (typeof credential.access !== "string" || credential.access.length === 0) {
      return { gap: "no-credential" };
    }
    if (typeof credential.expires === "number" && credential.expires <= now) {
      return { gap: "expired-credential" };
    }
    return { token: credential.access };
  }

  /**
   * Samples every Cursor account whose credential lives in this agent dir
   * and whose last reading is older than the sampling interval. Never
   * throws: a provider outage is a gap in evidence, not a controller fault.
   */
  async sample(now = Date.now()): Promise<CursorSampleReport[]> {
    const reports: CursorSampleReport[] = [];
    for (const account of this.ledger.accounts()) {
      if (account.provider !== CURSOR_PROVIDER) continue;
      if (account.accessUntil !== undefined && account.accessUntil <= now) continue;
      const last = this.ledger.latestReading(account.id, this.meterId);
      if (last && now - last.at < this.intervalMs) {
        reports.push({ accountId: account.id, outcome: "not-due" });
        continue;
      }
      const credential = this.accessToken(account.id, now);
      if ("gap" in credential) {
        reports.push({ accountId: account.id, outcome: credential.gap });
        continue;
      }
      let usage: CursorUsage | undefined;
      try {
        usage = await fetchCursorUsage(credential.token, this.fetchFn, this.requestTimeoutMs);
      } catch (thrown) {
        reports.push({ accountId: account.id, outcome: "request-failed", detail: String(thrown) });
        continue;
      }
      if (usage === undefined) {
        reports.push({ accountId: account.id, outcome: "unreadable-response" });
        continue;
      }
      const at = Date.now();
      if (last && at <= last.at) {
        reports.push({ accountId: account.id, outcome: "stale-reading" });
        continue;
      }
      this.ledger.recordReading(account.id, this.meterId, {
        at,
        usedPercent: Math.round(Math.max(0, Math.min(100, usage.usedPercent))),
        resetAt: usage.resetAt,
      });
      reports.push({ accountId: account.id, outcome: "recorded", usedPercent: usage.usedPercent });
    }
    return reports;
  }
}

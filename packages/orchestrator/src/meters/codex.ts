import { readFileSync } from "node:fs";
import { request as httpsRequest } from "node:https";
import type { Ledger } from "../ledger/ledger.js";
import { codexCredential } from "../auth/shared-codex.js";

/**
 * Codex meter sampling.
 *
 * Anthropic publishes its unified meters as headers on every response, so
 * the usage-logger extension records them for free. Codex publishes none:
 * pi's Codex transport is a WebSocket by default, so there is no HTTP
 * response to carry headers at all, and the SSE fallback is not where the
 * fleet lives. Codex accounts therefore had no meter source whatsoever —
 * every one of them sat permanently uncalibrated, which the broker correctly
 * reads as bootstrap and holds to exactly one concurrent session per
 * account. Seven Pro accounts running one agent each, at 8–23% of their
 * weekly plans, was the whole fleet's ceiling until this sampler existed.
 *
 * The source is the same account-usage endpoint the Codex client reads:
 * `GET /backend-api/codex/usage` returns the account's rate-limit windows
 * with an integer used-percent, the window length, and the reset instant.
 * Window length is what names the meter — the operator config declares
 * meters by window hours, and a window the config does not declare is
 * reported rather than guessed at, because a mis-named meter would calibrate
 * one plan's drain against another's allowance.
 *
 * Two constraints from docs/provider-meter-notes.md are load-bearing here,
 * exactly as they are for Cursor: history cannot be backfilled, so readings
 * are captured continuously rather than on demand; and a sampler must never
 * refresh OAuth — refresh tokens are single-use, and an independent refresh
 * would revoke the token family out from under every pi session on the
 * machine. An expired access token is a gap, recorded by not sampling.
 */

export const CODEX_PROVIDER = "openai-codex";
const USAGE_URL = "https://chatgpt.com/backend-api/codex/usage";
const USER_AGENT = "pi-orchestrator";

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

/**
 * The same request, issued with node's own HTTPS client instead of `fetch`.
 *
 * This endpoint is behind a bot filter that judges how a connection is
 * opened, not who is calling: the first request on a fresh undici connection
 * is answered 403 with perfectly good credentials (a second request on the
 * same warm socket then succeeds, which is what makes the failure look
 * intermittent and per-account when a poller walks a fleet). Node's own
 * client — the same TLS shape every other non-browser HTTP client on the box
 * presents — is answered 200 on a cold connection, every time. So the
 * transport is the fix, not a retry: a retry would double every poll and
 * still fail whenever the socket had gone idle. A default `User-Agent: node`
 * is refused the same way, which is why one is named above.
 */
function httpsFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  return new Promise((resolve, reject) => {
    const req = httpsRequest(
      String(input),
      {
        method: init?.method ?? "GET",
        headers: { ...(init?.headers as Record<string, string>), "Accept-Encoding": "identity" },
        signal: init?.signal ?? undefined,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("error", reject);
        res.on("end", () =>
          resolve(
            new Response(Buffer.concat(chunks), {
              // A status outside Response's legal range would throw here and
              // lose the real outcome; 502 says "upstream, unusable".
              status: res.statusCode !== undefined && res.statusCode >= 200 ? res.statusCode : 502,
            }),
          ),
        );
      },
    );
    req.on("error", reject);
    req.end(init?.body as string | undefined);
  });
}

export interface CodexWindowUsage {
  /** Percent of this window's allowance consumed, as Codex reports it. */
  readonly usedPercent: number;
  /** Length of the rolling window, which is what identifies the meter. */
  readonly windowSeconds: number;
  /** When this window rolls over. */
  readonly resetAt: number | undefined;
}

export type CodexSampleOutcome =
  | "recorded"
  | "not-due"
  | "no-credential"
  | "expired-credential"
  | "request-failed"
  | "unreadable-response"
  | "unmapped-window"
  | "stale-reading";

export interface CodexSampleReport {
  readonly accountId: string;
  readonly meterId?: string;
  readonly outcome: CodexSampleOutcome;
  readonly usedPercent?: number;
  readonly detail?: string;
}

/** A meter this deployment knows by the length of the window it measures. */
export interface CodexMeterSpec {
  readonly id: string;
  readonly windowHours: number;
}

function window(value: unknown, now: number): CodexWindowUsage | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const raw = value as Record<string, unknown>;
  const usedPercent = raw.used_percent;
  const windowSeconds = raw.limit_window_seconds;
  if (typeof usedPercent !== "number" || !Number.isFinite(usedPercent)) return undefined;
  if (typeof windowSeconds !== "number" || !Number.isFinite(windowSeconds) || windowSeconds <= 0) {
    return undefined;
  }
  // `reset_at` is epoch seconds; `reset_after_seconds` is the same instant
  // expressed relative to this response, and is the fallback when the
  // absolute form is missing.
  const resetAt = typeof raw.reset_at === "number" && Number.isFinite(raw.reset_at)
    ? raw.reset_at * 1000
    : typeof raw.reset_after_seconds === "number" && Number.isFinite(raw.reset_after_seconds)
      ? now + raw.reset_after_seconds * 1000
      : undefined;
  return { usedPercent, windowSeconds, resetAt };
}

/**
 * Reads the rate-limit windows out of a Codex usage response. An empty list
 * means the response carried no usable window — a gap in evidence, never a
 * zero reading. Model-scoped `additional_rate_limits` are deliberately not
 * read: they meter one model's allowance, not the account plan the broker
 * paces against.
 */
export function parseCodexUsage(value: unknown, now = Date.now()): CodexWindowUsage[] {
  if (value === null || typeof value !== "object") return [];
  const limit = (value as Record<string, unknown>).rate_limit;
  if (limit === null || typeof limit !== "object") return [];
  const raw = limit as Record<string, unknown>;
  return [window(raw.primary_window, now), window(raw.secondary_window, now)].filter(
    (w): w is CodexWindowUsage => w !== undefined,
  );
}

export async function fetchCodexUsage(
  accessToken: string,
  chatgptAccountId: string,
  fetchFn: FetchLike,
  requestTimeoutMs: number,
  now = Date.now(),
): Promise<CodexWindowUsage[]> {
  const response = await fetchFn(USAGE_URL, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "chatgpt-account-id": chatgptAccountId,
      Accept: "application/json",
      "User-Agent": USER_AGENT,
      originator: USER_AGENT,
    },
    signal: AbortSignal.timeout(requestTimeoutMs),
  });
  if (!response.ok) throw new Error(`codex usage HTTP ${response.status}`);
  return parseCodexUsage(await response.json(), now);
}

export interface CodexMeterSamplerOptions {
  /**
   * Credential stores to look in, in order: the shared Codex store beside
   * the ledger first, then the daemon user's own `auth.json` for accounts
   * whose custody was never moved.
   */
  readonly authPaths: readonly string[];
  /** Meters this deployment declares for Codex, from operator config. */
  readonly meters: readonly CodexMeterSpec[];
  /** Minimum spacing between readings for one account. */
  readonly intervalMs?: number;
  readonly requestTimeoutMs?: number;
  readonly fetch?: FetchLike;
}

const DEFAULT_INTERVAL_MS = 5 * 60_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
/** A declared meter claims a window whose length is within 10% of its own. */
const WINDOW_TOLERANCE = 0.1;

export class CodexMeterSampler {
  private readonly authPaths: readonly string[];
  private readonly meters: readonly CodexMeterSpec[];
  private readonly intervalMs: number;
  private readonly requestTimeoutMs: number;
  private readonly fetchFn: FetchLike;

  constructor(
    private readonly ledger: Ledger,
    options: CodexMeterSamplerOptions,
  ) {
    this.authPaths = options.authPaths;
    this.meters = options.meters;
    this.intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.fetchFn = options.fetch ?? httpsFetch;
  }

  /** The meter that measures this window, or undefined if none is declared. */
  private meterFor(windowSeconds: number): string | undefined {
    for (const meter of this.meters) {
      const declared = meter.windowHours * 3_600;
      if (Math.abs(windowSeconds - declared) <= declared * WINDOW_TOLERANCE) return meter.id;
    }
    return undefined;
  }

  /** Credential for `accountId`, read without ever refreshing it. */
  private credential(
    accountId: string,
    now: number,
  ): { token: string; chatgptAccountId: string } | { gap: CodexSampleOutcome } {
    let expired = false;
    for (const path of this.authPaths) {
      let auth: Record<string, unknown>;
      try {
        auth = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
      } catch {
        continue;
      }
      const credential = codexCredential(auth[accountId]);
      if (credential === undefined) continue;
      if (credential.expires <= now) {
        expired = true;
        continue;
      }
      return { token: credential.access, chatgptAccountId: credential.accountId };
    }
    return { gap: expired ? "expired-credential" : "no-credential" };
  }

  /**
   * Samples every Codex account with a readable credential whose last
   * reading is older than the sampling interval, and records one reading per
   * declared window. Never throws: a provider outage is a gap in evidence,
   * not a controller fault.
   */
  async sample(now = Date.now()): Promise<CodexSampleReport[]> {
    const reports: CodexSampleReport[] = [];
    for (const account of this.ledger.accounts()) {
      if (account.provider !== CODEX_PROVIDER) continue;
      if (account.accessUntil !== undefined && account.accessUntil <= now) continue;
      // Due-ness is judged on the freshest reading across this account's
      // meters: one request answers for every window at once, so a meter the
      // account does not report must not make the account due forever.
      const last = this.meters
        .map((meter) => this.ledger.latestReading(account.id, meter.id)?.at)
        .filter((at): at is number => at !== undefined)
        .reduce<number | undefined>((newest, at) => (newest === undefined || at > newest ? at : newest), undefined);
      if (last !== undefined && now - last < this.intervalMs) {
        reports.push({ accountId: account.id, outcome: "not-due" });
        continue;
      }
      const credential = this.credential(account.id, now);
      if ("gap" in credential) {
        reports.push({ accountId: account.id, outcome: credential.gap });
        continue;
      }
      let windows: CodexWindowUsage[];
      try {
        windows = await fetchCodexUsage(
          credential.token,
          credential.chatgptAccountId,
          this.fetchFn,
          this.requestTimeoutMs,
          now,
        );
      } catch (thrown) {
        reports.push({ accountId: account.id, outcome: "request-failed", detail: String(thrown) });
        continue;
      }
      if (windows.length === 0) {
        reports.push({ accountId: account.id, outcome: "unreadable-response" });
        continue;
      }
      for (const usage of windows) {
        const meterId = this.meterFor(usage.windowSeconds);
        if (meterId === undefined) {
          reports.push({
            accountId: account.id,
            outcome: "unmapped-window",
            detail: `no meter declared for a ${Math.round(usage.windowSeconds / 3_600)}h window`,
          });
          continue;
        }
        const previous = this.ledger.latestReading(account.id, meterId);
        const at = Date.now();
        if (previous && at <= previous.at) {
          reports.push({ accountId: account.id, meterId, outcome: "stale-reading" });
          continue;
        }
        this.ledger.recordReading(account.id, meterId, {
          at,
          usedPercent: Math.round(Math.max(0, Math.min(100, usage.usedPercent))),
          resetAt: usage.resetAt,
        });
        reports.push({
          accountId: account.id,
          meterId,
          outcome: "recorded",
          usedPercent: usage.usedPercent,
        });
      }
    }
    return reports;
  }
}

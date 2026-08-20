import {
  chmodSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

/**
 * GPT-Live call brokering on top of this machine's account custody: the
 * orchestrator ledger says which Codex accounts exist here and whether they
 * are cooling or past paid access; pi's auth.json owns the OAuth
 * credentials. The broker intersects the two, keeps calls spread across the
 * pool (accounts accept concurrent calls — see the operator's GPT-Live
 * concurrency memory — so there are no per-account leases), refreshes
 * tokens under the same directory lock convention pi itself uses, and
 * negotiates WebRTC SDP against the GPT-Live realtime endpoint.
 */

export const CODEX_PROVIDER = "openai-codex";
export const DEFAULT_LIVE_MODEL = "gpt-live-1-codex";
export const DEFAULT_LIVE_VOICE = "cove";
const DEFAULT_CALL_BASE_URL = "https://chatgpt.com/backend-api/codex";
const DEFAULT_USAGE_BASE_URL = "https://chatgpt.com/backend-api";
const TOKEN_URL = "https://auth.openai.com/oauth/token";
const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const LOCK_STALE_MS = 30_000;
const QUOTA_CACHE_MS = 60_000;
const TOKEN_MIN_LIFETIME_MS = 60_000;
const MAX_SDP_BYTES = 128 * 1024;

export type VoiceCredential = {
  type: "oauth";
  access: string;
  refresh: string;
  expires: number;
  accountId: string;
};

/** The slice of a ledger account row the broker needs. */
export interface VoiceAccount {
  readonly id: string;
  readonly provider: string;
  readonly accessUntil?: number | undefined;
  readonly cooldownUntil?: number | undefined;
}

export type VoiceAccountsSource = () => readonly VoiceAccount[];

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

type QuotaState = {
  checkedAt: number;
  exhausted: boolean;
  resetAt: number | null;
};

export type VoiceOfferResult =
  | { ok: true; status: number; sdp: string; account: string }
  | { ok: false; status: number; error: string };

export type VoiceBrokerStatus = {
  enabled: boolean;
  accountCount: number;
};

export interface VoiceNegotiateOptions {
  readonly model?: string;
  readonly voice?: string;
}

export interface VoiceBrokerOptions {
  /** pi agent directory holding auth.json (credential custody). */
  agentDir: string;
  /** Codex account rows from the orchestrator ledger. */
  accounts: VoiceAccountsSource;
  fetch?: FetchLike;
  now?: () => number;
  callBaseUrl?: string;
  usageBaseUrl?: string;
}

function record(value: unknown): Record<string, any> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, any>) : null;
}

function readJson(path: string): Record<string, any> {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return record(parsed) ?? {};
  } catch {
    return {};
  }
}

function credential(value: unknown): VoiceCredential | null {
  const raw = record(value);
  if (
    raw?.type !== "oauth" ||
    typeof raw.access !== "string" ||
    !raw.access ||
    typeof raw.refresh !== "string" ||
    !raw.refresh ||
    typeof raw.accountId !== "string" ||
    !raw.accountId ||
    typeof raw.expires !== "number" ||
    !Number.isFinite(raw.expires)
  ) {
    return null;
  }
  return raw as VoiceCredential;
}

function decodeJwtAccountId(access: string): string | null {
  try {
    const payload = JSON.parse(Buffer.from(access.split(".")[1] ?? "", "base64url").toString("utf8"));
    const value = payload?.["https://api.openai.com/auth"]?.chatgpt_account_id;
    return typeof value === "string" && value ? value : null;
  } catch {
    return null;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * pi stores credentials with proper-lockfile, whose lock is a `<path>.lock`
 * directory with mtime-based staleness. This lock speaks the same
 * convention so broker refreshes and pi's own refreshes exclude each other.
 */
async function acquireAuthLock(authPath: string, signal: AbortSignal): Promise<() => void> {
  const lockPath = `${authPath}.lock`;
  const deadline = Date.now() + LOCK_STALE_MS;
  while (true) {
    signal.throwIfAborted();
    try {
      mkdirSync(lockPath, { mode: 0o700 });
      const heartbeat = setInterval(() => {
        try {
          const time = new Date();
          utimesSync(lockPath, time, time);
        } catch {}
      }, 10_000);
      return () => {
        clearInterval(heartbeat);
        try {
          rmSync(lockPath, { recursive: true, force: true });
        } catch {}
      };
    } catch (cause: any) {
      if (cause?.code !== "EEXIST") throw cause;
      try {
        if (Date.now() - statSync(lockPath).mtimeMs > LOCK_STALE_MS) {
          rmSync(lockPath, { recursive: true, force: true });
          continue;
        }
      } catch {}
      if (Date.now() >= deadline) throw new Error("Timed out waiting for the pi OAuth credential lock");
      await sleep(25 + Math.floor(Math.random() * 75));
    }
  }
}

async function refreshCredential(
  authPath: string,
  alias: string,
  fetchFn: FetchLike,
  now: () => number,
): Promise<VoiceCredential> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);
  let release: (() => void) | undefined;
  try {
    release = await acquireAuthLock(authPath, controller.signal);
    const auth = readJson(authPath);
    const current = credential(auth[alias]);
    if (!current) throw new Error(`${alias} has no usable Codex OAuth credential`);
    if (current.expires > now() + TOKEN_MIN_LIFETIME_MS) return current;
    const response = await fetchFn(TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: current.refresh,
        client_id: CLIENT_ID,
      }),
      signal: controller.signal,
    });
    const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    if (!response.ok) throw new Error(`Codex OAuth refresh failed (${response.status})`);
    const access = typeof body.access_token === "string" ? body.access_token : "";
    const refresh = typeof body.refresh_token === "string" ? body.refresh_token : "";
    const expiresIn = typeof body.expires_in === "number" ? body.expires_in : Number.NaN;
    const accountId = decodeJwtAccountId(access);
    if (!access || !refresh || !Number.isFinite(expiresIn) || !accountId) {
      throw new Error("Codex OAuth refresh returned an invalid credential");
    }
    const next: VoiceCredential = { type: "oauth", access, refresh, expires: now() + expiresIn * 1000, accountId };
    auth[alias] = next;
    const temporary = join(dirname(authPath), `.auth.json.voice-${crypto.randomUUID()}`);
    writeFileSync(temporary, JSON.stringify(auth, null, 2), { encoding: "utf8", mode: 0o600 });
    chmodSync(temporary, 0o600);
    renameSync(temporary, authPath);
    return next;
  } finally {
    clearTimeout(timeout);
    release?.();
  }
}

function quotaWindow(value: unknown): { remaining: number; resetAt: number | null } | null {
  const raw = record(value);
  if (!raw || typeof raw.used_percent !== "number" || !Number.isFinite(raw.used_percent)) return null;
  return {
    remaining: Math.max(0, 100 - raw.used_percent),
    resetAt: typeof raw.reset_at === "number" && Number.isFinite(raw.reset_at) ? raw.reset_at * 1000 : null,
  };
}

function parseQuota(value: unknown, checkedAt: number): QuotaState {
  const raw = record(value);
  const rateLimit = record(raw?.rate_limit);
  const windows = [quotaWindow(rateLimit?.primary_window), quotaWindow(rateLimit?.secondary_window)].filter(
    (window): window is { remaining: number; resetAt: number | null } => window !== null,
  );
  const binding = windows.sort((left, right) => left.remaining - right.remaining)[0];
  return {
    checkedAt,
    exhausted: Boolean(binding && binding.remaining <= 0),
    resetAt: binding?.resetAt ?? null,
  };
}

export function boundedSdp(sdp: string): boolean {
  return sdp.startsWith("v=0") && Buffer.byteLength(sdp, "utf8") <= MAX_SDP_BYTES;
}

function numericSuffix(id: string): number {
  const match = /-(\d+)$/.exec(id);
  return match ? Number(match[1]) : 1;
}

export class VoiceBroker {
  readonly #agentDir: string;
  readonly #accounts: VoiceAccountsSource;
  readonly #fetch: FetchLike;
  readonly #now: () => number;
  readonly #callBaseUrl: string;
  readonly #usageBaseUrl: string;
  readonly #quota = new Map<string, QuotaState>();
  #cursor = 0;

  constructor(options: VoiceBrokerOptions) {
    this.#agentDir = options.agentDir;
    this.#accounts = options.accounts;
    this.#fetch = options.fetch ?? fetch;
    this.#now = options.now ?? Date.now;
    this.#callBaseUrl = (options.callBaseUrl ?? DEFAULT_CALL_BASE_URL).replace(/\/+$/, "");
    this.#usageBaseUrl = (options.usageBaseUrl ?? DEFAULT_USAGE_BASE_URL).replace(/\/+$/, "");
  }

  /**
   * Codex accounts registered in the ledger, alive (not past paid access,
   * not cooling), whose credentials live in this agent directory's
   * auth.json. Custody is the filter: ledger rows whose credential belongs
   * to another OS user are simply invisible here.
   */
  eligibleAccounts(): string[] {
    const now = this.#now();
    const auth = readJson(join(this.#agentDir, "auth.json"));
    return this.#accounts()
      .filter(
        (account) =>
          account.provider === CODEX_PROVIDER &&
          (account.accessUntil === undefined || account.accessUntil > now) &&
          (account.cooldownUntil === undefined || account.cooldownUntil <= now) &&
          credential(auth[account.id]) !== null,
      )
      .map((account) => account.id)
      .sort((left, right) => numericSuffix(left) - numericSuffix(right) || left.localeCompare(right));
  }

  status(): VoiceBrokerStatus {
    const accountCount = this.eligibleAccounts().length;
    return { enabled: accountCount > 0, accountCount };
  }

  async negotiate(sdp: string, instructions: string, options?: VoiceNegotiateOptions): Promise<VoiceOfferResult> {
    if (!boundedSdp(sdp)) return { ok: false, status: 400, error: "A valid bounded WebRTC SDP offer is required" };
    const authPath = join(this.#agentDir, "auth.json");
    const accounts = this.eligibleAccounts();
    if (!accounts.length) return { ok: false, status: 503, error: "No eligible Codex voice accounts are configured" };
    const start = this.#cursor % accounts.length;
    this.#cursor = (this.#cursor + 1) % accounts.length;
    const failures: string[] = [];
    let exhausted = 0;
    for (let offset = 0; offset < accounts.length; offset++) {
      const alias = accounts[(start + offset) % accounts.length]!;
      try {
        const current = await refreshCredential(authPath, alias, this.#fetch, this.#now);
        if (await this.#isExhausted(alias, current)) {
          exhausted++;
          continue;
        }
        const response = await this.#fetch(`${this.#callBaseUrl}/realtime/calls?intent=quicksilver&architecture=avas`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${current.access}`,
            "chatgpt-account-id": current.accountId,
            "content-type": "application/json",
            "openai-alpha": "quicksilver=v2",
            originator: "pi",
            "user-agent": "pi-orchestrator-voice",
            "x-session-id": crypto.randomUUID(),
          },
          body: JSON.stringify({
            sdp,
            session: {
              model: options?.model ?? DEFAULT_LIVE_MODEL,
              instructions,
              audio: { output: { voice: options?.voice ?? DEFAULT_LIVE_VOICE } },
              delegation: { type: "client", ack_filler: true },
            },
          }),
          signal: AbortSignal.timeout(30_000),
        });
        const answer = await response.text();
        if (response.status === 200 || response.status === 201) {
          this.#cursor = (this.#cursor + offset) % accounts.length;
          return { ok: true, status: response.status, sdp: answer, account: alias };
        }
        failures.push(`${alias}: HTTP ${response.status}`);
        if (response.status === 429 && /usage|quota|limit|exhaust/i.test(answer)) {
          this.#quota.set(alias, { checkedAt: this.#now(), exhausted: true, resetAt: null });
          exhausted++;
        }
      } catch (cause: any) {
        failures.push(`${alias}: ${String(cause?.message ?? cause)}`);
      }
    }
    return exhausted === accounts.length
      ? { ok: false, status: 429, error: "Every Codex voice account is quota exhausted" }
      : { ok: false, status: 503, error: `Could not start GPT-Live on any account (${failures.join("; ")})` };
  }

  async #isExhausted(alias: string, auth: VoiceCredential): Promise<boolean> {
    const cached = this.#quota.get(alias);
    const currentTime = this.#now();
    if (cached && currentTime - cached.checkedAt < QUOTA_CACHE_MS && (!cached.resetAt || cached.resetAt > currentTime)) {
      return cached.exhausted;
    }
    try {
      const response = await this.#fetch(`${this.#usageBaseUrl}/wham/usage`, {
        method: "GET",
        headers: {
          authorization: `Bearer ${auth.access}`,
          "chatgpt-account-id": auth.accountId,
          accept: "application/json",
          "user-agent": "pi-orchestrator-voice",
        },
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) return false;
      const state = parseQuota(await response.json(), currentTime);
      this.#quota.set(alias, state);
      return state.exhausted;
    } catch {
      return false;
    }
  }
}

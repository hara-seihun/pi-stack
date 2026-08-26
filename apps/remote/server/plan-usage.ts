import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Database } from "bun:sqlite";

const DEFAULT_OPENAI_USAGE_BASE_URL = "https://chatgpt.com/backend-api";
const DEFAULT_ANTHROPIC_BASE_URL = "https://api.anthropic.com";
const OPENAI_PROVIDER = "openai-codex";
const ANTHROPIC_PROVIDER = "anthropic";
const CURSOR_PROVIDER = "cursor";
/** A Cursor reading older than this is a broken sampler, not plan state. */
const DEFAULT_CURSOR_READING_MAX_AGE_MS = 60 * 60_000;
const LAST_GOOD_PLAN_TTL_MS = 15 * 60_000;
/** Beyond this an idle account and a stopped usage logger look identical. */
const DEFAULT_ANTHROPIC_READING_MAX_AGE_MS = 14 * 24 * 60 * 60_000;
/** Weekly capacity of an account whose plan tier could not be read: one Max
 * 5x unit, the smallest plan the fleet holds. */
const DEFAULT_WEEKLY_CAPACITY_WEIGHT = 1;

/**
 * Anthropic's meters as the orchestrator's usage logger records them from
 * `anthropic-ratelimit-unified-*` response headers.
 *
 * `7d_oi` is the scoped weekly bucket the usage endpoint reports as
 * `weekly_scoped` with display name "Fable". **Opus has no bucket of its
 * own on these plans** — `seven_day_opus` is null and opus-only accounts
 * never emit a `7d_oi` header — so opus traffic drains the session and
 * all-models weekly meters. A card labelled "Opus" would be the weekly
 * meter wearing a model's name.
 *
 * Because that header is model-scoped, response headers alone leave an
 * Opus account with no Fable meter whatsoever. The orchestrator's Anthropic
 * meter sampler polls the account usage endpoint for exactly that reason, so
 * a recorded `7d_oi` reading exists for every account rather than only for
 * the ones that happen to be running Fable.
 */
const ANTHROPIC_METERS = { session: "anthropic-5h", weekly: "anthropic-7d", fable: "anthropic-7d_oi" } as const;

type JsonRecord = Record<string, any>;
type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface ProviderPlanUsageSnapshot {
  state: "ready" | "partial" | "unavailable";
  percentLeft: number | null;
  expectedPercentLeft: number | null;
  paceDelta: number | null;
  planCount: number;
  checkedCount: number;
}

export interface AnthropicPlanUsageSnapshot extends ProviderPlanUsageSnapshot {
  fablePercentLeft: number | null;
  fableExpectedPercentLeft: number | null;
  fablePaceDelta: number | null;
  /** All-models weekly bucket. Opus draws on this one. */
  weeklyPercentLeft: number | null;
  weeklyExpectedPercentLeft: number | null;
  weeklyPaceDelta: number | null;
}

export interface CursorPlanUsageSnapshot extends ProviderPlanUsageSnapshot {
  percentUsed: number | null;
}

export interface PlanUsageSnapshot {
  openai: ProviderPlanUsageSnapshot;
  anthropic: AnthropicPlanUsageSnapshot;
  cursor: CursorPlanUsageSnapshot;
  updatedAt: string;
}

export interface PlanUsageOptions {
  agentDir: string;
  /** Shared Codex credential file; defaults to the local auth file. */
  openaiAuthPath?: string;
  /** pi-orchestrator ledger; the account registry for plan enumeration. */
  ledgerPath?: string;
  fetch?: FetchLike;
  baseUrl?: string;
  anthropicBaseUrl?: string;
  /** Staleness bound on the orchestrator's Cursor meter readings. */
  cursorReadingMaxAgeMs?: number;
  /** Staleness bound on recorded Anthropic meter readings. */
  anthropicReadingMaxAgeMs?: number;
  requestTimeoutMs?: number;
  now?: () => number;
}

function readJson(path: string): JsonRecord | null {
  try {
    const value = JSON.parse(readFileSync(path, "utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

function isProviderName(name: string, baseProvider: string): boolean {
  return name === baseProvider || new RegExp(`^${baseProvider.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}-\\d+$`).test(name);
}

/** Account registry custody is the pi-orchestrator ledger. A cancelled
 * subscription keeps reporting until its paid access ends; a missing or
 * unreadable ledger falls back to scanning auth.json aliases so plan cards
 * degrade to "every credentialed account" rather than to the base account. */
function ledgerAccountNames(ledgerPath: string | undefined, baseProvider: string, at: number): string[] | null {
  return withLedger(ledgerPath, (database) => {
    const rows = database.query("SELECT id, access_until FROM account WHERE provider = ?").all(baseProvider) as JsonRecord[];
    const names = rows
      .filter((row) => row.access_until === null || Number(row.access_until) > at)
      .map((row) => String(row.id));
    return names.length > 0 ? names : null;
  });
}

function withLedger<T>(ledgerPath: string | undefined, read: (database: Database) => T | null): T | null {
  if (!ledgerPath) return null;
  try {
    const database = new Database(ledgerPath, { readonly: true, strict: true });
    try {
      return read(database);
    } finally {
      database.close();
    }
  } catch {
    return null;
  }
}

function configuredPlanNames(ledgerPath: string | undefined, auth: JsonRecord, baseProvider: string, at: number): string[] {
  return ledgerAccountNames(ledgerPath, baseProvider, at)
    ?? Object.keys(auth).filter((name) => isProviderName(name, baseProvider));
}

function boundedRemaining(used: unknown): number | null {
  if (typeof used !== "number" || !Number.isFinite(used)) return null;
  return Math.max(0, Math.min(100, 100 - used));
}

const WEEK_MS = 7 * 24 * 60 * 60_000;

interface ProviderAccountUsage {
  percentLeft: number;
  expectedPercentLeft: number | null;
}

function resetTime(raw: JsonRecord | null | undefined, checkedAt: number): number | null {
  const epochMilliseconds = typeof raw?.resetsAt === "number" ? raw.resetsAt : Number.NaN;
  if (Number.isFinite(epochMilliseconds)) return epochMilliseconds;
  const epochSeconds = typeof raw?.reset_at === "number" ? raw.reset_at : Number.NaN;
  if (Number.isFinite(epochSeconds)) return epochSeconds * 1000;
  const parsed = typeof raw?.resets_at === "string" ? Date.parse(raw.resets_at) : Number.NaN;
  if (Number.isFinite(parsed)) return parsed;
  const afterSeconds = typeof raw?.reset_after_seconds === "number" ? raw.reset_after_seconds : Number.NaN;
  return Number.isFinite(afterSeconds) ? checkedAt + afterSeconds * 1000 : null;
}

function expectedRemainingPercent(raw: JsonRecord | null | undefined, checkedAt: number): number | null {
  const resetsAt = resetTime(raw, checkedAt);
  if (resetsAt === null) return null;
  return Math.max(0, Math.min(100, (resetsAt - checkedAt) * 100 / WEEK_MS));
}

function openAiRemainingPercent(data: unknown, checkedAt: number): ProviderAccountUsage | null {
  const raw = data && typeof data === "object" ? data as JsonRecord : null;
  const rateLimit = raw?.rate_limit && typeof raw.rate_limit === "object" ? raw.rate_limit as JsonRecord : null;
  const remaining = [rateLimit?.primary_window, rateLimit?.secondary_window]
    .map((window) => ({ percentLeft: boundedRemaining(window?.used_percent), window }))
    .filter((value): value is { percentLeft: number; window: JsonRecord } => value.percentLeft !== null)
    .sort((left, right) => left.percentLeft - right.percentLeft);
  const binding = remaining[0];
  return binding ? {
    percentLeft: binding.percentLeft,
    expectedPercentLeft: expectedRemainingPercent(binding.window, checkedAt),
  } : null;
}

/** One rolling bucket of one account, from whichever source observed it. */
interface BucketUsage {
  percentLeft: number;
  expectedPercentLeft: number | null;
}

type AnthropicBuckets = Record<keyof typeof ANTHROPIC_METERS, BucketUsage | null>;

const NO_BUCKETS: AnthropicBuckets = { session: null, weekly: null, fable: null };

interface AnthropicAccountUsage {
  percentLeft: number;
  fablePercentLeft: number | null;
  fableExpectedPercentLeft: number | null;
  weeklyPercentLeft: number | null;
  weeklyExpectedPercentLeft: number | null;
  weeklyCapacityWeight: number;
}

function apiBucket(limit: JsonRecord | null | undefined, checkedAt: number): BucketUsage | null {
  const percentLeft = boundedRemaining(limit?.percent ?? limit?.utilization);
  return percentLeft === null ? null : { percentLeft, expectedPercentLeft: expectedRemainingPercent(limit, checkedAt) };
}

function anthropicRemainingPercent(data: unknown, checkedAt: number): AnthropicBuckets | null {
  const raw = data && typeof data === "object" ? data as JsonRecord : null;
  if (!raw) return null;
  const limits = Array.isArray(raw.limits) ? raw.limits : [];
  const limit = (kind: string) => limits.find((candidate) => candidate?.kind === kind);
  // One scoped weekly bucket needs no name to be identified; several do.
  // `seven_day_opus` is deliberately not a fallback: it is null on these
  // plans and is not this bucket, so reading it would put Opus figures under
  // the Fable label the day Anthropic starts populating it.
  const scoped = limits.filter((candidate) => candidate?.kind === "weekly_scoped");
  const buckets: AnthropicBuckets = {
    session: apiBucket(limit("session") ?? raw.five_hour, checkedAt),
    weekly: apiBucket(limit("weekly_all") ?? raw.seven_day, checkedAt),
    fable: apiBucket(scoped.length === 1
      ? scoped[0]
      : scoped.find((candidate) => String(candidate?.scope?.model?.display_name ?? "").toLowerCase() === "fable"),
      checkedAt),
  };
  return buckets.session === null && buckets.weekly === null && buckets.fable === null ? null : buckets;
}

/**
 * Recorded meters for accounts whose credential this user cannot read — a
 * shared or fleet-credentialed account keeps its OAuth token in the fleet
 * user's store — and for accounts whose stored access token has expired.
 * Pi Remote never refreshes another runtime's rotating token, so without
 * this fallback those plans silently leave the average and the card reports
 * the healthiest account as if it were the fleet.
 *
 * Anthropic stamps every meter on every response, so an unchanged reading
 * means an idle account rather than a stopped sampler, and it stays true
 * until the window rolls over; a window that rolled over since the last
 * observation is empty.
 */
function recordedBucket(row: JsonRecord | undefined, checkedAt: number, maxAgeMs: number): BucketUsage | null {
  const at = Number(row?.at);
  const percentLeft = boundedRemaining(Number(row?.used_percent));
  if (percentLeft === null || !Number.isFinite(at) || at > checkedAt + 60_000 || checkedAt - at > maxAgeMs) return null;
  const resetsAt = Number(row?.reset_at);
  if (Number.isFinite(resetsAt) && checkedAt >= resetsAt) return { percentLeft: 100, expectedPercentLeft: null };
  return { percentLeft, expectedPercentLeft: Number.isFinite(resetsAt) ? expectedRemainingPercent({ resetsAt }, checkedAt) : null };
}

function anthropicRecordedBuckets(
  ledgerPath: string | undefined, names: string[], checkedAt: number, maxAgeMs: number,
): Map<string, AnthropicBuckets> {
  return withLedger(ledgerPath, (database) => {
    const query = database.query(`SELECT meter_id, at, used_percent, reset_at FROM meter_reading
      WHERE account_id = ? AND meter_id IN (?, ?, ?) GROUP BY meter_id HAVING at = max(at)`);
    return new Map(names.map((name) => {
      const rows = query.all(name, ANTHROPIC_METERS.session, ANTHROPIC_METERS.weekly, ANTHROPIC_METERS.fable) as JsonRecord[];
      const row = (meterId: string) => rows.find((candidate) => candidate.meter_id === meterId);
      return [name, {
        session: recordedBucket(row(ANTHROPIC_METERS.session), checkedAt, maxAgeMs),
        weekly: recordedBucket(row(ANTHROPIC_METERS.weekly), checkedAt, maxAgeMs),
        fable: recordedBucket(row(ANTHROPIC_METERS.fable), checkedAt, maxAgeMs),
      }] as [string, AnthropicBuckets];
    }));
  }) ?? new Map<string, AnthropicBuckets>();
}

/** A live reading outranks a recorded one; a recorded one outranks nothing. */
function mergeAnthropicBuckets(live: AnthropicBuckets | null, recorded: AnthropicBuckets): AnthropicBuckets {
  return {
    session: live?.session ?? recorded.session,
    weekly: live?.weekly ?? recorded.weekly,
    fable: live?.fable ?? recorded.fable,
  };
}

function anthropicAccountUsage(buckets: AnthropicBuckets, weeklyCapacityWeight: number): AnthropicAccountUsage | null {
  const known = [buckets.session, buckets.weekly, buckets.fable].filter((bucket): bucket is BucketUsage => bucket !== null);
  if (known.length === 0) return null;
  return {
    percentLeft: Math.min(...known.map((bucket) => bucket.percentLeft)),
    fablePercentLeft: buckets.fable?.percentLeft ?? null,
    fableExpectedPercentLeft: buckets.fable?.expectedPercentLeft ?? null,
    weeklyPercentLeft: buckets.weekly?.percentLeft ?? null,
    weeklyExpectedPercentLeft: buckets.weekly?.expectedPercentLeft ?? null,
    weeklyCapacityWeight,
  };
}

async function checkPlan<T>(
  providerName: string,
  auth: JsonRecord,
  fetchFn: FetchLike,
  endpoint: string,
  requestTimeoutMs: number,
  parseUsage: (data: unknown) => T | null,
  extraHeaders: Record<string, string> = {},
): Promise<T | null> {
  const credential = auth[providerName];
  if (credential?.type !== "oauth" || typeof credential.access !== "string" || credential.access.length === 0) return null;
  const headers = new Headers({
    Authorization: `Bearer ${credential.access}`,
    Accept: "application/json",
    "User-Agent": "pi-remote",
    ...extraHeaders,
  });
  if (typeof credential.accountId === "string" && credential.accountId.length > 0) {
    headers.set("chatgpt-account-id", credential.accountId);
  }
  try {
    const response = await fetchFn(endpoint, {
      method: "GET",
      headers,
      signal: AbortSignal.timeout(requestTimeoutMs),
    });
    if (!response.ok) return null;
    return parseUsage(await response.json());
  } catch {
    return null;
  }
}

const lastGoodPlans = new Map<string, { at: number; value: unknown }>();

async function checkPlanCached<T>(
  providerName: string,
  auth: JsonRecord,
  fetchFn: FetchLike,
  endpoint: string,
  requestTimeoutMs: number,
  parseUsage: (data: unknown) => T | null,
  checkedAt: number,
  extraHeaders: Record<string, string> = {},
): Promise<T | null> {
  const credential = auth[providerName];
  const access = credential?.type === "oauth" && typeof credential.access === "string"
    ? credential.access
    : null;
  const key = access === null ? null : `${endpoint}\u0000${providerName}\u0000${access}`;
  const current = await checkPlan(providerName, auth, fetchFn, endpoint, requestTimeoutMs, parseUsage, extraHeaders);
  if (current !== null) {
    if (key !== null) lastGoodPlans.set(key, { at: checkedAt, value: current });
    return current;
  }
  const cached = key === null ? undefined : lastGoodPlans.get(key);
  return cached !== undefined && checkedAt >= cached.at && checkedAt - cached.at <= LAST_GOOD_PLAN_TTL_MS
    ? cached.value as T
    : null;
}

function mean(values: number[]): number | null {
  return values.length > 0 ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

function summarize(values: Array<ProviderAccountUsage | null>, planCount: number): ProviderPlanUsageSnapshot {
  const available = values.filter((value): value is ProviderAccountUsage => value !== null);
  const timed = available.filter((value) => value.expectedPercentLeft !== null);
  const percentLeft = mean(available.map((value) => value.percentLeft));
  const expectedPercentLeft = mean(timed.map((value) => value.expectedPercentLeft!));
  return {
    state: available.length === planCount && planCount > 0 ? "ready" : available.length > 0 ? "partial" : "unavailable",
    percentLeft: percentLeft === null ? null : Math.round(percentLeft),
    expectedPercentLeft: expectedPercentLeft === null ? null : Math.round(expectedPercentLeft),
    paceDelta: percentLeft === null || expectedPercentLeft === null ? null : Math.round(percentLeft - expectedPercentLeft),
    planCount,
    checkedCount: available.length,
  };
}

function weightedMean(values: AnthropicAccountUsage[], field: keyof AnthropicAccountUsage): number | null {
  const available = values.filter((value) => typeof value[field] === "number" && Number.isFinite(value[field]));
  const totalWeight = available.reduce((sum, value) => sum + value.weeklyCapacityWeight, 0);
  if (totalWeight <= 0) return null;
  return available.reduce((sum, value) => sum + Number(value[field]) * value.weeklyCapacityWeight, 0) / totalWeight;
}

function pace(values: AnthropicAccountUsage[], actualField: keyof AnthropicAccountUsage, expectedField: keyof AnthropicAccountUsage): number | null {
  const timed = values.filter((value) => typeof value[expectedField] === "number" && Number.isFinite(value[expectedField]));
  const actual = weightedMean(timed, actualField);
  const expected = weightedMean(timed, expectedField);
  return actual === null || expected === null ? null : Math.round(actual - expected);
}

function rounded(value: number | null): number | null {
  return value === null ? null : Math.round(value);
}

/** Cursor bills on a monthly cycle, so the window that ends at `resetAt`
 * began at the same clock time one calendar month earlier; a shorter month
 * clamps to its last day rather than overflowing forward. */
function monthlyCycleStart(resetAt: number): number {
  const end = new Date(resetAt);
  const start = new Date(resetAt);
  start.setMonth(start.getMonth() - 1);
  if (start.getDate() !== end.getDate()) start.setDate(0);
  return start.getTime();
}

/**
 * Cursor's stream carries no rate-limit headers, so unlike Codex and
 * Anthropic its meter is not observed per response: the orchestrator daemon
 * polls it (it holds the credential, which lives in the fleet user's
 * auth.json) and records ordinary meter readings. The ledger is therefore
 * both the account registry and the usage source here, and a stale reading
 * means the sampler is broken — report it as unavailable rather than
 * showing plan state that is no longer true.
 */
function summarizeCursor(ledgerPath: string | undefined, maxAgeMs: number, checkedAt: number): CursorPlanUsageSnapshot {
  const names = ledgerAccountNames(ledgerPath, CURSOR_PROVIDER, checkedAt) ?? [];
  const readings = withLedger(ledgerPath, (database) => names.map((name) => database
    .query("SELECT at, used_percent, reset_at FROM meter_reading WHERE account_id = ? ORDER BY at DESC LIMIT 1")
    .get(name) as JsonRecord | null)) ?? [];
  const fresh = readings.filter((reading): reading is JsonRecord => {
    const at = Number(reading?.at);
    return Number.isFinite(at) && at <= checkedAt + 60_000 && checkedAt - at <= maxAgeMs &&
      Number.isFinite(Number(reading?.used_percent));
  });
  const percentUsed = mean(fresh.map((reading) => Math.max(0, Math.min(100, Number(reading.used_percent)))));
  const expected = mean(fresh
    .map((reading) => Number(reading.reset_at))
    .filter((resetAt) => Number.isFinite(resetAt) && resetAt > checkedAt)
    .map((resetAt) => Math.max(0, Math.min(100, (resetAt - checkedAt) * 100 / (resetAt - monthlyCycleStart(resetAt))))));
  const percentLeft = percentUsed === null ? null : Math.round((100 - percentUsed) * 10) / 10;
  const expectedPercentLeft = expected === null ? null : Math.round(expected * 10) / 10;
  return {
    state: fresh.length === names.length && names.length > 0 ? "ready" : fresh.length > 0 ? "partial" : "unavailable",
    percentLeft,
    percentUsed: percentUsed === null ? null : Math.round(percentUsed * 10) / 10,
    expectedPercentLeft,
    paceDelta: percentLeft === null || expectedPercentLeft === null
      ? null
      : Math.round((percentLeft - expectedPercentLeft) * 10) / 10,
    planCount: names.length,
    checkedCount: fresh.length,
  };
}

/**
 * Coverage is judged on the *worst-covered metric that still shows a
 * number*, not on how many accounts reported something.
 *
 * The scoped weekly meter is the reason. An account can report its weekly
 * meter and no Fable meter at all — response headers carry the Fable bucket
 * only for traffic scoped to that model — and a Fable percentage averaged
 * over the accounts that do have one silently drops the others, reporting
 * the healthy accounts as the fleet and always in the optimistic direction.
 * A metric with no value at all is not silent: it renders as "—", so it
 * lowers no coverage.
 */
function summarizeAnthropic(values: Array<AnthropicAccountUsage | null>, planCount: number): AnthropicPlanUsageSnapshot {
  const available = values.filter((value): value is AnthropicAccountUsage => value !== null && value.weeklyCapacityWeight > 0);
  const covering = [
    available.filter((value) => value.fablePercentLeft !== null).length,
    available.filter((value) => value.weeklyPercentLeft !== null).length,
  ].filter((count) => count > 0);
  const checkedCount = covering.length > 0 ? Math.min(...covering) : 0;
  return {
    state: checkedCount === planCount && planCount > 0 ? "ready" : available.length > 0 ? "partial" : "unavailable",
    percentLeft: rounded(weightedMean(available, "percentLeft")),
    expectedPercentLeft: null,
    paceDelta: null,
    fablePercentLeft: rounded(weightedMean(available, "fablePercentLeft")),
    fableExpectedPercentLeft: rounded(weightedMean(available, "fableExpectedPercentLeft")),
    fablePaceDelta: pace(available, "fablePercentLeft", "fableExpectedPercentLeft"),
    weeklyPercentLeft: rounded(weightedMean(available, "weeklyPercentLeft")),
    weeklyExpectedPercentLeft: rounded(weightedMean(available, "weeklyExpectedPercentLeft")),
    weeklyPaceDelta: pace(available, "weeklyPercentLeft", "weeklyExpectedPercentLeft"),
    planCount,
    checkedCount,
  };
}

function anthropicWeeklyCapacityWeight(data: unknown): number | null {
  const raw = data && typeof data === "object" ? data as JsonRecord : null;
  const tier = String(raw?.organization?.rate_limit_tier ?? "").trim().toLowerCase();
  if (tier === "default_claude_max_20x") return 2;
  if (tier === "default_claude_max_5x") return 1;
  return null;
}

async function loadAnthropicUsage(
  names: string[], auth: JsonRecord, fetchFn: FetchLike, baseUrl: string, requestTimeoutMs: number, checkedAt: number,
  ledgerPath: string | undefined, readingMaxAgeMs: number,
): Promise<Array<AnthropicAccountUsage | null>> {
  const recorded = anthropicRecordedBuckets(ledgerPath, names, checkedAt, readingMaxAgeMs);
  const values: Array<AnthropicAccountUsage | null> = [];
  const headers = {
    "anthropic-version": "2023-06-01",
    "anthropic-beta": "oauth-2025-04-20",
    "User-Agent": "claude-code/2.1.80",
  };
  for (const name of names) {
    const [live, tierWeight] = await Promise.all([
      checkPlanCached(name, auth, fetchFn, `${baseUrl}/api/oauth/usage`, requestTimeoutMs, (data) => anthropicRemainingPercent(data, checkedAt), checkedAt, headers),
      checkPlanCached(name, auth, fetchFn, `${baseUrl}/api/oauth/profile`, requestTimeoutMs, anthropicWeeklyCapacityWeight, checkedAt, headers),
    ]);
    const buckets = mergeAnthropicBuckets(live, recorded.get(name) ?? NO_BUCKETS);
    values.push(anthropicAccountUsage(buckets, tierWeight ?? DEFAULT_WEEKLY_CAPACITY_WEIGHT));
  }
  return values;
}

export async function loadPlanUsage(options: PlanUsageOptions): Promise<PlanUsageSnapshot> {
  const checkedAt = (options.now ?? Date.now)();
  const auth = readJson(join(options.agentDir, "auth.json")) ?? {};
  const openaiAuth = readJson(options.openaiAuthPath ?? join(options.agentDir, "auth.json")) ?? {};
  const openaiNames = configuredPlanNames(options.ledgerPath, openaiAuth, OPENAI_PROVIDER, checkedAt);
  const anthropicNames = configuredPlanNames(options.ledgerPath, auth, ANTHROPIC_PROVIDER, checkedAt);
  const openaiBaseUrl = (options.baseUrl ?? process.env.CHATGPT_BASE_URL ?? DEFAULT_OPENAI_USAGE_BASE_URL).replace(/\/+$/, "");
  const anthropicBaseUrl = (options.anthropicBaseUrl ?? process.env.ANTHROPIC_BASE_URL ?? DEFAULT_ANTHROPIC_BASE_URL).replace(/\/+$/, "");
  const fetchFn = options.fetch ?? fetch;
  const requestTimeoutMs = options.requestTimeoutMs ?? 10_000;
  const [openaiValues, anthropicValues] = await Promise.all([
    Promise.all(openaiNames.map((name) => checkPlanCached(
      name, openaiAuth, fetchFn, `${openaiBaseUrl}/wham/usage`, requestTimeoutMs,
      (data) => openAiRemainingPercent(data, checkedAt), checkedAt,
    ))),
    loadAnthropicUsage(
      anthropicNames, auth, fetchFn, anthropicBaseUrl, requestTimeoutMs, checkedAt,
      options.ledgerPath, options.anthropicReadingMaxAgeMs ?? DEFAULT_ANTHROPIC_READING_MAX_AGE_MS,
    ),
  ]);
  return {
    openai: summarize(openaiValues, openaiNames.length),
    anthropic: summarizeAnthropic(anthropicValues, anthropicNames.length),
    cursor: summarizeCursor(options.ledgerPath, options.cursorReadingMaxAgeMs ?? DEFAULT_CURSOR_READING_MAX_AGE_MS, checkedAt),
    updatedAt: new Date(checkedAt).toISOString(),
  };
}

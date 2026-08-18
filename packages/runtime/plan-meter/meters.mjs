import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";

export const SCHEMA_VERSION = 1;
export const DEFAULT_DB_PATH = process.env.PLAN_METER_DB
  ?? path.join(process.env.PLAN_METER_DATA ?? path.join(os.homedir(), "data/plan-meter"), "meters.sqlite3");

export const CODEX_USAGE_ENDPOINT = `${(process.env.CHATGPT_BASE_URL ?? "https://chatgpt.com/backend-api").replace(/\/$/, "")}/wham/usage`;
export const ANTHROPIC_USAGE_ENDPOINT = "https://api.anthropic.com/api/oauth/usage";
export const ANTHROPIC_PROFILE_ENDPOINT = "https://api.anthropic.com/api/oauth/profile";

/**
 * The sampler is deliberately read-only over Pi's credential file. Refresh
 * tokens are single-use and the orchestrator owns that path; an independent
 * refresh here would revoke the token family and take accounts offline. An
 * expired access token is therefore recorded as an observation gap.
 */
export function openDatabase(file = DEFAULT_DB_PATH, { readOnly = false } = {}) {
  if (!readOnly) fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(file, { readOnly });
  if (readOnly) return db;
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec(`
    CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS sample(
      sample_id INTEGER PRIMARY KEY AUTOINCREMENT,
      host TEXT NOT NULL,
      at INTEGER NOT NULL,
      provider TEXT NOT NULL,
      family TEXT NOT NULL,
      status TEXT NOT NULL,
      detail TEXT,
      plan TEXT,
      tier TEXT,
      account_key TEXT
    );
    CREATE INDEX IF NOT EXISTS sample_lookup ON sample(provider, at);
    CREATE INDEX IF NOT EXISTS sample_at ON sample(at);
    CREATE TABLE IF NOT EXISTS bucket(
      sample_id INTEGER NOT NULL REFERENCES sample(sample_id) ON DELETE CASCADE,
      bucket TEXT NOT NULL,
      used_percent REAL,
      resets_at INTEGER,
      window_seconds INTEGER,
      used_units REAL,
      limit_units REAL,
      PRIMARY KEY(sample_id, bucket)
    );
  `);
  db.prepare("INSERT INTO meta(key,value) VALUES('schema_version',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
    .run(String(SCHEMA_VERSION));
  return db;
}

export function readAuth(authPath) {
  const file = authPath ?? path.join(os.homedir(), ".pi/agent/auth.json");
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

export function oauthAccounts(auth, prefix) {
  return Object.entries(auth)
    .filter(([name, value]) =>
      (name === prefix || name.startsWith(`${prefix}-`)) && value?.type === "oauth" && value?.access)
    .sort(([left], [right]) => left.localeCompare(right, "en"));
}

/** Classify a failure without ever persisting a raw message that may embed a token. */
export function classify(error) {
  const text = String(error?.message ?? error ?? "");
  if (/abort|timeout|timed out/i.test(text)) return "timeout";
  if (/ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|network|socket/i.test(text)) return "network";
  const status = text.match(/\bHTTP (\d{3})\b/);
  if (status) return `http_${status[1]}`;
  return "error";
}

/** Canonical bucket name from a Codex rate-limit window duration. */
export function codexBucketName(windowSeconds) {
  const seconds = Number(windowSeconds);
  if (!Number.isFinite(seconds) || seconds <= 0) return "window_unknown";
  if (seconds <= 6 * 3600) return "session";
  if (seconds >= 6 * 86400 && seconds <= 8 * 86400) return "weekly";
  if (seconds >= 27 * 86400) return "monthly";
  return `window_${Math.round(seconds)}`;
}

function numberOrNull(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function epochMs(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") return Number.isFinite(value) ? Math.round(value * 1000) : null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Normalize a Codex /wham/usage body into plan metadata plus flat buckets. */
export function parseCodex(body) {
  const rate = body?.rate_limit ?? {};
  const buckets = [];
  for (const window of [rate.primary_window, rate.secondary_window]) {
    const used = numberOrNull(window?.used_percent);
    if (used === null) continue;
    buckets.push({
      bucket: codexBucketName(window.limit_window_seconds),
      usedPercent: used,
      resetsAt: epochMs(window.reset_at),
      windowSeconds: numberOrNull(window.limit_window_seconds),
      usedUnits: null,
      limitUnits: null,
    });
  }
  const review = body?.code_review_rate_limit;
  const reviewUsed = numberOrNull(review?.used_percent);
  if (reviewUsed !== null) {
    buckets.push({
      bucket: "code_review",
      usedPercent: reviewUsed,
      resetsAt: epochMs(review.reset_at),
      windowSeconds: numberOrNull(review.limit_window_seconds),
      usedUnits: null,
      limitUnits: null,
    });
  }
  const credits = body?.credits;
  const balance = numberOrNull(credits?.balance ?? credits?.remaining ?? credits?.available);
  if (balance !== null) {
    buckets.push({
      bucket: "credits",
      usedPercent: null,
      resetsAt: null,
      windowSeconds: null,
      usedUnits: balance,
      limitUnits: numberOrNull(credits?.granted ?? credits?.total),
    });
  }
  return {
    plan: typeof body?.plan_type === "string" ? body.plan_type.trim().toLowerCase() : null,
    accountKey: typeof body?.account_id === "string" ? body.account_id : null,
    tier: null,
    buckets,
  };
}

/**
 * Normalize an Anthropic /api/oauth/usage body. Every advertised bucket is
 * captured, not only the three the orchestrator needs for admission, because
 * any single bucket reaching 100% is what actually produces a 429.
 */
export function parseAnthropic(body, profile = null) {
  const buckets = [];
  const seen = new Set();
  const push = (name, percentValue, resetsAt, extra = {}) => {
    const used = numberOrNull(percentValue);
    if (used === null || seen.has(name)) return;
    seen.add(name);
    buckets.push({
      bucket: name,
      usedPercent: used,
      resetsAt: epochMs(resetsAt),
      windowSeconds: extra.windowSeconds ?? null,
      usedUnits: extra.usedUnits ?? null,
      limitUnits: extra.limitUnits ?? null,
    });
  };

  for (const limit of Array.isArray(body?.limits) ? body.limits : []) {
    const scope = String(limit?.scope?.model?.display_name ?? "").trim();
    const kind = String(limit?.kind ?? "").trim();
    if (!kind) continue;
    const name = kind === "session" ? "session"
      : kind === "weekly_all" ? "weekly"
      : kind === "weekly_scoped" ? `weekly_${(scope || "scoped").toLowerCase()}`
      : kind;
    push(name, limit?.percent, limit?.resets_at, { windowSeconds: kind === "session" ? 5 * 3600 : 7 * 86400 });
  }

  // Legacy flat fields remain authoritative for accounts not yet migrated to limits[].
  push("session", body?.five_hour?.utilization, body?.five_hour?.resets_at, { windowSeconds: 5 * 3600 });
  push("weekly", body?.seven_day?.utilization, body?.seven_day?.resets_at, { windowSeconds: 7 * 86400 });
  for (const [key, value] of Object.entries(body ?? {})) {
    if (!key.startsWith("seven_day_") || !value || typeof value !== "object") continue;
    push(`weekly_${key.slice("seven_day_".length)}`, value.utilization, value.resets_at, { windowSeconds: 7 * 86400 });
  }

  const extra = body?.extra_usage;
  if (extra && typeof extra === "object" && extra.is_enabled === true) {
    push("overage", extra.utilization, null, {
      usedUnits: numberOrNull(extra.used_credits),
      limitUnits: numberOrNull(extra.monthly_limit),
    });
  }

  if (!buckets.length) return null;
  const tier = String(profile?.organization?.rate_limit_tier ?? "").trim().toLowerCase() || null;
  return {
    plan: tier ? tier.replace(/^default_claude_/, "") : null,
    accountKey: typeof profile?.organization?.uuid === "string" ? profile.organization.uuid : null,
    tier,
    buckets,
  };
}

/**
 * Accumulate burn as the sum of positive deltas between consecutive samples.
 * A decrease means the provider reset the window, so a naive end-minus-start
 * would silently under-report any period that spans a reset.
 */
export function burn(series) {
  const ordered = [...series].sort((left, right) => left.at - right.at);
  let accumulated = 0;
  let resets = 0;
  for (let index = 1; index < ordered.length; index += 1) {
    const delta = ordered[index].used - ordered[index - 1].used;
    if (delta >= 0) accumulated += delta;
    else { accumulated += ordered[index].used; resets += 1; }
  }
  return {
    start: ordered.at(0)?.used ?? null,
    end: ordered.at(-1)?.used ?? null,
    burned: accumulated,
    resets,
    samples: ordered.length,
    resetsAt: ordered.at(-1)?.resetsAt ?? null,
    windowSeconds: ordered.at(-1)?.windowSeconds ?? null,
  };
}

/** The bucket that governs a plan over a window: the one that burned most. */
export function bindingBucket(byBucket) {
  let best = null;
  for (const [bucket, stats] of Object.entries(byBucket)) {
    if (bucket === "credits" || bucket === "overage") continue;
    if (!best || stats.burned > byBucket[best].burned) best = bucket;
  }
  return best;
}

export function recordSample(db, { host, at, provider, family, status, detail = null, plan = null, tier = null, accountKey = null, buckets = [] }) {
  const info = db.prepare(`
    INSERT INTO sample(host,at,provider,family,status,detail,plan,tier,account_key)
    VALUES(?,?,?,?,?,?,?,?,?)`).run(host, at, provider, family, status, detail, plan, tier, accountKey);
  const sampleId = Number(info.lastInsertRowid);
  const insert = db.prepare(`
    INSERT INTO bucket(sample_id,bucket,used_percent,resets_at,window_seconds,used_units,limit_units)
    VALUES(?,?,?,?,?,?,?) ON CONFLICT DO NOTHING`);
  for (const bucket of buckets) {
    insert.run(sampleId, bucket.bucket, bucket.usedPercent ?? null, bucket.resetsAt ?? null,
      bucket.windowSeconds ?? null, bucket.usedUnits ?? null, bucket.limitUnits ?? null);
  }
  return sampleId;
}

export async function sampleCodexAccount(provider, credential, { fetcher = fetch, at = Date.now() } = {}) {
  if (Number(credential?.expires) <= at) return { status: "expired", detail: "access token expired" };
  const response = await fetcher(CODEX_USAGE_ENDPOINT, {
    signal: AbortSignal.timeout(20000),
    headers: {
      Authorization: `Bearer ${credential.access}`,
      "chatgpt-account-id": credential.accountId ?? "",
      Accept: "application/json",
      "User-Agent": "works.kenan.plan-meter",
    },
  });
  if (!response.ok) return { status: "error", detail: `http_${response.status}` };
  const parsed = parseCodex(await response.json());
  if (!parsed.buckets.length) return { status: "error", detail: "no_buckets" };
  return { status: "ok", ...parsed };
}

export async function sampleAnthropicAccount(provider, credential, { fetcher = fetch, at = Date.now() } = {}) {
  if (Number(credential?.expires) <= at) return { status: "expired", detail: "access token expired" };
  const headers = {
    Authorization: `Bearer ${credential.access}`,
    Accept: "application/json",
    "anthropic-version": "2023-06-01",
    "anthropic-beta": "oauth-2025-04-20",
    "User-Agent": "claude-cli/2.1.0 (external, cli)",
  };
  const [usage, profile] = await Promise.all([
    fetcher(ANTHROPIC_USAGE_ENDPOINT, { signal: AbortSignal.timeout(20000), headers }),
    fetcher(ANTHROPIC_PROFILE_ENDPOINT, { signal: AbortSignal.timeout(20000), headers }),
  ]);
  if (!usage.ok) return { status: "error", detail: `http_${usage.status}` };
  const parsed = parseAnthropic(await usage.json(), profile.ok ? await profile.json() : null);
  if (!parsed) return { status: "error", detail: "no_buckets" };
  return { status: "ok", ...parsed };
}

export async function sampleAll(db, { auth, host = os.hostname(), fetcher = fetch, at = Date.now() } = {}) {
  const work = [
    ...oauthAccounts(auth, "openai-codex").map(([provider, credential]) =>
      ({ provider, family: "codex", credential, run: sampleCodexAccount })),
    ...oauthAccounts(auth, "anthropic").map(([provider, credential]) =>
      ({ provider, family: "anthropic", credential, run: sampleAnthropicAccount })),
  ];
  const results = await Promise.all(work.map(async ({ provider, family, credential, run }) => {
    try {
      return { provider, family, ...await run(provider, credential, { fetcher, at }) };
    } catch (error) {
      return { provider, family, status: "error", detail: classify(error) };
    }
  }));
  for (const result of results) {
    recordSample(db, { host, at, ...result });
  }
  return results;
}

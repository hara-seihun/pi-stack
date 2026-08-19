import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  bindingBucket, burn, classify, codexBucketName, openDatabase, oauthAccounts,
  parseAnthropic, parseCodex, parseCursor, recordSample, sampleAll, weeklyTokens, nnls,
} from "./meters.mjs";

const SECRET = "sk-ant-oat01-DO-NOT-PERSIST-abcdef";

function temporaryDatabase() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "plan-meter-"));
  return { dir, file: path.join(dir, "meters.sqlite3") };
}

test("codex windows are named by their duration", () => {
  assert.equal(codexBucketName(18000), "session");
  assert.equal(codexBucketName(604800), "weekly");
  assert.equal(codexBucketName(2592000), "monthly");
  assert.equal(codexBucketName(null), "window_unknown");
});

test("codex usage bodies normalize both windows, review and credits", () => {
  const parsed = parseCodex({
    plan_type: "Pro",
    account_id: "acct-1",
    rate_limit: {
      primary_window: { used_percent: 73, limit_window_seconds: 604800, reset_at: 1787240494 },
      secondary_window: { used_percent: 12, limit_window_seconds: 18000, reset_at: 1787100000 },
    },
    code_review_rate_limit: { used_percent: 4, limit_window_seconds: 18000, reset_at: 1787100000 },
    credits: { balance: 250, granted: 1000 },
  });
  assert.equal(parsed.plan, "pro");
  assert.equal(parsed.accountKey, "acct-1");
  const byName = Object.fromEntries(parsed.buckets.map((bucket) => [bucket.bucket, bucket]));
  assert.equal(byName.weekly.usedPercent, 73);
  assert.equal(byName.weekly.resetsAt, 1787240494000);
  assert.equal(byName.session.usedPercent, 12);
  assert.equal(byName.code_review.usedPercent, 4);
  assert.equal(byName.credits.usedUnits, 250);
  assert.equal(byName.credits.limitUnits, 1000);
});

test("codex bodies without a usable window yield no buckets", () => {
  assert.equal(parseCodex({ plan_type: "pro", rate_limit: { primary_window: null, secondary_window: null } }).buckets.length, 0);
});

test("anthropic scoped weekly buckets are captured, not only the headline bar", () => {
  const parsed = parseAnthropic({
    five_hour: { utilization: 100, resets_at: "2026-08-18T22:19:59.843247+00:00" },
    seven_day: { utilization: 60, resets_at: "2026-08-22T12:59:59.843272+00:00" },
    extra_usage: { is_enabled: true, utilization: 100, used_credits: 20012, monthly_limit: 20000 },
    limits: [
      { kind: "session", percent: 100, resets_at: "2026-08-18T22:19:59.843247+00:00" },
      { kind: "weekly_all", percent: 60, resets_at: "2026-08-22T12:59:59.843272+00:00" },
      { kind: "weekly_scoped", percent: 90, resets_at: "2026-08-22T12:59:59.843548+00:00", scope: { model: { display_name: "Fable" } } },
    ],
  }, { organization: { rate_limit_tier: "default_claude_max_5x", uuid: "org-9" } });

  const byName = Object.fromEntries(parsed.buckets.map((bucket) => [bucket.bucket, bucket]));
  assert.equal(parsed.tier, "default_claude_max_5x");
  assert.equal(parsed.plan, "max_5x");
  assert.equal(parsed.accountKey, "org-9");
  assert.equal(byName.session.usedPercent, 100);
  assert.equal(byName.weekly.usedPercent, 60);
  // The scoped bucket is the one that actually 429s this account.
  assert.equal(byName.weekly_fable.usedPercent, 90);
  assert.equal(byName.overage.usedUnits, 20012);
});

test("anthropic legacy flat fields work when limits[] is absent", () => {
  const parsed = parseAnthropic({
    five_hour: { utilization: 20, resets_at: "2026-08-18T22:00:00Z" },
    seven_day: { utilization: 28, resets_at: "2026-08-22T12:00:00Z" },
    seven_day_opus: { utilization: 94, resets_at: "2026-08-22T12:00:00Z" },
  });
  const byName = Object.fromEntries(parsed.buckets.map((bucket) => [bucket.bucket, bucket]));
  assert.equal(byName.weekly_opus.usedPercent, 94);
  assert.equal(parsed.tier, null);
});

test("anthropic bodies with no readable bucket are rejected", () => {
  assert.equal(parseAnthropic({ five_hour: null, seven_day: null, limits: [] }), null);
});

test("burn sums positive deltas and recovers usage across a reset", () => {
  const flat = burn([{ at: 3, used: 40 }, { at: 1, used: 10 }, { at: 2, used: 25 }]);
  assert.equal(flat.start, 10);
  assert.equal(flat.end, 40);
  assert.equal(flat.burned, 30);
  assert.equal(flat.resets, 0);

  // 10 -> 90 (+80), reset, 0 -> 15 (+15): end-minus-start would report -75.
  const wrapped = burn([{ at: 1, used: 10 }, { at: 2, used: 90 }, { at: 3, used: 5 }, { at: 4, used: 15 }]);
  assert.equal(wrapped.burned, 95);
  assert.equal(wrapped.resets, 1);
  assert.equal(wrapped.end, 15);
});

test("the binding bucket is the one that exhausts first, not the one that burned most", () => {
  // A five-hour window refills 33.6 times a week, so heavy session burn buys far
  // more weekly throughput than light weekly burn does.
  assert.equal(bindingBucket({
    session: { burned: 60, windowSeconds: 18000 },
    weekly: { burned: 4, windowSeconds: 604800 },
    credits: { burned: 900, windowSeconds: null },
  }), "weekly");
  // A scoped weekly bucket burning faster than the headline bar is the real wall.
  assert.equal(bindingBucket({
    weekly: { burned: 4, windowSeconds: 604800 },
    weekly_opus: { burned: 9, windowSeconds: 604800 },
  }), "weekly_opus");
  assert.equal(bindingBucket({ credits: { burned: 5, windowSeconds: null } }), null);
});

test("per-model quota cost is recoverable from accounts that mix models differently", () => {
  // Three accounts, two models, true cost 0.01%/M for the cheap model and
  // 0.05%/M for the expensive one. No single account reveals either rate.
  const mixes = [[40e6, 10e6], [10e6, 30e6], [25e6, 25e6]];
  const burns = mixes.map(([cheap, dear]) => cheap * 1e-8 + dear * 5e-8);
  const [cheapRate, dearRate] = nnls(mixes, burns, 2);
  assert.ok(Math.abs(cheapRate - 1e-8) < 1e-11, `cheap rate ${cheapRate}`);
  assert.ok(Math.abs(dearRate - 5e-8) < 1e-11, `dear rate ${dearRate}`);

  // A bucket only the second model consumes must not charge the first,
  // which is what keeps a scoped weekly window attributable without naming it.
  const scoped = mixes.map(([, dear]) => dear * 2e-7);
  const [unused, scopedRate] = nnls(mixes, scoped, 2);
  assert.ok(unused < scopedRate * 1e-4, `non-consuming model charged ${unused}`);
  assert.ok(Math.abs(scopedRate - 2e-7) < 1e-10);
});

test("capacity is normalized to seven days across window lengths", () => {
  // 10M tokens for 1% of a weekly window is 1B tokens per week.
  assert.equal(weeklyTokens({ burned: 1, windowSeconds: 604800 }, 10e6), 1e9);
  // The same rate against a 28-day cycle is a quarter of that per week.
  assert.equal(weeklyTokens({ burned: 1, windowSeconds: 4 * 604800 }, 10e6), 250e6);
  assert.equal(weeklyTokens({ burned: 0, windowSeconds: 604800 }, 10e6), null);
  assert.equal(weeklyTokens({ burned: 5, windowSeconds: null }, 10e6), null);
});

test("cursor spend is a retail-value balance, never a limit", () => {
  const parsed = parseCursor({
    billingCycleStart: "1787092762000",
    billingCycleEnd: "1789771162000",
    spendLimitUsage: { limitType: "user" },
    planUsage: { totalSpend: 2405, limit: 7000, totalPercentUsed: 2.642857142857143 },
  });
  const byName = Object.fromEntries(parsed.buckets.map((bucket) => [bucket.bucket, bucket]));
  assert.equal(parsed.plan, "pro+");
  assert.equal(byName.monthly.usedPercent, 2.642857142857143);
  assert.equal(byName.monthly.resetsAt, 1789771162000);
  assert.equal(byName.monthly.windowSeconds, 2678400);
  // 34% of the dollar figure with 2.6% of the quota spent: only the quota binds.
  assert.equal(byName.retail_value.usedPercent, null);
  assert.equal(byName.retail_value.windowSeconds, null);
  assert.equal(byName.retail_value.usedUnits, 2405);
  assert.equal(bindingBucket({
    monthly: { burned: 0.02, windowSeconds: 2678400 },
    retail_value: { burned: 0, windowSeconds: null },
  }), "monthly");
  assert.equal(parseCursor({ planUsage: {} }), null);
});

test("account discovery matches the alias family and skips non-oauth entries", () => {
  const auth = {
    "openai-codex": { type: "oauth", access: "a" },
    "openai-codex-12": { type: "oauth", access: "b" },
    "openai-codex-note": { type: "oauth", access: "c" },
    "openai": { type: "oauth", access: "d" },
    "anthropic-2": { type: "oauth", access: "e" },
    "anthropic-3": { type: "api", access: "f" },
  };
  assert.deepEqual(oauthAccounts(auth, "openai-codex").map(([name]) => name),
    ["openai-codex", "openai-codex-12", "openai-codex-note"]);
  assert.deepEqual(oauthAccounts(auth, "anthropic").map(([name]) => name), ["anthropic-2"]);
});

test("errors are classified rather than stored verbatim", () => {
  assert.equal(classify(new Error("The operation was aborted due to timeout")), "timeout");
  assert.equal(classify(new Error("getaddrinfo ENOTFOUND api.anthropic.com")), "network");
  assert.equal(classify(new Error("usage endpoint HTTP 401")), "http_401");
  assert.equal(classify(new Error("something else")), "error");
});

test("a full sampling round records readings, gaps, and no credential material", async () => {
  const { dir, file } = temporaryDatabase();
  try {
    const db = openDatabase(file);
    const auth = {
      "openai-codex": { type: "oauth", access: SECRET, accountId: "acct-1", expires: Date.now() + 3_600_000 },
      "openai-codex-2": { type: "oauth", access: SECRET, accountId: "acct-2", expires: Date.now() - 1000 },
      "anthropic": { type: "oauth", access: SECRET, expires: Date.now() + 3_600_000 },
      "cursor": { type: "oauth", access: SECRET, expires: Date.now() + 3_600_000 },
    };
    const fetcher = async (url) => {
      if (url.includes("cursor.sh")) {
        return { ok: true, json: async () => ({
          billingCycleStart: "1787092762000", billingCycleEnd: "1789771162000",
          planUsage: { totalSpend: 700, limit: 2000, totalPercentUsed: 0.8 },
        }) };
      }
      if (url.includes("wham/usage")) {
        return { ok: true, json: async () => ({
          plan_type: "pro", account_id: "acct-1",
          rate_limit: { primary_window: { used_percent: 61, limit_window_seconds: 604800, reset_at: 1787240494 } },
        }) };
      }
      if (url.endsWith("/profile")) return { ok: true, json: async () => ({ organization: { rate_limit_tier: "default_claude_max_20x" } }) };
      return { ok: true, json: async () => ({ limits: [{ kind: "weekly_all", percent: 33, resets_at: "2026-08-22T12:00:00Z" }] }) };
    };

    const results = await sampleAll(db, { auth, host: "testhost", fetcher, at: Date.now() });
    assert.equal(results.find((row) => row.provider === "openai-codex").status, "ok");
    // An expired token must be a recorded gap, never an implicit refresh.
    assert.equal(results.find((row) => row.provider === "openai-codex-2").status, "expired");
    assert.equal(results.find((row) => row.provider === "anthropic").plan, "max_20x");

    assert.equal(results.find((row) => row.provider === "cursor").status, "ok");
    const stored = db.prepare("SELECT provider, status, plan FROM sample ORDER BY provider").all();
    assert.equal(stored.length, 4);
    assert.equal(db.prepare("SELECT used_units FROM bucket WHERE bucket='retail_value'").get().used_units, 700);
    assert.equal(results.find((row) => row.provider === "cursor").plan, "pro");
    assert.equal(db.prepare("SELECT used_percent FROM bucket WHERE bucket='weekly' AND used_percent=61").all().length, 1);
    db.close();

    const raw = fs.readFileSync(file, "latin1");
    assert.equal(raw.includes(SECRET), false, "credential material must never reach the meter database");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a failing provider degrades to a classified error row", async () => {
  const { dir, file } = temporaryDatabase();
  try {
    const db = openDatabase(file);
    const auth = { "openai-codex": { type: "oauth", access: SECRET, accountId: "a", expires: Date.now() + 3_600_000 } };
    const results = await sampleAll(db, {
      auth, host: "testhost", at: Date.now(),
      fetcher: async () => { throw new Error("getaddrinfo EAI_AGAIN chatgpt.com"); },
    });
    assert.equal(results[0].status, "error");
    assert.equal(results[0].detail, "network");
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM bucket").get().count, 0);
    db.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("recorded samples round-trip through the schema", () => {
  const { dir, file } = temporaryDatabase();
  try {
    const db = openDatabase(file);
    recordSample(db, {
      host: "h", at: 1000, provider: "openai-codex-4", family: "codex", status: "ok", plan: "pro",
      buckets: [{ bucket: "weekly", usedPercent: 73, resetsAt: 2000, windowSeconds: 604800 }],
    });
    const row = db.prepare(`
      SELECT s.provider, s.plan, b.bucket, b.used_percent FROM sample s
      JOIN bucket b ON b.sample_id = s.sample_id`).get();
    assert.equal(row.provider, "openai-codex-4");
    assert.equal(row.used_percent, 73);
    db.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

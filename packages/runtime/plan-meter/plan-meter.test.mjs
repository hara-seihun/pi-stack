import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  bindingBucket, burn, classify, codexBucketName, openDatabase, oauthAccounts,
  parseAnthropic, parseCodex, recordSample, sampleAll,
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

test("the weekly window is the economics denominator even when it burned less", () => {
  // A five-hour window refills several times a day. Dividing tokens by its burn
  // and scaling to 100% would describe a different period than a weekly plan.
  assert.equal(bindingBucket({
    session: { burned: 60 },
    weekly: { burned: 4 },
    credits: { burned: 900 },
  }), "weekly");
});

test("without a weekly window the heaviest burn wins, ignoring balances", () => {
  assert.equal(bindingBucket({
    session: { burned: 5 },
    window_43200: { burned: 41 },
    credits: { burned: 900 },
    overage: { burned: 800 },
  }), "window_43200");
  assert.equal(bindingBucket({ credits: { burned: 5 } }), null);
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
    };
    const fetcher = async (url) => {
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

    const stored = db.prepare("SELECT provider, status, plan FROM sample ORDER BY provider").all();
    assert.equal(stored.length, 3);
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

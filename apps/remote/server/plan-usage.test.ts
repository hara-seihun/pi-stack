import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { loadPlanUsage } from "./plan-usage";

const NOW = Date.parse("2026-08-18T13:00:00Z");
const HALF_WEEK_RESET_SECONDS = (NOW + 3.5 * 24 * 60 * 60_000) / 1000;
const HALF_WEEK_RESET_ISO = new Date(HALF_WEEK_RESET_SECONDS * 1000).toISOString();
const dirs: string[] = [];
afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function agentDir(auth: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-remote-plans-"));
  dirs.push(dir);
  writeFileSync(join(dir, "auth.json"), JSON.stringify(auth));
  return dir;
}

/** Account registry and meter-reading fixture in the pi-orchestrator ledger shape. */
function ledger(
  dir: string,
  accounts: Array<{ id: string; provider: string; accessUntil?: number }>,
  readings: Array<{ accountId: string; meterId: string; at: number; usedPercent: number; resetAt?: number }> = [],
): string {
  const path = join(dir, "ledger.sqlite3");
  const db = new Database(path, { strict: true });
  db.exec("CREATE TABLE account (id TEXT PRIMARY KEY, provider TEXT NOT NULL, access_until INTEGER)");
  db.exec(`CREATE TABLE meter_reading (account_id TEXT NOT NULL, meter_id TEXT NOT NULL, at INTEGER NOT NULL,
    used_percent INTEGER NOT NULL, reset_at INTEGER, PRIMARY KEY (account_id, meter_id, at))`);
  for (const account of accounts) {
    db.query("INSERT INTO account(id,provider,access_until) VALUES(?,?,?)")
      .run(account.id, account.provider, account.accessUntil ?? null);
  }
  for (const reading of readings) {
    db.query("INSERT INTO meter_reading(account_id,meter_id,at,used_percent,reset_at) VALUES(?,?,?,?,?)")
      .run(reading.accountId, reading.meterId, reading.at, reading.usedPercent, reading.resetAt ?? null);
  }
  db.close();
  return path;
}

/** Cursor cycle boundaries around NOW: half of a 31-day August cycle spent. */
const CURSOR_CYCLE_END = Date.parse("2026-09-03T01:00:00Z");
const CURSOR_CYCLE_HALFWAY = Date.parse("2026-08-18T13:00:00Z");

function openAiUsage(...usedPercents: number[]): Response {
  const [primary, secondary] = usedPercents;
  return Response.json({
    rate_limit: {
      primary_window: primary == null ? null : { used_percent: primary, reset_at: HALF_WEEK_RESET_SECONDS },
      secondary_window: secondary == null ? null : { used_percent: secondary, reset_at: HALF_WEEK_RESET_SECONDS },
    },
  });
}

function anthropicUsage(sessionPercent: number, weeklyPercent: number, fablePercent: number): Response {
  return Response.json({
    limits: [
      { kind: "session", percent: sessionPercent },
      { kind: "weekly_all", percent: weeklyPercent, resets_at: HALF_WEEK_RESET_ISO },
      { kind: "weekly_scoped", percent: fablePercent, resets_at: HALF_WEEK_RESET_ISO, scope: { model: { display_name: "Fable" } } },
    ],
  });
}

function anthropicProfile(tier: "default_claude_max_5x" | "default_claude_max_20x" | "default_claude_pro"): Response {
  return Response.json({ organization: { rate_limit_tier: tier } });
}

describe("loadPlanUsage", () => {
  test("reports OpenAI and Anthropic plan headroom independently", async () => {
    const dir = agentDir({
      "openai-codex": { type: "oauth", access: "openai-a", accountId: "a" },
      "openai-codex-2": { type: "oauth", access: "openai-b", accountId: "b" },
      anthropic: { type: "oauth", access: "anthropic-a" },
      "anthropic-2": { type: "oauth", access: "anthropic-b" },
    });
    const ledgerPath = ledger(dir, [
      { id: "openai-codex", provider: "openai-codex" },
      { id: "openai-codex-2", provider: "openai-codex" },
      { id: "anthropic", provider: "anthropic" },
      { id: "anthropic-2", provider: "anthropic" },
    ]);
    const calls: string[] = [];
    const result = await loadPlanUsage({
      agentDir: dir,
      ledgerPath,
      baseUrl: "https://openai.test",
      anthropicBaseUrl: "https://anthropic.test",
      now: () => NOW,
      fetch: async (input, init) => {
        const url = String(input);
        const headers = new Headers(init?.headers);
        calls.push(url);
        if (url.startsWith("https://anthropic.test")) {
          expect(headers.get("anthropic-version")).toBe("2023-06-01");
          expect(headers.get("anthropic-beta")).toBe("oauth-2025-04-20");
          expect(headers.get("user-agent")).toBe("claude-code/2.1.80");
          const first = headers.get("authorization") === "Bearer anthropic-a";
          return url.endsWith("/profile")
            ? anthropicProfile(first ? "default_claude_max_20x" : "default_claude_max_5x")
            : first ? anthropicUsage(20, 98, 70) : anthropicUsage(0, 0, 20);
        }
        const id = headers.get("chatgpt-account-id");
        return id === "a" ? openAiUsage(20, 50) : openAiUsage(10);
      },
    });

    expect(result.openai).toEqual({
      state: "ready", percentLeft: 70, expectedPercentLeft: 50, paceDelta: 20, planCount: 2, checkedCount: 2,
    });
    expect(result.anthropic).toEqual({
      state: "ready", percentLeft: 28, expectedPercentLeft: null, paceDelta: null,
      fablePercentLeft: 47, fableExpectedPercentLeft: 50, fablePaceDelta: -3,
      weeklyPercentLeft: 35, weeklyExpectedPercentLeft: 50, weeklyPaceDelta: -15,
      planCount: 2, checkedCount: 2,
    });
    expect(calls.filter((url) => url === "https://openai.test/wham/usage")).toHaveLength(2);
    expect(calls.filter((url) => url === "https://anthropic.test/api/oauth/usage")).toHaveLength(2);
    expect(calls.filter((url) => url === "https://anthropic.test/api/oauth/profile")).toHaveLength(2);
  });

  test("keeps each account's last good reading through transient provider failures", async () => {
    const dir = agentDir({ anthropic: { type: "oauth", access: "sticky-anthropic" } });
    const ledgerPath = ledger(dir, [{ id: "anthropic", provider: "anthropic" }]);
    const first = await loadPlanUsage({
      agentDir: dir,
      ledgerPath,
      anthropicBaseUrl: "https://sticky-anthropic.test",
      now: () => NOW,
      fetch: async (input) => String(input).endsWith("/profile")
        ? anthropicProfile("default_claude_max_20x")
        : anthropicUsage(10, 20, 30),
    });
    const second = await loadPlanUsage({
      agentDir: dir,
      ledgerPath,
      anthropicBaseUrl: "https://sticky-anthropic.test",
      now: () => NOW + 60_000,
      fetch: async () => new Response("temporarily unavailable", { status: 503 }),
    });

    expect(first.anthropic).toMatchObject({ state: "ready", fablePercentLeft: 70, weeklyPercentLeft: 80 });
    expect(second.anthropic).toEqual(first.anthropic);
  });

  /** The defect this covers: the Anthropic card averaged only the accounts
   * whose OAuth token happened to live in this user's auth.json and answer
   * right now, then presented that average as the fleet's headroom. A plan
   * held in another custody domain, or one whose stored token has expired,
   * left the average entirely — so one idle account read as "100%" while a
   * drained one was invisible. */
  test("counts plans this user cannot authenticate to, from the orchestrator's recorded meters", async () => {
    const dir = agentDir({ anthropic: { type: "oauth", access: "readable" } });
    const ledgerPath = ledger(dir, [
      { id: "anthropic", provider: "anthropic" },
      { id: "anthropic-2", provider: "anthropic" },
      { id: "anthropic-3", provider: "anthropic" },
    ], [
      // Orchestrator custody: the credential lives in the fleet user's store.
      { accountId: "anthropic-2", meterId: "anthropic-5h", at: NOW - 60_000, usedPercent: 1, resetAt: NOW + 2 * 60 * 60_000 },
      { accountId: "anthropic-2", meterId: "anthropic-7d", at: NOW - 60_000, usedPercent: 88, resetAt: NOW + 24 * 60 * 60_000 },
      { accountId: "anthropic-2", meterId: "anthropic-7d_oi", at: NOW - 60_000, usedPercent: 30, resetAt: NOW + 24 * 60 * 60_000 },
      // Expired stored token: the live check 401s, the recorded meters stand.
      { accountId: "anthropic-3", meterId: "anthropic-7d", at: NOW - 6 * 60 * 60_000, usedPercent: 21, resetAt: NOW + 3.5 * 24 * 60 * 60_000 },
      { accountId: "anthropic-3", meterId: "anthropic-7d_oi", at: NOW - 6 * 60 * 60_000, usedPercent: 27, resetAt: NOW + 3.5 * 24 * 60 * 60_000 },
    ]);
    const result = await loadPlanUsage({
      agentDir: dir,
      ledgerPath,
      anthropicBaseUrl: "https://anthropic.test",
      now: () => NOW,
      fetch: async (input, init) => {
        if (new Headers(init?.headers).get("authorization") !== "Bearer readable") return new Response("expired", { status: 401 });
        return String(input).endsWith("/profile") ? anthropicProfile("default_claude_max_20x") : anthropicUsage(2, 0, 0);
      },
    });

    expect(result.anthropic).toEqual({
      state: "ready", percentLeft: 70, expectedPercentLeft: null, paceDelta: null,
      fablePercentLeft: 86, fableExpectedPercentLeft: 41, fablePaceDelta: 45,
      weeklyPercentLeft: 73, weeklyExpectedPercentLeft: 41, weeklyPaceDelta: 32,
      planCount: 3, checkedCount: 3,
    });
  });

  /** The defect this covers: the Fable meter is reported by response headers
   * only for traffic scoped to that model, so an Opus account had no Fable
   * reading at all — and the card averaged the accounts that did, presenting
   * two healthy plans as the fleet while a third sat at zero Fable headroom.
   * A metric that covers fewer plans than the fleet holds must say so. */
  test("never reports a Fable average that silently drops a plan", async () => {
    const dir = agentDir({ anthropic: { type: "oauth", access: "readable" } });
    const accounts = [
      { id: "anthropic", provider: "anthropic" },
      { id: "anthropic-2", provider: "anthropic" },
    ];
    const weekly = { accountId: "anthropic-2", meterId: "anthropic-7d", at: NOW - 60_000, usedPercent: 90, resetAt: NOW + 24 * 60 * 60_000 };
    const scoped = { ...weekly, meterId: "anthropic-7d_oi", usedPercent: 100 };
    const options = {
      agentDir: dir,
      anthropicBaseUrl: "https://anthropic.test",
      now: () => NOW,
      fetch: async (input: string | URL | Request, init?: RequestInit) =>
        new Headers(init?.headers).get("authorization") !== "Bearer readable"
          ? new Response("expired", { status: 401 })
          : String(input).endsWith("/profile") ? anthropicProfile("default_claude_max_5x") : anthropicUsage(2, 6, 6),
    };

    const headersOnly = await loadPlanUsage({ ...options, ledgerPath: ledger(dir, accounts, [weekly]) });
    // The Opus account reports no Fable meter: 94% is one plan's headroom,
    // not the fleet's, and the card carries that limit.
    expect(headersOnly.anthropic).toMatchObject({ state: "partial", fablePercentLeft: 94, planCount: 2, checkedCount: 1 });

    const polled = await loadPlanUsage({ ...options, ledgerPath: ledger(agentDir({ anthropic: { type: "oauth", access: "readable" } }), accounts, [weekly, scoped]) });
    // With the sampler's polled reading the drained plan counts, and the
    // Fable figure drops to what the fleet actually has left.
    expect(polled.anthropic).toMatchObject({ state: "ready", fablePercentLeft: 47, planCount: 2, checkedCount: 2 });
  });

  test("reads a window that rolled over since the last observation as empty", async () => {
    const dir = agentDir({});
    const ledgerPath = ledger(dir, [{ id: "anthropic", provider: "anthropic" }], [
      { accountId: "anthropic", meterId: "anthropic-7d", at: NOW - 3 * 24 * 60 * 60_000, usedPercent: 94, resetAt: NOW - 60_000 },
    ]);
    const result = await loadPlanUsage({
      agentDir: dir, ledgerPath, now: () => NOW,
      fetch: async () => new Response("no credential", { status: 401 }),
    });

    expect(result.anthropic).toMatchObject({ state: "ready", weeklyPercentLeft: 100, checkedCount: 1 });
  });

  test("stops trusting recorded meters once an idle account and a stopped logger are indistinguishable", async () => {
    const dir = agentDir({});
    const ledgerPath = ledger(dir, [{ id: "anthropic", provider: "anthropic" }], [
      { accountId: "anthropic", meterId: "anthropic-7d", at: NOW - 20 * 24 * 60 * 60_000, usedPercent: 40, resetAt: NOW + 60_000 },
    ]);
    const result = await loadPlanUsage({
      agentDir: dir, ledgerPath, now: () => NOW,
      fetch: async () => new Response("no credential", { status: 401 }),
    });

    expect(result.anthropic).toMatchObject({ state: "unavailable", weeklyPercentLeft: null, planCount: 1, checkedCount: 0 });
  });

  test("reads Cursor usage from the orchestrator's meter readings, whose credential this user cannot see", async () => {
    const dir = agentDir({});
    const ledgerPath = ledger(dir, [{ id: "cursor", provider: "cursor" }], [
      { accountId: "cursor", meterId: "cursor-month", at: CURSOR_CYCLE_HALFWAY - 60 * 60_000, usedPercent: 8, resetAt: CURSOR_CYCLE_END },
      { accountId: "cursor", meterId: "cursor-month", at: CURSOR_CYCLE_HALFWAY - 5 * 60_000, usedPercent: 12, resetAt: CURSOR_CYCLE_END },
    ]);
    const result = await loadPlanUsage({
      agentDir: dir,
      ledgerPath,
      now: () => CURSOR_CYCLE_HALFWAY,
      fetch: async () => { throw new Error("Cursor usage must come from the ledger, not this user's credentials"); },
    });

    expect(result.cursor).toEqual({
      state: "ready",
      percentLeft: 88,
      percentUsed: 12,
      expectedPercentLeft: 50,
      paceDelta: 38,
      planCount: 1,
      checkedCount: 1,
    });
  });

  test("reports Cursor unavailable when the meter sampler has stopped", async () => {
    const dir = agentDir({});
    const ledgerPath = ledger(dir, [{ id: "cursor", provider: "cursor" }], [
      { accountId: "cursor", meterId: "cursor-month", at: NOW - 25 * 60 * 60_000, usedPercent: 12, resetAt: NOW + 5 * 24 * 60 * 60_000 },
    ]);
    const result = await loadPlanUsage({ agentDir: dir, ledgerPath, now: () => NOW, fetch: async () => openAiUsage(0) });

    expect(result.cursor).toEqual({
      state: "unavailable", percentLeft: null, percentUsed: null, expectedPercentLeft: null, paceDelta: null,
      planCount: 1, checkedCount: 0,
    });
  });

  test("reports no Cursor plan when the ledger holds no Cursor account", async () => {
    const dir = agentDir({});
    const ledgerPath = ledger(dir, [{ id: "openai-codex", provider: "openai-codex" }]);
    const result = await loadPlanUsage({ agentDir: dir, ledgerPath, now: () => NOW, fetch: async () => openAiUsage(0) });

    expect(result.cursor).toMatchObject({ state: "unavailable", planCount: 0, checkedCount: 0 });
  });

  test("marks one provider partial without changing the other provider", async () => {
    const dir = agentDir({
      "openai-codex": { type: "oauth", access: "good" },
      "openai-codex-2": { type: "oauth", access: "bad" },
    });
    const ledgerPath = ledger(dir, [
      { id: "openai-codex", provider: "openai-codex" },
      { id: "openai-codex-2", provider: "openai-codex" },
      { id: "openai-codex-3", provider: "openai-codex" },
    ]);
    const result = await loadPlanUsage({
      agentDir: dir,
      ledgerPath,
      now: () => NOW,
      fetch: async (_input, init) => {
        const token = new Headers(init?.headers).get("authorization");
        return token === "Bearer good" ? openAiUsage(25) : new Response("no", { status: 401 });
      },
    });

    expect(result.openai).toEqual({
      state: "partial", percentLeft: 75, expectedPercentLeft: 50, paceDelta: 25, planCount: 3, checkedCount: 1,
    });
    expect(result.anthropic).toEqual({
      state: "unavailable", percentLeft: null, expectedPercentLeft: null, paceDelta: null,
      fablePercentLeft: null, fableExpectedPercentLeft: null, fablePaceDelta: null,
      weeklyPercentLeft: null, weeklyExpectedPercentLeft: null, weeklyPaceDelta: null,
      planCount: 0, checkedCount: 0,
    });
  });

  test("falls back to every credentialed auth.json alias when the ledger is absent", async () => {
    const dir = agentDir({
      "openai-codex": { type: "oauth", access: "a" },
      "openai-codex-2": { type: "oauth", access: "b" },
      "openai-codex-3": { type: "oauth", access: "c" },
      anthropic: { type: "oauth", access: "d" },
      "anthropic-2": { type: "oauth", access: "e" },
    });
    const result = await loadPlanUsage({
      agentDir: dir,
      ledgerPath: join(dir, "missing-ledger.sqlite3"),
      now: () => NOW,
      fetch: async (input) => String(input).endsWith("/profile")
        ? anthropicProfile("default_claude_max_20x")
        : String(input).includes("anthropic.com") ? anthropicUsage(0, 0, 0) : openAiUsage(0),
    });

    expect(result.openai).toEqual({
      state: "ready", percentLeft: 100, expectedPercentLeft: 50, paceDelta: 50, planCount: 3, checkedCount: 3,
    });
    expect(result.anthropic).toEqual({
      state: "ready", percentLeft: 100, expectedPercentLeft: null, paceDelta: null,
      fablePercentLeft: 100, fableExpectedPercentLeft: 50, fablePaceDelta: 50,
      weeklyPercentLeft: 100, weeklyExpectedPercentLeft: 50, weeklyPaceDelta: 50,
      planCount: 2, checkedCount: 2,
    });
  });

  test("a cancelled subscription stops counting once its paid access ends", async () => {
    const dir = agentDir({
      "openai-codex": { type: "oauth", access: "a" },
      "openai-codex-2": { type: "oauth", access: "b" },
    });
    const ledgerPath = ledger(dir, [
      { id: "openai-codex", provider: "openai-codex" },
      { id: "openai-codex-2", provider: "openai-codex", accessUntil: NOW - 1 },
    ]);
    const result = await loadPlanUsage({
      agentDir: dir,
      ledgerPath,
      now: () => NOW,
      fetch: async () => openAiUsage(40),
    });
    expect(result.openai).toMatchObject({ state: "ready", planCount: 1, checkedCount: 1, percentLeft: 60 });
  });
});

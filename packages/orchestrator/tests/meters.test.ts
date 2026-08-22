import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { Ledger } from "../src/ledger/ledger.js";
import { CursorMeterSampler, parseCursorPeriodUsage } from "../src/meters/cursor.js";
import { CodexMeterSampler, parseCodexUsage } from "../src/meters/codex.js";
import {
  ANTHROPIC_METER_IDS,
  AnthropicMeterSampler,
  parseAnthropicUsage,
} from "../src/meters/anthropic.js";
import { MeterLog } from "../src/meters/log.js";
import { anthropicMeterReadings } from "../src/extension/usage-logger.js";

/** Upsert an account and record it as fleet-credentialed, the way the
 * controller's per-tick credential observation would. */
function fleetAccount(ledger: Ledger, spec: Parameters<Ledger["upsertAccount"]>[0]): void {
  ledger.upsertAccount(spec);
  ledger.syncFleetCredentials(new Set(ledger.accounts().map((a) => a.id)));
}


const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function workspace(auth: Record<string, unknown>): { ledger: Ledger; agentDir: string } {
  const dir = mkdtempSync(join(tmpdir(), "pi-orch-meters-"));
  dirs.push(dir);
  writeFileSync(join(dir, "auth.json"), JSON.stringify(auth));
  const ledger = Ledger.open(join(dir, "ledger.sqlite3"));
  fleetAccount(ledger, { id: "cursor", provider: "cursor" });
  return { ledger, agentDir: dir };
}

function usageResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const CYCLE_END = Date.now() + 10 * 24 * 3_600_000;
const PERIOD_USAGE = {
  billingCycleStart: String(CYCLE_END - 30 * 24 * 3_600_000),
  billingCycleEnd: String(CYCLE_END),
  planUsage: { totalPercentUsed: 41.7, includedSpend: 8_231, limit: 20_000 },
};

describe("cursor period usage parsing", () => {
  it("reads the percentage meter and the cycle end", () => {
    expect(parseCursorPeriodUsage(PERIOD_USAGE)).toEqual({ usedPercent: 41.7, resetAt: CYCLE_END });
  });

  it("treats a response without a percentage as a gap, not a zero reading", () => {
    expect(parseCursorPeriodUsage({ planUsage: { includedSpend: 8_231 } })).toBeUndefined();
    expect(parseCursorPeriodUsage({})).toBeUndefined();
    expect(parseCursorPeriodUsage(null)).toBeUndefined();
  });
});

describe("cursor meter sampler", () => {
  it("records the polled percentage as an ordinary meter reading", async () => {
    const { ledger, agentDir } = workspace({ cursor: { type: "oauth", access: "token", expires: Date.now() + 60_000 } });
    let authorization: string | null = null;
    const sampler = new CursorMeterSampler(ledger, {
      agentDir,
      meterId: "cursor-month",
      fetch: async (_input, init) => {
        authorization = new Headers(init?.headers).get("authorization");
        return usageResponse(PERIOD_USAGE);
      },
    });

    expect(await sampler.sample()).toEqual([{ accountId: "cursor", outcome: "recorded", usedPercent: 41.7 }]);
    expect(authorization).toBe("Bearer token");
    const reading = ledger.latestReading("cursor", "cursor-month");
    expect(reading?.usedPercent).toBe(42);
    expect(reading?.resetAt).toBe(CYCLE_END);
    expect(ledger.latestUsedPercent("cursor")).toBe(42);
  });

  it("spaces readings by the sampling interval", async () => {
    const { ledger, agentDir } = workspace({ cursor: { type: "oauth", access: "token" } });
    let calls = 0;
    const sampler = new CursorMeterSampler(ledger, {
      agentDir,
      meterId: "cursor-month",
      intervalMs: 10 * 60_000,
      fetch: async () => {
        calls++;
        return usageResponse(PERIOD_USAGE);
      },
    });

    expect((await sampler.sample())[0]?.outcome).toBe("recorded");
    expect((await sampler.sample())[0]?.outcome).toBe("not-due");
    expect(calls).toBe(1);
  });

  it("never refreshes an expired credential; the window is recorded as a gap", async () => {
    const { ledger, agentDir } = workspace({ cursor: { type: "oauth", access: "token", expires: Date.now() - 1 } });
    const sampler = new CursorMeterSampler(ledger, {
      agentDir,
      meterId: "cursor-month",
      fetch: async () => {
        throw new Error("sampler must not call the provider without a live token");
      },
    });

    expect(await sampler.sample()).toEqual([{ accountId: "cursor", outcome: "expired-credential" }]);
    expect(ledger.latestReading("cursor", "cursor-month")).toBeUndefined();
  });

  it("skips accounts whose credential lives in another auth store", async () => {
    const { ledger, agentDir } = workspace({ "openai-codex-8": { type: "oauth", access: "other" } });
    const sampler = new CursorMeterSampler(ledger, {
      agentDir,
      meterId: "cursor-month",
      fetch: async () => usageResponse(PERIOD_USAGE),
    });

    expect(await sampler.sample()).toEqual([{ accountId: "cursor", outcome: "no-credential" }]);
  });

  it("reports a provider failure without throwing or writing a reading", async () => {
    const { ledger, agentDir } = workspace({ cursor: { type: "oauth", access: "token" } });
    const sampler = new CursorMeterSampler(ledger, {
      agentDir,
      meterId: "cursor-month",
      fetch: async () => usageResponse({ error: "unauthenticated" }, 401),
    });

    const [report] = await sampler.sample();
    expect(report?.outcome).toBe("request-failed");
    expect(report?.detail).toContain("401");
    expect(ledger.latestReading("cursor", "cursor-month")).toBeUndefined();
  });

  it("ignores accounts past their paid access", async () => {
    const { ledger, agentDir } = workspace({ cursor: { type: "oauth", access: "token" } });
    ledger.setAccountAccessUntil("cursor", Date.now() - 1);
    const sampler = new CursorMeterSampler(ledger, {
      agentDir,
      meterId: "cursor-month",
      fetch: async () => usageResponse(PERIOD_USAGE),
    });

    expect(await sampler.sample()).toEqual([]);
  });
});

const CODEX_METERS = [
  { id: "codex-5h", windowHours: 5 },
  { id: "codex-7d", windowHours: 168 },
];
const RESET_AT = Math.floor(Date.now() / 1000) + 559_357;
const CODEX_USAGE = {
  plan_type: "pro",
  rate_limit: {
    primary_window: {
      used_percent: 11,
      limit_window_seconds: 604_800,
      reset_after_seconds: 559_357,
      reset_at: RESET_AT,
    },
    secondary_window: null,
  },
  // Model-scoped allowances are not the account plan and must not be read.
  additional_rate_limits: [
    {
      limit_name: "GPT-5.3-Codex-Spark",
      rate_limit: { primary_window: { used_percent: 40, limit_window_seconds: 18_000 } },
    },
  ],
};

function codexWorkspace(auth: Record<string, unknown>): { ledger: Ledger; authPath: string } {
  const dir = mkdtempSync(join(tmpdir(), "pi-orch-codex-"));
  dirs.push(dir);
  const authPath = join(dir, "auth.json");
  writeFileSync(authPath, JSON.stringify(auth));
  const ledger = Ledger.open(join(dir, "ledger.sqlite3"));
  fleetAccount(ledger, { id: "openai-codex-8", provider: "openai-codex" });
  return { ledger, authPath };
}

const CODEX_CREDENTIAL = {
  type: "oauth",
  access: "token",
  refresh: "refresh",
  expires: Date.now() + 3_600_000,
  accountId: "chatgpt-account",
};

describe("codex usage parsing", () => {
  it("reads each plan window with its length and reset instant", () => {
    expect(parseCodexUsage(CODEX_USAGE)).toEqual([
      { usedPercent: 11, windowSeconds: 604_800, resetAt: RESET_AT * 1000 },
    ]);
  });

  it("falls back to the relative reset when no absolute one is given", () => {
    const now = 1_000_000;
    expect(
      parseCodexUsage(
        { rate_limit: { primary_window: { used_percent: 4, limit_window_seconds: 18_000, reset_after_seconds: 60 } } },
        now,
      ),
    ).toEqual([{ usedPercent: 4, windowSeconds: 18_000, resetAt: now + 60_000 }]);
  });

  it("treats a response without a usable window as a gap, not a zero reading", () => {
    expect(parseCodexUsage({ rate_limit: { primary_window: null, secondary_window: null } })).toEqual([]);
    expect(parseCodexUsage({ rate_limit: { primary_window: { used_percent: 5 } } })).toEqual([]);
    expect(parseCodexUsage({})).toEqual([]);
    expect(parseCodexUsage(null)).toEqual([]);
  });
});

describe("codex meter sampler", () => {
  it("records the polled window against the meter of that window length", async () => {
    const { ledger, authPath } = codexWorkspace({ "openai-codex-8": CODEX_CREDENTIAL });
    let headers: Headers | undefined;
    const sampler = new CodexMeterSampler(ledger, {
      authPaths: [authPath],
      meters: CODEX_METERS,
      fetch: async (_input, init) => {
        headers = new Headers(init?.headers);
        return usageResponse(CODEX_USAGE);
      },
    });

    expect(await sampler.sample()).toEqual([
      { accountId: "openai-codex-8", meterId: "codex-7d", outcome: "recorded", usedPercent: 11 },
    ]);
    expect(headers?.get("authorization")).toBe("Bearer token");
    expect(headers?.get("chatgpt-account-id")).toBe("chatgpt-account");
    // Not decoration: the endpoint's bot filter answers node's default
    // user-agent with 403, so a named client is what makes the call work.
    expect(headers?.get("user-agent")).toBe("pi-orchestrator");
    const reading = ledger.latestReading("openai-codex-8", "codex-7d");
    expect(reading?.usedPercent).toBe(11);
    expect(reading?.resetAt).toBe(RESET_AT * 1000);
    // The account reports no five-hour window, so that meter stays sourceless
    // rather than being invented at zero.
    expect(ledger.latestReading("openai-codex-8", "codex-5h")).toBeUndefined();
  });

  it("records both windows when the plan has two", async () => {
    const { ledger, authPath } = codexWorkspace({ "openai-codex-8": CODEX_CREDENTIAL });
    const sampler = new CodexMeterSampler(ledger, {
      authPaths: [authPath],
      meters: CODEX_METERS,
      fetch: async () =>
        usageResponse({
          rate_limit: {
            primary_window: { used_percent: 62, limit_window_seconds: 18_000 },
            secondary_window: { used_percent: 30, limit_window_seconds: 604_800 },
          },
        }),
    });

    expect((await sampler.sample()).map((r) => [r.meterId, r.usedPercent])).toEqual([
      ["codex-5h", 62],
      ["codex-7d", 30],
    ]);
  });

  it("reports a window no meter is declared for instead of guessing one", async () => {
    const { ledger, authPath } = codexWorkspace({ "openai-codex-8": CODEX_CREDENTIAL });
    const sampler = new CodexMeterSampler(ledger, {
      authPaths: [authPath],
      meters: [{ id: "codex-7d", windowHours: 168 }],
      fetch: async () =>
        usageResponse({ rate_limit: { primary_window: { used_percent: 62, limit_window_seconds: 18_000 } } }),
    });

    const [report] = await sampler.sample();
    expect(report?.outcome).toBe("unmapped-window");
    expect(report?.detail).toContain("5h");
    expect(ledger.latestReading("openai-codex-8", "codex-7d")).toBeUndefined();
  });

  it("spaces readings by the sampling interval", async () => {
    const { ledger, authPath } = codexWorkspace({ "openai-codex-8": CODEX_CREDENTIAL });
    let calls = 0;
    const sampler = new CodexMeterSampler(ledger, {
      authPaths: [authPath],
      meters: CODEX_METERS,
      intervalMs: 5 * 60_000,
      fetch: async () => {
        calls++;
        return usageResponse(CODEX_USAGE);
      },
    });

    expect((await sampler.sample())[0]?.outcome).toBe("recorded");
    expect((await sampler.sample())[0]?.outcome).toBe("not-due");
    expect(calls).toBe(1);
  });

  it("never refreshes an expired credential; the window is recorded as a gap", async () => {
    const { ledger, authPath } = codexWorkspace({
      "openai-codex-8": { ...CODEX_CREDENTIAL, expires: Date.now() - 1 },
    });
    const sampler = new CodexMeterSampler(ledger, {
      authPaths: [authPath],
      meters: CODEX_METERS,
      fetch: async () => {
        throw new Error("sampler must not call the provider without a live token");
      },
    });

    expect(await sampler.sample()).toEqual([
      { accountId: "openai-codex-8", outcome: "expired-credential" },
    ]);
    expect(ledger.latestReading("openai-codex-8", "codex-7d")).toBeUndefined();
  });

  it("falls through to the next credential store", async () => {
    const { ledger, authPath } = codexWorkspace({ "someone-else": CODEX_CREDENTIAL });
    const other = join(mkdtempSync(join(tmpdir(), "pi-orch-codex-alt-")), "auth.json");
    dirs.push(other);
    writeFileSync(other, JSON.stringify({ "openai-codex-8": CODEX_CREDENTIAL }));
    const sampler = new CodexMeterSampler(ledger, {
      authPaths: [authPath, other],
      meters: CODEX_METERS,
      fetch: async () => usageResponse(CODEX_USAGE),
    });

    expect((await sampler.sample())[0]?.outcome).toBe("recorded");
  });

  it("reports a provider failure without throwing or writing a reading", async () => {
    const { ledger, authPath } = codexWorkspace({ "openai-codex-8": CODEX_CREDENTIAL });
    const sampler = new CodexMeterSampler(ledger, {
      authPaths: [authPath],
      meters: CODEX_METERS,
      fetch: async () => usageResponse({ detail: "unauthenticated" }, 401),
    });

    const [report] = await sampler.sample();
    expect(report?.outcome).toBe("request-failed");
    expect(report?.detail).toContain("401");
    expect(ledger.latestReading("openai-codex-8", "codex-7d")).toBeUndefined();
  });

  it("ignores accounts past their paid access", async () => {
    const { ledger, authPath } = codexWorkspace({ "openai-codex-8": CODEX_CREDENTIAL });
    ledger.setAccountAccessUntil("openai-codex-8", Date.now() - 1);
    const sampler = new CodexMeterSampler(ledger, {
      authPaths: [authPath],
      meters: CODEX_METERS,
      fetch: async () => usageResponse(CODEX_USAGE),
    });

    expect(await sampler.sample()).toEqual([]);
  });
});

const WEEK_RESET = "2026-08-28T09:00:00.000Z";
const SESSION_RESET = "2026-08-21T21:40:00.000Z";
const ANTHROPIC_USAGE = {
  five_hour: { utilization: 12, resets_at: SESSION_RESET },
  seven_day: { utilization: 5, resets_at: WEEK_RESET },
  seven_day_opus: null,
  limits: [
    { kind: "session", percent: 12, resets_at: SESSION_RESET, scope: null },
    { kind: "weekly_all", percent: 5, resets_at: WEEK_RESET, scope: null },
    {
      kind: "weekly_scoped",
      percent: 100,
      resets_at: WEEK_RESET,
      scope: { model: { id: null, display_name: "Fable" }, surface: null },
    },
  ],
};

function anthropicWorkspace(auth: Record<string, unknown>): { ledger: Ledger; agentDir: string } {
  const dir = mkdtempSync(join(tmpdir(), "pi-orch-anthropic-"));
  dirs.push(dir);
  writeFileSync(join(dir, "auth.json"), JSON.stringify(auth));
  const ledger = Ledger.open(join(dir, "ledger.sqlite3"));
  fleetAccount(ledger, { id: "anthropic-2", provider: "anthropic" });
  return { ledger, agentDir: dir };
}

const ANTHROPIC_CREDENTIAL = { type: "oauth", access: "token", expires: Date.now() + 3_600_000 };

describe("anthropic usage parsing", () => {
  it("reads every bucket, including the scoped weekly one headers omit", () => {
    expect(parseAnthropicUsage(ANTHROPIC_USAGE)).toEqual({
      unmappedScopes: [],
      buckets: [
        { meterId: "anthropic-5h", usedPercent: 12, resetAt: Date.parse(SESSION_RESET) },
        { meterId: "anthropic-7d", usedPercent: 5, resetAt: Date.parse(WEEK_RESET) },
        { meterId: "anthropic-7d_oi", usedPercent: 100, resetAt: Date.parse(WEEK_RESET) },
      ],
    });
  });

  it("records the buckets under the same meter ids the response headers do", () => {
    const headerIds = anthropicMeterReadings(
      {
        "anthropic-ratelimit-unified-5h-utilization": "0.12",
        "anthropic-ratelimit-unified-7d-utilization": "0.05",
        "anthropic-ratelimit-unified-7d_oi-utilization": "1",
      },
      Date.now(),
    ).map((r) => r.meterId);
    expect(headerIds).toEqual(Object.values(ANTHROPIC_METER_IDS));
    expect(parseAnthropicUsage(ANTHROPIC_USAGE).buckets.map((b) => b.meterId)).toEqual(headerIds);
  });

  it("identifies a sole scoped weekly bucket without needing its name", () => {
    const usage = {
      limits: [{ kind: "weekly_scoped", percent: 40, resets_at: WEEK_RESET, scope: { model: {} } }],
    };
    expect(parseAnthropicUsage(usage).buckets).toEqual([
      { meterId: "anthropic-7d_oi", usedPercent: 40, resetAt: Date.parse(WEEK_RESET) },
    ]);
  });

  it("reports a scope no meter is declared for instead of guessing one", () => {
    const usage = {
      limits: [
        { kind: "weekly_scoped", percent: 40, scope: { model: { display_name: "Fable" } } },
        { kind: "weekly_scoped", percent: 90, scope: { model: { display_name: "Sonnet" } } },
      ],
    };
    const reading = parseAnthropicUsage(usage);
    expect(reading.buckets).toEqual([{ meterId: "anthropic-7d_oi", usedPercent: 40, resetAt: undefined }]);
    expect(reading.unmappedScopes).toEqual(["Sonnet"]);
  });

  it("treats a response without limits as a gap, not a zero reading", () => {
    // The older top-level fields express no scoped weekly bucket at all, so
    // reading them would silently restore the hole the sampler exists to close.
    expect(parseAnthropicUsage({ five_hour: { utilization: 12 }, seven_day: { utilization: 5 } }).buckets).toEqual([]);
    expect(parseAnthropicUsage({}).buckets).toEqual([]);
    expect(parseAnthropicUsage(null).buckets).toEqual([]);
  });
});

describe("anthropic meter sampler", () => {
  it("records every polled bucket as an ordinary meter reading", async () => {
    const { ledger, agentDir } = anthropicWorkspace({ "anthropic-2": ANTHROPIC_CREDENTIAL });
    let headers: Headers | undefined;
    const sampler = new AnthropicMeterSampler(ledger, {
      agentDir,
      fetch: async (_input, init) => {
        headers = new Headers(init?.headers);
        return usageResponse(ANTHROPIC_USAGE);
      },
    });

    expect((await sampler.sample()).map((r) => [r.meterId, r.outcome, r.usedPercent])).toEqual([
      ["anthropic-5h", "recorded", 12],
      ["anthropic-7d", "recorded", 5],
      ["anthropic-7d_oi", "recorded", 100],
    ]);
    expect(headers?.get("authorization")).toBe("Bearer token");
    expect(headers?.get("anthropic-beta")).toBe("oauth-2025-04-20");
    const scoped = ledger.latestReading("anthropic-2", "anthropic-7d_oi");
    expect(scoped?.usedPercent).toBe(100);
    expect(scoped?.resetAt).toBe(Date.parse(WEEK_RESET));
  });

  it("polls an account whose scoped meter is missing though its headers are current", async () => {
    // The Opus account: every response refreshes 5h and 7d and none of them
    // can report the Fable weekly bucket, so judging due-ness on the freshest
    // meter would leave that bucket empty forever.
    const { ledger, agentDir } = anthropicWorkspace({ "anthropic-2": ANTHROPIC_CREDENTIAL });
    const now = Date.now();
    ledger.recordReading("anthropic-2", "anthropic-5h", { at: now, usedPercent: 14 });
    ledger.recordReading("anthropic-2", "anthropic-7d", { at: now, usedPercent: 90 });
    const sampler = new AnthropicMeterSampler(ledger, {
      agentDir,
      fetch: async () => usageResponse(ANTHROPIC_USAGE),
    });

    const recorded = (await sampler.sample()).filter((r) => r.outcome === "recorded").map((r) => r.meterId);
    expect(recorded).toContain("anthropic-7d_oi");
    expect(ledger.latestReading("anthropic-2", "anthropic-7d_oi")?.usedPercent).toBe(100);
  });

  it("spaces readings by the sampling interval once every meter is fresh", async () => {
    const { ledger, agentDir } = anthropicWorkspace({ "anthropic-2": ANTHROPIC_CREDENTIAL });
    let calls = 0;
    const sampler = new AnthropicMeterSampler(ledger, {
      agentDir,
      intervalMs: 10 * 60_000,
      fetch: async () => {
        calls++;
        return usageResponse(ANTHROPIC_USAGE);
      },
    });

    expect((await sampler.sample())[0]?.outcome).toBe("recorded");
    expect(await sampler.sample()).toEqual([{ accountId: "anthropic-2", outcome: "not-due" }]);
    expect(calls).toBe(1);
  });

  it("never refreshes an expired credential; the window is recorded as a gap", async () => {
    const { ledger, agentDir } = anthropicWorkspace({
      "anthropic-2": { ...ANTHROPIC_CREDENTIAL, expires: Date.now() - 1 },
    });
    const sampler = new AnthropicMeterSampler(ledger, {
      agentDir,
      fetch: async () => {
        throw new Error("sampler must not call the provider without a live token");
      },
    });

    expect(await sampler.sample()).toEqual([{ accountId: "anthropic-2", outcome: "expired-credential" }]);
    expect(ledger.latestReading("anthropic-2", "anthropic-7d_oi")).toBeUndefined();
  });

  it("skips accounts whose credential lives in another auth store", async () => {
    const { ledger, agentDir } = anthropicWorkspace({ anthropic: ANTHROPIC_CREDENTIAL });
    const sampler = new AnthropicMeterSampler(ledger, {
      agentDir,
      fetch: async () => usageResponse(ANTHROPIC_USAGE),
    });

    expect(await sampler.sample()).toEqual([{ accountId: "anthropic-2", outcome: "no-credential" }]);
  });

  it("reports a provider failure without throwing or writing a reading", async () => {
    const { ledger, agentDir } = anthropicWorkspace({ "anthropic-2": ANTHROPIC_CREDENTIAL });
    const sampler = new AnthropicMeterSampler(ledger, {
      agentDir,
      fetch: async () => usageResponse({ error: "unauthorized" }, 401),
    });

    const [report] = await sampler.sample();
    expect(report?.outcome).toBe("request-failed");
    expect(report?.detail).toContain("401");
    expect(ledger.latestReading("anthropic-2", "anthropic-5h")).toBeUndefined();
  });

  it("ignores accounts past their paid access", async () => {
    const { ledger, agentDir } = anthropicWorkspace({ "anthropic-2": ANTHROPIC_CREDENTIAL });
    ledger.setAccountAccessUntil("anthropic-2", Date.now() - 1);
    const sampler = new AnthropicMeterSampler(ledger, {
      agentDir,
      fetch: async () => usageResponse(ANTHROPIC_USAGE),
    });

    expect(await sampler.sample()).toEqual([]);
  });
});

describe("meter logging", () => {
  function sinkLog(quiet: string[] = []) {
    const lines: string[] = [];
    return {
      lines,
      log: new MeterLog(
        { info: (line) => lines.push(`out ${line}`), error: (line) => lines.push(`err ${line}`) },
        quiet,
      ),
    };
  }

  it("announces a gap once and again when it closes", () => {
    const { lines, log } = sinkLog();
    for (let poll = 0; poll < 5; poll += 1) {
      log.report({ accountId: "anthropic-2", outcome: "expired-credential" });
    }
    log.report({ accountId: "anthropic-2", meterId: "anthropic-5h", outcome: "recorded", usedPercent: 12 });
    log.report({ accountId: "anthropic-2", outcome: "expired-credential" });

    expect(lines).toEqual([
      "err meter anthropic-2/?: expired-credential",
      "out meter anthropic-2/anthropic-5h: readable again (was expired-credential)",
      "out meter anthropic-2/anthropic-5h: 12% used",
      "err meter anthropic-2/?: expired-credential",
    ]);
  });

  it("reports a gap that changes, and the recovery of the meter that had it", () => {
    const { lines, log } = sinkLog();
    const cursor = { accountId: "cursor", meterId: "monthly" } as const;
    log.report({ ...cursor, outcome: "request-failed", detail: "HTTP 500" });
    log.report({ ...cursor, outcome: "request-failed", detail: "HTTP 502" });
    log.report({ ...cursor, outcome: "unreadable-response" });
    log.report({ ...cursor, outcome: "recorded", usedPercent: 40 });

    expect(lines).toEqual([
      "err meter cursor/monthly: request-failed (HTTP 500)",
      "err meter cursor/monthly: unreadable-response",
      "out meter cursor/monthly: readable again (was unreadable-response)",
      "out meter cursor/monthly: 40% used",
    ]);
  });

  it("keeps resting states silent", () => {
    const { lines, log } = sinkLog(["no-credential"]);
    log.report({ accountId: "anthropic-3", outcome: "not-due" });
    log.report({ accountId: "anthropic-3", outcome: "no-credential" });

    expect(lines).toEqual([]);
  });
});

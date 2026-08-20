import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { Ledger } from "../src/ledger/ledger.js";
import { CursorMeterSampler, parseCursorPeriodUsage } from "../src/meters/cursor.js";

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function workspace(auth: Record<string, unknown>): { ledger: Ledger; agentDir: string } {
  const dir = mkdtempSync(join(tmpdir(), "pi-orch-meters-"));
  dirs.push(dir);
  writeFileSync(join(dir, "auth.json"), JSON.stringify(auth));
  const ledger = Ledger.open(join(dir, "ledger.sqlite3"));
  ledger.upsertAccount({ id: "cursor", provider: "cursor", domain: "orchestrator" });
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

  it("skips accounts whose credential lives in another custody domain", async () => {
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

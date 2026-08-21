import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { Ledger } from "../src/ledger/ledger.js";
import usageLogger, { anthropicMeterReadings, baseProvider } from "../src/extension/usage-logger.js";

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

/** Header fixture copied verbatim from recorded production traffic. */
const PRODUCTION_HEADERS: Record<string, string> = {
  "anthropic-ratelimit-unified-5h-reset": "1787190600",
  "anthropic-ratelimit-unified-5h-status": "allowed",
  "anthropic-ratelimit-unified-5h-utilization": "0.0",
  "anthropic-ratelimit-unified-7d-reset": "1787209200",
  "anthropic-ratelimit-unified-7d-status": "allowed",
  "anthropic-ratelimit-unified-7d-utilization": "0.56",
  "anthropic-ratelimit-unified-7d_oi-reset": "1787209200",
  "anthropic-ratelimit-unified-7d_oi-status": "allowed",
  "anthropic-ratelimit-unified-7d_oi-utilization": "0.46",
  "anthropic-ratelimit-unified-status": "allowed",
  "request-id": "req_011CeCmVRNoVLKHXzTpXyv1t",
};

describe("usage-logger extension", () => {
  it("parses all three anthropic meters from production response headers", () => {
    const readings = anthropicMeterReadings(PRODUCTION_HEADERS, 1_787_000_000_000);
    expect(readings).toEqual([
      {
        meterId: "anthropic-5h",
        reading: { at: 1_787_000_000_000, usedPercent: 0, resetAt: 1_787_190_600_000 },
      },
      {
        meterId: "anthropic-7d",
        reading: { at: 1_787_000_000_000, usedPercent: 56, resetAt: 1_787_209_200_000 },
      },
      {
        meterId: "anthropic-7d_oi",
        reading: { at: 1_787_000_000_000, usedPercent: 46, resetAt: 1_787_209_200_000 },
      },
    ]);
  });

  it("ignores responses without rate-limit headers", () => {
    expect(anthropicMeterReadings({ "request-id": "abc" }, 0)).toEqual([]);
  });

  it("maps provider aliases to base providers for account rows", () => {
    expect(baseProvider("anthropic-3")).toBe("anthropic");
    expect(baseProvider("anthropic")).toBe("anthropic");
    expect(baseProvider("openai-codex")).toBe("openai-codex");
  });
});

/**
 * The wiring this covers: response headers report only the windows the
 * request was metered against, so an Opus session's ledger holds no Fable
 * meter at all. The extension polls the account usage endpoint to fill in
 * what the headers structurally cannot carry.
 */
describe("usage-logger meter poll", () => {
  it("polls the usage endpoint for the buckets the headers omit", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-orch-extension-"));
    dirs.push(dir);
    const ledgerPath = join(dir, "ledger.sqlite3");
    writeFileSync(join(dir, "auth.json"), JSON.stringify({
      anthropic: { type: "oauth", access: "token", expires: Date.now() + 3_600_000 },
    }));
    process.env.PI_ORCHESTRATOR_LEDGER = ledgerPath;
    process.env.PI_AGENT_DIR = dir;
    const handlers = new Map<string, (event: any, ctx: any) => Promise<void>>();
    let polls = 0;
    vi.stubGlobal("fetch", async () => {
      polls++;
      return new Response(JSON.stringify({
        limits: [
          { kind: "session", percent: 14 },
          { kind: "weekly_all", percent: 90 },
          { kind: "weekly_scoped", percent: 100, scope: { model: { display_name: "Fable" } } },
        ],
      }));
    });

    try {
      usageLogger({ on: (name: string, handler: any) => handlers.set(name, handler) } as any);
      // An Opus response: the scoped weekly header is simply not present.
      const opusHeaders = { ...PRODUCTION_HEADERS };
      delete opusHeaders["anthropic-ratelimit-unified-7d_oi-utilization"];
      delete opusHeaders["anthropic-ratelimit-unified-7d_oi-reset"];
      const ctx = { model: { provider: "anthropic" } };
      await handlers.get("after_provider_response")!({ headers: opusHeaders }, ctx);
      // A second response inside the sampling interval must not poll again.
      await handlers.get("after_provider_response")!({ headers: opusHeaders }, ctx);
      // Shutdown awaits the in-flight poll before closing the ledger handle.
      await handlers.get("session_shutdown")!({}, ctx);

      const ledger = Ledger.open(ledgerPath);
      expect(ledger.latestReading("anthropic", "anthropic-7d_oi")?.usedPercent).toBe(100);
      // One poll answers for every bucket, so the meters the headers do
      // carry are refreshed by the same reading rather than left behind.
      expect(ledger.latestReading("anthropic", "anthropic-7d")?.usedPercent).toBe(90);
      ledger.close();
      expect(polls).toBe(1);
    } finally {
      vi.unstubAllGlobals();
      delete process.env.PI_ORCHESTRATOR_LEDGER;
      delete process.env.PI_AGENT_DIR;
    }
  });
});

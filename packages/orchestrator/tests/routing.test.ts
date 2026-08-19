import { describe, expect, it } from "vitest";
import { Ledger, type AccountRow } from "../src/ledger/ledger.js";
import { pickAccount } from "../src/extension/select-account.js";
import { isRateLimitError } from "../src/extension/routing.js";

function account(partial: Partial<AccountRow> & { id: string }): AccountRow {
  return {
    provider: "anthropic",
    label: undefined,
    accessUntil: undefined,
    cooldownUntil: undefined,
    lastBoundAt: undefined,
    createdAt: 0,
    ...partial,
  };
}

describe("interactive account selection", () => {
  it("least-used account wins", () => {
    const usage = new Map([
      ["anthropic", 62],
      ["anthropic-2", 17],
      ["anthropic-3", 40],
    ]);
    const picked = pickAccount(
      [account({ id: "anthropic" }), account({ id: "anthropic-2" }), account({ id: "anthropic-3" })],
      "anthropic",
      0,
      (id) => usage.get(id),
    );
    expect(picked?.id).toBe("anthropic-2");
  });

  it("an account with no readings sorts first and starts earning calibration", () => {
    const picked = pickAccount(
      [account({ id: "anthropic" }), account({ id: "anthropic-new" })],
      "anthropic",
      0,
      (id) => (id === "anthropic" ? 5 : undefined),
    );
    expect(picked?.id).toBe("anthropic-new");
  });

  it("integer-percent ties round-robin by least-recently-bound", () => {
    const accounts = [
      account({ id: "anthropic", lastBoundAt: 300 }),
      account({ id: "anthropic-2", lastBoundAt: 100 }),
      account({ id: "anthropic-3", lastBoundAt: 200 }),
    ];
    // All report the same integer percent: rotation, not pile-on.
    expect(pickAccount(accounts, "anthropic", 0, () => 30)?.id).toBe("anthropic-2");
  });

  it("cooling, expired, foreign-family, and excluded accounts are skipped", () => {
    const accounts = [
      account({ id: "anthropic", cooldownUntil: 5000 }),
      account({ id: "anthropic-2", accessUntil: 500 }),
      account({ id: "codex-1", provider: "openai-codex" }),
      account({ id: "anthropic-3" }),
      account({ id: "anthropic-4" }),
    ];
    const picked = pickAccount(accounts, "anthropic", 1000, () => 0, new Set(["anthropic-3"]));
    expect(picked?.id).toBe("anthropic-4");
    // A passed cooldown deadline makes the account eligible again.
    expect(pickAccount(accounts, "anthropic", 6000, () => 0, new Set(["anthropic-3", "anthropic-4"]))?.id).toBe(
      "anthropic",
    );
  });

  it("no eligible account yields undefined rather than a bad binding", () => {
    expect(pickAccount([account({ id: "anthropic", cooldownUntil: 99 })], "anthropic", 0, () => 0)).toBeUndefined();
  });
});

describe("ledger-backed usage view", () => {
  it("latestUsedPercent is the most binding meter's latest reading", () => {
    const ledger = Ledger.open(":memory:");
    ledger.upsertAccount({ id: "anthropic", provider: "anthropic" });
    ledger.recordReading("anthropic", "anthropic-5h", { at: 1000, usedPercent: 80 });
    ledger.recordReading("anthropic", "anthropic-5h", { at: 2000, usedPercent: 12 });
    ledger.recordReading("anthropic", "anthropic-7d", { at: 1500, usedPercent: 44 });
    // 5h meter's *latest* value (12) is stale-proof; 7d latest is 44 -> max 44.
    expect(ledger.latestUsedPercent("anthropic")).toBe(44);
    expect(ledger.latestUsedPercent("missing")).toBeUndefined();
  });
});

describe("failover triggers", () => {
  it("recognizes real provider exhaustion messages", () => {
    for (const message of [
      "429 Too Many Requests",
      "Rate limit reached for requests",
      "You have hit your usage limit.",
      "Overloaded",
      "insufficient_quota: You exceeded your current quota",
    ]) {
      expect(isRateLimitError(message)).toBe(true);
    }
  });

  it("does not treat ordinary errors as exhaustion", () => {
    for (const message of [
      "ECONNRESET",
      "Invalid API key",
      "model not found",
      "context length exceeded",
    ]) {
      expect(isRateLimitError(message)).toBe(false);
    }
  });
});

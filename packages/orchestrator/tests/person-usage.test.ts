import { test, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store.js";
import { modelPrices, personUsage } from "../src/person-usage.js";

test("usage is attributed to broker principals, their completions, and otherwise the ledger owner", () => {
  const root = mkdtempSync(join(tmpdir(), "person-usage-"));
  const store = Store.open(join(root, "ledger.sqlite3"));
  try {
    store.upsertAccount({ id: "account", provider: "openai-codex" });
    const hour = 10 * 3_600_000;
    const record = (source: string, runId: string, model: string, component: "input" | "output" | "cacheRead", tokens: number, at = hour) =>
      store.recordUsage({ accountId: "account", hour: at, source, runId, model, component, tokens });
    record("interactive", "broker:sybil:1", "priced", "input", 1_000_000);
    record("interactive", "broker:sybil:2", "priced", "cacheRead", 1_000_000);
    record("interactive", "owner-session", "priced", "output", 1_000_000);
    record("fleet", "fleet-run", "priced", "input", 1_000_000);
    record("completion", "completion-run", "unpriced", "output", 500);
    store.setControl("completion-run:completion-run", "broker-abc");
    store.setControl("completion:broker-abc", JSON.stringify({ access: { principal: "jodie" } }));
    record("interactive", "broker:sybil:old", "priced", "input", 9_000_000, hour - 3_600_000);
    const prices = { priced: { input: 2, output: 10, cacheRead: 0.5, cacheWrite: 2.5 } };
    const window = personUsage(store, hour, hour + 3_600_000, model => prices[model as "priced"]);
    expect(window.rows.map(row => row.principal)).toEqual([null, "sybil", "jodie"]);
    const [owner, sybil, jodie] = window.rows;
    expect(owner).toMatchObject({ tokens: 2_000_000, value: 12, unpricedTokens: 0 });
    expect(owner!.sources.fleet).toEqual({ tokens: 1_000_000, value: 2 });
    expect(owner!.sources.interactive).toEqual({ tokens: 1_000_000, value: 10 });
    expect(sybil).toMatchObject({ tokens: 2_000_000, value: 2.5 });
    expect(jodie).toMatchObject({ tokens: 500, value: 0, unpricedTokens: 500 });
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("list prices cover catalog and retired pooled models", () => {
  const prices = modelPrices();
  expect(prices.get("claude-fable-5-1")?.output).toBeGreaterThan(0);
  expect(prices.get("gpt-6-astra")?.input).toBeGreaterThan(0);
});

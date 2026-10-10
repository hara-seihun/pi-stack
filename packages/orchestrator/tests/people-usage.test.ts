import { expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../src/store.js";
import { personUsageAcrossStores } from "../src/person-usage.js";

test("host analytics preserve each old ledger owner's attribution and frozen spend, deduplicating only a shared pool", () => {
  const root = mkdtempSync(join(tmpdir(), "people-usage-"));
  const stores = [Store.open(join(root, "one.sqlite3")), Store.open(join(root, "two.sqlite3"))];
  try {
    const now = Date.now(), hour = Math.floor(now / 3_600_000) * 3_600_000;
    for (const [index, store] of stores.entries()) {
      store.upsertAccount({ id: "codex", provider: "openai-codex", label: "Private subscription label" });
      store.recordUsage({ runId: "owner-usage", accountId: "codex", model: "gpt-6-luna", component: "input", tokens: 1000 * (index + 1), source: "interactive", hour });
      store.db.prepare("INSERT INTO usage_rate(provider,hour,rate) VALUES(?,?,?)").run("openai-codex", hour, index + 1);
    }
    const ledgers = stores.map((store, index) => ({ store, ownerPrincipal: index ? "bob" : "alice", accountPoolId: "shared-auth" }));
    const window = personUsageAcrossStores(ledgers, hour, now);
    expect(window.rows.map(row => [row.principal, row.tokens]).sort()).toEqual([["alice", 1000], ["bob", 2000]]);
    expect(window.rows.every(row => row.spend > 0)).toBe(true);
    expect(window.subscriptions.find(plan => plan.provider === "openai-codex")).toMatchObject({ accounts: 1, rate: null });
    expect(JSON.stringify(window)).not.toContain("Private subscription label");
    ledgers[1]!.accountPoolId = "independent-auth";
    expect(personUsageAcrossStores(ledgers, hour, now).subscriptions.find(plan => plan.provider === "openai-codex")?.accounts).toBe(2);
    expect(() => personUsageAcrossStores([ledgers[0]!, ledgers[0]!], hour, now)).toThrow("unique");
  } finally { for (const store of stores) store.close(); rmSync(root, { recursive: true, force: true }); }
});

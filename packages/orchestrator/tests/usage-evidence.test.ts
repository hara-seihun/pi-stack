import { test, expect } from "vitest";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store.js";
import { readUsageEvidence } from "../src/usage-evidence.js";

test("usage evidence is read-only, bounded, and omits account and session identities", () => {
  const root = mkdtempSync(join(tmpdir(), "usage-evidence-")), path = join(root, "ledger.sqlite3");
  try {
    expect(readUsageEvidence(path).ok).toBe(false);
    expect(existsSync(path)).toBe(false);
    const now = Date.now(), store = Store.open(path);
    store.upsertAccount({ id: "account", provider: "openai-codex", label: "PRIVATE LABEL" });
    store.recordMeter("account", "codex-7d", 10, now + 86400000, now);
    store.recordUsage({ accountId: "account", hour: Math.floor(now / 3600000) * 3600000,
      source: "interactive", runId: "PRIVATE SESSION", model: "gpt-6-astra", component: "input", tokens: 123 });
    store.close();
    const before = readFileSync(path);
    const result = readUsageEvidence(path, now + 1);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.hours).toHaveLength(1);
    expect(result.value.hours[0]!.tokens).toBe(123);
    expect(result.value.weeklyMeters.find(m => m.id === "anthropic-7d_oi")!.models).toEqual(["claude-fable-5-1"]);
    expect(JSON.stringify(result.value)).not.toContain("PRIVATE");
    expect(readFileSync(path)).toEqual(before);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

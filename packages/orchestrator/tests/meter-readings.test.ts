import { expect, it } from "vitest";
import { Store } from "../src/store.js";

it.each([["codex-7d", "openai-codex"], ["anthropic-7d", "anthropic"]] as const)("applies same-millisecond %s corrections without losing history or changing sibling readings", (meterId, provider) => {
  const store = Store.open(":memory:"), at = Date.UTC(2026, 9, 5), resetAt = at + 604800000;
  try {
    store.upsertAccount({ id: "account", provider });
    store.upsertAccount({ id: "sibling", provider });
    store.recordMeter("account", meterId, 99, resetAt, at - 1);
    store.recordMeter("account", meterId, 100, resetAt, at);
    store.recordMeter("account", "other", 20, resetAt, at);
    store.recordMeter("sibling", meterId, 30, resetAt, at);

    store.recordReading("account", meterId, { at, usedPercent: 0, resetAt: resetAt + 604800000 });
    expect(store.latestReading("account", meterId)).toEqual({ at, usedPercent: 0, resetAt: resetAt + 604800000 });
    expect(store.latestMeters("account").find(row => row.meter_id === meterId)?.used_percent).toBe(0);
    expect(store.meters("account").filter(row => row.meter_id === meterId)).toHaveLength(2);
    expect(store.latestReading("account", "other")?.usedPercent).toBe(20);
    expect(store.latestReading("sibling", meterId)?.usedPercent).toBe(30);

    store.recordReading("account", meterId, { at: at - 1, usedPercent: 98, resetAt });
    expect(store.latestReading("account", meterId)?.usedPercent).toBe(0);
    store.recordReading("account", meterId, { at, usedPercent: 1 });
    expect(store.latestReading("account", meterId)).toEqual({ at, usedPercent: 1, resetAt: undefined });
  } finally {
    store.close();
  }
});

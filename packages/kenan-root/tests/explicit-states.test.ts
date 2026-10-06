import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseRootRequest } from "../src/requests.js";
import { RootConsentManager } from "../src/consent.js";

test("stored root lifecycle rejects unknown states, delivery variants and incomplete replies", () => {
  for (const record of [
    { state: "pending", delivery: "pending" },
    { state: "executing", delivery: "new_delivery" },
    { state: "completed", delivery: "delivered" },
    { state: "finalizing", delivery: "pending", chosen: { reply: "chosen" } },
  ]) expect(() => parseRootRequest(JSON.stringify(record))).toThrow();
  for (const state of ["executing", "failed", "interrupted"])
    expect(parseRootRequest(JSON.stringify({ state, delivery: "pending" })).state).toBe(state);
});

test("unsupported durable consent or notification states cannot report delivery success", async () => {
  let effects = 0;
  const unavailable = async () => { effects++; throw new Error("Unexpected side effect"); };
  const directory = mkdtempSync(join(tmpdir(), "root-explicit-states-"));
  const manager = new RootConsentManager(join(directory, "consent.sqlite3"), { enabled: () => true,
    bridge: { question: unavailable, answer: unavailable, reply: unavailable, notify: unavailable },
    memory: unavailable, executor: unavailable });
  try {
    // Exercise the reconciliation boundary with corrupted persisted discriminators.
    const reconcile = manager as unknown as {
      advance(row: unknown): Promise<{ ok: boolean }>;
      advanceNotification(row: unknown): Promise<{ ok: boolean }>;
    };
    expect((await reconcile.advance({ state: "unknown" })).ok).toBe(false);
    expect((await reconcile.advanceNotification({ state: "unknown" })).ok).toBe(false);
    expect((await reconcile.advanceNotification({ state: "failed" })).ok).toBe(false);
    expect((await reconcile.advance({ state: "delivered" })).ok).toBe(true);
    expect((await reconcile.advanceNotification({ state: "delivered" })).ok).toBe(true);
    expect(effects).toBe(0);
  } finally { manager.close(); rmSync(directory, { recursive: true, force: true }); }
});

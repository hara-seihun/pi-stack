import { expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store.js";
import { assign } from "../src/policy.js";
import { allowsAccountUse } from "../src/domain.js";
import { transactSharedCredential } from "../src/auth/shared-oauth.js";
import { loadConfig } from "../src/config.js";
import { catalogModel } from "../src/catalog.js";
import { outputLimitContinuation } from "../src/host/continuations.js";

const config = loadConfig("/missing");
const candidate = { ...catalogModel("astra")!, thinking: "xhigh" };

it("retains calling-account exclusion and exact model selection across ledger reopen", () => {
  const root = mkdtempSync(join(tmpdir(), "provider-custody-")), ledger = join(root, "ledger.sqlite3");
  let store = Store.open(ledger);
  try {
    for (const id of ["a", "b"]) store.upsertAccount({ id, provider: "openai-codex" });
    store.setControl("account-use:a", "voice");
    store.close(); store = Store.open(ledger);
    expect(assign(store, candidate, "force", config).assignment).toMatchObject({ accountId: "b", model: candidate.model, thinking: "xhigh" });
    expect(assign(store, candidate, "force", config, Date.now(), "a").assignment).toBeUndefined();
    expect(allowsAccountUse(store.account("a")!, "interactive")).toBe(false);
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

it.each(["background", "force", "live"] as const)("%s account admission preserves pauses, exhaustion and explicit model", budget => {
  const store = Store.open(":memory:");
  try {
    store.upsertAccount({ id: "a", provider: "openai-codex" });
    expect(assign(store, candidate, budget, config).assignment?.model).toBe(candidate.model);
    store.setControl("launches", "paused");
    expect(assign(store, candidate, budget, config).refusals[0]?.reason).toBe("emergency halt");
    store.setControl("launches", "enabled");
    store.recordMeter("a", "codex-7d", 100, Date.now() + 3_600_000);
    expect(assign(store, candidate, budget, config).refusals[0]?.reason).toBe("provider quota exhausted");
  } finally { store.close(); }
});

it("does not put historical factory runs in provider admission", () => {
  const store = Store.open(":memory:");
  try {
    store.createRuns({ count: 1, source: "lane", sourceId: "held-research", prompt: "historical", cwd: "/tmp", profile: "sol", budget: "force" });
    expect(store.admissionQueue()).toEqual([]);
    expect(store.runs()).toHaveLength(1);
  } finally { store.close(); }
});

it("rolls back credential custody when account import fails", async () => {
  const root = mkdtempSync(join(tmpdir(), "provider-auth-")), path = join(root, "auth.json");
  try {
    writeFileSync(path, "{}\n");
    await expect(transactSharedCredential(path, "a", { type: "oauth", access: "access", refresh: "refresh", expires: Date.now() + 60_000 }, async () => { throw new Error("ledger unavailable"); })).rejects.toThrow("ledger unavailable");
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({});
  } finally { rmSync(root, { recursive: true, force: true }); }
});

it("continues a provider-truncated turn without continuing an ordinary settled output", () => {
  expect(outputLimitContinuation([{ role: "assistant", stopReason: "length" }, { role: "toolResult", isError: true }])).toContain("pick up exactly where you stopped");
  expect(outputLimitContinuation([{ role: "assistant", stopReason: "stop" }])).toBeUndefined();
});

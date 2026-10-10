import { afterEach, expect, test, vi } from "vitest";
import { createServer } from "node:http";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store.js";
import { CompletionService } from "../src/completion.js";
import { loadBrokerConfig } from "../src/model-broker.js";
import { createCoreProvider, parseCoreProviderConfig, type CoreProviderConfig } from "../src/core/provider.js";
import { acquireDatabaseOwnership } from "../src/core/ownership.js";
import { brokerUsageAcrossStores, WeeklyAllowances } from "../src/broker-usage.js";
import type { PermissionPolicy } from "../src/permissions.js";

vi.mock("../src/model-broker.js", async importOriginal => ({ ...await importOriginal<typeof import("../src/model-broker.js")>(), loadBrokerConfig: vi.fn() }));
const roots: string[] = [];
afterEach(() => { vi.clearAllMocks(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const principal = { kind: "person", id: "kenan", person: "kenan" } as const;
const resource = { id: "provider", kind: "model", owner: "kenan", privacy: "private", subjects: ["kenan"], consent: "not-required" } as const;
const policy: PermissionPolicy = { revision: 1, consents: [], grants: [{ id: "provider-owner", principal: "kenan", resource: { kind: "exact", id: "provider" }, actions: ["use", "read", "write"], effect: "allow", validFrom: 0, validUntil: null, issuedBy: "owner", source: "fixture" }] };
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "core-provider-")); roots.push(root);
  const store = Store.open(join(root, "pool.sqlite3")), retained = Store.open(join(root, "fleet.sqlite3"));
  const input = { model: "luna", prompt: "retained", thinkingLevel: "low", speed: "standard" } as const;
  const submitted = new CompletionService(retained, root).submit("unchanged-old-id", input);
  if (!submitted.ok) throw Error(submitted.error.message);
  const receipt = (id: string, path: string) => {
    const s = statSync(path, { bigint: true }), receiptPath = join(root, `${id}.json`);
    writeFileSync(receiptPath, JSON.stringify({ version: 1, state: "detached", scopeId: id, databasePath: path, databaseIdentity: { dev: String(s.dev), ino: String(s.ino) }, previousOwner: { identity: "old-generation", detachedAt: new Date().toISOString() } }), { mode: 0o600 });
    return receiptPath;
  };
  const brokerConfig = { ledgerPath: store.path, authPath: join(root, "auth.json"), listeners: [{ principal: "kenan", port: 19100, accounts: ["codex"], models: ["openai-codex/gpt-6-luna"], maxInFlight: 5 }], grantOwner: "core" };
  vi.mocked(loadBrokerConfig).mockReturnValue(brokerConfig);
  const config: Extract<CoreProviderConfig, { kind: "configured" }> = { kind: "configured", configPath: join(root, "broker.json"), adoptionReceiptPath: receipt("provider", store.path), uid: process.getuid!(), gid: process.getgid!(), home: root, agentDir: root, availabilityPath: join(root, "models.json"), releasePath: root, meterMaxAgeMs: 60_000, autoReset: false, resource: { ...resource, subjects: [...resource.subjects] }, retainedLedgers: [{ id: "fleet", databasePath: retained.path, adoptionReceiptPath: receipt("fleet", retained.path), uid: process.getuid!(), gid: process.getgid!(), home: root, authPath: brokerConfig.authPath, agentDir: root }], completionAliases: [{ principal: "kenan", requestId: "public-id", storedRequestId: "unchanged-old-id", ownerId: "fleet" }] };
  store.close(); retained.close();
  return { config, root, runId: submitted.value.runId };
}

test("provider registry requires explicit retained descriptors and exact alias identities", () => {
  const { config } = fixture();
  expect(parseCoreProviderConfig(config, policy, principal).ok).toBe(true);
  expect(parseCoreProviderConfig({ ...config, retainedLedgers: undefined }, policy, principal).ok).toBe(false);
  expect(parseCoreProviderConfig({ ...config, completionAliases: undefined }, policy, principal).ok).toBe(false);
  expect(parseCoreProviderConfig({ ...config, completionAliases: [...config.completionAliases, ...config.completionAliases] }, policy, principal).ok).toBe(false);
  expect(parseCoreProviderConfig({ ...config, completionAliases: [{ ...config.completionAliases[0], ownerId: "undeclared" }] }, policy, principal).ok).toBe(false);
});

test("core adopts each exact ledger under its receipt/lock and serves old IDs without initialization or replay", async () => {
  const { config, runId } = fixture(), opened = createCoreProvider(config, policy);
  expect(opened.ok).toBe(true); if (!opened.ok) return;
  const provider = opened.value;
  const server = createServer((req, res) => {
    void provider.request(principal, new Request(`http://127.0.0.1${req.url}`, { method: req.method }), req, res).then(response => {
      if (!response) return;
      res.writeHead(response.status, Object.fromEntries(response.headers)); void response.text().then(text => res.end(text));
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const descriptor = config.retainedLedgers[0]!;
    const competing = acquireDatabaseOwnership({ id: descriptor.id, databasePath: descriptor.databasePath, adoptionReceiptPath: descriptor.adoptionReceiptPath, uid: descriptor.uid }, path => path);
    expect(competing.ok).toBe(false);
    const address = server.address(); if (!address || typeof address === "string") throw Error("No fixture listener");
    const response = await fetch(`http://127.0.0.1:${address.port}/v1/model-broker/v1/completions/public-id`);
    expect(response.status).toBe(200); expect(await response.json()).toMatchObject({ requestId: "public-id", runId, state: "queued" });
    expect(provider.imageAccounts.store.runs()).toHaveLength(0);
  } finally { await provider.close(); await new Promise<void>(resolve => server.close(() => resolve())); }
  const descriptor = config.retainedLedgers[0]!;
  const successor = acquireDatabaseOwnership({ id: descriptor.id, databasePath: descriptor.databasePath, adoptionReceiptPath: descriptor.adoptionReceiptPath, uid: descriptor.uid }, path => path);
  expect(successor.ok).toBe(true); if (successor.ok) successor.value.close();
});

test("one missing detached-ledger receipt rejects the registry and releases acquired locks", () => {
  const { config } = fixture();
  config.retainedLedgers[0]!.adoptionReceiptPath = join(config.agentDir, "missing-receipt.json");
  expect(createCoreProvider(config, policy).ok).toBe(false);
  const successor = acquireDatabaseOwnership({ id: "provider", databasePath: vi.mocked(loadBrokerConfig).mock.results[0]!.value.ledgerPath, adoptionReceiptPath: config.adoptionReceiptPath, uid: config.uid }, path => path);
  expect(successor.ok).toBe(true); if (successor.ok) successor.value.close();
});

test("usage projection and allowance include retained usage once, without labels or other principals", () => {
  const root = mkdtempSync(join(tmpdir(), "retained-usage-")); roots.push(root);
  const stores = [Store.open(join(root, "one.sqlite3")), Store.open(join(root, "two.sqlite3"))];
  try {
    const now = Date.now(), hour = Math.floor(now / 3_600_000) * 3_600_000;
    for (const [index, store] of stores.entries()) {
      store.upsertAccount({ id: "codex", provider: "openai-codex", label: "Private account name" });
      store.recordMeter("codex", "codex-7d", 10 + index, now + 7 * 24 * 3_600_000, now - (1 - index) * 1_000);
      store.recordUsage({ runId: `broker:kenan:${index}`, accountId: "codex", model: "gpt-6-luna", component: "input", tokens: 1000 * (index + 1), source: "interactive", hour });
      store.db.prepare("INSERT INTO usage_rate(provider,hour,rate) VALUES(?,?,?)").run("openai-codex", hour, 2);
    }
    const combined = brokerUsageAcrossStores(stores, "kenan", ["codex"], now);
    const week = Object.values(combined.personal.periods.week.plans).reduce((sum, figures) => sum + figures.tokens, 0);
    expect(week).toBe(3000);
    const spent = stores.reduce((sum, store) => sum + new WeeklyAllowances(store).spent("kenan", 0, now), 0);
    expect(Object.values(combined.personal.periods.week.plans).reduce((sum, figures) => sum + figures.spend, 0)).toBeCloseTo(spent);
    const observations = Object.values(combined.plans.plans).flatMap(plan => Object.values(plan.metrics).flatMap(metric => metric.accounts));
    expect(observations.every(account => account.accountLabel === "codex")).toBe(true);
    expect(brokerUsageAcrossStores(stores, "other", ["codex"], now).personal.periods.week.plans).not.toEqual(combined.personal.periods.week.plans);
    expect(() => brokerUsageAcrossStores([stores[0]!, stores[0]!], "kenan", ["codex"])).toThrow("unique");
  } finally { for (const store of stores) store.close(); }
});

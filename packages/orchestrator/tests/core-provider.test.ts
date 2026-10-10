import { afterEach, expect, test, vi } from "vitest";
import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import { verifyBrokerDrainReceipt, verifyLiveBrokerIdentity } from "../src/core/broker-transports.js";
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store.js";
import { ProviderController } from "../src/provider-controller.js";
import { CompletionService } from "../src/completion.js";
import { loadBrokerConfig } from "../src/model-broker.js";
import { createCoreProvider, parseCoreProviderConfig, type CoreProviderConfig } from "../src/core/provider.js";
import { acquireDatabaseOwnership } from "../src/core/ownership.js";
import { brokerUsageAcrossStores, WeeklyAllowances } from "../src/broker-usage.js";
import type { PermissionPolicy, Principal } from "../src/permissions.js";

vi.mock("../src/core/broker-transports.js", async importOriginal => ({ ...await importOriginal<typeof import("../src/core/broker-transports.js")>(), verifyBrokerDrainReceipt: vi.fn(() => ({ ok: true, value: undefined })), verifyLiveBrokerIdentity: vi.fn(async () => ({ ok: true, value: undefined })) }));
vi.mock("../src/model-broker.js", async importOriginal => ({ ...await importOriginal<typeof import("../src/model-broker.js")>(), loadBrokerConfig: vi.fn() }));
const roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const principal = { kind: "person", id: "kenan", person: "kenan" } as const;
const resource = { id: "provider", kind: "model", owner: "kenan", privacy: "private", subjects: ["kenan"], consent: "not-required" } as const;
const peopleResource = { ...resource, id: "people-usage", kind: "data" as const };
const policy: PermissionPolicy = { revision: 1, consents: [], grants: [{ id: "people-reader", principal: "kenan", resource: { kind: "exact", id: "people-usage" }, actions: ["read"], effect: "allow", validFrom: 0, validUntil: null, issuedBy: "owner", source: "fixture" }, { id: "provider-owner", principal: "kenan", resource: { kind: "exact", id: "provider" }, actions: ["use", "read", "write"], effect: "allow", validFrom: 0, validUntil: null, issuedBy: "owner", source: "fixture" }] };
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
  const config: Extract<CoreProviderConfig, { kind: "configured" }> = { kind: "configured", primaryConfigPath: join(root, "broker.json"), configPaths: [join(root, "broker.json")], grantFootprints: [{ configPath: join(root, "broker.json"), ledgerOwnerIds: ["current", "fleet"] }], ownerRoutes: [], adoptionReceiptPath: receipt("provider", store.path), uid: process.getuid!(), gid: process.getgid!(), home: root, agentDir: root, availabilityPath: join(root, "models.json"), releasePath: root, meterMaxAgeMs: 60_000, autoReset: false, resource: { ...resource, subjects: [...resource.subjects] }, peopleUsageResource: { ...peopleResource, subjects: [...peopleResource.subjects] }, ownerPrincipal: "kenan", retainedListeners: { kind: "disabled" }, retainedLedgers: [{ id: "fleet", ownerPrincipal: "kenan", databasePath: retained.path, adoptionReceiptPath: receipt("fleet", retained.path), uid: process.getuid!(), gid: process.getgid!(), home: root, authPath: brokerConfig.authPath, agentDir: root, meterMaxAgeMs: 30_000, autoReset: false }], completionAliases: [{ principal: "kenan", requestId: "public-id", storedRequestId: "unchanged-old-id", ownerId: "fleet" }] };
  store.close(); retained.close();
  return { config, brokerConfig, root, runId: submitted.value.runId };
}

test("original grant owners and footprints stay partitioned, including absent owners and per-ledger meter policy", async () => {
  const { config, brokerConfig } = fixture();
  const other = { kind: "person", id: "other", person: "other" } as const;
  const otherPath = join(config.agentDir, "other-broker.json");
  const otherConfig = { ledgerPath: brokerConfig.ledgerPath, authPath: brokerConfig.authPath, listeners: [{ ...brokerConfig.listeners[0]!, principal: "other", port: 19101 }] };
  config.configPaths.push(otherPath);
  config.grantFootprints = [{ configPath: config.primaryConfigPath, ledgerOwnerIds: ["current"] }, { configPath: otherPath, ledgerOwnerIds: ["fleet"] }];
  config.completionAliases = [];
  const retained = Store.open(config.retainedLedgers[0]!.databasePath);
  retained.publishBrokerGrants([{ principal: "stale", accounts: [], models: [] }]);
  retained.publishBrokerGrants([{ principal: "unrelated", accounts: ["kept"], models: [] }], "unrelated-source");
  retained.close();
  vi.mocked(loadBrokerConfig).mockImplementation(path => path === otherPath ? otherConfig : brokerConfig);
  const freshness: number[] = [];
  vi.spyOn(ProviderController.prototype, "reconcile").mockImplementation(async function (this: ProviderController) { freshness.push(this.config.meterMaxAgeMs); });
  const opened = createCoreProvider(config, policy, [principal, other]);
  expect(opened.ok).toBe(true); if (!opened.ok) return;
  try {
    const current = opened.value.imageAccounts.store;
    expect(current.brokerGrant("kenan")).toEqual({ accounts: ["codex"], models: ["openai-codex/gpt-6-luna"] });
    expect(current.control("broker-grant-owner:kenan")).toBe("core");
    expect(current.brokerGrant("other")).toBeUndefined();
    await opened.value.reconcile();
    expect(freshness.sort()).toEqual([30_000, 60_000]);
  } finally { await opened.value.close(); }
  const adopted = Store.open(config.retainedLedgers[0]!.databasePath);
  try {
    expect(adopted.brokerGrant("kenan")).toBeUndefined();
    expect(adopted.brokerGrant("other")).toEqual({ accounts: ["codex"], models: ["openai-codex/gpt-6-luna"] });
    expect(adopted.control("broker-grant-owner:other")).toBeUndefined();
    expect(adopted.brokerGrant("stale")).toBeUndefined();
    expect(adopted.brokerGrant("unrelated")).toEqual({ accounts: ["kept"], models: [] });
  } finally { adopted.close(); }
});

test("original owner routes retain stored IDs, exact callers and distinct control permissions", async () => {
  const { config, runId } = fixture();
  config.completionAliases = [];
  const keys = ["completionRead", "completionSubmit", "completionRetry", "completionCancel", "providerRead", "providerControl"] as const;
  const resources = Object.fromEntries(keys.map(key => [key, { ...resource, subjects: [...resource.subjects], id: `fleet-${key}` }])) as unknown as typeof config.ownerRoutes[number]["resources"];
  config.ownerRoutes = [{ ownerId: "fleet", scopeId: "fleet", callerPrincipals: ["kenan"], budget: "background", resources }];
  const ownPolicy: PermissionPolicy = { ...policy, grants: [...policy.grants, ...keys.map(key => ({ id: key, principal: "kenan", resource: { kind: "exact" as const, id: resources[key].id }, actions: [key.endsWith("Read") ? "read" as const : key === "completionSubmit" ? "use" as const : "control" as const], effect: "allow" as const, validFrom: 0, validUntil: null, issuedBy: "owner", source: "fixture" }))] };
  const opened = createCoreProvider(config, ownPolicy, [principal], () => ({ ok: true, value: { threads: [], running: { total: 0, lanes: new Map() }, custody: new Map() } }));
  expect(opened.ok).toBe(true); if (!opened.ok) return;
  const req = new IncomingMessage(new Socket()), res = new ServerResponse(req);
  const call = async (path: string, method = "GET", body?: unknown, actor: Principal = principal) => {
    const response = await opened.value.request(actor, new Request(`http://core/v1/providers/owners/fleet/v1/${path}`, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), req, res);
    if (!(response instanceof Response)) throw Error("Expected direct owner response");
    return response;
  };
  try {
    const read = await call("completions/unchanged-old-id");
    expect(read.status).toBe(200); expect(await read.json()).toMatchObject({ requestId: "unchanged-old-id", runId });
    const replay = await call("completions/unchanged-old-id", "PUT", { model: "luna", prompt: "retained", thinkingLevel: "low", speed: "standard" });
    expect(replay.status).toBe(200); expect(await replay.json()).toMatchObject({ runId });
    expect((await call("completions/unchanged-old-id/attempts")).status).toBe(200);
    expect((await call("completions/openapi.json")).status).toBe(200);
    expect((await call("completions/unchanged-old-id", "GET", undefined, { kind: "person", id: "other", person: "other" })).status).toBe(403);
    expect((await call("accounts/codex/reservation", "PUT", { reason: "bounded", metadata: { campaign: "one" } })).status).toBe(200);
    expect(await (await call("accounts/codex/reservation")).json()).toMatchObject({ reservation: { reason: "bounded", metadata: { campaign: "one" } } });
    expect((await call("accounts/codex/reservation", "DELETE")).status).toBe(200);
    expect((await call("accounts/codex/reservation", "PUT", { metadata: {} })).status).toBe(400);
    ownPolicy.grants = ownPolicy.grants.filter(g => g.id !== "completionCancel");
    expect((await call("completions/unchanged-old-id/cancel", "POST")).status).toBe(403);
    expect(opened.value.imageAccounts.store.runs()).toHaveLength(0);
  } finally { await opened.value.close(); req.destroy(); }
});

test("provider registry requires explicit retained descriptors and exact alias identities", () => {
  const { config } = fixture();
  expect(parseCoreProviderConfig(config, policy, principal).ok).toBe(true);
  expect(parseCoreProviderConfig({ ...config, retainedLedgers: undefined }, policy, principal).ok).toBe(false);
  expect(parseCoreProviderConfig({ ...config, completionAliases: undefined }, policy, principal).ok).toBe(false);
  expect(parseCoreProviderConfig({ ...config, completionAliases: [...config.completionAliases, ...config.completionAliases] }, policy, principal).ok).toBe(false);
  expect(parseCoreProviderConfig({ ...config, completionAliases: [{ ...config.completionAliases[0], ownerId: "undeclared" }] }, policy, principal).ok).toBe(false);
});

test("core adopts each exact ledger under its receipt/lock and serves old IDs without initialization or replay", async () => {
  const { config, runId } = fixture(), opened = createCoreProvider(config, policy, [principal]);
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
  expect(createCoreProvider(config, policy, [principal]).ok).toBe(false);
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

test("retained listeners keep immutable routes in the core and recheck host identity and unified policy per request", async () => {
  const { config, brokerConfig } = fixture();
  const reservation = createServer(); await new Promise<void>(resolve => reservation.listen(0, "127.0.0.1", resolve));
  const address = reservation.address(); if (!address || typeof address === "string") throw Error("No reserved port");
  await new Promise<void>(resolve => reservation.close(() => resolve()));
  brokerConfig.listeners[0]!.port = address.port;
  config.retainedListeners = { kind: "uid-bound", adoptionReceiptPath: join(config.agentDir, "broker-drain.json"), bindings: [{ principalId: "kenan", port: address.port, uid: process.getuid!(), authorizedUids: [0, process.getuid!()], family: "inet", table: "pi_user_access", inputChain: "input", outputChain: "output" }] };
  const mutablePolicy = { ...policy, grants: [...policy.grants] }, opened = createCoreProvider(config, mutablePolicy, [principal]);
  expect(opened.ok).toBe(true); if (!opened.ok) return;
  try {
    expect(await opened.value.startTransports()).toMatchObject({ ok: true });
    const url = `http://127.0.0.1:${address.port}/v1/completions/public-id`;
    expect((await fetch(url)).status).toBe(200);
    expect(verifyBrokerDrainReceipt).toHaveBeenCalledTimes(2);
    expect(verifyLiveBrokerIdentity).toHaveBeenCalledTimes(2);
    mutablePolicy.grants = [];
    expect((await fetch(url)).status).toBe(403);
    expect(verifyLiveBrokerIdentity).toHaveBeenCalledTimes(3);
  } finally { await opened.value.close(); }
});

test("an undrained old broker refuses adoption before acquiring or changing a ledger", () => {
  const { config, brokerConfig } = fixture();
  config.retainedListeners = { kind: "uid-bound", adoptionReceiptPath: "/missing/drain", bindings: [] };
  vi.mocked(verifyBrokerDrainReceipt).mockReturnValueOnce({ ok: false, error: { code: "ownership-conflict", message: "Old broker still owns accepted streams" } });
  expect(createCoreProvider(config, policy, [principal])).toMatchObject({ ok: false, error: { code: "ownership-conflict" } });
  expect(existsSync(`${brokerConfig.ledgerPath}.core-owner.lock`)).toBe(false);
});

test("people analytics have their own explicit read grant, exact periods and no account labels", async () => {
  const { config } = fixture(), opened = createCoreProvider(config, policy, [principal]);
  expect(opened.ok).toBe(true); if (!opened.ok) return;
  const req = new IncomingMessage(new Socket()), res = new ServerResponse(req);
  try {
    const read = (period: string, actor: Principal = principal) => opened.value.request(actor, new Request(`http://core/v1/providers/people-usage${period}`), req, res);
    const allowed = await read("?period=day");
    expect(allowed?.status).toBe(200);
    if (!(allowed instanceof Response)) throw Error("Expected analytics response");
    const value = await allowed.json(); expect(value.rows).toEqual([]); expect(value.subscriptions).toBeDefined();
    expect((await read(""))?.status).toBe(400);
    expect((await read("?period=month"))?.status).toBe(400);
    expect((await read("?period=day&period=week"))?.status).toBe(400);
    expect((await read("?period=day", { kind: "person", id: "other", person: "other" }))?.status).toBe(403);
  } finally { await opened.value.close(); req.destroy(); }
});

import { afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store.js";
import { Fleet } from "../src/fleet.js";
import { loadConfig } from "../src/config.js";
import { assign as assignFleet } from "../src/policy.js";
import { CompletionService } from "../src/completion.js";
import { quotaScopeCovers } from "../src/catalog.js";
import type { Thread } from "../src/threads/contracts.js";
import type { CompletionExecution, CompletionOutcome } from "../src/completion-contract.js";

const DAY = 24 * 3_600_000;
const MONTHLY = "429 rate_limit_error: This request would exceed your account's monthly spend limit.";
const opus = "claude-opus-5-5", fable = "claude-fable-5-1", sonnet = "claude-sonnet-5";
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); vi.unstubAllEnvs(); });

function anthropicPool(): Store {
  const store = Store.open(":memory:");
  for (const id of ["anthropic", "anthropic-2", "anthropic-3"]) store.upsertAccount({ id, provider: "anthropic", concurrency: 4 });
  return store;
}

it("lifts a cooldown only for a request that started after the latest refusal", () => {
  const store = anthropicPool();
  try {
    store.setCooldown("anthropic", 10_000 + DAY, { model: opus, at: 10_000 });
    expect(store.recordProviderSuccess("anthropic", { model: opus, startedAt: 9_000, source: "test", now: 20_000 })).toBe(false);
    expect(store.recordProviderSuccess("anthropic", { model: opus, startedAt: 10_000, source: "test", now: 20_000 })).toBe(false);
    // A newer refusal arrives before an older in-flight success reports back.
    store.setCooldown("anthropic", 30_000 + DAY, { model: opus, at: 30_000 });
    expect(store.recordProviderSuccess("anthropic", { model: opus, startedAt: 25_000, source: "test", now: 31_000 })).toBe(false);
    expect(store.account("anthropic")?.cooldownUntil).toBe(30_000 + DAY);
    expect(store.recordProviderSuccess("anthropic", { model: opus, startedAt: 30_001, source: "test", now: 40_000 })).toBe(true);
    expect(store.account("anthropic")?.cooldownUntil).toBeUndefined();
    expect(store.cooldownEvidence("anthropic")).toBeUndefined();
    expect(JSON.parse(store.control("cooldown-recovery:anthropic")!)).toMatchObject({
      clearedAt: 40_000, cooldown: { until: 30_000 + DAY, at: 30_000, models: [opus] }, success: { model: opus, startedAt: 30_001, source: "test" } });
  } finally { store.close(); }
});

it("keeps the latest refusal time when a shorter refusal does not extend the hold", () => {
  const store = anthropicPool();
  try {
    store.setCooldown("anthropic", 10_000 + DAY, { model: opus, at: 10_000 });
    store.setCooldown("anthropic", Math.max(store.account("anthropic")!.cooldownUntil!, 50_000 + 60_000), { model: opus, at: 50_000 });
    expect(store.cooldownEvidence("anthropic")).toEqual({ until: 10_000 + DAY, at: 50_000, models: [opus] });
    expect(store.recordProviderSuccess("anthropic", { model: opus, startedAt: 40_000, source: "test", now: 60_000 })).toBe(false);
  } finally { store.close(); }
});

it("matches the refusal's quota scope: a success must pass through every meter the refused models drain", () => {
  expect(quotaScopeCovers("anthropic", sonnet, opus)).toBe(true);
  expect(quotaScopeCovers("anthropic", fable, opus)).toBe(true);
  expect(quotaScopeCovers("anthropic", opus, fable)).toBe(false);
  expect(quotaScopeCovers("openai-codex", "image:default", "gpt-6-luna")).toBe(false);
  expect(quotaScopeCovers("openai-codex", "gpt-6-luna", "image:default")).toBe(false);
  const store = anthropicPool();
  try {
    store.setCooldown("anthropic-2", 10_000 + DAY, { model: fable, at: 10_000 });
    expect(store.recordProviderSuccess("anthropic-2", { model: opus, startedAt: 20_000, source: "test", now: 30_000 })).toBe(false);
    // Refusals while the hold stands accumulate; the success must cover all of them.
    store.setCooldown("anthropic-2", 10_000 + DAY, { model: opus, at: 11_000 });
    expect(store.cooldownEvidence("anthropic-2")?.models.sort()).toEqual([fable, opus].sort());
    expect(store.recordProviderSuccess("anthropic-2", { model: fable, startedAt: 20_000, source: "test", now: 30_000 })).toBe(true);
  } finally { store.close(); }
});

it("dates cooldowns without evidence at adoption, so only later requests can lift them", () => {
  const root = mkdtempSync(join(tmpdir(), "cooldown-adopt-")); roots.push(root);
  const path = join(root, "ledger.sqlite3");
  let store = Store.open(path);
  store.upsertAccount({ id: "anthropic", provider: "anthropic" });
  const until = Date.now() + DAY;
  // What a release without evidence, or an old process, leaves behind.
  store.db.prepare("UPDATE account SET cooldown_until=? WHERE id=?").run(until, "anthropic");
  store.close();
  const before = Date.now();
  store = Store.open(path);
  try {
    const evidence = store.cooldownEvidence("anthropic")!;
    expect(evidence).toMatchObject({ until, models: [] });
    expect(evidence.at).toBeGreaterThanOrEqual(before);
    expect(store.recordProviderSuccess("anthropic", { model: opus, startedAt: before - 1, source: "test" })).toBe(false);
    expect(store.recordProviderSuccess("anthropic", { model: opus, startedAt: evidence.at + 1, source: "test", now: evidence.at + 2 })).toBe(true);
    // An old writer replacing the hold invalidates its evidence rather than letting stale evidence lift it.
    store.setCooldown("anthropic", until, { model: opus, at: 1_000 });
    store.db.prepare("UPDATE account SET cooldown_until=? WHERE id=?").run(until + 1, "anthropic");
    expect(store.recordProviderSuccess("anthropic", { model: opus, startedAt: Date.now(), source: "test" })).toBe(false);
  } finally { store.close(); }
});

it("does not touch expired cooldowns or accounts nobody cooled", () => {
  const store = anthropicPool();
  try {
    store.setCooldown("anthropic", 20_000, { model: opus, at: 10_000 });
    expect(store.recordProviderSuccess("anthropic", { model: opus, startedAt: 15_000, source: "test", now: 25_000 })).toBe(false);
    expect(store.recordProviderSuccess("anthropic-2", { model: opus, startedAt: 15_000, source: "test", now: 25_000 })).toBe(false);
    expect(store.control("cooldown-recovery:anthropic")).toBeUndefined();
  } finally { store.close(); }
});

const thread: Thread = { id: "worker", parentId: "parent", title: "work", cwd: "/tmp", sessionFile: "/tmp/worker.jsonl",
  settings: { model: `anthropic/${opus}`, thinkingLevel: "high", speed: "standard" }, admission: "force",
  lifecycle: { kind: "idle" }, state: "running", held: false, revision: 1, createdAt: 1, updatedAt: 1, pendingMessages: 1 };

it("replays September 29: an Opus success on one account reopens fleet admission to it alone", async () => {
  const store = anthropicPool();
  const fleet = new Fleet(store, loadConfig("/missing"));
  try {
    const refusedAt = Date.now() - 4 * 3_600_000;
    for (const id of ["anthropic", "anthropic-2", "anthropic-3"]) store.setCooldown(id, refusedAt + DAY, { model: opus, at: refusedAt });
    const blocked = await fleet.admit(thread, thread.settings, false, "blocked");
    expect(blocked).toMatchObject({ ok: false, error: { message: expect.stringContaining("account cooling down") } });
    // The native CLI's answer, as the routing extension or the fleet reports it.
    expect(store.recordProviderSuccess("anthropic", { model: opus, startedAt: Date.now() - 1_000, source: "interactive" })).toBe(true);
    const admitted = await fleet.admit(thread, thread.settings, false, "recovered");
    expect(admitted).toMatchObject({ ok: true, value: { env: { PI_ORCHESTRATOR_ACCOUNT_ID: "anthropic" } } });
    expect(store.account("anthropic-2")?.cooldownUntil).toBe(refusedAt + DAY);
    expect(store.account("anthropic-3")?.cooldownUntil).toBe(refusedAt + DAY);
    if (admitted.ok) await admitted.value.release();
  } finally { store.close(); }
});

it("a fleet worker's own answer lifts its account's stale hold, and its refusal records the model", async () => {
  const store = anthropicPool();
  const fleet = new Fleet(store, loadConfig("/missing"));
  try {
    const admitted = await fleet.admit(thread, thread.settings, false, "work");
    if (!admitted.ok) throw new Error(admitted.error.message);
    const account = admitted.value.env?.PI_ORCHESTRATOR_ACCOUNT_ID!;
    const startedAt = Date.now();
    fleet.event(thread.id, { type: "message_end", message: { role: "assistant", model: opus, stopReason: "error", errorMessage: MONTHLY, timestamp: startedAt } });
    const evidence = store.cooldownEvidence(account)!;
    expect(evidence.models).toEqual([opus]);
    expect(store.account(account)!.cooldownUntil! - evidence.at).toBeGreaterThan(23 * 3_600_000);
    // The same wave's earlier request answering late must not lift the refusal.
    fleet.event(thread.id, { type: "message_end", message: { role: "assistant", model: opus, stopReason: "stop", timestamp: startedAt - 1, usage: { input: 1, output: 1 } } });
    expect(store.account(account)?.cooldownUntil).toBe(evidence.until);
    fleet.event(thread.id, { type: "message_end", message: { role: "assistant", model: opus, stopReason: "aborted", timestamp: evidence.at + 1 } });
    expect(store.account(account)?.cooldownUntil).toBe(evidence.until);
    fleet.event(thread.id, { type: "message_end", message: { role: "assistant", model: opus, stopReason: "toolUse", timestamp: evidence.at + 1, usage: { input: 1, output: 1 } } });
    expect(store.account(account)?.cooldownUntil).toBeUndefined();
    await admitted.value.release();
  } finally { store.close(); }
});

it("lets fleet admission see the lifted hold without meters being consulted for the lift", () => {
  const store = anthropicPool();
  try {
    const config = loadConfig("/missing");
    for (const id of ["anthropic", "anthropic-2", "anthropic-3"]) store.setCooldown(id, Date.now() + DAY, { model: opus, at: Date.now() - 10_000 });
    // Low subscription meters are not evidence about a monthly spend ceiling.
    for (const id of ["anthropic", "anthropic-2", "anthropic-3"]) store.recordMeter(id, "anthropic-7d", 5, Date.now() + DAY);
    expect(store.accounts().every(account => account.cooldownUntil)).toBe(true);
    expect(assignFleet(store, { provider: "anthropic", model: opus }, "force", config).assignment).toBeUndefined();
    store.recordProviderSuccess("anthropic-3", { model: opus, startedAt: Date.now(), source: "model-broker" });
    expect(assignFleet(store, { provider: "anthropic", model: opus }, "force", config).assignment?.accountId).toBe("anthropic-3");
  } finally { store.close(); }
});

function value<T>(outcome: CompletionOutcome<T>): T { if (!outcome.ok) throw new Error(outcome.error.message); return outcome.value; }
const completed: CompletionExecution = { state: "completed", result: { text: "ok", provider: "openai-codex", model: "gpt-6-luna", usage: { input: 2, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 3 }, stopReason: "stop" } };

it("a completed completion lifts a hold refused before its admission, never one refused after", () => {
  const store = Store.open(":memory:");
  try {
    store.upsertAccount({ id: "codex", provider: "openai-codex" });
    const service = new CompletionService(store, "/tmp");
    const input = { model: "luna" as const, prompt: "p", systemPrompt: "s", thinkingLevel: "low" as const, speed: "standard" as const };
    const run = (requestId: string) => {
      const record = value(service.submit(requestId, input));
      expect(store.assignRun(record.runId, { accountId: "codex", provider: "openai-codex", model: "gpt-6-luna", unit: `completion:${record.runId}`, releasePath: "/release" })).toBe(true);
      value(service.claim(record.runId, "attempt"));
      return record.runId;
    };
    store.setCooldown("codex", Date.now() + DAY, { model: "gpt-6-luna", at: Date.now() - 10_000 });
    value(service.settle(run("before"), "attempt", completed));
    expect(store.account("codex")?.cooldownUntil).toBeUndefined();
    const late = run("after");
    store.setCooldown("codex", Date.now() + DAY, { model: "gpt-6-luna", at: Date.now() + 1_000 });
    value(service.settle(late, "attempt", completed));
    expect(store.account("codex")?.cooldownUntil).toBeGreaterThan(Date.now());
  } finally { store.close(); }
});

it("the routing extension reports pooled answers from interactive sessions", async () => {
  const root = mkdtempSync(join(tmpdir(), "cooldown-routing-")); roots.push(root);
  const ledger = join(root, "ledger.sqlite3"), auth = join(root, "auth.json");
  writeFileSync(auth, "{}");
  vi.stubEnv("PI_ORCHESTRATOR_LEDGER", ledger); vi.stubEnv("PI_ORCHESTRATOR_AUTH", auth);
  vi.stubEnv("PI_MODEL_BROKER_URL", undefined); vi.stubEnv("PI_ORCHESTRATOR_ASSIGNED", "0");
  vi.stubEnv("PI_ORCHESTRATOR_CONFIG", join(root, "config.json"));
  const store = Store.open(ledger);
  try {
    store.upsertAccount({ id: "anthropic", provider: "anthropic" });
    store.setCooldown("anthropic", Date.now() + DAY, { model: opus, at: Date.now() - 10_000 });
    const handlers = new Map<string, ((event: any, ctx: any) => unknown)[]>();
    const pi: any = new Proxy({
      on: (name: string, handler: (event: any, ctx: any) => unknown) => handlers.set(name, [...handlers.get(name) ?? [], handler]),
      events: { on: () => () => {} },
    }, { get: (target, key) => key in target ? (target as any)[key] : () => undefined });
    const { default: routing } = await import("../src/extension/routing.js");
    routing(pi);
    const emit = async (name: string, event: any) => { for (const handler of handlers.get(name) ?? []) await handler(event, { sessionManager: { getSessionId: () => "session" } }); };
    await emit("message_end", { type: "message_end", message: { role: "assistant", provider: "anthropic", model: opus, stopReason: "stop", timestamp: Date.now() - 20_000 } });
    expect(store.account("anthropic")?.cooldownUntil).toBeGreaterThan(Date.now());
    await emit("message_end", { type: "message_end", message: { role: "assistant", provider: "anthropic", model: opus, stopReason: "stop", timestamp: Date.now() } });
    expect(store.account("anthropic")?.cooldownUntil).toBeUndefined();
    expect(JSON.parse(store.control("cooldown-recovery:anthropic")!).success.source).toBe("interactive");
    await emit("session_shutdown", { type: "session_shutdown" });
  } finally { store.close(); }
});

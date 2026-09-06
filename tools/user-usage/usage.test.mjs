import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { scanSessions } from "./sessions.mjs";
import { estimateUsage } from "./economics.mjs";

const HOUR = 3_600_000, start = Date.parse("2026-09-01T00:00:00Z");
const model = { provider: "openai-codex", model: "gpt-6-astra", tokens: { input: 1000, output: 100, cacheRead: 10000, cacheWrite: 0 },
  pricedTokens: { input: 1000, output: 100, cacheRead: 10000, cacheWrite: 0 },
  componentUsd: { input: 0.01, output: 0.005, cacheRead: 0.01, cacheWrite: 0 },
  totalTokens: 11100, loggedApiUsd: 0.025, unpricedResponses: 0 };
function fixture() {
  return { version: 1, capturedAt: start + 6 * HOUR + 60_000,
    accounts: ["a", "b"].map(id => ({ id, provider: "openai-codex", use: "shared" })),
    weeklyMeters: [{ id: "weekly", provider: "openai-codex", windowHours: 168, models: null }],
    meters: ["a", "b"].flatMap(accountId => [0, 6].map(h => ({ accountId, meterId: "weekly", at: start + h * HOUR,
      usedPercent: h ? 30 : 10, resetAt: start + 168 * HOUR }))),
    hours: ["a", "b"].flatMap(accountId => Object.entries(model.tokens).map(([component, tokens]) => ({
      accountId, hour: start + HOUR, model: model.model, component, tokens: tokens * 1000 }))),
  };
}
const usage = () => ({ models: [structuredClone(model)], missingUsage: 0 });
function estimate(evidence = fixture(), options = {}) { return estimateUsage(usage(), evidence, options).value; }
const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} != ${expected}`);

test("pool quota only over matched account spans, weight components, and scale the plan price", () => {
  const evidence = fixture();
  evidence.hours.push({ accountId: "a", hour: start - HOUR, model: model.model, component: "input", tokens: 1e12 });
  evidence.hours.push({ accountId: "a", hour: start + 6 * HOUR, model: model.model, component: "input", tokens: 1e12 });
  const report = estimate(evidence);
  near(report.usd, 200 * 0.025 / (50 / 40 * 100 * 30 / 7));
  near(estimate(evidence, { planUsd: 100 }).usd, report.usd / 2);
  near(estimate(evidence, { monthDays: 60 }).usd, report.usd / 2);
  assert.equal(report.models[0].meters[0].samples.length, 2);
});

test("insufficient, reset, saturated, stale, voice, mixed, or unpriced evidence never becomes zero dollars", () => {
  for (const invalid of [null, {}, { ...fixture(), meters: [null] }]) {
    assert.equal(estimateUsage(usage(), invalid).ok, false);
  }
  for (const change of [
    e => { e.accounts[0].use = "voice"; },
    e => { e.meters[1].usedPercent = 100; },
    e => { e.meters[1].resetAt += 120_000; },
    e => { e.meters[1].usedPercent = 9; },
    e => { e.capturedAt += 3 * HOUR; },
    e => { e.hours.push({ accountId: "a", hour: start + HOUR, model: "other", component: "input", tokens: 1e6 }); },
    e => { e.hours[3].tokens = 100; },
  ]) {
    const evidence = fixture(); change(evidence);
    assert.equal(estimate(evidence).usd, null);
  }
  assert.equal(estimate(fixture(), { accounts: ["a"] }).usd, null);
  const unpriced = usage(); unpriced.models[0].unpricedResponses = 1;
  assert.equal(estimateUsage(unpriced, fixture()).value.usd, null);
  const missing = usage(); missing.missingUsage = 1;
  assert.equal(estimateUsage(missing, fixture()).value.usd, null);
});

test("overlapping weekly and scoped meters bind by maximum, not summed charges", () => {
  const evidence = fixture(), baseline = estimate(evidence).usd;
  evidence.weeklyMeters.push({ id: "scoped", provider: "openai-codex", windowHours: 168, models: [model.model] });
  evidence.meters.push(...evidence.meters.map(m => ({ ...m, meterId: "scoped", usedPercent: m.usedPercent * 2 })));
  near(estimate(evidence).usd, baseline * 2);
});

test("session branches deduplicate copied calls, retain abandoned calls, and never double-count reasoning", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-user-usage-"));
  try {
    const entry = { type: "message", id: "same-id", timestamp: new Date(start).toISOString(), message: {
      role: "assistant", provider: "openai-codex-2", model: model.model,
      usage: { ...model.tokens, reasoning: 50, totalTokens: model.totalTokens,
        cost: { ...model.componentUsd, total: model.loggedApiUsd } }, content: [{ type: "text", text: "private" }],
    } };
    const next = structuredClone(entry); next.timestamp = new Date(start + HOUR).toISOString();
    await writeFile(join(root, "one.jsonl"), JSON.stringify(entry) + "\n" + JSON.stringify(next) + "\n");
    await writeFile(join(root, "fork.jsonl"), JSON.stringify(entry) + "\n{\"unfinished\":");
    const all = await scanSessions(root, 0, start + 2 * HOUR);
    assert.equal(all.ok, true);
    assert.equal(all.value.totalTokens, 22200);
    assert.equal(all.value.responses, 2);
    assert.equal(all.value.duplicates, 1);
    assert.equal(all.value.incompleteTails, 1);
    assert.equal(all.value.models[0].provider, "openai-codex");
    assert.ok(!JSON.stringify(all).includes("private"));
    const cut = await scanSessions(root, start, start + HOUR);
    assert.equal(cut.value.responses, 1);
    await writeFile(join(root, "broken.jsonl"), "broken\n");
    assert.equal((await scanSessions(root, 0, start + 2 * HOUR)).ok, false);
  } finally { await rm(root, { recursive: true }); }
});

test("a named person's private ledger is read as that person, even when her sessions are directly readable", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-usage-person-"));
  try {
    const bin = join(root, "bin"), registry = join(root, "persons"), data = join(root, "data");
    await Promise.all([mkdir(bin), mkdir(registry), mkdir(join(data, "sessions"), { recursive: true })]);
    const user = "usage-test-person", ledger = "/private/person/ledger.sqlite3";
    await writeFile(join(registry, `${user}.json`), JSON.stringify({ user, environment: {
      PI_REMOTE_DATA: data, PI_REMOTE_ORCHESTRATOR_DB: ledger,
    } }));
    await writeFile(join(bin, "pi-orchestrator"), `#!/usr/bin/env node\nconsole.log(${JSON.stringify(JSON.stringify(fixture()))});\n`, { mode: 0o755 });
    await writeFile(join(bin, "sudo"), '#!/bin/sh\nprintf "%s\\n" "$@" > "$USAGE_TEST_CALL"\nshift 3\nexec "$@"\n', { mode: 0o755 });
    const result = spawnSync(process.execPath, [new URL("main", import.meta.url).pathname, user, "--json"], {
      encoding: "utf8", env: { ...process.env, PATH: `${bin}:${process.env.PATH}`,
        PI_REMOTE_PERSONS_DIR: registry, USAGE_TEST_CALL: join(root, "call") },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).calibrationError, null);
    assert.deepEqual((await readFile(join(root, "call"), "utf8")).trim().split("\n"),
      ["-n", "-u", user, join(bin, "pi-orchestrator"), "usage-evidence", "--ledger", ledger]);
  } finally { await rm(root, { recursive: true }); }
});

test("CLI can reproduce an offline report without a person registry or model requests", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-usage-cli-"));
  try {
    await writeFile(join(root, "evidence.json"), JSON.stringify(fixture()));
    const result = spawnSync(process.execPath, [new URL("main", import.meta.url).pathname, "fixture",
      "--sessions", root, "--evidence", join(root, "evidence.json"), "--json"], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).usage.totalTokens, 0);
    assert.equal(JSON.parse(result.stdout).estimate.usd, 0);
    const bad = spawnSync(process.execPath, [new URL("main", import.meta.url).pathname, "--plan-usd", "NaN"], { encoding: "utf8" });
    assert.equal(bad.status, 1);
  } finally { await rm(root, { recursive: true }); }
});

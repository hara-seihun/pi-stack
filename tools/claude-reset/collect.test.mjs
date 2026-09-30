import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { stripTypeScriptTypes } from "node:module";

const collector = resolve("tools/claude-reset/main");
const orgId = "12345678-1234-1234-1234-123456789abc";
const resetAt = "2030-10-01T00:00:00Z";
const meterIds = ["anthropic-5h", "anthropic-7d", "anthropic-7d_oi"];
const usage = () => ({
  cedar_ember: { grants: [{ resets_left: 1, ends_at: resetAt }] },
  limits: [
    { kind: "session", percent: 0, resets_at: resetAt },
    { kind: "weekly_all", percent: 0, resets_at: resetAt },
    { kind: "weekly_scoped", scope: { model: { display_name: "Fable" } }, utilization: 0, resets_at: resetAt },
  ],
  five_hour: { utilization: 100 }, seven_day: { utilization: 100 },
});

function fixture(t, changes = {}) {
  const root = mkdtempSync(join(tmpdir(), "claude-reset-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const initial = {
    account: { id: "claude", provider: "anthropic", label: "sara@example.com" },
    credits: { at: 1, available: 2 },
    meters: meterIds.map(meterId => ({ meterId, at: 1, usedPercent: 100 })),
  };
  const statePath = join(root, "state.json"), callsPath = join(root, "calls.jsonl");
  writeFileSync(statePath, JSON.stringify(initial));
  writeFileSync(join(root, "config.json"), JSON.stringify({ claude: "sara-profile" }));
  writeFileSync(join(root, "response.json"), JSON.stringify({ usage: usage(), email: "sara@example.com", ...changes }));
  mkdirSync(join(root, "auth"));
  // Exercise the source parser, without building or importing the live release.
  for (const file of ["meters-anthropic", "auth/meter-credential"]) {
    const source = readFileSync(resolve(`packages/orchestrator/src/${file}.ts`), "utf8");
    writeFileSync(join(root, `${file}.js`), stripTypeScriptTypes(source, { mode: "transform" }));
  }
  writeFileSync(join(root, "store.js"), `
import { readFileSync, writeFileSync } from "node:fs";
export class Store {
  static open(path) { return new Store(path); }
  constructor(path) { this.path = path; this.state = JSON.parse(readFileSync(path)); }
  account() { return this.state.account; }
  resetCredits() { return this.state.credits; }
  transaction(fn) {
    const previous = structuredClone(this.state);
    this.writing = true;
    try { fn(); } catch (error) { this.state = previous; throw error; }
    finally { this.writing = false; }
  }
  recordResetCredits(id, reading) {
    if (!this.writing) throw new Error("write outside transaction");
    this.state.credits = reading;
  }
  recordReading(id, meterId, reading) {
    if (!this.writing) throw new Error("write outside transaction");
    if (process.env.FAIL_WRITE === meterId) throw new Error("meter write failed");
    this.state.meters = this.state.meters.filter(m => m.meterId !== meterId);
    this.state.meters.push({ meterId, ...reading });
  }
  close() { writeFileSync(this.path, JSON.stringify(this.state)); }
}
`);
  const fakeKernel = `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2), config = JSON.parse(fs.readFileSync(process.env.RESPONSE));
fs.appendFileSync(process.env.CALLS, JSON.stringify({ program: process.argv[1].split("/").pop(), args }) + "\\n");
if (args[0] === "start") { console.log(JSON.stringify({session_id: "test123"})); }
else if (args[0] === "stop") { if (config.failStop) process.exit(1); }
else {
  if (args[0] !== "browsers" || args[1] !== "curl" || args[args.indexOf("--request") + 1] !== "GET") process.exit(2);
  const url = args[3];
  if (url.endsWith("/account")) console.log(JSON.stringify({email_address: config.email}));
  else if (url.endsWith("/organizations")) console.log(JSON.stringify([{uuid: "${orgId}", billing_type: "stripe_subscription"}]));
  else if (url.endsWith("/usage?cedar_ember=1&skip_spend=1")) {
    if (config.failUsage) process.exit(1);
    console.log(JSON.stringify(config.usage));
  } else process.exit(3);
}
`;
  for (const name of ["kernel", "kernel-browser"]) writeFileSync(join(root, name), fakeKernel, { mode: 0o755 });
  return {
    initial,
    run(args = [], env = {}) {
      const result = spawnSync(process.execPath, [collector, "--config", join(root, "config.json"), "--json", ...args], {
        encoding: "utf8", timeout: 10_000,
        env: { ...process.env, PATH: `${root}:${process.env.PATH}`, PI_ORCHESTRATOR_STORE: join(root, "store.js"),
          PI_ORCHESTRATOR_LEDGER: statePath, RESPONSE: join(root, "response.json"), CALLS: callsPath, ...env },
      });
      assert.ifError(result.error);
      return { ...result, rows: JSON.parse(result.stdout), state: JSON.parse(readFileSync(statePath)),
        calls: (() => { try { return readFileSync(callsPath, "utf8").trim().split("\n").map(JSON.parse); } catch { return []; } })() };
    },
  };
}

test("identified collection replaces exhausted quota and spent credits together, using real limits", t => {
  const f = fixture(t), result = f.run();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.rows[0].outcome, "recorded");
  assert.equal(result.state.credits.available, 1);
  assert.deepEqual(result.state.meters.map(m => m.meterId), meterIds);
  for (const meter of result.state.meters) {
    assert.equal(meter.usedPercent, 0);
    assert.equal(meter.at, result.state.credits.at);
    assert.equal(meter.resetAt, Date.parse(resetAt));
  }
  assert.equal(result.calls.length, 5);
  assert.equal(result.calls.at(-1).args[0], "stop");
});

test("dry-run reads both facts without writes; status never starts a browser", t => {
  const f = fixture(t), dryRun = f.run(["--dry-run"]);
  assert.equal(dryRun.status, 0, dryRun.stderr);
  assert.equal(dryRun.rows[0].outcome, "would-record");
  assert.equal(dryRun.rows[0].meters.length, 3);
  assert.deepEqual(dryRun.state, f.initial);
  const status = f.run(["status"]);
  assert.equal(status.status, 0, status.stderr);
  assert.deepEqual(status.rows[0].reading, f.initial.credits);
  assert.deepEqual(status.calls, dryRun.calls);
});

for (const [name, changes] of [
  ["identity mismatch", { email: "someone-else@example.com" }],
  ["failed HTTP usage read", { failUsage: true }],
  ["missing grant balance", { usage: { limits: usage().limits } }],
  ["missing limits despite older fields", { usage: { ...usage(), limits: undefined } }],
  ["unreadable limits", { usage: { ...usage(), limits: [{ kind: "weekly_all", percent: "0" }] } }],
  ["failed session stop", { failStop: true }],
]) test(`${name} preserves credits and meters and stops the browser`, t => {
  const f = fixture(t, changes), result = f.run();
  assert.equal(result.status, 1, result.stderr);
  assert.equal(result.rows[0].outcome, "error");
  assert.deepEqual(result.state, f.initial);
  assert.equal(result.calls.at(-1).args[0], "stop");
  if (changes.email) assert.equal(result.calls.filter(c => c.args[3]?.includes("/usage?")).length, 0);
});

test("a meter write failure rolls back credits and all meters", t => {
  const f = fixture(t), result = f.run([], { FAIL_WRITE: "anthropic-7d" });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.rows[0].reason, /meter write failed/);
  assert.deepEqual(result.state, f.initial);
});

test("unknown scopes remain separate rather than relabeled or turned into zero", t => {
  const response = usage();
  response.limits[1].percent = 17.6;
  response.limits[2].scope.model.display_name = "Opus";
  const f = fixture(t, { usage: response }), result = f.run();
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.rows[0].unmappedScopes, ["Opus"]);
  assert.equal(result.state.meters.find(m => m.meterId === "anthropic-7d").usedPercent, 18);
  assert.deepEqual(result.state.meters.find(m => m.meterId === "anthropic-7d_oi"), f.initial.meters[2]);
});

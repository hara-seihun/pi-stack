#!/usr/bin/env node
import os from "node:os";
import { execFileSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import {
  DEFAULT_DB_PATH, SCHEMA_VERSION, openDatabase, readAuth, sampleAll, burn, bindingBucket,
} from "./meters.mjs";
import { DEFAULT_DB_PATH as USAGE_DB_PATH } from "../extensions/pi-usage-logger/database.mjs";

const REMOTE_HOST = process.env.PLAN_METER_REMOTE ?? "converge-kenan";

function fail(message) {
  console.error(`plan-meter: ${message}`);
  process.exit(1);
}

function since(value) {
  if (/^\d+[mhdw]$/.test(value)) {
    const count = Number(value.slice(0, -1));
    const unit = { m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 }[value.at(-1)];
    return Date.now() - count * unit;
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) fail(`invalid time range: ${value}`);
  return parsed;
}

function fmt(value) {
  const number = Number(value ?? 0);
  if (!Number.isFinite(number)) return "n/a";
  if (Math.abs(number) >= 1e9) return `${(number / 1e9).toFixed(2)}B`;
  if (Math.abs(number) >= 1e6) return `${(number / 1e6).toFixed(2)}M`;
  if (Math.abs(number) >= 1e3) return `${(number / 1e3).toFixed(1)}K`;
  return String(Math.round(number));
}

function duration(ms) {
  if (!Number.isFinite(ms)) return "n/a";
  if (ms <= 0) return "due";
  const hours = ms / 3_600_000;
  if (hours < 48) return `${hours.toFixed(1)}h`;
  return `${(hours / 24).toFixed(1)}d`;
}

function printTable(values, columns) {
  if (!values.length) {
    console.log("No matching records.");
    return;
  }
  const widths = columns.map((column) =>
    Math.max(column.label.length, ...values.map((row) => String(column.value(row)).length)));
  console.log(columns.map((column, index) => column.label.padEnd(widths[index])).join("  "));
  console.log(widths.map((width) => "-".repeat(width)).join("  "));
  for (const row of values) {
    console.log(columns.map((column, index) => String(column.value(row)).padEnd(widths[index])).join("  "));
  }
}

/** Content-free token totals per provider alias from the Pi usage ledger. */
function localTokens(lo, hi, dbPath = process.env.PI_USAGE_DB ?? USAGE_DB_PATH) {
  let db;
  try { db = new DatabaseSync(dbPath, { readOnly: true }); }
  catch { return {}; }
  const rows = db.prepare(`
    SELECT provider,
           COUNT(*) AS requests,
           COALESCE(SUM(input_tokens),0) AS input,
           COALESCE(SUM(output_tokens),0) AS output,
           COALESCE(SUM(cache_read_tokens),0) AS cache_read,
           COALESCE(SUM(cache_write_tokens),0) AS cache_write,
           COALESCE(SUM(total_tokens),0) AS total
    FROM request
    WHERE started_at >= ? AND started_at < ? AND provider IS NOT NULL
    GROUP BY provider`).all(lo, hi);
  db.close();
  return Object.fromEntries(rows.map((row) => [row.provider, {
    requests: Number(row.requests),
    input: Number(row.input),
    output: Number(row.output),
    cacheRead: Number(row.cache_read),
    cacheWrite: Number(row.cache_write),
    total: Number(row.total),
  }]));
}

function localSamples(lo, hi, dbPath = DEFAULT_DB_PATH) {
  let db;
  try { db = openDatabase(dbPath, { readOnly: true }); }
  catch { return []; }
  const rows = db.prepare(`
    SELECT s.provider, s.family, s.at, s.status, s.plan, s.tier, s.account_key,
           b.bucket, b.used_percent, b.resets_at, b.window_seconds
    FROM sample s LEFT JOIN bucket b ON b.sample_id = s.sample_id
    WHERE s.at >= ? AND s.at <= ? AND s.status = 'ok'
    ORDER BY s.at`).all(lo, hi);
  db.close();
  return rows.map((row) => ({ ...row, host: "local" }));
}

function remote(script, args) {
  try {
    return execFileSync("ssh", ["-o", "BatchMode=yes", "-o", "ConnectTimeout=15", REMOTE_HOST, "node", "-e", script, "--", ...args],
      { encoding: "utf8", timeout: 120_000, maxBuffer: 64 * 1024 * 1024 });
  } catch (error) {
    console.error(`plan-meter: ${REMOTE_HOST} unreachable, reporting local data only (${error?.code ?? "error"})`);
    return null;
  }
}

const REMOTE_SCRIPT = `
const { DatabaseSync } = require("node:sqlite");
const os = require("node:os");
const [lo, hi] = process.argv.slice(2).map(Number);
const out = { tokens: {}, samples: [] };
try {
  const db = new DatabaseSync(os.homedir() + "/data/pi-usage/usage.sqlite3", { readOnly: true });
  for (const row of db.prepare("SELECT provider, COUNT(*) requests, COALESCE(SUM(input_tokens),0) input, COALESCE(SUM(output_tokens),0) output, COALESCE(SUM(cache_read_tokens),0) cache_read, COALESCE(SUM(cache_write_tokens),0) cache_write, COALESCE(SUM(total_tokens),0) total FROM request WHERE started_at >= ? AND started_at < ? AND provider IS NOT NULL GROUP BY provider").all(lo, hi)) {
    out.tokens[row.provider] = { requests: Number(row.requests), input: Number(row.input), output: Number(row.output), cacheRead: Number(row.cache_read), cacheWrite: Number(row.cache_write), total: Number(row.total) };
  }
  db.close();
} catch {}
try {
  const db = new DatabaseSync(os.homedir() + "/data/plan-meter/meters.sqlite3", { readOnly: true });
  out.samples = db.prepare("SELECT s.provider, s.family, s.at, s.status, s.plan, s.tier, s.account_key, b.bucket, b.used_percent, b.resets_at, b.window_seconds FROM sample s LEFT JOIN bucket b ON b.sample_id = s.sample_id WHERE s.at >= ? AND s.at <= ? AND s.status = 'ok' ORDER BY s.at").all(lo, hi);
  db.close();
} catch {}
process.stdout.write(JSON.stringify(out));
`;

function mergeTokens(...parts) {
  const total = {};
  for (const part of parts) {
    for (const [provider, value] of Object.entries(part ?? {})) {
      const entry = total[provider] ??= { requests: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
      for (const key of Object.keys(entry)) entry[key] += Number(value[key] ?? 0);
    }
  }
  return total;
}

function report(args) {
  const window = args.find((value) => !value.startsWith("--")) ?? "24h";
  const json = args.includes("--json");
  const localOnly = args.includes("--local");
  const lo = since(window);
  const hi = Date.now();

  let remoteData = null;
  if (!localOnly) {
    const raw = remote(REMOTE_SCRIPT, [String(lo), String(hi)]);
    if (raw) { try { remoteData = JSON.parse(raw); } catch { remoteData = null; } }
  }

  const tokens = mergeTokens(localTokens(lo, hi), remoteData?.tokens);
  const samples = [...localSamples(lo, hi), ...(remoteData?.samples ?? []).map((row) => ({ ...row, host: REMOTE_HOST }))];

  // Meters are server-side and global, so identical readings observed from two
  // hosts describe one account. Deduplicate on provider+bucket+timestamp.
  const accounts = new Map();
  for (const row of samples) {
    if (!row.bucket || row.used_percent === null) continue;
    const account = accounts.get(row.provider) ?? {
      provider: row.provider, family: row.family, plan: row.plan, tier: row.tier, buckets: new Map(),
    };
    account.plan ??= row.plan;
    account.tier ??= row.tier;
    const series = account.buckets.get(row.bucket) ?? new Map();
    series.set(row.at, { at: row.at, used: Number(row.used_percent), resetsAt: row.resets_at, windowSeconds: row.window_seconds });
    account.buckets.set(row.bucket, series);
    accounts.set(row.provider, account);
  }

  const rows = [];
  for (const account of accounts.values()) {
    const byBucket = {};
    for (const [bucket, series] of account.buckets) byBucket[bucket] = burn([...series.values()]);
    const binding = bindingBucket(byBucket);
    const stats = binding ? byBucket[binding] : null;
    const used = tokens[account.provider] ?? { requests: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
    const fresh = used.input + used.output + used.cacheWrite;
    const perPercent = stats && stats.burned > 0 ? used.total / stats.burned : null;
    rows.push({
      provider: account.provider,
      family: account.family,
      plan: account.plan ?? account.tier ?? "?",
      bucket: binding ?? "-",
      start: stats?.start ?? null,
      end: stats?.end ?? null,
      burned: stats?.burned ?? null,
      resets: stats?.resets ?? 0,
      samples: stats?.samples ?? 0,
      resetsAt: stats?.resetsAt ?? null,
      requests: used.requests,
      total: used.total,
      fresh,
      perPercent,
      planTokens: perPercent === null ? null : perPercent * 100,
      buckets: byBucket,
    });
  }
  rows.sort((left, right) => left.family.localeCompare(right.family, "en") || left.provider.localeCompare(right.provider, "en"));

  if (json) {
    console.log(JSON.stringify({
      window: { from: new Date(lo).toISOString(), to: new Date(hi).toISOString() },
      hosts: localOnly ? ["local"] : ["local", REMOTE_HOST],
      accounts: rows.map(({ buckets, ...rest }) => ({
        ...rest,
        buckets: Object.fromEntries(Object.entries(buckets).map(([name, value]) => [name, value])),
      })),
    }, null, 1));
    return;
  }

  console.log(`Plan meter ${new Date(lo).toISOString()} -> ${new Date(hi).toISOString()}`);
  console.log(`Hosts: ${localOnly ? os.hostname() : `${os.hostname()} + ${REMOTE_HOST}`}\n`);
  if (!rows.length) {
    console.log("No samples in window. Run `plan-meter sample` or check plan-meter.timer.");
    return;
  }

  printTable(rows, [
    { label: "Account", value: (row) => row.provider },
    { label: "Plan", value: (row) => row.plan },
    { label: "Window", value: (row) => row.bucket },
    { label: "Start%", value: (row) => row.start === null ? "n/a" : row.start.toFixed(1) },
    { label: "End%", value: (row) => row.end === null ? "n/a" : row.end.toFixed(1) },
    { label: "Burn%", value: (row) => row.burned === null ? "n/a" : row.burned.toFixed(1) },
    { label: "Rst", value: (row) => String(row.resets) },
    { label: "Reqs", value: (row) => String(row.requests) },
    { label: "Tokens", value: (row) => fmt(row.total) },
    { label: "Fresh+out", value: (row) => fmt(row.fresh) },
    { label: "Tok/1%", value: (row) => row.perPercent === null ? "n/a" : fmt(row.perPercent) },
    { label: "FullPlan", value: (row) => row.planTokens === null ? "n/a" : fmt(row.planTokens) },
    { label: "Resets in", value: (row) => row.resetsAt === null ? "n/a" : duration(row.resetsAt - hi) },
  ]);

  console.log("\nPlan totals (FullPlan = tokens one complete window is worth at the observed rate)");
  const families = {};
  for (const row of rows) {
    const family = families[row.family] ??= { accounts: 0, measured: 0, total: 0, fresh: 0, planTokens: 0 };
    family.accounts += 1;
    family.total += row.total;
    family.fresh += row.fresh;
    if (row.planTokens !== null) { family.measured += 1; family.planTokens += row.planTokens; }
  }
  printTable(Object.entries(families).map(([family, value]) => ({ family, ...value })), [
    { label: "Provider", value: (row) => row.family },
    { label: "Accounts", value: (row) => String(row.accounts) },
    { label: "Measured", value: (row) => String(row.measured) },
    { label: "Tokens", value: (row) => fmt(row.total) },
    { label: "Fresh+out", value: (row) => fmt(row.fresh) },
    { label: "FullPlan sum", value: (row) => fmt(row.planTokens) },
  ]);

  const thin = rows.filter((row) => row.samples < 2);
  if (thin.length) {
    console.log(`\n${thin.length} account(s) have fewer than two samples in this window; their burn is unmeasurable.`);
  }
  const saturated = rows.flatMap((row) =>
    Object.entries(row.buckets).filter(([, stats]) => (stats.end ?? 0) >= 99).map(([bucket]) => `${row.provider}:${bucket}`));
  if (saturated.length) console.log(`Saturated buckets: ${saturated.join(", ")}`);
}

async function sample(args) {
  const db = openDatabase();
  const results = await sampleAll(db, { auth: readAuth(), host: os.hostname() });
  db.close();
  const ok = results.filter((row) => row.status === "ok").length;
  if (args.includes("--quiet")) {
    if (ok === 0) fail("no account produced a reading");
    return;
  }
  printTable(results, [
    { label: "Account", value: (row) => row.provider },
    { label: "Status", value: (row) => row.status },
    { label: "Plan", value: (row) => row.plan ?? row.tier ?? "-" },
    { label: "Buckets", value: (row) => (row.buckets ?? []).map((bucket) =>
      `${bucket.bucket}=${bucket.usedPercent === null ? fmt(bucket.usedUnits) : `${bucket.usedPercent.toFixed(0)}%`}`)
      .join(" ") || (row.detail ?? "") },
  ]);
  console.log(`\n${ok}/${results.length} accounts sampled.`);
  if (ok === 0) fail("no account produced a reading");
}

function doctor() {
  let db;
  try { db = openDatabase(DEFAULT_DB_PATH, { readOnly: true }); }
  catch (error) { fail(`cannot open ${DEFAULT_DB_PATH}: ${error.message}`); }
  const version = db.prepare("SELECT value FROM meta WHERE key='schema_version'").get()?.value;
  const total = db.prepare("SELECT COUNT(*) AS count FROM sample").get().count;
  const latest = db.prepare("SELECT MAX(at) AS at FROM sample").get().at;
  const recent = db.prepare(`
    SELECT status, COUNT(*) AS count FROM sample WHERE at >= ? GROUP BY status ORDER BY count DESC`)
    .all(Date.now() - 86_400_000);
  const stale = latest === null ? Infinity : Date.now() - Number(latest);
  db.close();
  console.log(`Database   ${DEFAULT_DB_PATH}`);
  console.log(`Schema     ${version ?? "missing"} (expected ${SCHEMA_VERSION})`);
  console.log(`Samples    ${total}`);
  console.log(`Latest     ${latest ? new Date(Number(latest)).toISOString() : "never"} (${duration(stale)} ago)`);
  console.log("Last 24h   " + (recent.map((row) => `${row.status}=${row.count}`).join(" ") || "none"));
  if (String(version) !== String(SCHEMA_VERSION)) fail("schema version mismatch");
  if (stale > 3 * 3_600_000) fail("no sample in the last three hours; check plan-meter.timer");
  console.log("\nOK");
}

const [command, ...args] = process.argv.slice(2);
if (command === "sample") await sample(args);
else if (command === "report") report(args);
else if (command === "doctor") doctor();
else {
  console.log(`Usage:
  plan-meter sample [--quiet]      Poll every configured account and append a reading
  plan-meter report [window]       Meter movement and tokens per account (default 24h)
    [--json] [--local]             --local skips the ${REMOTE_HOST} merge
  plan-meter doctor                Verify schema, freshness, and sampling health

Windows accept 30m, 6h, 24h, 7d, 2w or an ISO timestamp.
Reads Pi credentials without refreshing them; an expired token is recorded as a gap.`);
  if (command && command !== "--help" && command !== "-h") process.exit(1);
}

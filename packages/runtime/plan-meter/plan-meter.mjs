#!/usr/bin/env node
import os from "node:os";
import { execFileSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import {
  DEFAULT_DB_PATH, SCHEMA_VERSION, WEEK_SECONDS, openDatabase, readAuth, sampleAll, burn,
  bindingBucket, weeklyTokens,
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

const TOKENS_QUERY = `
  SELECT provider,
         COUNT(*) AS requests,
         COALESCE(SUM(input_tokens),0) AS input,
         COALESCE(SUM(output_tokens),0) AS output,
         COALESCE(SUM(cache_read_tokens),0) AS cache_read,
         COALESCE(SUM(cache_write_tokens),0) AS cache_write,
         COALESCE(SUM(total_tokens),0) AS total
  FROM request
  WHERE started_at >= ? AND started_at < ? AND provider IS NOT NULL
  GROUP BY provider`;

const SAMPLES_QUERY = `
  SELECT s.provider, s.family, s.at, s.status, s.plan, s.tier, s.account_key,
         b.bucket, b.used_percent, b.resets_at, b.window_seconds
  FROM sample s LEFT JOIN bucket b ON b.sample_id = s.sample_id
  WHERE s.at >= ? AND s.at <= ? AND s.status = 'ok'
  ORDER BY s.at`;

function openReadOnly(path) {
  try { return new DatabaseSync(path, { readOnly: true }); }
  catch { return null; }
}

function shapeTokens(row) {
  return {
    requests: Number(row.requests),
    input: Number(row.input),
    output: Number(row.output),
    cacheRead: Number(row.cache_read),
    cacheWrite: Number(row.cache_write),
    total: Number(row.total),
  };
}

/** Content-free token totals per provider alias from the Pi usage ledger. */
function localTokens(lo, hi, dbPath = process.env.PI_USAGE_DB ?? USAGE_DB_PATH) {
  const db = openReadOnly(dbPath);
  if (!db) return {};
  const rows = db.prepare(TOKENS_QUERY).all(lo, hi);
  db.close();
  return Object.fromEntries(rows.map((row) => [row.provider, shapeTokens(row)]));
}

function localSamples(lo, hi, dbPath = DEFAULT_DB_PATH) {
  const db = openReadOnly(dbPath);
  if (!db) return [];
  const rows = db.prepare(SAMPLES_QUERY).all(lo, hi);
  db.close();
  return rows.map((row) => ({ ...row, host: "local" }));
}

/**
 * Earliest instant at which this host observes both token traffic and meter
 * readings. Measuring before it would divide tokens the ledger never saw by
 * meter movement that happened anyway, understating plan capacity.
 */
function localCoverage(usagePath = process.env.PI_USAGE_DB ?? USAGE_DB_PATH, meterPath = DEFAULT_DB_PATH) {
  const usage = openReadOnly(usagePath);
  const meter = openReadOnly(meterPath);
  const first = {
    tokens: usage ? Number(usage.prepare("SELECT MIN(started_at) AS at FROM request").get()?.at ?? 0) : 0,
    meters: meter ? Number(meter.prepare("SELECT MIN(at) AS at FROM sample WHERE status='ok'").get()?.at ?? 0) : 0,
  };
  usage?.close();
  meter?.close();
  return first;
}

/**
 * ssh flattens its command arguments into one remote shell string, so a program
 * passed with `node -e` is re-parsed by that shell and corrupted. Feed the
 * source over stdin to `node -` instead and inline the window bounds.
 */
function remote(script) {
  try {
    return execFileSync("ssh", ["-o", "BatchMode=yes", "-o", "ConnectTimeout=15", REMOTE_HOST, "node", "-"],
      { input: script, encoding: "utf8", timeout: 60_000, maxBuffer: 64 * 1024 * 1024, stdio: ["pipe", "pipe", "pipe"] });
  } catch (error) {
    console.error(`plan-meter: ${REMOTE_HOST} unreachable, reporting local data only (${error?.code ?? "error"})`);
    return null;
  }
}

function remoteJson(script) {
  const raw = remote(script);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

const REMOTE_PRELUDE = `
const { DatabaseSync } = require("node:sqlite");
const os = require("node:os");
const open = (file) => { try { return new DatabaseSync(file, { readOnly: true }); } catch { return null; } };
const usage = open(os.homedir() + "/data/pi-usage/usage.sqlite3");
const meter = open(os.homedir() + "/data/plan-meter/meters.sqlite3");
`;

const remoteCoverageScript = `${REMOTE_PRELUDE}
const out = {
  tokens: usage ? Number(usage.prepare("SELECT MIN(started_at) at FROM request").get().at || 0) : 0,
  meters: meter ? Number(meter.prepare("SELECT MIN(at) at FROM sample WHERE status='ok'").get().at || 0) : 0,
};
process.stdout.write(JSON.stringify(out));
`;

const remoteDataScript = (lo, hi) => `${REMOTE_PRELUDE}
const lo = ${Number(lo)}, hi = ${Number(hi)};
const out = { tokens: {}, samples: [] };
if (usage) {
  for (const row of usage.prepare(${JSON.stringify(TOKENS_QUERY)}).all(lo, hi)) {
    out.tokens[row.provider] = { requests: Number(row.requests), input: Number(row.input), output: Number(row.output), cacheRead: Number(row.cache_read), cacheWrite: Number(row.cache_write), total: Number(row.total) };
  }
}
if (meter) out.samples = meter.prepare(${JSON.stringify(SAMPLES_QUERY)}).all(lo, hi);
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

function accountRows(samples, tokens) {
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
      windowSeconds: stats?.windowSeconds ?? null,
      requests: used.requests,
      total: used.total,
      fresh,
      perPercent: stats && stats.burned > 0 ? used.total / stats.burned : null,
      weekly: weeklyTokens(stats, used.total),
      weeklyFresh: weeklyTokens(stats, fresh),
      buckets: Object.fromEntries(Object.entries(byBucket).map(([name, value]) => [name, {
        ...value, weekly: weeklyTokens(value, used.total),
      }])),
    });
  }
  return rows.sort((left, right) =>
    left.family.localeCompare(right.family, "en") || left.provider.localeCompare(right.provider, "en"));
}

/**
 * Meters tick in whole percent, so a single account over a few hours divides
 * tokens by a 1-2% reading and inherits its rounding error. Pooling every
 * account's tokens over their summed weekly-equivalent burn before multiplying
 * by the account count keeps the family figure stable at short windows.
 */
function familyRows(rows) {
  const families = {};
  for (const row of rows) {
    const family = families[row.family] ??= {
      family: row.family, accounts: 0, measured: 0, total: 0, fresh: 0,
      pooledTokens: 0, pooledFresh: 0, pooledBurn: 0, limits: new Set(),
    };
    family.accounts += 1;
    family.total += row.total;
    family.fresh += row.fresh;
    if (row.weekly === null) continue;
    family.measured += 1;
    family.pooledTokens += row.total;
    family.pooledFresh += row.fresh;
    family.pooledBurn += row.burned * (row.windowSeconds / WEEK_SECONDS);
    family.limits.add(row.bucket);
  }
  return Object.values(families).map((family) => ({
    ...family,
    weekly: family.pooledBurn > 0 ? (family.pooledTokens / family.pooledBurn) * 100 * family.measured : null,
    weeklyFresh: family.pooledBurn > 0 ? (family.pooledFresh / family.pooledBurn) * 100 * family.measured : null,
    limits: [...family.limits].join(", ") || "-",
  }));
}

function totalRow(families) {
  const sum = (key) => families.reduce((value, family) => value + (family[key] ?? 0), 0);
  return {
    family: "TOTAL",
    accounts: sum("accounts"),
    measured: sum("measured"),
    total: sum("total"),
    fresh: sum("fresh"),
    weekly: sum("weekly"),
    weeklyFresh: sum("weeklyFresh"),
    limits: "-",
  };
}

function report(args) {
  const window = args.find((value) => !value.startsWith("--")) ?? "auto";
  const json = args.includes("--json");
  const localOnly = args.includes("--local");
  const hi = Date.now();

  let lo;
  if (window === "auto") {
    const local = localCoverage();
    const remoteFirst = localOnly ? null : remoteJson(remoteCoverageScript);
    const starts = [local.tokens, local.meters, remoteFirst?.tokens, remoteFirst?.meters]
      .map(Number).filter((value) => Number.isFinite(value) && value > 0);
    if (!starts.length) fail("no usage or meter history found; run `plan-meter sample`");
    lo = Math.max(...starts);
  } else {
    lo = since(window);
  }

  const remoteData = localOnly ? null : remoteJson(remoteDataScript(lo, hi));
  const tokens = mergeTokens(localTokens(lo, hi), remoteData?.tokens);
  const samples = [...localSamples(lo, hi), ...(remoteData?.samples ?? []).map((row) => ({ ...row, host: REMOTE_HOST }))];
  const rows = accountRows(samples, tokens);
  const families = familyRows(rows);
  const hours = (hi - lo) / 3_600_000;

  if (json) {
    console.log(JSON.stringify({
      window: { from: new Date(lo).toISOString(), to: new Date(hi).toISOString(), hours, selector: window },
      hosts: localOnly ? ["local"] : ["local", REMOTE_HOST],
      weeklyTokens: totalRow(families).weekly,
      families,
      accounts: rows,
    }, null, 1));
    return;
  }

  console.log(`Plan meter ${new Date(lo).toISOString()} -> ${new Date(hi).toISOString()} (${hours.toFixed(2)}h`
    + `${window === "auto" ? ", auto: full overlap of token and meter history" : ""})`);
  console.log(`Hosts: ${localOnly ? os.hostname() : `${os.hostname()} + ${REMOTE_HOST}`}\n`);
  if (!rows.length) {
    console.log("No samples in window. Run `plan-meter sample` or check plan-meter.timer.");
    return;
  }

  console.log("Weekly capacity per plan (tokens a full 7 days buys at the observed workload)");
  printTable([...families, totalRow(families)], [
    { label: "Provider", value: (row) => row.family },
    { label: "Accts", value: (row) => `${row.measured}/${row.accounts}` },
    { label: "Tokens", value: (row) => fmt(row.total) },
    { label: "Tok/week", value: (row) => row.weekly ? fmt(row.weekly) : "n/a" },
    { label: "Fresh/week", value: (row) => row.weeklyFresh ? fmt(row.weeklyFresh) : "n/a" },
    { label: "Binding limits", value: (row) => row.limits },
  ]);

  console.log("\nPer account (Bucket = the limit that exhausts first, which sets capacity)");
  printTable(rows, [
    { label: "Account", value: (row) => row.provider },
    { label: "Plan", value: (row) => row.plan },
    { label: "Bucket", value: (row) => row.bucket },
    { label: "Win", value: (row) => row.windowSeconds ? duration(row.windowSeconds * 1000) : "n/a" },
    { label: "Start%", value: (row) => row.start === null ? "n/a" : row.start.toFixed(1) },
    { label: "End%", value: (row) => row.end === null ? "n/a" : row.end.toFixed(1) },
    { label: "Burn%", value: (row) => row.burned === null ? "n/a" : row.burned.toFixed(1) },
    { label: "Rst", value: (row) => String(row.resets) },
    { label: "Reqs", value: (row) => String(row.requests) },
    { label: "Tokens", value: (row) => fmt(row.total) },
    { label: "Tok/1%", value: (row) => row.perPercent === null ? "n/a" : fmt(row.perPercent) },
    { label: "Tok/week", value: (row) => row.weekly === null ? "n/a" : fmt(row.weekly) },
    { label: "Resets in", value: (row) => row.resetsAt === null ? "n/a" : duration(row.resetsAt - hi) },
  ]);

  const thin = rows.filter((row) => row.weekly === null);
  if (thin.length) {
    console.log(`\n${thin.length}/${rows.length} account(s) show no measurable meter movement yet`
      + " (idle, saturated, or sampled too recently); their weekly capacity is unmeasurable.");
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
  const families = db.prepare(`
    SELECT family, COUNT(DISTINCT provider) AS accounts FROM sample WHERE at >= ? AND status='ok' GROUP BY family`)
    .all(Date.now() - 86_400_000);
  const stale = latest === null ? Infinity : Date.now() - Number(latest);
  db.close();
  console.log(`Database   ${DEFAULT_DB_PATH}`);
  console.log(`Schema     ${version ?? "missing"} (expected ${SCHEMA_VERSION})`);
  console.log(`Samples    ${total}`);
  console.log(`Latest     ${latest ? new Date(Number(latest)).toISOString() : "never"} (${duration(stale)} ago)`);
  console.log("Last 24h   " + (recent.map((row) => `${row.status}=${row.count}`).join(" ") || "none"));
  console.log("Accounts   " + (families.map((row) => `${row.family}=${row.accounts}`).join(" ") || "none"));
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
  plan-meter report [window]       Weekly plan capacity and tokens per account
    [--json] [--local]             --local skips the ${REMOTE_HOST} merge
  plan-meter doctor                Verify schema, freshness, and sampling health

The default window is 'auto': the longest span both hosts have token and meter
history for. Explicit windows accept 30m, 6h, 24h, 7d, 2w or an ISO timestamp.
Capacity is normalized to ${WEEK_SECONDS / 86400} days, so weekly Codex/Anthropic buckets and the
monthly Cursor cycle are directly comparable.
Reads Pi credentials without refreshing them; an expired token is recorded as a gap.`);
  if (command && command !== "--help" && command !== "-h") process.exit(1);
}

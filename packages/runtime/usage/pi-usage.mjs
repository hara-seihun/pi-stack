#!/usr/bin/env node
import { DatabaseSync } from "node:sqlite";
import { DEFAULT_DB_PATH, SCHEMA_VERSION } from "../extensions/pi-usage-logger/database.mjs";

function fail(message) {
  console.error(`pi-usage: ${message}`);
  process.exit(1);
}

function since(value = "24h") {
  if (/^\d+[mhdw]$/.test(value)) {
    const count = Number(value.slice(0,-1));
    const unit = { m:60_000,h:3_600_000,d:86_400_000,w:604_800_000 }[value.at(-1)];
    return Date.now()-count*unit;
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) fail(`invalid time range: ${value}`);
  return parsed;
}

function fmt(value) {
  const number = Number(value ?? 0);
  if (Math.abs(number) >= 1e9) return `${(number/1e9).toFixed(2)}B`;
  if (Math.abs(number) >= 1e6) return `${(number/1e6).toFixed(2)}M`;
  if (Math.abs(number) >= 1e3) return `${(number/1e3).toFixed(1)}K`;
  return String(Math.round(number));
}

function percent(numerator,denominator) {
  return denominator ? `${(100*Number(numerator)/Number(denominator)).toFixed(2)}%` : "n/a";
}

function open() {
  try { return new DatabaseSync(process.env.PI_USAGE_DB ?? DEFAULT_DB_PATH,{readOnly:true}); }
  catch (error) { fail(error.message); }
}

function rows(db, sql, ...values) {
  return db.prepare(sql).all(...values);
}

function printTable(values, columns) {
  if (!values.length) {
    console.log("No matching records.");
    return;
  }
  const widths = columns.map((column) => Math.max(column.label.length,...values.map((row) => String(column.value(row)).length)));
  console.log(columns.map((column,index) => column.label.padEnd(widths[index])).join("  "));
  console.log(widths.map((width) => "-".repeat(width)).join("  "));
  for (const row of values) console.log(columns.map((column,index) => String(column.value(row)).padEnd(widths[index])).join("  "));
}

function summary(db, from, json) {
  const total = db.prepare(`SELECT count(*) requests,count(DISTINCT session_id) sessions,
    coalesce(sum(input_tokens),0) input,coalesce(sum(output_tokens),0) output,
    coalesce(sum(cache_read_tokens),0) cache_read,coalesce(sum(cache_write_tokens),0) cache_write,
    coalesce(sum(total_tokens),0) total,coalesce(sum(cost_total),0) cost,
    coalesce(sum(stop_reason='error'),0) errors,coalesce(sum(stop_reason='aborted'),0) aborted,
    coalesce(sum(cache_miss_tokens),0) cache_miss,
    coalesce(avg(finished_at-started_at),0) avg_ms
    FROM request WHERE started_at>=?`).get(from);
  const attempts = db.prepare(`SELECT count(*) responses,
    coalesce(sum(attempt>1),0) retries,coalesce(sum(http_status>=400),0) http_errors
    FROM provider_attempt WHERE request_id IN (SELECT request_id FROM request WHERE started_at>=?)`).get(from);
  const diagnostics = db.prepare(`SELECT count(*) diagnostics FROM request_diagnostic
    WHERE request_id IN (SELECT request_id FROM request WHERE started_at>=?)`).get(from);
  const byOwner = rows(db,`SELECT s.owner_kind,count(*) requests,count(DISTINCT r.session_id) sessions,
    sum(r.input_tokens+r.output_tokens+r.cache_write_tokens) noncached,sum(r.cache_read_tokens) cache_read,
    sum(r.input_tokens+r.cache_read_tokens+r.cache_write_tokens) prompt,
    sum(r.input_tokens+r.output_tokens+r.cache_read_tokens+r.cache_write_tokens) tokens,
    coalesce(sum(r.stop_reason='error'),0) errors FROM request r JOIN session s USING(session_id)
    WHERE r.started_at>=? GROUP BY s.owner_kind ORDER BY tokens DESC`,from);
  const byModel = rows(db,`SELECT provider||'/'||model model,count(*) requests,
    sum(input_tokens+output_tokens+cache_write_tokens) noncached,sum(cache_read_tokens) cache_read,
    sum(input_tokens+output_tokens+cache_read_tokens+cache_write_tokens) tokens,
    coalesce(sum(stop_reason='error'),0) errors FROM request WHERE started_at>=? GROUP BY provider,model ORDER BY tokens DESC`,from);
  const payload = { from:new Date(from).toISOString(),total,attempts,diagnostics:diagnostics.diagnostics,byOwner,byModel };
  if (json) return console.log(JSON.stringify(payload,null,2));
  const prompt = Number(total.input)+Number(total.cache_read)+Number(total.cache_write);
  console.log(`Since ${payload.from}`);
  console.log(`Sessions ${total.sessions}  Requests ${total.requests}  Tokens ${fmt(total.total)}  Non-cache-read+output ${fmt(Number(total.input)+Number(total.cache_write)+Number(total.output))}`);
  console.log(`Cache hit ${percent(total.cache_read,prompt)}  Cache misses ${fmt(total.cache_miss)}  Output ${fmt(total.output)}  Errors ${total.errors}  Aborted ${total.aborted}  Mean latency ${(Number(total.avg_ms)/1000).toFixed(1)}s`);
  console.log(`HTTP responses ${attempts.responses}  HTTP retries ${attempts.retries}  HTTP errors ${attempts.http_errors}  Transport diagnostics ${diagnostics.diagnostics}`);
  console.log("\nBy owner");
  printTable(byOwner,[
    {label:"Owner",value:(r)=>r.owner_kind},{label:"Sessions",value:(r)=>r.sessions},{label:"Requests",value:(r)=>r.requests},
    {label:"Tokens",value:(r)=>fmt(r.tokens)},{label:"Fresh+out",value:(r)=>fmt(r.noncached)},
    {label:"Cache",value:(r)=>percent(r.cache_read,r.prompt)},{label:"Errors",value:(r)=>r.errors},
  ]);
  console.log("\nBy model");
  printTable(byModel,[
    {label:"Model",value:(r)=>r.model},{label:"Requests",value:(r)=>r.requests},{label:"Tokens",value:(r)=>fmt(r.tokens)},
    {label:"Fresh+out",value:(r)=>fmt(r.noncached)},{label:"Cache read",value:(r)=>fmt(r.cache_read)},{label:"Errors",value:(r)=>r.errors},
  ]);
}

function top(db, from, limit, json) {
  const result = rows(db,`SELECT s.owner_kind,coalesce(s.owner_label,s.owner_id,s.session_id) owner,s.session_id,
    count(*) requests,sum(r.input_tokens+r.output_tokens+r.cache_read_tokens+r.cache_write_tokens) tokens,
    sum(r.input_tokens+r.output_tokens+r.cache_write_tokens) noncached,sum(r.cache_read_tokens) cache_read,
    sum(r.input_tokens+r.cache_read_tokens+r.cache_write_tokens) prompt,
    sum(r.output_tokens) output,coalesce(sum(r.stop_reason='error'),0) errors,
    max(r.context_bytes) max_context_bytes,max(r.context_tool_result_bytes) max_tool_result_bytes
    FROM request r JOIN session s USING(session_id) WHERE r.started_at>=?
    GROUP BY s.session_id ORDER BY tokens DESC LIMIT ?`,from,limit);
  if (json) return console.log(JSON.stringify(result,null,2));
  printTable(result,[
    {label:"Kind",value:(r)=>r.owner_kind},{label:"Owner",value:(r)=>String(r.owner).slice(0,44)},
    {label:"Req",value:(r)=>r.requests},{label:"Tokens",value:(r)=>fmt(r.tokens)},
    {label:"Fresh+out",value:(r)=>fmt(r.noncached)},{label:"Cache",value:(r)=>percent(r.cache_read,r.prompt)},
    {label:"Output",value:(r)=>fmt(r.output)},{label:"Errors",value:(r)=>r.errors},
    {label:"Max ctx B",value:(r)=>fmt(r.max_context_bytes)},{label:"Max tool B",value:(r)=>fmt(r.max_tool_result_bytes)},
  ]);
}

function failures(db, from, json) {
  const requestErrors = rows(db,`SELECT s.owner_kind,r.provider,r.model,coalesce(r.error_category,'unfinished') category,
    count(*) count,max(r.started_at) latest FROM request r JOIN session s USING(session_id)
    WHERE r.started_at>=? AND (r.stop_reason='error' OR r.finished_at IS NULL)
    GROUP BY s.owner_kind,r.provider,r.model,category ORDER BY count DESC,latest DESC`,from);
  const httpErrors = rows(db,`SELECT r.provider,r.model,a.http_status,count(*) count,max(a.response_at) latest
    FROM provider_attempt a JOIN request r USING(request_id)
    WHERE r.started_at>=? AND a.http_status>=400 GROUP BY r.provider,r.model,a.http_status ORDER BY count DESC,latest DESC`,from);
  const diagnostics = rows(db,`SELECT r.provider,r.model,d.kind,d.error_category,count(*) count,max(coalesce(d.at,r.started_at)) latest
    FROM request_diagnostic d JOIN request r USING(request_id) WHERE r.started_at>=?
    GROUP BY r.provider,r.model,d.kind,d.error_category ORDER BY count DESC,latest DESC`,from);
  const payload = { from:new Date(from).toISOString(),requestErrors,httpErrors,diagnostics };
  if (json) return console.log(JSON.stringify(payload,null,2));
  console.log(`Since ${payload.from}\n\nRequest errors and unfinished requests`);
  printTable(requestErrors,[
    {label:"Owner",value:(r)=>r.owner_kind},{label:"Provider/model",value:(r)=>`${r.provider}/${r.model}`},
    {label:"Category",value:(r)=>r.category},{label:"Count",value:(r)=>r.count},{label:"Latest",value:(r)=>new Date(Number(r.latest)).toISOString()},
  ]);
  console.log("\nHTTP errors");
  printTable(httpErrors,[
    {label:"Provider/model",value:(r)=>`${r.provider}/${r.model}`},{label:"Status",value:(r)=>r.http_status},
    {label:"Count",value:(r)=>r.count},{label:"Latest",value:(r)=>new Date(Number(r.latest)).toISOString()},
  ]);
  console.log("\nTransport diagnostics");
  printTable(diagnostics,[
    {label:"Provider/model",value:(r)=>`${r.provider}/${r.model}`},{label:"Kind",value:(r)=>r.kind},
    {label:"Category",value:(r)=>r.error_category},{label:"Count",value:(r)=>r.count},{label:"Latest",value:(r)=>new Date(Number(r.latest)).toISOString()},
  ]);
}

function doctor(db, json) {
  const version = Number(db.prepare("SELECT value FROM meta WHERE key='schema_version'").get()?.value ?? 0);
  const integrity = db.prepare("PRAGMA integrity_check").get()?.integrity_check;
  const mode = db.prepare("PRAGMA journal_mode").get()?.journal_mode;
  const counts = db.prepare(`SELECT count(*) requests,coalesce(sum(finished_at IS NULL),0) unfinished,
    coalesce(sum(finished_at IS NULL AND started_at<?),0) stale_unfinished,max(started_at) latest FROM request`).get(Date.now()-3_600_000);
  const attempts = db.prepare("SELECT count(*) provider_attempts FROM provider_attempt").get();
  const diagnostics = db.prepare("SELECT count(*) request_diagnostics FROM request_diagnostic").get();
  const payload = { path:process.env.PI_USAGE_DB ?? DEFAULT_DB_PATH,schemaVersion:version,expectedSchemaVersion:SCHEMA_VERSION,integrity,journalMode:mode,...counts,...attempts,...diagnostics,latestIso:counts.latest?new Date(Number(counts.latest)).toISOString():null };
  if (json) console.log(JSON.stringify(payload,null,2));
  else {
    console.log(`Database ${payload.path}`);
    console.log(`Schema ${version}/${SCHEMA_VERSION}  Integrity ${integrity}  Journal ${mode}`);
    console.log(`Requests ${counts.requests}  HTTP attempts ${attempts.provider_attempts}  Diagnostics ${diagnostics.request_diagnostics}`);
    console.log(`Unfinished ${counts.unfinished}  Stale unfinished ${counts.stale_unfinished}  Latest ${payload.latestIso ?? "none"}`);
  }
  if (version !== SCHEMA_VERSION || integrity !== "ok" || mode !== "wal") process.exitCode=1;
}

function usage() {
  console.log(`Usage:
  pi-usage summary [RANGE] [--json]
  pi-usage top [RANGE] [LIMIT] [--json]
  pi-usage failures [RANGE] [--json]
  pi-usage doctor [--json]

RANGE is an ISO timestamp or a duration such as 30m, 24h, 7d, or 4w.`);
}

const args = process.argv.slice(2);
const json = args.includes("--json");
const positional = args.filter((arg) => arg !== "--json");
const command = positional[0] ?? "summary";
if (["help","--help","-h"].includes(command)) usage();
else {
  const db = open();
  try {
    if (command === "summary") summary(db,since(positional[1]),json);
    else if (command === "top") top(db,since(positional[1]),Math.max(1,Math.min(100,Number(positional[2] ?? 20))),json);
    else if (command === "failures") failures(db,since(positional[1]),json);
    else if (command === "doctor") doctor(db,json);
    else fail(`unknown command: ${command}`);
  } finally { db.close(); }
}

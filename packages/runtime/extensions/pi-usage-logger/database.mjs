import { createHash, randomUUID } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { hostname } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";

export const SCHEMA_VERSION = 2;
export const DEFAULT_DATA_DIR = process.env.PI_USAGE_DATA ?? join(process.env.HOME ?? "/home/kenan", "data/pi-usage");
export const DEFAULT_DB_PATH = process.env.PI_USAGE_DB ?? join(DEFAULT_DATA_DIR, "usage.sqlite3");

function finite(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export function usageFields(usage) {
  const value = usage && typeof usage === "object" ? usage : {};
  const cost = value.cost && typeof value.cost === "object" ? value.cost : {};
  const input = finite(value.input);
  const output = finite(value.output);
  const cacheRead = finite(value.cacheRead);
  const cacheWrite = finite(value.cacheWrite);
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    totalTokens: finite(value.totalTokens) || input + output + cacheRead + cacheWrite,
    costInput: finite(cost.input),
    costOutput: finite(cost.output),
    costCacheRead: finite(cost.cacheRead),
    costCacheWrite: finite(cost.cacheWrite),
    costTotal: finite(cost.total),
  };
}

function updateHash(hash, value, counters, key = "") {
  if (value === null) {
    hash.update("n;");
    counters.bytes += 4;
    return;
  }
  if (typeof value === "string") {
    const bytes = Buffer.byteLength(value);
    const hiddenBinary = (key === "data" || key === "source") && value.length > 4096;
    hash.update(hiddenBinary ? `b:${bytes};` : `s:${bytes}:`).update(hiddenBinary ? "" : value).update(";");
    counters.bytes += bytes + 3;
    counters.strings += 1;
    return;
  }
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    const text = String(value);
    hash.update(`${typeof value}:${text};`);
    counters.bytes += text.length + 3;
    return;
  }
  if (Array.isArray(value)) {
    hash.update(`a:${value.length}[`);
    counters.bytes += 3;
    for (const item of value) updateHash(hash, item, counters);
    hash.update("]");
    return;
  }
  if (typeof value === "object") {
    const keys = Object.keys(value).sort();
    hash.update(`o:${keys.length}{`);
    counters.bytes += 3;
    for (const childKey of keys) {
      hash.update(`k:${childKey.length}:${childKey};`);
      counters.bytes += Buffer.byteLength(childKey) + 3;
      updateHash(hash, value[childKey], counters, childKey);
    }
    hash.update("}");
    return;
  }
  hash.update(`x:${typeof value};`);
}

export function fingerprint(value) {
  const hash = createHash("sha256");
  const counters = { bytes: 0, strings: 0 };
  updateHash(hash, value, counters);
  return { hash: hash.digest("hex"), bytes: counters.bytes, strings: counters.strings };
}

function contentMetrics(content, metrics, bucket) {
  if (typeof content === "string") {
    metrics[bucket] += Buffer.byteLength(content);
    return;
  }
  if (!Array.isArray(content)) return;
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    if (block.type === "text") metrics[bucket] += Buffer.byteLength(String(block.text ?? ""));
    else if (block.type === "thinking") metrics.thinkingBytes += Buffer.byteLength(String(block.thinking ?? ""));
    else if (block.type === "image") metrics.imageCount += 1;
    else if (block.type === "toolCall" || block.type === "tool_use") metrics.toolCalls += 1;
  }
}

export function contextMetrics(messages) {
  const metrics = {
    messageCount: 0,
    userBytes: 0,
    assistantBytes: 0,
    thinkingBytes: 0,
    toolResultBytes: 0,
    imageCount: 0,
    toolCalls: 0,
  };
  if (Array.isArray(messages)) {
    metrics.messageCount = messages.length;
    for (const message of messages) {
      if (!message || typeof message !== "object") continue;
      if (message.role === "user") contentMetrics(message.content, metrics, "userBytes");
      else if (message.role === "assistant") contentMetrics(message.content, metrics, "assistantBytes");
      else if (message.role === "toolResult") contentMetrics(message.content, metrics, "toolResultBytes");
      else if (message.role === "bashExecution") metrics.toolResultBytes += Buffer.byteLength(String(message.output ?? ""));
      else if (message.role === "custom") contentMetrics(message.content, metrics, "userBytes");
    }
  }
  return { ...metrics, ...fingerprint(messages ?? []) };
}

export function classifyError(message) {
  const text = String(message ?? "");
  const lower = text.toLowerCase();
  let category = "other";
  if (!text) category = "none";
  else if (/rate.?limit|too many requests|\b429\b|quota|usage limit/.test(lower)) category = "rate_limit";
  else if (/overload|\b529\b|capacity/.test(lower)) category = "overloaded";
  else if (/timeout|timed out|terminated|connection reset|socket/.test(lower)) category = "transport";
  else if (/context|too many tokens|prompt.*long|maximum.*token/.test(lower)) category = "context";
  else if (/auth|unauthor|forbidden|token.*expir|\b401\b|\b403\b/.test(lower)) category = "auth";
  else if (/abort|cancel/.test(lower)) category = "aborted";
  return { category, hash: text ? createHash("sha256").update(text).digest("hex") : null };
}

export function safeResponseHeaders(headers) {
  const result = {};
  if (!headers || typeof headers !== "object") return result;
  for (const [key, value] of Object.entries(headers)) {
    const lower = key.toLowerCase();
    if (lower === "retry-after" || lower === "request-id" || lower === "x-request-id" || lower === "openai-request-id" || lower.includes("ratelimit") || lower.includes("rate-limit") || lower === "x-service-tier") {
      result[lower] = String(value).slice(0, 512);
    }
  }
  return result;
}

function schema(db) {
  db.exec(`
    PRAGMA journal_mode=WAL;
    PRAGMA synchronous=NORMAL;
    PRAGMA foreign_keys=ON;
    PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS session(
      session_id TEXT PRIMARY KEY,
      first_seen INTEGER NOT NULL,
      last_seen INTEGER NOT NULL,
      session_file TEXT,
      cwd TEXT NOT NULL,
      mode TEXT NOT NULL,
      owner_kind TEXT NOT NULL,
      owner_id TEXT,
      owner_label TEXT,
      remote_session_id TEXT,
      orchestrator_run_id TEXT,
      pid INTEGER NOT NULL,
      host TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS agent_run(
      run_id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES session(session_id),
      started_at INTEGER NOT NULL,
      ended_at INTEGER,
      settled_at INTEGER,
      model_provider TEXT,
      model_id TEXT,
      thinking TEXT,
      retry_count INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS turn(
      turn_id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES session(session_id),
      run_id TEXT,
      turn_index INTEGER,
      started_at INTEGER NOT NULL,
      ended_at INTEGER,
      tool_count INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS request(
      request_id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES session(session_id),
      run_id TEXT,
      turn_id TEXT,
      sequence INTEGER NOT NULL,
      started_at INTEGER NOT NULL,
      response_at INTEGER,
      stream_started_at INTEGER,
      finished_at INTEGER,
      provider TEXT,
      model TEXT,
      response_model TEXT,
      api TEXT,
      thinking TEXT,
      http_status INTEGER,
      response_headers TEXT NOT NULL DEFAULT '{}',
      response_id TEXT,
      service_tier TEXT,
      stop_reason TEXT,
      raw_stop_reason TEXT,
      error_category TEXT,
      error_hash TEXT,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      cache_read_tokens INTEGER NOT NULL DEFAULT 0,
      cache_write_tokens INTEGER NOT NULL DEFAULT 0,
      total_tokens INTEGER NOT NULL DEFAULT 0,
      cost_input REAL NOT NULL DEFAULT 0,
      cost_output REAL NOT NULL DEFAULT 0,
      cost_cache_read REAL NOT NULL DEFAULT 0,
      cost_cache_write REAL NOT NULL DEFAULT 0,
      cost_total REAL NOT NULL DEFAULT 0,
      cache_miss_tokens INTEGER,
      system_prompt_bytes INTEGER NOT NULL DEFAULT 0,
      system_prompt_hash TEXT,
      tool_schema_bytes INTEGER NOT NULL DEFAULT 0,
      tool_schema_hash TEXT,
      context_messages INTEGER NOT NULL DEFAULT 0,
      context_bytes INTEGER NOT NULL DEFAULT 0,
      context_hash TEXT,
      context_user_bytes INTEGER NOT NULL DEFAULT 0,
      context_assistant_bytes INTEGER NOT NULL DEFAULT 0,
      context_thinking_bytes INTEGER NOT NULL DEFAULT 0,
      context_tool_result_bytes INTEGER NOT NULL DEFAULT 0,
      context_image_count INTEGER NOT NULL DEFAULT 0,
      context_tool_calls INTEGER NOT NULL DEFAULT 0,
      payload_bytes INTEGER NOT NULL DEFAULT 0,
      payload_hash TEXT,
      payload_system_bytes INTEGER NOT NULL DEFAULT 0,
      payload_system_hash TEXT,
      payload_messages_bytes INTEGER NOT NULL DEFAULT 0,
      payload_messages_hash TEXT,
      payload_tools_bytes INTEGER NOT NULL DEFAULT 0,
      payload_tools_hash TEXT,
      response_bytes INTEGER NOT NULL DEFAULT 0,
      response_hash TEXT,
      response_text_bytes INTEGER NOT NULL DEFAULT 0,
      response_thinking_bytes INTEGER NOT NULL DEFAULT 0,
      response_image_count INTEGER NOT NULL DEFAULT 0,
      response_tool_calls INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS provider_attempt(
      provider_attempt_id TEXT PRIMARY KEY,
      request_id TEXT NOT NULL REFERENCES request(request_id),
      attempt INTEGER NOT NULL,
      response_at INTEGER NOT NULL,
      http_status INTEGER,
      response_headers TEXT NOT NULL DEFAULT '{}',
      UNIQUE(request_id,attempt)
    );
    CREATE TABLE IF NOT EXISTS request_diagnostic(
      request_diagnostic_id TEXT PRIMARY KEY,
      request_id TEXT NOT NULL REFERENCES request(request_id),
      diagnostic_index INTEGER NOT NULL,
      at INTEGER,
      kind TEXT NOT NULL,
      error_category TEXT,
      error_hash TEXT,
      configured_transport TEXT,
      fallback_transport TEXT,
      phase TEXT,
      events_emitted INTEGER,
      request_bytes INTEGER,
      UNIQUE(request_id,diagnostic_index)
    );
    CREATE TABLE IF NOT EXISTS tool_execution(
      tool_execution_id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES session(session_id),
      run_id TEXT,
      turn_id TEXT,
      tool_call_id TEXT,
      tool_name TEXT NOT NULL,
      started_at INTEGER NOT NULL,
      finished_at INTEGER,
      is_error INTEGER,
      args_bytes INTEGER NOT NULL DEFAULT 0,
      args_hash TEXT,
      result_bytes INTEGER NOT NULL DEFAULT 0,
      result_hash TEXT
    );
    CREATE TABLE IF NOT EXISTS usage_event(
      usage_event_id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES session(session_id),
      run_id TEXT,
      at INTEGER NOT NULL,
      kind TEXT NOT NULL,
      reason TEXT,
      success INTEGER,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      cache_read_tokens INTEGER NOT NULL DEFAULT 0,
      cache_write_tokens INTEGER NOT NULL DEFAULT 0,
      total_tokens INTEGER NOT NULL DEFAULT 0,
      cost_total REAL NOT NULL DEFAULT 0,
      tokens_before INTEGER,
      tokens_after INTEGER,
      detail_bytes INTEGER NOT NULL DEFAULT 0,
      detail_hash TEXT
    );
    CREATE TABLE IF NOT EXISTS lifecycle_event(
      lifecycle_event_id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES session(session_id),
      run_id TEXT,
      at INTEGER NOT NULL,
      kind TEXT NOT NULL,
      attempt INTEGER,
      delay_ms INTEGER,
      success INTEGER,
      detail_category TEXT,
      detail_hash TEXT
    );
    CREATE INDEX IF NOT EXISTS request_started ON request(started_at);
    CREATE INDEX IF NOT EXISTS request_session ON request(session_id,sequence);
    CREATE INDEX IF NOT EXISTS request_model ON request(provider,model,started_at);
    CREATE INDEX IF NOT EXISTS provider_attempt_request ON provider_attempt(request_id,attempt);
    CREATE INDEX IF NOT EXISTS provider_attempt_status ON provider_attempt(http_status,response_at);
    CREATE INDEX IF NOT EXISTS request_diagnostic_request ON request_diagnostic(request_id,diagnostic_index);
    CREATE INDEX IF NOT EXISTS session_owner ON session(owner_kind,owner_id,last_seen);
    CREATE INDEX IF NOT EXISTS tool_started ON tool_execution(started_at);
    CREATE INDEX IF NOT EXISTS usage_event_at ON usage_event(at);
    CREATE INDEX IF NOT EXISTS lifecycle_at ON lifecycle_event(at);
  `);
  const requestColumns = new Set(db.prepare("PRAGMA table_info(request)").all().map((column) => column.name));
  const addColumn = (table,name,definition) => {
    try { db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`); }
    catch (error) {
      // Multiple Pi processes can discover the same migration concurrently.
      if (!String(error?.message).includes("duplicate column name")) throw error;
    }
  };
  for (const [name,definition] of [
    ["stream_started_at","INTEGER"],
    ["response_id","TEXT"],
    ["raw_stop_reason","TEXT"],
    ["response_bytes","INTEGER NOT NULL DEFAULT 0"],
    ["response_hash","TEXT"],
    ["response_text_bytes","INTEGER NOT NULL DEFAULT 0"],
    ["response_thinking_bytes","INTEGER NOT NULL DEFAULT 0"],
    ["response_image_count","INTEGER NOT NULL DEFAULT 0"],
    ["response_tool_calls","INTEGER NOT NULL DEFAULT 0"],
  ]) {
    if (!requestColumns.has(name)) addColumn("request",name,definition);
  }
  const usageColumns = new Set(db.prepare("PRAGMA table_info(usage_event)").all().map((column) => column.name));
  if (!usageColumns.has("detail_bytes")) addColumn("usage_event","detail_bytes","INTEGER NOT NULL DEFAULT 0");
  db.prepare("INSERT INTO meta(key,value) VALUES('schema_version',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(String(SCHEMA_VERSION));
}

export class UsageDatabase {
  constructor(path = DEFAULT_DB_PATH) {
    this.path = path;
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    schema(this.db);
    try {
      chmodSync(dirname(path), 0o700);
      chmodSync(path, 0o600);
    } catch {}
    this.statements = new Map();
  }

  statement(sql) {
    let statement = this.statements.get(sql);
    if (!statement) {
      statement = this.db.prepare(sql);
      this.statements.set(sql, statement);
    }
    return statement;
  }

  upsertSession(row) {
    this.statement(`INSERT INTO session(session_id,first_seen,last_seen,session_file,cwd,mode,owner_kind,owner_id,owner_label,remote_session_id,orchestrator_run_id,pid,host)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(session_id) DO UPDATE SET
      last_seen=excluded.last_seen,session_file=excluded.session_file,cwd=excluded.cwd,mode=excluded.mode,
      owner_kind=excluded.owner_kind,owner_id=excluded.owner_id,owner_label=excluded.owner_label,
      remote_session_id=excluded.remote_session_id,orchestrator_run_id=excluded.orchestrator_run_id,pid=excluded.pid,host=excluded.host`)
      .run(row.sessionId,row.at,row.at,row.sessionFile ?? null,row.cwd,row.mode,row.ownerKind,row.ownerId ?? null,row.ownerLabel ?? null,row.remoteSessionId ?? null,row.orchestratorRunId ?? null,process.pid,hostname());
  }

  insertAgentRun(row) {
    this.statement("INSERT INTO agent_run(run_id,session_id,started_at,model_provider,model_id,thinking) VALUES(?,?,?,?,?,?)")
      .run(row.runId,row.sessionId,row.at,row.provider ?? null,row.model ?? null,row.thinking ?? null);
  }

  endAgentRun(runId, at, settled = false) {
    this.statement(settled ? "UPDATE agent_run SET settled_at=? WHERE run_id=?" : "UPDATE agent_run SET ended_at=? WHERE run_id=?").run(at,runId);
  }

  incrementRetry(runId) {
    if (runId) this.statement("UPDATE agent_run SET retry_count=retry_count+1 WHERE run_id=?").run(runId);
  }

  insertTurn(row) {
    this.statement("INSERT INTO turn(turn_id,session_id,run_id,turn_index,started_at) VALUES(?,?,?,?,?)")
      .run(row.turnId,row.sessionId,row.runId ?? null,row.turnIndex ?? null,row.at);
  }

  endTurn(turnId, at, toolCount) {
    this.statement("UPDATE turn SET ended_at=?,tool_count=? WHERE turn_id=?").run(at,toolCount,turnId);
  }

  nextRequestSequence(sessionId) {
    return Number(this.statement("SELECT coalesce(max(sequence),0)+1 sequence FROM request WHERE session_id=?").get(sessionId).sequence);
  }

  insertRequest(row) {
    this.statement(`INSERT INTO request(
      request_id,session_id,run_id,turn_id,sequence,started_at,provider,model,api,thinking,service_tier,
      system_prompt_bytes,system_prompt_hash,tool_schema_bytes,tool_schema_hash,
      context_messages,context_bytes,context_hash,context_user_bytes,context_assistant_bytes,context_thinking_bytes,
      context_tool_result_bytes,context_image_count,context_tool_calls,payload_bytes,payload_hash,
      payload_system_bytes,payload_system_hash,payload_messages_bytes,payload_messages_hash,payload_tools_bytes,payload_tools_hash)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(row.requestId,row.sessionId,row.runId ?? null,row.turnId ?? null,row.sequence,row.at,row.provider ?? null,row.model ?? null,row.api ?? null,row.thinking ?? null,row.serviceTier ?? null,
        row.systemPromptBytes,row.systemPromptHash,row.toolSchemaBytes,row.toolSchemaHash,row.contextMessages,row.contextBytes,row.contextHash,
        row.contextUserBytes,row.contextAssistantBytes,row.contextThinkingBytes,row.contextToolResultBytes,row.contextImageCount,row.contextToolCalls,
        row.payloadBytes,row.payloadHash,row.payloadSystemBytes,row.payloadSystemHash,row.payloadMessagesBytes,row.payloadMessagesHash,row.payloadToolsBytes,row.payloadToolsHash);
  }

  recordResponse(requestId, at, status, headers) {
    const normalizedStatus = Number.isFinite(status) ? status : null;
    const normalizedHeaders = JSON.stringify(safeResponseHeaders(headers));
    const attempt = Number(this.statement("SELECT count(*)+1 attempt FROM provider_attempt WHERE request_id=?").get(requestId).attempt);
    this.statement("INSERT INTO provider_attempt(provider_attempt_id,request_id,attempt,response_at,http_status,response_headers) VALUES(?,?,?,?,?,?)")
      .run(randomUUID(),requestId,attempt,at,normalizedStatus,normalizedHeaders);
    this.statement("UPDATE request SET response_at=coalesce(response_at,?),http_status=?,response_headers=? WHERE request_id=?")
      .run(at,normalizedStatus,normalizedHeaders,requestId);
    return attempt;
  }

  markStreamStart(requestId, at) {
    this.statement("UPDATE request SET stream_started_at=coalesce(stream_started_at,?) WHERE request_id=?").run(at,requestId);
  }

  finishRequest(requestId, at, message, previous) {
    const usage = usageFields(message?.usage);
    const error = classifyError(message?.errorMessage);
    const promptTokens = usage.input + usage.cacheRead + usage.cacheWrite;
    const response = fingerprint(message?.content ?? []);
    const responseMetrics = contextMetrics(message ? [message] : []);
    let cacheMiss = null;
    if (previous && previous.promptTokens > 0 && promptTokens > 0 && (usage.cacheRead > 0 || previous.reportedCache)) {
      cacheMiss = Math.max(0, Math.min(previous.promptTokens,promptTokens)-usage.cacheRead);
    }
    this.statement(`UPDATE request SET finished_at=?,response_model=?,response_id=?,stop_reason=?,raw_stop_reason=?,error_category=?,error_hash=?,
      input_tokens=?,output_tokens=?,cache_read_tokens=?,cache_write_tokens=?,total_tokens=?,
      cost_input=?,cost_output=?,cost_cache_read=?,cost_cache_write=?,cost_total=?,cache_miss_tokens=?,
      response_bytes=?,response_hash=?,response_text_bytes=?,response_thinking_bytes=?,response_image_count=?,response_tool_calls=? WHERE request_id=?`)
      .run(at,message?.responseModel ?? null,message?.responseId ?? null,message?.stopReason ?? null,message?.rawStopReason ?? null,error.category,error.hash,
        usage.input,usage.output,usage.cacheRead,usage.cacheWrite,usage.totalTokens,
        usage.costInput,usage.costOutput,usage.costCacheRead,usage.costCacheWrite,usage.costTotal,cacheMiss,
        response.bytes,response.hash,responseMetrics.assistantBytes,responseMetrics.thinkingBytes,responseMetrics.imageCount,responseMetrics.toolCalls,requestId);
    for (const [index,diagnostic] of (Array.isArray(message?.diagnostics) ? message.diagnostics : []).entries()) {
      if (!diagnostic || typeof diagnostic !== "object") continue;
      const diagnosticError = classifyError(diagnostic.error?.message);
      const details = diagnostic.details && typeof diagnostic.details === "object" ? diagnostic.details : {};
      this.statement(`INSERT OR IGNORE INTO request_diagnostic(request_diagnostic_id,request_id,diagnostic_index,at,kind,error_category,error_hash,
        configured_transport,fallback_transport,phase,events_emitted,request_bytes) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(randomUUID(),requestId,index,Number.isFinite(diagnostic.timestamp) ? diagnostic.timestamp : null,String(diagnostic.type ?? "other").slice(0,128),
          diagnosticError.category,diagnosticError.hash,typeof details.configuredTransport === "string" ? details.configuredTransport.slice(0,64) : null,
          typeof details.fallbackTransport === "string" ? details.fallbackTransport.slice(0,64) : null,typeof details.phase === "string" ? details.phase.slice(0,64) : null,
          typeof details.eventsEmitted === "boolean" ? details.eventsEmitted ? 1 : 0 : null,Number.isFinite(details.requestBytes) ? details.requestBytes : null);
    }
    return { promptTokens, reportedCache: usage.cacheRead + usage.cacheWrite > 0 };
  }

  previousRequest(sessionId, beforeSequence, provider, model) {
    const row = this.statement(`SELECT input_tokens+cache_read_tokens+cache_write_tokens prompt_tokens,
      cache_read_tokens+cache_write_tokens>0 reported_cache FROM request
      WHERE session_id=? AND sequence<? AND provider IS ? AND model IS ? AND finished_at IS NOT NULL
      ORDER BY sequence DESC LIMIT 1`).get(sessionId,beforeSequence,provider ?? null,model ?? null);
    return row ? { promptTokens: Number(row.prompt_tokens), reportedCache: Boolean(row.reported_cache) } : null;
  }

  insertTool(row) {
    this.statement("INSERT INTO tool_execution(tool_execution_id,session_id,run_id,turn_id,tool_call_id,tool_name,started_at,args_bytes,args_hash) VALUES(?,?,?,?,?,?,?,?,?)")
      .run(row.id,row.sessionId,row.runId ?? null,row.turnId ?? null,row.toolCallId ?? null,row.toolName,row.at,row.argsBytes,row.argsHash);
  }

  finishTool(id, at, isError, resultBytes, resultHash) {
    this.statement("UPDATE tool_execution SET finished_at=?,is_error=?,result_bytes=?,result_hash=? WHERE tool_execution_id=?")
      .run(at,isError ? 1 : 0,resultBytes,resultHash,id);
  }

  insertUsageEvent(row) {
    const usage = usageFields(row.usage);
    this.statement(`INSERT INTO usage_event(usage_event_id,session_id,run_id,at,kind,reason,success,input_tokens,output_tokens,cache_read_tokens,cache_write_tokens,total_tokens,cost_total,tokens_before,tokens_after,detail_bytes,detail_hash)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(randomUUID(),row.sessionId,row.runId ?? null,row.at,row.kind,row.reason ?? null,row.success === undefined ? null : row.success ? 1 : 0,
        usage.input,usage.output,usage.cacheRead,usage.cacheWrite,usage.totalTokens,usage.costTotal,row.tokensBefore ?? null,row.tokensAfter ?? null,row.detailBytes ?? 0,row.detailHash ?? null);
  }

  insertLifecycle(row) {
    this.statement(`INSERT INTO lifecycle_event(lifecycle_event_id,session_id,run_id,at,kind,attempt,delay_ms,success,detail_category,detail_hash)
      VALUES(?,?,?,?,?,?,?,?,?,?)`).run(randomUUID(),row.sessionId,row.runId ?? null,row.at,row.kind,row.attempt ?? null,row.delayMs ?? null,
        row.success === undefined ? null : row.success ? 1 : 0,row.detailCategory ?? null,row.detailHash ?? null);
  }

  close() {
    this.db.close();
  }
}

const sharedSymbol = Symbol.for("works.kenan.piUsageDatabases");

export function sharedUsageDatabase(path = DEFAULT_DB_PATH) {
  const root = globalThis;
  if (!root[sharedSymbol]) root[sharedSymbol] = new Map();
  if (!root[sharedSymbol].has(path)) root[sharedSymbol].set(path,new UsageDatabase(path));
  return root[sharedSymbol].get(path);
}

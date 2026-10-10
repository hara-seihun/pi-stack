import { existsSync, readFileSync, openSync, closeSync, readSync, fstatSync, statSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { TextDecoder } from "node:util";
import { projectAnthropicNarrationMessage } from "./anthropic-narration.mjs";
import { isSilentAssistant } from "./manager-turn.mjs";

export const MAX_HISTORY_RECORD_BYTES = 8 * 1024 * 1024;
export const MAX_HISTORY_INDEX_BYTES = 64 * 1024 * 1024;
export const MAX_HISTORY_INDEXES = 32;
const SCAN_CHUNK_BYTES = 64 * 1024;
const indexes = new Map();
const snapshotDescriptors = new WeakMap();
let indexedMetadataBytes = 0;
const decoder = new TextDecoder("utf-8", { fatal: true });
const ok = value => ({ ok: true, value });
const failure = (code, path, message, extra = {}) => ({ ok: false, error: { code, path, message, ...extra } });
const stamp = stat => `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
const sameFile = (a, b) => a.dev === b.dev && a.ino === b.ino;
const nonempty = value => typeof value === "string" && value.length > 0 && value.length <= 4096;
const managerWakeInput = Symbol("managerWakeInput");
const humanFacingText = Symbol("humanFacingText");
const silentAssistant = Symbol("silentAssistant");
const inputReceiptOrigin = Symbol("inputReceiptOrigin");
const landedWorkId = Symbol("landedWorkId");
const inputAssociationBarriers = new Set(["thread_stop", "thread_stopped", "thread_settled", "thread_rejected", "thread_deferred", "thread_resume", "thread_branch"]);
const AGENT_MESSAGE_PREFIX = "<agent_message>\nThis is an agent-to-agent message, not a user message.\n";

function isManagerWakeInput(content) {
  const text = typeof content === "string" ? content : (content ?? [])
    .filter(block => block.type === "text" && typeof block.text === "string").map(block => block.text).join("\n");
  if (!text.startsWith(AGENT_MESSAGE_PREFIX)) return false;
  const metadataEnd = text.indexOf("\n\n", AGENT_MESSAGE_PREFIX.length);
  const bodyEnd = text.lastIndexOf("\n</agent_message>");
  if (metadataEnd < 0 || bodyEnd < metadataEnd + 2) return false;
  let metadata;
  try { metadata = JSON.parse(text.slice(AGENT_MESSAGE_PREFIX.length, metadataEnd)); }
  catch { return false; }
  return metadata !== null && typeof metadata === "object" && !Array.isArray(metadata)
    && (metadata.source === "explicit" || metadata.source === "notification")
    && nonempty(metadata.senderThreadId) && nonempty(metadata.recipientThreadId)
    && typeof metadata.messageId === "string"
    && ["thread-wake:", "manager-questions:", "manager-custody:"].some(prefix => metadata.messageId.startsWith(prefix));
}

function annotateManagerTurns(records) {
  let turnStart = -1, hasText = false, silent = false;
  const annotated = [...records];
  const finish = end => {
    if (turnStart < 0) return;
    const input = records[turnStart];
    const wake = input[managerWakeInput] && input.inputOrigin !== "human";
    const quiet = silent || wake && !hasText;
    if (!quiet && !wake) return;
    for (let index = turnStart; index < end; index++) {
      const record = records[index];
      const hidden = index === turnStart ? wake || quiet && input.inputOrigin === "machine" : quiet;
      annotated[index] = Object.freeze({ ...record, monoVisibility: hidden ? "hidden" : "visible" });
    }
  };
  for (let index = 0; index < records.length; index++) {
    const record = records[index];
    if (record.role === "user") {
      finish(index);
      turnStart = index; hasText = false; silent = false;
    } else if (record.role === "assistant") {
      silent = record[silentAssistant];
      if (record[humanFacingText] && !silent) hasText = true;
      if (turnStart < 0 && silent) annotated[index] = Object.freeze({ ...record, monoVisibility: "hidden" });
    }
  }
  finish(records.length);
  return annotated;
}

function withSource(path, use) {
  let fd, result;
  try { fd = openSync(path, "r"); result = use(fd); }
  catch (error) { result = failure(error.code === "ENOENT" ? "missing" : "io", path, error.message); }
  if (fd !== undefined) {
    try { closeSync(fd); }
    catch (error) { return failure("io", path, error.message); }
  }
  return result;
}

function parseRecord(raw, path, line, offset) {
  let entry;
  try { entry = JSON.parse(decoder.decode(raw)); }
  catch (error) { return failure("invalid-record", path, `Invalid session JSONL at line ${line}: ${error.message}`, { line, offset }); }
  if (!entry || typeof entry !== "object" || Array.isArray(entry) || !nonempty(entry.type)) {
    return failure("invalid-record", path, `Invalid session entry at line ${line}`, { line, offset });
  }
  return ok(entry);
}

function recordMetadata(entry, raw, path, line, offset) {
  if (entry.type === "session") return ok(null);
  if (!nonempty(entry.id) || (entry.parentId != null && !nonempty(entry.parentId))) {
    return failure("invalid-record", path, `Invalid session entry identity at line ${line}`, { line, offset });
  }
  if (entry.timestamp != null && ((typeof entry.timestamp !== "string" && typeof entry.timestamp !== "number") || timestampMs(entry.timestamp) === undefined)) {
    return failure("invalid-record", path, `Invalid session entry timestamp at line ${line}`, { line, offset });
  }
  if (entry.type === "custom" && entry.customType != null && !nonempty(entry.customType)) {
    return failure("invalid-record", path, `Invalid native custom entry type at line ${line}`, { line, offset });
  }
  if (entry.type === "custom" && entry.customType === "thread_input" && entry.data?.inputOrigin !== undefined
    && entry.data.inputOrigin !== "human" && entry.data.inputOrigin !== "machine") {
    return failure("invalid-record", path, `Invalid native input origin at line ${line}`, { line, offset });
  }
  const base = { id: entry.id, parentId: entry.parentId ?? null, type: entry.type, offset, length: raw.length, line,
    timestamp: timestampMs(entry.timestamp) ?? null, digest: createHash("sha256").update(raw).digest("hex"),
    ...(entry.type === "custom" && entry.customType != null ? { customType: entry.customType } : {}),
    ...(entry.type === "custom" && entry.customType === "thread_landed" && nonempty(entry.data?.workId)
      ? { [landedWorkId]: entry.data.workId } : {}),
    ...(entry.type === "custom" && entry.customType === "thread_input" && nonempty(entry.data?.workId)
      && (entry.data.inputOrigin === "human" || entry.data.inputOrigin === "machine")
      ? { [inputReceiptOrigin]: { workId: entry.data.workId, origin: entry.data.inputOrigin } } : {}) };
  if (entry.type !== "message" && entry.type !== "custom_message") return ok(Object.freeze(base));
  const nativeMessage = entry.type === "custom_message" ? { role: "custom", content: entry.content, timestamp: entry.timestamp } : entry.message;
  const message = nativeMessage && typeof nativeMessage === "object" ? projectAnthropicNarrationMessage(nativeMessage) : nativeMessage;
  if (!message || !nonempty(message.role) || (message.toolCallId != null && !nonempty(message.toolCallId))) {
    return failure("invalid-record", path, `Invalid session message at line ${line}`, { line, offset });
  }
  if (typeof message.content !== "string" && !Array.isArray(message.content) && message.content != null) {
    return failure("invalid-record", path, `Invalid session message content at line ${line}`, { line, offset });
  }
  const timestamp = message.timestamp ?? entry.timestamp;
  if (timestamp != null && ((typeof timestamp !== "string" && typeof timestamp !== "number") || timestampMs(timestamp) === undefined)) {
    return failure("invalid-record", path, `Invalid session timestamp at line ${line}`, { line, offset });
  }
  if (message.questionId != null && !nonempty(message.questionId)) {
    return failure("invalid-record", path, `Invalid question receipt identity at line ${line}`, { line, offset });
  }
  const blocks = [];
  for (const [index, block] of (Array.isArray(message.content) ? message.content : []).entries()) {
    if (!block || !nonempty(block.type) || (block.type === "toolCall" && !nonempty(block.id))) {
      return failure("invalid-record", path, `Invalid session content block at line ${line}`, { line, offset });
    }
    if ((block.name != null && !nonempty(block.name)) || (block.namespace != null && !nonempty(block.namespace))) {
      return failure("invalid-record", path, `Invalid session tool metadata at line ${line}`, { line, offset });
    }
    blocks.push(Object.freeze({ index, type: block.type,
      displayed: block.type === "thinking" ? Boolean(String(block.thinking || "").trim())
        : message.role === "assistant" && block.type === "text" ? Boolean(String(block.text || "").trim()) : true,
      ...(block.type === "toolCall" ? { toolCallId: block.id } : {}),
      ...(block.name != null ? { name: block.name } : {}),
      ...(block.namespace != null ? { namespace: block.namespace } : {}),
    }));
  }
  const displayedItemCount = message.role === "assistant" && Array.isArray(message.content)
    ? blocks.filter(block => block.displayed).length + Number(blocks.length === 0 && Boolean(message.errorMessage))
    : message.role === "assistant" && typeof message.content === "string" && !message.content.trim() ? 0 : 1;
  return ok(Object.freeze({ ...base, role: message.role, timestamp: timestampMs(timestamp) ?? null,
    blocks: Object.freeze(blocks), toolCallIds: Object.freeze(blocks.filter(block => block.type === "toolCall").map(block => block.toolCallId)),
    toolResultId: message.role === "toolResult" ? message.toolCallId ?? null : null, displayedItemCount,
    ...(typeof message.rootConsent === "boolean" ? { rootConsent: message.rootConsent } : {}),
    ...(typeof message.questionId === "string" ? { questionId: message.questionId } : {}),
    ...(message.role === "user" ? { [managerWakeInput]: isManagerWakeInput(message.content) } : {}),
    ...(message.role === "assistant" ? { [silentAssistant]: isSilentAssistant(message), [humanFacingText]: typeof message.content === "string" ? Boolean(message.content.trim())
      : (message.content ?? []).some(block => block.type === "text" && typeof block.text === "string" && Boolean(block.text.trim())) } : {}) }));
}

function associateInputIds(records) {
  const pending = new Map(), consumed = new Set(), origins = new Map();
  let addedMetadataBytes = 0;
  const associated = records.map(record => {
    if (record[inputReceiptOrigin]) origins.set(record[inputReceiptOrigin].workId, record[inputReceiptOrigin].origin);
    if (record.type === "custom") {
      pending.set(record.id, record.customType === "thread_landed" ? (record[landedWorkId] ? record : null)
        : inputAssociationBarriers.has(record.customType) ? null : pending.get(record.parentId) ?? null);
    }
    if (record.type !== "message" || record.role !== "user") return record;
    const receipt = pending.get(record.parentId);
    if (!receipt || consumed.has(receipt.id)) return record;
    // Stored order consumes a receipt once, even when a later fork reuses its ancestry.
    consumed.add(receipt.id);
    const inputId = receipt[landedWorkId], inputOrigin = origins.get(inputId);
    if (record.inputId === inputId && record.inputOrigin === inputOrigin) return record;
    const annotated = Object.freeze({ ...record, inputId, ...(inputOrigin ? { inputOrigin } : {}) });
    addedMetadataBytes += metadataBytes(annotated) - metadataBytes(record);
    return annotated;
  });
  return { records: associated, addedMetadataBytes };
}

function metadataBytes(record) {
  const stringBytes = text => typeof text === "string" ? 32 + text.length * 2 : 0;
  let bytes = 512 + [record.id, record.parentId, record.type, record.digest, record.role, record.questionId, record.toolResultId, record.customType, record.inputId, record.inputOrigin, record[inputReceiptOrigin]?.workId, record[inputReceiptOrigin]?.origin, record[landedWorkId]]
    .reduce((sum, text) => sum + stringBytes(text), 0);
  for (const block of record.blocks ?? []) {
    bytes += 256 + stringBytes(block.type) + stringBytes(block.toolCallId) + stringBytes(block.name) + stringBytes(block.namespace);
  }
  return bytes + (record.toolCallIds?.length ?? 0) * 16;
}

function scanRecords(fd, path, size, start, firstLine, hash, hashFrom, initialMetadataBytes) {
  const chunk = Buffer.allocUnsafe(SCAN_CHUNK_BYTES);
  const records = [];
  let parts = [], length = 0, recordStart = start, line = firstLine, position = start, estimatedBytes = initialMetadataBytes;
  const consume = () => {
    const raw = parts.length === 1 ? parts[0] : Buffer.concat(parts, length);
    if (raw.toString("utf8").trim()) {
      const parsed = parseRecord(raw, path, line, recordStart);
      if (!parsed.ok) return parsed;
      const metadata = recordMetadata(parsed.value, raw, path, line, recordStart);
      if (!metadata.ok) return metadata;
      if (metadata.value) {
        estimatedBytes += metadataBytes(metadata.value);
        if (estimatedBytes > MAX_HISTORY_INDEX_BYTES) return failure("oversized-index", path, `Session metadata exceeds ${MAX_HISTORY_INDEX_BYTES} estimated bytes`, { line, offset: recordStart, limit: MAX_HISTORY_INDEX_BYTES });
        records.push(metadata.value);
      }
    }
    parts = []; length = 0;
    return ok(null);
  };
  while (position < size) {
    const bytes = readSync(fd, chunk, 0, Math.min(chunk.length, size - position), position);
    if (!bytes) return failure("stale-source", path, "Session changed during indexing");
    if (position + bytes > hashFrom) hash.update(chunk.subarray(Math.max(0, hashFrom - position), bytes));
    let begin = 0;
    for (let end = 0; end <= bytes; end++) {
      if (end !== bytes && chunk[end] !== 10) continue;
      const part = chunk.subarray(begin, end);
      length += part.length;
      if (length > MAX_HISTORY_RECORD_BYTES) return failure("oversized-record", path, `Session record exceeds ${MAX_HISTORY_RECORD_BYTES} bytes`, { line, offset: recordStart, limit: MAX_HISTORY_RECORD_BYTES });
      if (part.length) parts.push(Buffer.from(part));
      if (end < bytes) {
        const consumed = consume();
        if (!consumed.ok) return consumed;
        line++; recordStart = position + end + 1;
      }
      begin = end + 1;
    }
    position += bytes;
  }
  if (length) {
    const consumed = consume();
    if (!consumed.ok) return consumed;
  }
  return ok({ records, metadataBytes: estimatedBytes, resumeOffset: recordStart, resumeLine: line });
}

function hashRange(fd, path, hash, start, end) {
  const chunk = Buffer.allocUnsafe(SCAN_CHUNK_BYTES);
  for (let position = start; position < end;) {
    const bytes = readSync(fd, chunk, 0, Math.min(chunk.length, end - position), position);
    if (!bytes) return failure("stale-source", path, "Session changed during indexing");
    hash.update(chunk.subarray(0, bytes)); position += bytes;
  }
  return ok(hash);
}

function branchRecords(cache, path, leafId, managerWakeVisibility, inputOrigins) {
  const byId = cache.byId;
  let leaf = leafId === undefined ? cache.records.at(-1) : byId.get(leafId);
  if (leafId !== undefined && !leaf) return failure("invalid-branch", path, `Session entry not found: ${leafId}`, { entryId: leafId });
  const chain = [], visited = new Set();
  while (leaf) {
    if (visited.has(leaf.id)) return failure("invalid-branch", path, `Cycle in session parent chain at ${leaf.id}`, { entryId: leaf.id });
    visited.add(leaf.id); chain.push(leaf);
    if (leaf.parentId !== null && !byId.has(leaf.parentId)) return failure("invalid-branch", path, `Missing session parent ${leaf.parentId} for ${leaf.id}`, { entryId: leaf.id });
    leaf = byId.get(leaf.parentId);
  }
  chain.reverse();
  const classified = [];
  for (const record of chain) {
    const inputOrigin = record.inputId && inputOrigins && Object.hasOwn(inputOrigins, record.inputId) ? inputOrigins[record.inputId] : undefined;
    if (inputOrigin !== undefined && inputOrigin !== "human" && inputOrigin !== "machine") return failure("invalid-record", path, "Invalid controller input origin", { entryId: record.id });
    if (inputOrigin !== undefined && record.inputOrigin !== undefined && inputOrigin !== record.inputOrigin) return failure("invalid-record", path, "Native and controller input origin disagree", { entryId: record.id });
    classified.push(inputOrigin && inputOrigin !== record.inputOrigin ? Object.freeze({ ...record, inputOrigin }) : record);
  }
  const entries = managerWakeVisibility ? annotateManagerTurns(classified) : classified;
  const messages = entries.filter(record => record.type === "message" || record.type === "custom_message");
  const results = new Map(messages.filter(record => record.role === "toolResult").map(record => [record.toolResultId, record]));
  const paired = new Set();
  const displayed = messages.map(record => {
    if (record.role === "assistant") {
      for (const id of record.toolCallIds) if (results.has(id)) paired.add(results.get(id));
    }
    return paired.has(record) ? Object.freeze({ ...record, pairedToolResult: true }) : record;
  });
  const messageById = new Map(displayed.map(record => [record.id, record]));
  return ok({ leafId: chain.at(-1)?.id ?? null, messages: Object.freeze(displayed),
    entries: Object.freeze(entries.map(record => messageById.get(record.id) ?? record)) });
}

function readIndexedRecord(source, descriptors, descriptor) {
  if (!descriptors.has(descriptor)) return failure("invalid-descriptor", source.path, "Record descriptor does not belong to this history snapshot");
  if (descriptor.length > MAX_HISTORY_RECORD_BYTES) return failure("oversized-record", source.path, `Session record exceeds ${MAX_HISTORY_RECORD_BYTES} bytes`, { line: descriptor.line, offset: descriptor.offset, limit: MAX_HISTORY_RECORD_BYTES });
  return withSource(source.path, fd => {
    if (stamp(fstatSync(fd, { bigint: true })) !== source.revision) return failure("stale-source", source.path, "Session revision changed; refresh the history index");
    const record = readRecordAt(fd, source, descriptor);
    if (stamp(fstatSync(fd, { bigint: true })) !== source.revision || stamp(statSync(source.path, { bigint: true })) !== source.revision) {
      return failure("stale-source", source.path, "Session record changed during reading");
    }
    return record;
  });
}

function readRecordAt(fd, source, descriptor) {
  const raw = Buffer.allocUnsafe(descriptor.length);
  let position = 0;
  while (position < raw.length) {
    const bytes = readSync(fd, raw, position, raw.length - position, descriptor.offset + position);
    if (!bytes) return failure("stale-source", source.path, "Session record changed during reading");
    position += bytes;
  }
  if (createHash("sha256").update(raw).digest("hex") !== descriptor.digest) {
    return failure("stale-source", source.path, "Session record changed during reading");
  }
  return parseRecord(raw, source.path, descriptor.line, descriptor.offset);
}

/** Project a bounded window synchronously; discard the whole projection if its exact revision changes. */
export function withIndexedThreadHistory(path, leafId, options, project) {
  path = resolve(path);
  let generation;
  for (let attempt = 0; attempt < 3; attempt++) {
    let retryable = true;
    const result = withSource(path, fd => {
      const indexed = indexedThreadHistory(path, leafId, options);
      if (!indexed.ok) return indexed;
      const history = indexed.value, source = history.source;
      if (generation !== undefined && generation !== source.generation) {
        retryable = false;
        return failure("stale-source", path, "Session was rewritten or replaced during window reading");
      }
      generation = source.generation;
      if (stamp(fstatSync(fd, { bigint: true })) !== source.revision) return failure("stale-source", path, "Session changed before window reading");
      const descriptors = snapshotDescriptors.get(history);
      let active = true;
      const scoped = Object.freeze({ ...history, read: descriptor => {
        if (!active || !descriptors.has(descriptor)) return failure("invalid-descriptor", path, "Record descriptor does not belong to this active history snapshot");
        if (descriptor.length > MAX_HISTORY_RECORD_BYTES) return failure("oversized-record", path, `Session record exceeds ${MAX_HISTORY_RECORD_BYTES} bytes`, { limit: MAX_HISTORY_RECORD_BYTES });
        return readRecordAt(fd, source, descriptor);
      } });
      let value;
      try { value = project(scoped); }
      finally { active = false; }
      if (stamp(fstatSync(fd, { bigint: true })) !== source.revision || stamp(statSync(path, { bigint: true })) !== source.revision) {
        return failure("stale-source", path, "Session changed during window reading");
      }
      return ok(value);
    });
    if (result.ok || !retryable || result.error.code !== "stale-source") return result;
  }
  return failure("stale-source", path, "Session kept changing during window reading; refresh the history index");
}

function trimIndexCache() {
  while (indexes.size > MAX_HISTORY_INDEXES || indexedMetadataBytes > MAX_HISTORY_INDEX_BYTES) {
    const oldest = indexes.keys().next().value;
    indexedMetadataBytes -= indexes.get(oldest).metadataBytes;
    indexes.delete(oldest);
  }
}

function snapshotBytes(branch) {
  return 1024 + branch.entries.length * 96 + branch.messages.length * 16
    + branch.messages.filter(record => record.pairedToolResult).length * 256
    + branch.entries.filter(record => record.monoVisibility !== undefined).length * 512;
}

/** Native JSONL remains authoritative. The cache retains offsets and metadata, never message bodies. */
export function indexedThreadHistory(path, leafId, options) {
  path = resolve(path);
  return withSource(path, fd => {
    const stat = fstatSync(fd, { bigint: true });
    if (!stat.isFile() || stat.size > BigInt(Number.MAX_SAFE_INTEGER)) return failure("io", path, "Session source must be a seekable, safely addressable file");
    const revision = stamp(stat), size = Number(stat.size);
    let cache = indexes.get(path);
    if (!cache || cache.revision !== revision) {
      const hash = createHash("sha256");
      let append = false;
      if (cache && sameFile(cache.stat, stat) && size > cache.size) {
        const prefix = hashRange(fd, path, hash, 0, cache.size);
        if (!prefix.ok) return prefix;
        append = hash.copy().digest("hex") === cache.digest;
      }
      const completeHash = append ? hash : createHash("sha256");
      const retained = append ? cache.records.filter(record => record.offset < cache.resumeOffset) : [];
      const initialMetadataBytes = append ? cache.recordMetadataBytes - cache.records
        .filter(record => record.offset >= cache.resumeOffset).reduce((sum, record) => sum + metadataBytes(record), 0) : 0;
      const scanned = scanRecords(fd, path, size, append ? cache.resumeOffset : 0, append ? cache.resumeLine : 1,
        completeHash, append ? cache.size : 0, initialMetadataBytes);
      if (!scanned.ok) return scanned;
      const associated = associateInputIds(append ? [...retained, ...scanned.value.records] : scanned.value.records);
      const records = associated.records;
      const recordMetadataBytes = scanned.value.metadataBytes + associated.addedMetadataBytes;
      if (recordMetadataBytes > MAX_HISTORY_INDEX_BYTES) return failure("oversized-index", path, `Session metadata exceeds ${MAX_HISTORY_INDEX_BYTES} estimated bytes`, { limit: MAX_HISTORY_INDEX_BYTES });
      const byId = new Map();
      for (const record of records) {
        if (byId.has(record.id)) return failure("invalid-record", path, `Duplicate session entry ${record.id}`, { line: record.line, offset: record.offset, entryId: record.id });
        byId.set(record.id, record);
      }
      if (stamp(fstatSync(fd, { bigint: true })) !== revision || stamp(statSync(path, { bigint: true })) !== revision) return failure("stale-source", path, "Session changed during indexing");
      cache = { stat, revision, size, generation: append ? cache.generation : randomUUID(), digest: completeHash.digest("hex"),
        records, byId, recordMetadataBytes, metadataBytes: recordMetadataBytes,
        snapshots: new Map(), resumeOffset: scanned.value.resumeOffset, resumeLine: scanned.value.resumeLine };
      const previous = indexes.get(path);
      if (previous) indexedMetadataBytes -= previous.metadataBytes;
      indexes.delete(path); indexes.set(path, cache);
      indexedMetadataBytes += cache.metadataBytes;
      trimIndexCache();
    } else {
      indexes.delete(path); indexes.set(path, cache);
    }
    const managerWakeVisibility = options?.managerWakeVisibility === true;
    const inputOrigins = options?.inputOrigins;
    const snapshotKey = JSON.stringify([leafId ?? null, managerWakeVisibility, inputOrigins ?? null]);
    const known = cache.snapshots.get(snapshotKey);
    if (known) {
      if (stamp(statSync(path, { bigint: true })) !== revision) return failure("stale-source", path, "Session changed during indexing");
      cache.snapshots.delete(snapshotKey); cache.snapshots.set(snapshotKey, known);
      return ok(known.value);
    }
    const branch = branchRecords(cache, path, leafId, managerWakeVisibility, inputOrigins);
    if (!branch.ok) return branch;
    if (stamp(statSync(path, { bigint: true })) !== revision) return failure("stale-source", path, "Session changed during indexing");
    const bytes = snapshotBytes(branch.value) + snapshotKey.length * 2;
    if (cache.recordMetadataBytes + bytes > MAX_HISTORY_INDEX_BYTES)
      return failure("oversized-index", path, `Session metadata and branch snapshot exceed ${MAX_HISTORY_INDEX_BYTES} estimated bytes`, { limit: MAX_HISTORY_INDEX_BYTES });
    while (cache.snapshots.size >= MAX_HISTORY_INDEXES || cache.metadataBytes + bytes > MAX_HISTORY_INDEX_BYTES) {
      const oldest = cache.snapshots.keys().next().value;
      const dropped = cache.snapshots.get(oldest);
      cache.snapshots.delete(oldest);
      cache.metadataBytes -= dropped.bytes; indexedMetadataBytes -= dropped.bytes;
    }
    const source = Object.freeze({ kind: "native-jsonl", path, generation: cache.generation, revision, size, leafId: branch.value.leafId });
    const descriptors = new Set(branch.value.entries);
    const presentationRevision = createHash("sha256").update(snapshotKey).digest("hex");
    const value = Object.freeze({ source, presentationRevision, entries: branch.value.entries, messages: branch.value.messages,
      read: descriptor => readIndexedRecord(source, descriptors, descriptor) });
    snapshotDescriptors.set(value, descriptors);
    cache.snapshots.set(snapshotKey, { value, bytes });
    cache.metadataBytes += bytes; indexedMetadataBytes += bytes;
    trimIndexCache();
    return ok(value);
  });
}

export function readThreadHistory(path, leafId) {
  if (!existsSync(path)) return [];
  return activePath(parseSession(readFileSync(path, "utf8")), leafId);
}

export function visibleThreadHistory(path, leafId) {
  return readThreadHistory(path, leafId).flatMap(entry => {
    if (!["message", "custom_message"].includes(entry.type)) return [];
    if (entry.message?.role !== "assistant" || !Array.isArray(entry.message.content)) return [entry];
    const message = projectAnthropicNarrationMessage(entry.message);
    const content = message.content.filter(block => block.type !== "thinking").map(block => {
      const { thinkingSignature, textSignature, encrypted_content, encryptedContent, thoughtSignature, ...visible } = block;
      return visible;
    });
    return [{ ...entry, message: { ...entry.message, content } }];
  });
}

export function parseSession(text) {
  const entries = [];
  const lines = text.split("\n");
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (!line.trim()) continue;
    try {
      entries.push(JSON.parse(line));
    } catch (error) {
      if (index === lines.length - 1) break;
      throw new Error(`Invalid session JSONL at line ${index + 1}: ${error.message}`);
    }
  }
  return entries;
}

/** The newest stored entry is the persisted branch tip; a live runtime can supply an explicit leaf. */
export function activePath(entries, leafId) {
  const tree = entries.filter((entry) => entry.type !== "session" && entry.id);
  const byId = new Map(tree.map((entry) => [entry.id, entry]));
  let leaf = leafId === undefined ? tree.at(-1) : byId.get(leafId);
  if (leafId !== undefined && !leaf) throw new Error(`Session entry not found: ${leafId}`);
  const path = [];
  const visited = new Set();
  for (let cursor = leaf; cursor; cursor = byId.get(cursor.parentId)) {
    if (visited.has(cursor.id)) throw new Error(`Cycle in session parent chain at ${cursor.id}`);
    visited.add(cursor.id);
    path.push(cursor);
    if (cursor.parentId && !byId.has(cursor.parentId)) throw new Error(`Missing session parent ${cursor.parentId} for ${cursor.id}`);
  }
  return path.reverse();
}

export function timestampMs(value) {
  const parsed = typeof value === "number" ? value : Date.parse(value ?? "");
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function sessionRecords(text) {
  const entries = parseSession(text);
  let index = 0;
  return text.split("\n").flatMap((raw, line) => {
    if (!raw.trim() || index >= entries.length) return [];
    return [{ entry: entries[index++], raw, line: line + 1 }];
  });
}

import { createHash } from "node:crypto";
import { CString, dlopen, ptr, type Pointer } from "bun:ffi";
import type { Database } from "bun:sqlite";
import { messageFinalizationKey } from "./sync";
import { displayAssistantMessage } from "./context-display";
import { ResourceCache } from "../shared/resource-cache";

export const CONTEXT_CHUNK_BYTES = 64 * 1024;
export const CONTEXT_RECORD_BYTES = 8 * 1024 * 1024;
export const CONTEXT_INDEX_CACHE_BYTES = 64 * 1024 * 1024;
export const CONTEXT_INDEX_CACHE_ENTRIES = 32;
const METADATA_FIELD_BYTES = 16 * 1024;
const INDEX_ENTRIES = 500_000;
const INDEX_METADATA_BYTES = 32 * 1024 * 1024;

export type ContextSourceError =
  | { code: "invalid"; detail: string }
  | { code: "stale"; detail: string }
  | { code: "oversized"; detail: string; bytes: number; limit: number }
  | { code: "storage"; detail: string };
export type ContextReadResult<T> = { ok: true; value: T } | { ok: false; error: ContextSourceError };
const ok = <T>(value: T): ContextReadResult<T> => ({ ok: true, value });
const invalid = (detail: string): ContextReadResult<never> => ({ ok: false, error: { code: "invalid", detail } });
const oversized = (detail: string, bytes: number, limit: number): ContextReadResult<never> =>
  ({ ok: false, error: { code: "oversized", detail, bytes, limit } });
function storage<T>(action: () => ContextReadResult<T>): ContextReadResult<T> {
  try { return action(); }
  catch (cause) { return { ok: false, error: { code: "storage", detail: cause instanceof Error ? cause.message : String(cause) } }; }
}

export interface ContextBlockDescriptor {
  index: number;
  type: string;
  id?: string;
  thinkingNonempty?: boolean;
  thinkingEmpty?: boolean;
}
export interface ContextMessageDescriptor {
  index: number;
  offset: number;
  bytes: number;
  role: string;
  timestamp?: number;
  contentKind: "unset" | "string" | "array" | "other";
  blocks: ContextBlockDescriptor[];
  toolCallId?: string;
  errorMessageNonempty?: boolean;
  displayItemCount: number;
  finalizationKey?: string;
  finalizationKeyError?: ContextSourceError;
  recordHash: string;
  rootConsent?: boolean;
  questionId?: string;
}
export interface IndexedContextHeader {
  systemPrompt: string;
  tools: any[];
  contextUsage?: any;
  contextModel?: string;
  source?: any;
}
export interface ContextByteStream {
  next(): ContextReadResult<Uint8Array | null>;
  close(): ContextReadResult<void>;
}
export interface IndexedContext {
  capturedAt: number;
  revision: string;
  metadataBytes: number;
  sourceToken: string;
  totalBytes: number;
  header: IndexedContextHeader;
  messages: ContextMessageDescriptor[];
  readMessage(index: number, expectedRevision?: string): ContextReadResult<any>;
  readBytes(offset: number, bytes: number, expectedRevision?: string): ContextReadResult<Uint8Array>;
  openByteStream(expectedRevision?: string): ContextReadResult<ContextByteStream>;
}

type BaseRow = { captured_at: number; bytes: number; row_id: number };
type PatchRow = { seq: number; captured_at: number; base_hash: string; target_hash: string;
  prefix_bytes: number; delete_bytes: number; encoded_bytes: number };
type Snapshot = { base: BaseRow; patches: PatchRow[]; token: string };
type Piece = { kind: "base" | "patch"; seq: number; start: number; bytes: number };
function snapshot(db: Database, sessionId: string): Snapshot | null {
  const base = db.query("SELECT rowid AS row_id,captured_at,octet_length(context) AS bytes FROM session_contexts WHERE session_id=?")
    .get(sessionId) as BaseRow | null;
  if (!base) return null;
  const patches = db.query(`SELECT seq,captured_at,base_hash,target_hash,prefix_bytes,delete_bytes,
    octet_length(insert_base64) AS encoded_bytes
    FROM session_context_patches WHERE session_id=? ORDER BY seq LIMIT 1025`).all(sessionId) as PatchRow[];
  return { base, patches, token: JSON.stringify([base, patches]) };
}

const sqliteSymbols = {
  sqlite3_open_v2: { args: ["ptr", "ptr", "i32", "ptr"], returns: "i32" },
  sqlite3_close_v2: { args: ["ptr"], returns: "i32" },
  sqlite3_errmsg: { args: ["ptr"], returns: "ptr" },
  sqlite3_exec: { args: ["ptr", "ptr", "ptr", "ptr", "ptr"], returns: "i32" },
  sqlite3_blob_open: { args: ["ptr", "ptr", "ptr", "ptr", "i64", "i32", "ptr"], returns: "i32" },
  sqlite3_blob_read: { args: ["ptr", "ptr", "i32", "i32"], returns: "i32" },
  sqlite3_blob_close: { args: ["ptr"], returns: "i32" },
} as const;
type SqliteLibrary = ReturnType<typeof dlopen<typeof sqliteSymbols>>;
let sqliteLibrary: SqliteLibrary | null = null;
const cString = (value: string) => Buffer.from(value + "\0");
const outPointer = (output: BigUint64Array): Pointer => Number(output[0]) as Pointer;

class NativeBlobs {
  private blobs = new Map<string, Pointer>();
  private constructor(readonly library: SqliteLibrary, readonly connection: Pointer) {}
  static open(filename: string): ContextReadResult<NativeBlobs> {
    return storage(() => {
      const library = sqliteLibrary ??= dlopen("libsqlite3.so.0", sqliteSymbols);
      const output = new BigUint64Array(1);
      const status = library.symbols.sqlite3_open_v2(cString(filename), output, 1 | 0x10000, null);
      const connection = outPointer(output);
      if (status !== 0) {
        const detail = connection ? new CString(library.symbols.sqlite3_errmsg(connection)).toString() : `SQLite status ${status}`;
        if (connection) library.symbols.sqlite3_close_v2(connection);
        return { ok: false, error: { code: "storage", detail } };
      }
      const configured = library.symbols.sqlite3_exec(connection, cString("PRAGMA cache_size=-2048; BEGIN"), null, null, null);
      if (configured !== 0) {
        const detail = new CString(library.symbols.sqlite3_errmsg(connection)).toString();
        library.symbols.sqlite3_close_v2(connection);
        return { ok: false, error: { code: "storage", detail } };
      }
      return ok(new NativeBlobs(library, connection));
    });
  }
  read(table: string, column: string, rowid: number, offset: number, bytes: number): ContextReadResult<Buffer> {
    const key = `${table}:${rowid}`;
    let blob = this.blobs.get(key);
    if (!blob) {
      const output = new BigUint64Array(1);
      const status = this.library.symbols.sqlite3_blob_open(this.connection, cString("main"), cString(table), cString(column), rowid, 0, output);
      if (status !== 0) return { ok: false, error: { code: "storage", detail: new CString(this.library.symbols.sqlite3_errmsg(this.connection)).toString() } };
      blob = outPointer(output);
      this.blobs.set(key, blob);
    }
    const result = Buffer.allocUnsafe(bytes);
    if (bytes === 0) return ok(result);
    const status = this.library.symbols.sqlite3_blob_read(blob, ptr(result), bytes, offset);
    return status === 0 ? ok(result) : { ok: false, error: { code: "storage", detail: new CString(this.library.symbols.sqlite3_errmsg(this.connection)).toString() } };
  }
  close(): ContextReadResult<void> {
    let status = 0;
    for (const blob of this.blobs.values()) {
      const closed = this.library.symbols.sqlite3_blob_close(blob);
      if (closed !== 0) status = closed;
    }
    this.blobs.clear();
    const closed = this.library.symbols.sqlite3_close_v2(this.connection);
    if (closed !== 0) status = closed;
    return status === 0 ? ok(undefined) : { ok: false, error: { code: "storage", detail: `Closing incremental SQLite source failed (${status})` } };
  }
}

class ByteSource {
  private native: NativeBlobs | null = null;
  private constructor(readonly db: Database, readonly sessionId: string, readonly state: Snapshot,
    public pieces: Piece[], public bytes: number, public capturedAt: number) {}
  fork(): ByteSource { return new ByteSource(this.db, this.sessionId, this.state, this.pieces, this.bytes, this.capturedAt); }
  close(): ContextReadResult<void> {
    const result = this.native?.close() ?? ok(undefined);
    this.native = null;
    return result;
  }
  using<T>(action: () => ContextReadResult<T>): ContextReadResult<T> {
    let result: ContextReadResult<T>;
    try { result = storage(action); }
    finally {
      const closed = this.close();
      if (!closed.ok) result = closed;
    }
    return result!;
  }
  private raw(kind: "base" | "patch", seq: number, offset: number, bytes: number): ContextReadResult<Buffer> {
    if (this.db.filename === ":memory:" || this.db.filename === "") {
      const sql = kind === "base"
        ? "SELECT substr(CAST(context AS BLOB),?,?) AS chunk FROM session_contexts WHERE session_id=?"
        : "SELECT substr(CAST(insert_base64 AS BLOB),?,?) AS chunk FROM session_context_patches WHERE session_id=? AND seq=?";
      const row = this.db.query(sql).get(...(kind === "base" ? [offset + 1, bytes, this.sessionId] : [offset + 1, bytes, this.sessionId, seq])) as { chunk: Uint8Array } | null;
      return row && row.chunk.length === bytes ? ok(Buffer.from(row.chunk)) : invalid("Captured SQLite source disappeared or was shortened");
    }
    if (!this.native) {
      const opened = NativeBlobs.open(this.db.filename);
      if (!opened.ok) return opened;
      this.native = opened.value;
    }
    return kind === "base"
      ? this.native.read("session_contexts", "context", this.state.base.row_id, offset, bytes)
      : this.native.read("session_context_patches", "insert_base64", seq, offset, bytes);
  }

  static open(db: Database, sessionId: string): ContextReadResult<ByteSource | null> {
    const state = snapshot(db, sessionId);
    if (!state) return ok(null);
    if (!Number.isSafeInteger(state.base.bytes) || state.base.bytes < 0 || !Number.isSafeInteger(state.base.captured_at))
      return invalid("Invalid captured context base metadata");
    if (state.patches.length > 1024) return oversized("Context patch journal", state.patches.length, 1024);
    if ((db.filename === ":memory:" || db.filename === "")
      && Math.max(state.base.bytes, ...state.patches.map(patch => patch.encoded_bytes)) > CONTEXT_RECORD_BYTES)
      return oversized("In-memory SQLite source cannot use incremental blobs", Math.max(state.base.bytes, ...state.patches.map(patch => patch.encoded_bytes)), CONTEXT_RECORD_BYTES);
    const source = new ByteSource(db, sessionId, state, [], state.base.bytes, state.base.captured_at);
    return source.using(() => {
    let pieces: Piece[] = [{ kind: "base", seq: 0, start: 0, bytes: state.base.bytes }];
    let bytes = state.base.bytes;
    let hash: string | undefined;
    if (state.patches.length) {
      const baseHash = createHash("sha256");
      for (let offset = 0; offset < state.base.bytes; offset += CONTEXT_CHUNK_BYTES) {
        const chunk = source.raw("base", 0, offset, Math.min(CONTEXT_CHUNK_BYTES, state.base.bytes - offset));
        if (!chunk.ok) return chunk;
        baseHash.update(chunk.value);
      }
      hash = baseHash.digest("hex");
    }
    let capturedAt = state.base.captured_at;
    for (const patch of state.patches) {
      if (!/^[a-f0-9]{64}$/.test(patch.base_hash) || !/^[a-f0-9]{64}$/.test(patch.target_hash))
        return invalid("Invalid context patch hash");
      if (hash !== undefined && patch.base_hash !== hash) return invalid("Context patch hash chain does not match");
      if (![patch.prefix_bytes, patch.delete_bytes, patch.encoded_bytes, patch.captured_at].every(Number.isSafeInteger)
        || patch.prefix_bytes < 0 || patch.delete_bytes < 0 || patch.prefix_bytes + patch.delete_bytes > bytes
        || patch.encoded_bytes < 0 || patch.encoded_bytes % 4 !== 0)
        return invalid("Invalid context patch range or encoding length");
      const tailRead = source.raw("patch", patch.seq, Math.max(0, patch.encoded_bytes - 2), Math.min(2, patch.encoded_bytes));
      if (!tailRead.ok) return tailRead;
      const tail = tailRead.value.toString("ascii");
      const insertBytes = patch.encoded_bytes / 4 * 3 - (tail.endsWith("==") ? 2 : tail.endsWith("=") ? 1 : 0);
      const prefix: Piece[] = [], suffix: Piece[] = [];
      let position = 0;
      const end = patch.prefix_bytes + patch.delete_bytes;
      for (const piece of pieces) {
        if (position < patch.prefix_bytes) prefix.push({ ...piece, bytes: Math.min(piece.bytes, patch.prefix_bytes - position) });
        if (position + piece.bytes > end) {
          const skip = Math.max(0, end - position);
          suffix.push({ ...piece, start: piece.start + skip, bytes: piece.bytes - skip });
        }
        position += piece.bytes;
      }
      pieces = [...prefix, { kind: "patch" as const, seq: patch.seq, start: 0, bytes: insertBytes }, ...suffix].filter(piece => piece.bytes > 0);
      bytes += insertBytes - patch.delete_bytes;
      capturedAt = Math.max(capturedAt, patch.captured_at);
      hash = patch.target_hash;
    }
    source.pieces = pieces; source.bytes = bytes; source.capturedAt = capturedAt;
    return ok(source);
    });
  }

  fresh(): ContextReadResult<void> {
    if (snapshot(this.db, this.sessionId)?.token !== this.state.token)
      return { ok: false, error: { code: "stale", detail: "Captured context changed; reopen its index" } };
    return ok(undefined);
  }

  read(offset: number, bytes: number): ContextReadResult<Buffer> {
    if (![offset, bytes].every(Number.isSafeInteger) || offset < 0 || bytes < 0 || offset + bytes > this.bytes)
      return invalid("Context byte range is outside the captured source");
    if (bytes > CONTEXT_RECORD_BYTES) return oversized("Context byte read", bytes, CONTEXT_RECORD_BYTES);
    const result = Buffer.allocUnsafe(bytes);
    let position = 0, written = 0;
    for (const piece of this.pieces) {
      const skip = Math.max(0, offset - position);
      const count = Math.min(piece.bytes - skip, bytes - written);
      if (count > 0) {
        const start = piece.start + skip;
        if (piece.kind === "base") {
          const read = this.raw("base", 0, start, count);
          if (!read.ok) return read;
          result.set(read.value, written);
        } else {
          const encodedStart = Math.floor(start / 3) * 4;
          const encodedBytes = Math.ceil((start % 3 + count) / 3) * 4;
          const read = this.raw("patch", piece.seq, encodedStart, encodedBytes);
          if (!read.ok) return read;
          const encoded = read.value.toString("ascii");
          if (!/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) return invalid("Captured context patch has invalid base64");
          const decoded = Buffer.from(encoded, "base64");
          const part = decoded.subarray(start % 3, start % 3 + count);
          if (part.length !== count) return invalid("Captured context patch disappeared or was shortened");
          result.set(part, written);
        }
        written += count;
        if (written === bytes) break;
      }
      position += piece.bytes;
    }
    return written === bytes ? ok(result) : invalid("Incomplete captured context byte range");
  }
}

type Span = { offset: number; bytes: number; kind: "object" | "array" | "string" | "scalar"; nonempty?: boolean; recordHash?: string };
type Path = (string | number)[];

/** A byte scanner: it retains structural spans, never skipped JSON string values. */
class JsonScanner {
  offset = 0;
  error: ContextSourceError | null = null;
  private chunk: Buffer = Buffer.alloc(0);
  private chunkStart = 0;
  private hash = createHash("sha256");
  private keyBytesHeld = 0;
  private recordHash: ReturnType<typeof createHash> | null = null;
  private recordStart = 0;
  constructor(readonly source: ByteSource, readonly visit: (path: Path, span: Span) => ContextReadResult<void>) {}
  fail(error: ContextSourceError): null { this.error = error; return null; }
  private peek(): number {
    if (this.error || this.offset === this.source.bytes) return -1;
    if (this.offset >= this.chunkStart + this.chunk.length) {
      if (this.recordHash) this.recordHash.update(this.chunk.subarray(this.recordStart));
      this.recordStart = 0;
      const read = this.source.read(this.offset, Math.min(CONTEXT_CHUNK_BYTES, this.source.bytes - this.offset));
      if (!read.ok) { this.fail(read.error); return -1; }
      this.chunk = read.value;
      this.chunkStart = this.offset;
      this.hash.update(this.chunk);
    }
    return this.chunk[this.offset - this.chunkStart];
  }
  private whitespace(): void { while ([32, 10, 13, 9].includes(this.peek())) this.offset++; }
  private malformed(detail: string): null { return this.fail({ code: "invalid", detail: `${detail} at byte ${this.offset}` }); }
  private string(trackNonempty: boolean): Span | null {
    const start = this.offset++;
    let nonempty = false;
    while (!this.error) {
      const char = this.peek();
      if (char === -1 || char < 32) return this.malformed("Unterminated or invalid JSON string");
      this.offset++;
      if (char === 34) return { offset: start, bytes: this.offset - start, kind: "string", nonempty };
      let codepoint = char;
      if (char === 92) {
        const escape = this.peek(); this.offset++;
        if (escape === 117) {
          let hex = "";
          for (let i = 0; i < 4; i++) {
            const digit = this.peek();
            if (!(digit >= 48 && digit <= 57 || digit >= 65 && digit <= 70 || digit >= 97 && digit <= 102))
              return this.malformed("Invalid JSON unicode escape");
            hex += String.fromCharCode(digit); this.offset++;
          }
          codepoint = parseInt(hex, 16);
        } else {
          const codes: Record<number, number> = { 34: 34, 92: 92, 47: 47, 98: 8, 102: 12, 110: 10, 114: 13, 116: 9 };
          if (!(escape in codes)) return this.malformed("Invalid JSON escape");
          codepoint = codes[escape];
        }
      } else if (char >= 128) {
        const count = char >= 240 && char <= 244 ? 3 : char >= 224 && char <= 239 ? 2 : char >= 194 && char <= 223 ? 1 : -1;
        if (count < 0) return this.malformed("Invalid UTF-8 in JSON string");
        codepoint = char & (count === 3 ? 7 : count === 2 ? 15 : 31);
        for (let i = 0; i < count; i++) {
          const continuation = this.peek();
          if (continuation < 128 || continuation > 191) return this.malformed("Invalid UTF-8 continuation");
          codepoint = codepoint * 64 + continuation - 128; this.offset++;
        }
        if (codepoint > 0x10ffff || codepoint >= 0xd800 && codepoint <= 0xdfff
          || codepoint < (count === 3 ? 0x10000 : count === 2 ? 0x800 : 0x80)) return this.malformed("Invalid UTF-8 codepoint");
      }
      if (trackNonempty && !nonempty && !/\s/u.test(String.fromCodePoint(codepoint))) nonempty = true;
    }
    return null;
  }
  value(path: Path): Span | null {
    if (path.length > 128) return this.malformed("JSON nesting exceeds 128");
    this.whitespace();
    if (this.error) return null;
    const start = this.offset, char = this.peek();
    const isMessage = path.length === 2 && path[0] === "messages" && typeof path[1] === "number";
    if (isMessage) { this.recordHash = createHash("sha256"); this.recordStart = this.offset - this.chunkStart; }
    let span: Span | null;
    if (char === 34) {
      const field = path.at(-1);
      span = this.string(field === "thinking" || field === "errorMessage");
    } else if (char === 123 || char === 91) {
      const object = char === 123, close = object ? 125 : 93;
      this.offset++; this.whitespace();
      let index = 0;
      const keys = new Set<string>();
      let localKeyBytes = 0;
      if (this.peek() !== close) {
        while (!this.error) {
          let key: string | number = index++;
          if (object) {
            if (this.peek() !== 34) return this.malformed("Expected JSON object key");
            const keySpan = this.string(false);
            if (!keySpan) return null;
            const parsed = parseSpan(this.source, keySpan, METADATA_FIELD_BYTES);
            if (!parsed.ok) return this.fail(parsed.error);
            key = parsed.value;
            if (keys.has(key as string)) return this.malformed("Duplicate JSON object key");
            keys.add(key as string);
            localKeyBytes += keySpan.bytes;
            this.keyBytesHeld += keySpan.bytes;
            if (this.keyBytesHeld > INDEX_METADATA_BYTES) return this.fail({ code: "oversized", detail: "JSON structural keys", bytes: this.keyBytesHeld, limit: INDEX_METADATA_BYTES });
            if (keys.size > INDEX_ENTRIES) return this.fail({ code: "oversized", detail: "JSON object keys", bytes: keys.size, limit: INDEX_ENTRIES });
            this.whitespace();
            if (this.peek() !== 58) return this.malformed("Expected colon after JSON object key");
            this.offset++;
          }
          if (!this.value([...path, key])) return null;
          this.whitespace();
          if (this.peek() === close) break;
          if (this.peek() !== 44) return this.malformed("Expected JSON comma");
          this.offset++; this.whitespace();
        }
      }
      if (this.error || this.peek() !== close) return this.malformed("Unterminated JSON container");
      this.offset++;
      this.keyBytesHeld -= localKeyBytes;
      span = { offset: start, bytes: this.offset - start, kind: object ? "object" : "array" };
    } else {
      let scalar = "";
      while (!this.error) {
        const next = this.peek();
        if (next === -1 || [32, 9, 10, 13, 44, 93, 125].includes(next)) break;
        if (scalar.length >= METADATA_FIELD_BYTES) return this.fail({ code: "oversized", detail: "JSON scalar", bytes: scalar.length + 1, limit: METADATA_FIELD_BYTES });
        scalar += String.fromCharCode(next); this.offset++;
      }
      if (!/^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)$/.test(scalar)) return this.malformed("Invalid JSON scalar");
      span = { offset: start, bytes: this.offset - start, kind: "scalar" };
    }
    if (!span) return null;
    if (isMessage && this.recordHash) {
      this.recordHash.update(this.chunk.subarray(this.recordStart, this.offset - this.chunkStart));
      span.recordHash = this.recordHash.digest("hex");
      this.recordHash = null;
    }
    const visited = this.visit(path, span);
    if (!visited.ok) return this.fail(visited.error);
    return span;
  }
  finish(): ContextReadResult<string> {
    const root = this.value([]);
    if (!root || this.error) return { ok: false, error: this.error ?? { code: "invalid", detail: "Invalid context JSON" } };
    this.whitespace();
    if (this.error) return { ok: false, error: this.error };
    if (root.kind !== "object" || this.offset !== this.source.bytes) return invalid("Context must be one complete JSON object");
    return ok(this.hash.digest("hex"));
  }
}

function parseSpan(source: ByteSource, span: Span, limit: number): ContextReadResult<any> {
  if (span.bytes > limit) return oversized("Captured JSON record", span.bytes, limit);
  const raw = source.read(span.offset, span.bytes);
  if (!raw.ok) return raw;
  if (span.recordHash && createHash("sha256").update(raw.value).digest("hex") !== span.recordHash)
    return { ok: false, error: { code: "stale", detail: "Captured record bytes no longer match the indexed source" } };
  try { return ok(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw.value))); }
  catch (cause) { return invalid(`Invalid captured JSON record: ${cause instanceof Error ? cause.message : String(cause)}`); }
}

function buildIndexedContext(db: Database, sessionId: string): ContextReadResult<IndexedContext | null> {
  return storage(() => {
    const opened = ByteSource.open(db, sessionId);
    if (!opened.ok) return opened;
    if (!opened.value) return ok(null);
    const source = opened.value;
    return source.using(() => {
    const messages: ContextMessageDescriptor[] = [];
    const header: IndexedContextHeader = { systemPrompt: "", tools: [] };
    let headerBytes = 0, metadataBytes = 0, entries = 0;
    let systemSet = false, toolsSet = false, messagesSet = false;
    const messageAt = (index: number): ContextMessageDescriptor => messages[index] ??= { index, offset: 0, bytes: 0, role: "", contentKind: "unset", blocks: [], displayItemCount: 0, recordHash: "" };
    const visit = (path: Path, span: Span): ContextReadResult<void> => {
      if (path[0] === "messages") {
        if (path.length === 1) { messagesSet = span.kind === "array"; return messagesSet ? ok(undefined) : invalid("Context messages must be an array"); }
        if (typeof path[1] !== "number") return ok(undefined);
        const index = path[1];
        if (index >= INDEX_ENTRIES) return oversized("Context message count", index + 1, INDEX_ENTRIES);
        const message = messageAt(index);
        if (path.length === 2) {
          if (span.kind !== "object" || !message.role) return invalid("Context message must be an object with a role");
          message.offset = span.offset; message.bytes = span.bytes;
          message.recordHash = span.recordHash!;
          message.displayItemCount = message.role === "assistant" && message.contentKind === "array"
            ? message.blocks.filter(block => block.type !== "thinking" || block.thinkingNonempty).length
              + (message.blocks.length === 0 && message.errorMessageNonempty ? 1 : 0)
            : 1;
          if (message.role === "assistant") {
            const record = parseSpan(source, span, CONTEXT_RECORD_BYTES);
            if (record.ok) {
              message.finalizationKey = messageFinalizationKey(record.value);
              const projected = displayAssistantMessage(record.value);
              if (Array.isArray(projected.content)) message.displayItemCount = projected.content
                .filter((block: any) => block?.type !== "thinking" || String(block.thinking || "").trim()).length
                + (projected.content.length === 0 && projected.errorMessage ? 1 : 0);
            }
            else if (record.error.code === "oversized") message.finalizationKeyError = record.error;
            else return record;
          }
          if (++entries > INDEX_ENTRIES) return oversized("Context index entries", entries, INDEX_ENTRIES);
        } else if (path.length === 3 && ["role", "timestamp", "toolCallId"].includes(String(path[2]))) {
          const parsed = parseSpan(source, span, METADATA_FIELD_BYTES);
          if (!parsed.ok) return parsed;
          const field = String(path[2]);
          if (field === "timestamp") {
            if (typeof parsed.value !== "number" || !Number.isFinite(parsed.value)) return invalid("Message timestamp must be finite");
            message.timestamp = parsed.value;
          } else {
            if (typeof parsed.value !== "string" || field === "role" && !parsed.value) return invalid(`Message ${field} must be a string`);
            if (field === "role") message.role = parsed.value; else message.toolCallId = parsed.value;
          }
          metadataBytes += span.bytes;
        } else if (path.length === 3 && (path[2] === "rootConsent" || path[2] === "questionId")) {
          const parsed = parseSpan(source, span, METADATA_FIELD_BYTES);
          if (!parsed.ok) return parsed;
          if (path[2] === "rootConsent") {
            if (typeof parsed.value !== "boolean") return invalid("Message rootConsent must be boolean");
            message.rootConsent = parsed.value;
          } else {
            if (typeof parsed.value !== "string") return invalid("Message questionId must be a string");
            message.questionId = parsed.value;
          }
          metadataBytes += span.bytes;
        } else if (path.length === 3 && path[2] === "errorMessage") {
          if (span.kind !== "string") return invalid("Message errorMessage must be a string");
          message.errorMessageNonempty = span.bytes > 2;
        }
        else if (path[2] === "content") {
          if (path.length === 3) message.contentKind = span.kind === "string" ? "string" : span.kind === "array" ? "array" : "other";
          else if (typeof path[3] === "number") {
            const blockIndex = path[3];
            if (blockIndex >= INDEX_ENTRIES) return oversized("Message block count", blockIndex + 1, INDEX_ENTRIES);
            const block = message.blocks[blockIndex] ??= { index: blockIndex, type: "unsupported" };
            if (path.length === 4) {
              if (++entries > INDEX_ENTRIES) return oversized("Context index entries", entries, INDEX_ENTRIES);
            } else if (path.length === 5 && ["type", "id"].includes(String(path[4]))) {
              const parsed = parseSpan(source, span, METADATA_FIELD_BYTES);
              if (!parsed.ok) return parsed;
              if (typeof parsed.value !== "string") return invalid(`Content block ${String(path[4])} must be a string`);
              if (path[4] === "type") block.type = parsed.value; else block.id = parsed.value;
              metadataBytes += span.bytes;
            } else if (path.length === 5 && path[4] === "thinking") {
              if (span.kind !== "string") return invalid("Thinking content must be a string");
              block.thinkingNonempty = span.nonempty === true;
              block.thinkingEmpty = span.bytes === 2;
            }
          }
        }
        if (metadataBytes > INDEX_METADATA_BYTES) return oversized("Context metadata", metadataBytes, INDEX_METADATA_BYTES);
      } else if (path[0] === "tools" && path.length === 2 && typeof path[1] === "number") {
        headerBytes += span.bytes;
        if (headerBytes > CONTEXT_RECORD_BYTES) return oversized("Context header", headerBytes, CONTEXT_RECORD_BYTES);
        if (span.kind !== "object") return invalid("Context tool must be an object");
        const parsed = parseSpan(source, span, CONTEXT_RECORD_BYTES);
        if (!parsed.ok) return parsed;
        header.tools.push(parsed.value);
      } else if (path.length === 1) {
        const field = String(path[0]);
        if (field === "tools") { toolsSet = span.kind === "array"; return toolsSet ? ok(undefined) : invalid("Context tools must be an array"); }
        if (["systemPrompt", "contextUsage", "contextModel", "source"].includes(field)) {
          headerBytes += span.bytes;
          if (headerBytes > CONTEXT_RECORD_BYTES) return oversized("Context header", headerBytes, CONTEXT_RECORD_BYTES);
          const parsed = parseSpan(source, span, CONTEXT_RECORD_BYTES);
          if (!parsed.ok) return parsed;
          if (field === "systemPrompt") {
            if (typeof parsed.value !== "string") return invalid("Context systemPrompt must be a string");
            header.systemPrompt = parsed.value; systemSet = true;
          } else if (field === "contextModel") {
            if (typeof parsed.value !== "string") return invalid("Context contextModel must be a string");
            header.contextModel = parsed.value;
          } else if (field === "contextUsage") header.contextUsage = parsed.value;
          else header.source = parsed.value;
        }
      }
      const estimate = headerBytes * 16 + messages.length * 512 + entries * 256 + metadataBytes * 4 + source.state.token.length * 2;
      if (estimate > CONTEXT_INDEX_CACHE_BYTES) return oversized("Context index memory estimate", estimate, CONTEXT_INDEX_CACHE_BYTES);
      return ok(undefined);
    };
    const scanned = new JsonScanner(source, visit).finish();
    if (!scanned.ok) return scanned;
    if (!systemSet || !toolsSet || !messagesSet) return invalid("Captured context requires systemPrompt, tools and messages");
    const target = source.state.patches.at(-1)?.target_hash;
    if (target && target !== scanned.value) return invalid("Context splice target hash does not match");
    const fresh = source.fresh();
    if (!fresh.ok) return fresh;
    const revision = scanned.value;
    const memoryBytes = headerBytes * 16 + messages.length * 512 + entries * 256 + metadataBytes * 4 + source.state.token.length * 2;
    return ok({ capturedAt: source.capturedAt, revision, metadataBytes: memoryBytes, sourceToken: source.state.token, totalBytes: source.bytes, header, messages,
      openByteStream(expectedRevision = revision): ContextReadResult<ContextByteStream> {
        if (expectedRevision !== revision) return { ok: false, error: { code: "stale", detail: "Captured context revision does not match" } };
        const owned = source.fork();
        const fresh = owned.fresh();
        if (!fresh.ok) return fresh;
        let offset = 0;
        const hash = createHash("sha256");
        let state: "open" | "done" | "closed" = "open";
        const close = (): ContextReadResult<void> => {
          if (state !== "open") return ok(undefined);
          state = "closed";
          return owned.close();
        };
        return ok({ close, next(): ContextReadResult<Uint8Array | null> {
          if (state === "done") return ok(null);
          if (state === "closed") return invalid("Captured context stream is closed");
          if (offset === owned.bytes) {
            if (hash.digest("hex") !== revision) {
              const closed = close();
              return closed.ok ? { ok: false, error: { code: "stale", detail: "Captured stream bytes no longer match the indexed source" } } : closed;
            }
            const closed = close();
            if (!closed.ok) return closed;
            state = "done";
            return ok(null);
          }
          const result = storage(() => {
            const before = owned.fresh();
            if (!before.ok) return before;
            const read = owned.read(offset, Math.min(CONTEXT_CHUNK_BYTES, owned.bytes - offset));
            if (!read.ok) return read;
            const after = owned.fresh();
            if (!after.ok) return after;
            offset += read.value.length;
            hash.update(read.value);
            return read;
          });
          if (!result.ok) {
            const closed = close();
            return closed.ok ? result : closed;
          }
          return result;
        } });
      },
      readBytes(offset: number, bytes: number, expectedRevision = revision): ContextReadResult<Uint8Array> {
        return source.using(() => {
          if (expectedRevision !== revision) return { ok: false, error: { code: "stale", detail: "Captured context revision does not match" } };
          const before = source.fresh();
          if (!before.ok) return before;
          if (bytes > CONTEXT_CHUNK_BYTES) return oversized("Context stream chunk", bytes, CONTEXT_CHUNK_BYTES);
          const read = source.read(offset, bytes);
          if (!read.ok) return read;
          const after = source.fresh();
          return after.ok ? read : after;
        });
      },
      readMessage(index: number, expectedRevision = revision): ContextReadResult<any> {
        return source.using(() => {
          if (expectedRevision !== revision) return { ok: false, error: { code: "stale", detail: "Captured context revision does not match" } };
          const before = source.fresh();
          if (!before.ok) return before;
          if (!Number.isSafeInteger(index) || index < 0 || index >= messages.length) return invalid("Message index is outside the captured context");
          const message = messages[index];
          const parsed = parseSpan(source, { offset: message.offset, bytes: message.bytes, kind: "object", recordHash: message.recordHash }, CONTEXT_RECORD_BYTES);
          if (!parsed.ok) return parsed;
          const after = source.fresh();
          return after.ok ? parsed : after;
        });
      },
    });
    });
  });
}

export interface ContextRevisionProbe {
  sourceToken: string;
  capturedAt: number;
  revision?: string;
}
export function probeIndexedContext(db: Database, sessionId: string): ContextReadResult<ContextRevisionProbe | null> {
  return storage(() => {
    const state = snapshot(db, sessionId);
    if (!state) return ok(null);
    return ok({ sourceToken: state.token, capturedAt: Math.max(state.base.captured_at, ...state.patches.map(patch => patch.captured_at)),
      ...(state.patches.length ? { revision: state.patches.at(-1)!.target_hash } : {}) });
  });
}
const indexes = new ResourceCache<IndexedContext>({ entries: CONTEXT_INDEX_CACHE_ENTRIES, bytes: CONTEXT_INDEX_CACHE_BYTES });
const databaseIds = new WeakMap<Database, number>();
let nextDatabaseId = 0;
function cacheKey(db: Database, sessionId: string): string {
  let id = databaseIds.get(db);
  if (id === undefined) { id = ++nextDatabaseId; databaseIds.set(db, id); }
  return `${id}:${sessionId}`;
}
export function forgetIndexedContext(db: Database, sessionId: string): void {
  indexes.delete(cacheKey(db, sessionId));
}
export function openIndexedContext(db: Database, sessionId: string): ContextReadResult<IndexedContext | null> {
  const key = cacheKey(db, sessionId);
  const probe = probeIndexedContext(db, sessionId);
  if (!probe.ok) { indexes.delete(key); return probe; }
  if (!probe.value) { indexes.delete(key); return ok(null); }
  const cached = indexes.get(key);
  if (cached?.sourceToken === probe.value.sourceToken) return ok(cached);
  indexes.delete(key);
  const opened = buildIndexedContext(db, sessionId);
  if (opened.ok && opened.value) indexes.set(key, opened.value, opened.value.metadataBytes);
  return opened;
}

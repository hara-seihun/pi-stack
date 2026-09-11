import { existsSync, readFileSync } from "node:fs";
import { activePath, parseSession } from "./condense.mjs";
import { renderEntry } from "./thread-reader.mjs";

const encode = value => Buffer.from(JSON.stringify(value)).toString("base64url");
function decode(cursor) {
  try {
    const value = JSON.parse(Buffer.from(cursor, "base64url").toString());
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    return value;
  } catch { throw new Error("Invalid thread page cursor"); }
}
function pageSize(value, fallback, maximum) {
  const size = value ?? fallback;
  if (!Number.isSafeInteger(size) || size < 1 || size > maximum) throw new Error(`Page size must be 1..${maximum}`);
  return size;
}

export function subagentPage(db, parentId, options = {}) {
  const includeIdle = options.includeIdle === true;
  const limit = pageSize(options.limit, 20, 100);
  const cursor = options.cursor ? decode(options.cursor) : {
    kind: "subagents", parentId, includeIdle, asOf: new Date().toISOString(),
    maxSeq: Number(db.prepare("SELECT COALESCE(MAX(seq),0) n FROM events").get().n), beforeSeq: null, beforeId: "",
  };
  if (cursor.kind !== "subagents" || cursor.parentId !== parentId || cursor.includeIdle !== includeIdle
    || !Number.isSafeInteger(cursor.maxSeq) || typeof cursor.asOf !== "string"
    || !(cursor.beforeSeq === null || Number.isSafeInteger(cursor.beforeSeq)) || typeof cursor.beforeId !== "string") {
    throw new Error("Cursor does not match this subagent query");
  }
  const rows = db.prepare(`WITH children AS (
    SELECT s.id,s.name,s.state,s.created_at,s.archived_at,a.model,
      COALESCE((SELECT MAX(e.seq) FROM events e WHERE e.session_id=s.id
        AND e.type IN ('user','assistant') AND e.seq<=?),0) message_seq
    FROM subagents a JOIN sessions s ON s.id=a.session_id
    WHERE a.parent_session_id=? AND s.created_at<=?
      ${includeIdle ? "" : "AND s.archived_at IS NULL AND s.state IN ('STARTING','RUNNING','ABORTING')"}
  ) SELECT children.*,COALESCE((SELECT time FROM events WHERE seq=message_seq),created_at) last_message_at
    FROM children WHERE (? IS NULL OR message_seq<? OR (message_seq=? AND id<?))
    ORDER BY message_seq DESC,id DESC LIMIT ?`).all(cursor.maxSeq, parentId, cursor.asOf,
      cursor.beforeSeq, cursor.beforeSeq, cursor.beforeSeq, cursor.beforeId, limit + 1);
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  return {
    parentThreadId: parentId, includeIdle, order: "most-recent-message", snapshotAt: cursor.asOf,
    subagents: page.map(row => ({ threadId: row.id, name: row.name, model: row.model, state: row.state,
      active: !row.archived_at && ["STARTING", "RUNNING", "ABORTING"].includes(row.state),
      lastMessageAt: row.last_message_at, archivedAt: row.archived_at })),
    nextCursor: rows.length > limit ? encode({ ...cursor, beforeSeq: last.message_seq, beforeId: last.id }) : null,
  };
}

function transcriptEntries(db, row, includeTools) {
  if (row.session_path && existsSync(row.session_path)) {
    const entries = activePath(parseSession(readFileSync(row.session_path, "utf8")));
    const settings = { work: includeTools, argumentCap: Infinity, bodyCap: Infinity, errorCap: Infinity };
    return { source: "active-transcript", entries: entries.flatMap(entry => {
      // Deliberation is not needed to read another worker's conversation and actions.
      const visible = entry.message?.role === "assistant" && Array.isArray(entry.message.content)
        ? { ...entry, message: { ...entry.message, content: entry.message.content.filter(block => block.type !== "thinking") } } : entry;
      const text = renderEntry(visible, settings).trim();
      return text ? [{ id: entry.id, text }] : [];
    }) };
  }
  return { source: "supervisor-events", entries: db.prepare(
    `SELECT seq,time,type,payload FROM events WHERE session_id=? AND type IN ('user','assistant','notice'${includeTools ? ",'tool_start','tool_end'" : ""}) ORDER BY seq`,
  ).all(row.id).map(event => ({ id: `event-${event.seq}`, text: `[${event.time}] ${event.type}\n${event.payload}` })) };
}

export function threadPage(db, row, options = {}) {
  const includeTools = options.includeTools !== false;
  const transcript = transcriptEntries(db, row, includeTools);
  const identity = { threadId: row.id, name: row.name, state: row.state, source: transcript.source };
  if (options.entryId) {
    const entry = transcript.entries.find(item => item.id === options.entryId);
    if (!entry) throw new Error("Entry is not on this thread's current active branch");
    const offset = options.offset ?? 0;
    const maxChars = pageSize(options.maxChars, 16000, 48000);
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > entry.text.length) throw new Error("Invalid entry offset");
    const end = Math.min(entry.text.length, offset + maxChars);
    return { ...identity, entryId: entry.id, offset, text: entry.text.slice(offset, end),
      nextOffset: end < entry.text.length ? end : null, totalChars: entry.text.length };
  }
  const limit = pageSize(options.limit, 10, 20);
  const cursor = options.cursor ? decode(options.cursor) : {
    kind: "transcript", threadId: row.id, includeTools, head: transcript.entries.at(-1)?.id ?? null, before: null,
  };
  if (cursor.kind !== "transcript" || cursor.threadId !== row.id || cursor.includeTools !== includeTools) throw new Error("Cursor does not match this thread query");
  const head = cursor.head === null ? -1 : transcript.entries.findIndex(entry => entry.id === cursor.head);
  if (cursor.head !== null && head < 0) throw new Error("Thread branch changed; start a new read without the cursor");
  let end = head + 1;
  if (cursor.before !== null) {
    end = transcript.entries.findIndex(entry => entry.id === cursor.before);
    if (end < 0 || end > head) throw new Error("Thread branch changed; start a new read without the cursor");
  }
  const start = Math.max(0, end - limit);
  const page = transcript.entries.slice(start, end);
  return { ...identity, order: "chronological-within-page; newest-page-first",
    entries: page.map(entry => ({ entryId: entry.id, text: entry.text.slice(0, 2000),
      truncated: entry.text.length > 2000, totalChars: entry.text.length })),
    nextCursor: start > 0 ? encode({ ...cursor, before: page[0].id }) : null,
  };
}

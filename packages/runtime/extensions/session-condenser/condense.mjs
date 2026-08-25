import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

export const DEFAULT_THRESHOLD = 4000;
export const VERBATIM_TAIL_CALLS = 10;
const ROW_CHUNK_CHARS = 150_000;
const CONTEXT_CAP_CHARS = 2000;

export function hashBlock(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export function parseSession(text) {
  const entries = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      entries.push(JSON.parse(line));
    } catch {
      // A torn final line from a live session is expected; anything else
      // would also be unparseable by pi itself.
    }
  }
  return entries;
}

/**
 * The active conversation is the parent chain of the last written entry.
 * Sessions are append-only trees; abandoned branches stay in the file but
 * the newest entry is always on the live branch.
 */
export function activePath(entries) {
  const byId = new Map();
  for (const entry of entries) if (entry.id) byId.set(entry.id, entry);
  let leaf;
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i].id) {
      leaf = entries[i];
      break;
    }
  }
  const path = [];
  for (let cursor = leaf; cursor; cursor = byId.get(cursor.parentId)) path.push(cursor);
  return path.reverse();
}

const blockText = (block) => (block.type === "thinking" ? block.thinking ?? "" : block.type === "text" ? block.text ?? "" : "");

const contentBlocks = (message) =>
  Array.isArray(message.content) ? message.content : [{ type: "text", text: String(message.content ?? "") }];

/**
 * Flatten the active path into one ordered sequence of block items — the
 * unit the hierarchic condenser works on.
 */
export function flattenPath(path) {
  const items = [];
  const push = (item) => items.push({ chars: item.text.length, ...item });
  for (const entry of path) {
    if (entry.type === "compaction") {
      push({
        kind: "compaction",
        time: entry.timestamp,
        text: `[compaction · ~${entry.tokensBefore ?? "?"} tokens replaced]${entry.summary ? `\n${entry.summary}` : ""}`,
      });
      continue;
    }
    if (entry.type !== "message") continue;
    const message = entry.message;
    const time = message.timestamp ?? entry.timestamp;
    if (message.role === "toolResult") {
      push({
        kind: "toolResult",
        toolName: message.toolName ?? "tool",
        isError: Boolean(message.isError),
        time,
        text: contentBlocks(message).map(blockText).join("\n"),
      });
      continue;
    }
    if (message.role === "user") {
      const text = contentBlocks(message)
        .map((b) => (b.type === "image" ? "[image]" : blockText(b)))
        .filter(Boolean)
        .join("\n");
      push({ kind: "user", time, text });
      continue;
    }
    for (const block of contentBlocks(message)) {
      if (block.type === "thinking") push({ kind: "thinking", model: message.model, time, text: blockText(block) });
      else if (block.type === "toolCall") {
        const args = typeof block.arguments === "string" ? block.arguments : JSON.stringify(block.arguments);
        push({ kind: "toolCall", name: block.name, time, text: args });
      } else if (block.type === "image") push({ kind: "image", time, text: "[image]" });
      else if (blockText(block)) push({ kind: "text", model: message.model, time, text: blockText(block) });
    }
  }
  return items;
}

/**
 * Verbatim items are anchors the condenser never touches: every user
 * message, the assistant prose the user was replying to, compaction
 * markers, and everything from the entry of the verbatimTailCalls-th most
 * recent tool call onward — the most recent activity is what a live reader
 * is here for.
 */
export function markVerbatim(items, verbatimTailCalls = VERBATIM_TAIL_CALLS) {
  let tailStart = items.length;
  for (let i = items.length - 1, calls = 0; i >= 0 && calls < verbatimTailCalls; i--) {
    if (items[i].kind === "toolCall") {
      calls++;
      tailStart = i;
    }
  }
  items.forEach((item, index) => {
    item.verbatim =
      index >= tailStart || item.kind === "user" || item.kind === "compaction" || item.kind === "image";
  });
  for (let i = 0; i < items.length; i++) {
    if (items[i].kind !== "user") continue;
    for (let j = i - 1; j >= 0; j--) {
      if (items[j].kind === "user") break;
      if (items[j].kind === "text") {
        items[j].verbatim = true;
        break;
      }
    }
  }
  return items;
}

/**
 * Pass 1: every non-verbatim item at or over the threshold is an individual
 * summarization job, deduplicated by content hash.
 */
export function pass1Jobs(items, threshold) {
  const jobs = new Map();
  for (const item of items) {
    if (item.verbatim || item.chars < threshold) continue;
    item.pass1 = hashBlock(item.text);
    if (!jobs.has(item.pass1)) jobs.set(item.pass1, { hash: item.pass1, kind: item.kind, chars: item.chars, text: item.text });
  }
  return [...jobs.values()];
}

function rowText(item) {
  if (item.kind === "toolCall") return `→ ${item.name}(${item.text})`;
  if (item.kind === "toolResult") return `[${item.toolName} result${item.isError ? " (ERROR)" : ""}]\n${item.text}`;
  if (item.kind === "thinking") return `[thinking]\n${item.text}`;
  return `[assistant text]\n${item.text}`;
}

/** The neighbor a row compactor sees: a pass-1 summary when one exists, else the item's own text, capped. */
function contextText(item, summaries) {
  const summary = item.pass1 ? summaries.get(item.pass1)?.summary : undefined;
  if (summary) return `(summary of a ${item.kind} block) ${summary}`;
  return item.text.length > CONTEXT_CAP_CHARS ? `${item.text.slice(0, CONTEXT_CAP_CHARS)} …[truncated]` : item.text;
}

/**
 * Pass 2: split the item sequence into segments. Maximal stretches of items
 * pass 1 left untouched become rows; a row whose combined mass clears the
 * threshold is compacted into one summary (per ≤150 KB chunk), fed with the
 * already-condensed neighbor on each side as context. Rows below the
 * threshold and everything verbatim stay as individual items.
 *
 * Chunks pack greedily from row start and context comes from stable pass-1
 * summaries, so chunk hashes — and their cache entries — survive session
 * growth everywhere except the still-moving end.
 */
export function buildSegments(items, threshold, summaries) {
  const segments = [];
  let row = [];

  const flushRow = (nextItem) => {
    if (row.length === 0) return;
    const chars = row.reduce((n, item) => n + item.chars, 0);
    if (chars < threshold) {
      for (const item of row) segments.push({ type: "item", item });
      row = [];
      return;
    }
    const previous = segments.at(-1);
    const before = previous?.type === "item" ? contextText(previous.item, summaries) : null;
    const after = nextItem ? contextText(nextItem, summaries) : null;

    const groups = [[]];
    let size = 0;
    for (const item of row) {
      const piece = rowText(item);
      if (size > 0 && size + piece.length > ROW_CHUNK_CHARS) {
        groups.push([]);
        size = 0;
      }
      groups.at(-1).push(piece);
      size += piece.length;
    }
    const chunks = groups.map((pieces, index) => {
      let input = "";
      if (index === 0) input += `=== context — what came just before (do not summarize) ===\n${before ?? "(start of session)"}\n\n`;
      input += `=== the blocks to summarize ===\n${pieces.join("\n\n")}`;
      if (index === groups.length - 1) input += `\n\n=== context — what comes just after (do not summarize) ===\n${after ?? "(end of session)"}`;
      return { hash: hashBlock(input), text: input, chars: pieces.reduce((n, piece) => n + piece.length, 0) };
    });
    segments.push({
      type: "row",
      blocks: row.length,
      calls: row.filter((item) => item.kind === "toolCall").length,
      chars,
      chunks,
      t0: row[0].time,
      t1: row.at(-1).time,
    });
    row = [];
  };

  for (const item of items) {
    if (!item.verbatim && !item.pass1) {
      row.push(item);
      continue;
    }
    flushRow(item);
    segments.push({ type: "item", item });
  }
  flushRow(null);
  return segments;
}

/** Pass-2 jobs: every row chunk, deduplicated by hash. */
export function rowJobs(segments) {
  const jobs = new Map();
  for (const segment of segments) {
    if (segment.type !== "row") continue;
    for (const chunk of segment.chunks) {
      if (!jobs.has(chunk.hash)) jobs.set(chunk.hash, { hash: chunk.hash, kind: "row", chars: chunk.chars, text: chunk.text });
    }
  }
  return [...jobs.values()];
}

const stamp = (ms) => (typeof ms === "number" ? new Date(ms) : new Date(ms ?? 0)).toISOString().slice(0, 16).replace("T", " ");
const count = (n) => n.toLocaleString("en-US");

const truncate = (text, max) => (text.length > max ? `${text.slice(0, max)} …[${count(text.length)} chars total]` : text);

function renderItem(item, summaries, out) {
  if (item.kind === "compaction") {
    out.push(`\n${item.text}`);
    return;
  }
  if (item.kind === "toolCall") {
    out.push(`→ ${item.name}(${truncate(item.text, 500)})`);
    return;
  }
  const summary = item.pass1 ? summaries.get(item.pass1) : undefined;
  const head =
    item.kind === "user" ? `\n[${stamp(item.time)}] user:`
    : item.kind === "thinking" ? `\n[${stamp(item.time)}] assistant (${item.model ?? "?"}) thinking:`
    : item.kind === "text" ? `\n[${stamp(item.time)}] assistant (${item.model ?? "?"}):`
    : item.kind === "toolResult" ? `\n[${stamp(item.time)}] ${item.toolName} result${item.isError ? " (error)" : ""}:`
    : `\n[${stamp(item.time)}]`;
  out.push(head);
  if (!item.pass1) {
    out.push(item.text);
  } else if (summary?.summary) {
    out.push(`[${count(item.chars)} chars · summarized]\n${summary.summary}`);
  } else {
    const reason = summary?.error ? `summarizer failed: ${summary.error}` : "not summarized";
    out.push(`[${count(item.chars)} chars · ${reason} · first 800 chars follow]\n${item.text.slice(0, 800)}`);
  }
}

/**
 * One readable transcript: user messages and the replies they answered
 * verbatim, big blocks as pass-1 summaries, the grind between them as row
 * summaries, and the recent tail exactly as it happened.
 */
export function renderCondensed(segments, threshold, summaries, source, header) {
  const out = [
    `=== condensed session ${source ?? header?.id ?? ""} ===`,
    `cwd: ${header?.cwd ?? "unknown"} · blocks ≥${threshold} chars summarized individually, the stretches between them summarized as rows · last ${VERBATIM_TAIL_CALLS} tool calls verbatim`,
  ];
  for (const segment of segments) {
    if (segment.type === "item") {
      renderItem(segment.item, summaries, out);
      continue;
    }
    out.push(`\n[${stamp(segment.t0)} → ${stamp(segment.t1)}] condensed row · ${segment.blocks} blocks (${segment.calls} tool calls) · ${count(segment.chars)} chars · summarized:`);
    for (const chunk of segment.chunks) {
      const found = summaries.get(chunk.hash);
      if (found?.summary) out.push(found.summary);
      else out.push(`[chunk ${found?.error ? `summarizer failed: ${found.error}` : "not summarized"} · first 800 chars follow]\n${chunk.text.slice(0, 800)}`);
    }
  }
  return out.join("\n");
}

export function openSummaryDb(file) {
  mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE IF NOT EXISTS summaries (
    hash TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    chars INTEGER NOT NULL,
    model TEXT NOT NULL,
    summary TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  )`);
  return db;
}

export function lookupSummaries(db, hashes) {
  const found = new Map();
  const statement = db.prepare("SELECT hash, summary, model FROM summaries WHERE hash = ?");
  for (const hash of hashes) {
    const row = statement.get(hash);
    if (row) found.set(hash, { summary: row.summary, model: row.model });
  }
  return found;
}

export function storeSummary(db, { hash, kind, chars, model, summary }) {
  db.prepare("INSERT OR REPLACE INTO summaries (hash, kind, chars, model, summary) VALUES (?,?,?,?,?)").run(
    hash, kind, chars, model, summary,
  );
}

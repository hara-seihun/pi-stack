import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { promptForJob } from "./prompts.mjs";
import { timestampMs } from "pi-orchestrator/history";
export { activePath, parseSession, timestampMs } from "pi-orchestrator/history";

export const DEFAULT_THRESHOLD = 16_000;
export const VERBATIM_TAIL_CALLS = 10;
export const EPISODE_CHUNK_CHARS = 300_000;
export const TAIL_BODY_CAP_CHARS = 2_000;
const CONTEXT_CAP_CHARS = 2_000;

export function hashBlock(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** Cache identity includes the exact prompt, not only source content. */
export function hashJob(kind, text) {
  return hashBlock(promptForJob(kind, text));
}

const blockText = (block) =>
  block.type === "thinking" ? block.thinking ?? "" : block.type === "text" ? block.text ?? "" : "";

const contentBlocks = (message) =>
  Array.isArray(message.content) ? message.content : [{ type: "text", text: String(message.content ?? "") }];

/** Flatten the active path into the ordered block sequence the condenser reads. */
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
        .map((block) => (block.type === "image" ? "[image]" : blockText(block)))
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

/** Keep only session activity in the requested incremental window. */
export function itemsSince(items, since) {
  if (since === undefined) return items;
  return items.filter((item) => {
    const time = timestampMs(item.time);
    return time !== undefined && time >= since;
  });
}

export function contextThrough(items, since) {
  let through = since;
  for (const item of items) {
    const time = timestampMs(item.time);
    if (time !== undefined && (through === undefined || time > through)) through = time;
  }
  return through;
}

/**
 * Durable anchors are user messages, the assistant prose each user was
 * replying to, compaction markers, and images. Recent activity from the
 * tenth-most-recent tool call onward is also retained instead of condensed.
 */
export function markVerbatim(items, verbatimTailCalls = VERBATIM_TAIL_CALLS) {
  let tailStart = items.length;
  for (let i = items.length - 1, calls = 0; i >= 0 && calls < verbatimTailCalls; i--) {
    if (items[i].kind === "toolCall") {
      calls++;
      tailStart = i;
    }
  }
  for (let index = 0; index < items.length; index++) {
    const item = items[index];
    item.anchor = item.kind === "user" || item.kind === "compaction" || item.kind === "image";
    item.tail = index >= tailStart;
  }
  for (let i = 0; i < items.length; i++) {
    if (items[i].kind !== "user") continue;
    for (let j = i - 1; j >= 0; j--) {
      if (items[j].kind === "user") break;
      if (items[j].kind === "text") {
        items[j].anchor = true;
        break;
      }
    }
  }
  for (const item of items) item.verbatim = item.anchor || item.tail;
  return items;
}

/** Individually pre-summarize only unusually large, non-verbatim blocks. */
export function pass1Jobs(items, threshold) {
  const jobs = new Map();
  for (const item of items) {
    if (item.verbatim || item.chars < threshold) continue;
    const kind = item.kind === "thinking" ? "thinking" : "block";
    item.pass1 = hashJob(kind, item.text);
    if (!jobs.has(item.pass1)) {
      jobs.set(item.pass1, { hash: item.pass1, kind, sourceKind: item.kind, chars: item.chars, text: item.text });
    }
  }
  return [...jobs.values()];
}

function rawEpisodeText(item) {
  if (item.kind === "toolCall") return `→ ${item.name}(${item.text})`;
  if (item.kind === "toolResult") return `[${item.toolName} result${item.isError ? " (ERROR)" : ""}]\n${item.text}`;
  if (item.kind === "thinking") return `[thinking]\n${item.text}`;
  return `[assistant text]\n${item.text}`;
}

function episodeText(item, summaries) {
  if (!item.pass1) return rawEpisodeText(item);
  const found = summaries.get(item.pass1);
  if (found?.summary) {
    return `[${item.kind} · ${item.chars.toLocaleString("en-US")} source chars · pre-summarized]\n${found.summary}`;
  }
  const reason = found?.error ? `pre-summary failed: ${found.error}` : "pre-summary unavailable";
  return `[${item.kind} · ${item.chars.toLocaleString("en-US")} source chars · ${reason}; original follows]\n${item.text}`;
}

function contextText(item) {
  if (!item) return null;
  const text = item.kind === "toolCall" ? `→ ${item.name}(${item.text})` : item.text;
  return text.length > CONTEXT_CAP_CHARS ? `${text.slice(0, CONTEXT_CAP_CHARS)} …[truncated]` : text;
}

/**
 * Replace each substantial anchor-to-anchor episode with summaries of
 * ≤300 KB represented chunks. Large blocks contribute their pass-1 summary
 * inside the episode rather than remaining visible boundaries.
 */
export function buildEpisodes(items, threshold, summaries, chunkChars = EPISODE_CHUNK_CHARS) {
  const segments = [];
  let episode = [];

  const flushEpisode = (nextAnchor) => {
    if (episode.length === 0) return;
    const chars = episode.reduce((total, item) => total + item.chars, 0);
    if (chars < threshold) {
      for (const item of episode) segments.push({ type: "item", item });
      episode = [];
      return;
    }

    const groups = [[]];
    let representedChars = 0;
    for (const item of episode) {
      const piece = { text: episodeText(item, summaries), chars: item.chars, item };
      if (groups.at(-1).length > 0 && representedChars + piece.text.length > chunkChars) {
        groups.push([]);
        representedChars = 0;
      }
      groups.at(-1).push(piece);
      representedChars += piece.text.length;
    }

    const previousAnchor = segments.at(-1)?.type === "item" ? segments.at(-1).item : null;
    const chunks = groups.map((pieces, index) => {
      let input = `=== episode chunk ${index + 1} of ${groups.length} ===\n`;
      if (index === 0) {
        input += `\n=== context before the episode (do not summarize) ===\n${contextText(previousAnchor) ?? "(start of session)"}\n`;
      }
      input += `\n=== activity to summarize ===\n${pieces.map((piece) => piece.text).join("\n\n")}`;
      if (index === groups.length - 1) {
        input += `\n\n=== context after the episode (do not summarize) ===\n${contextText(nextAnchor) ?? "(end of session)"}`;
      }
      return {
        hash: hashJob("episode", input),
        text: input,
        chars: pieces.reduce((total, piece) => total + piece.chars, 0),
        blocks: pieces.length,
      };
    });
    segments.push({
      type: "episode",
      blocks: episode.length,
      calls: episode.filter((item) => item.kind === "toolCall").length,
      chars,
      chunks,
      t0: episode[0].time,
      t1: episode.at(-1).time,
    });
    episode = [];
  };

  for (const item of items) {
    if (!item.verbatim) {
      episode.push(item);
      continue;
    }
    flushEpisode(item);
    segments.push({ type: "item", item });
  }
  flushEpisode(null);
  return segments;
}

export function episodeJobs(segments) {
  const jobs = new Map();
  for (const segment of segments) {
    if (segment.type !== "episode") continue;
    for (const chunk of segment.chunks) {
      if (!jobs.has(chunk.hash)) jobs.set(chunk.hash, { hash: chunk.hash, kind: "episode", chars: chunk.chars, text: chunk.text });
    }
  }
  return [...jobs.values()];
}

const stamp = (value) => {
  const date = typeof value === "number" ? new Date(value) : new Date(value ?? 0);
  return Number.isNaN(date.valueOf()) ? "unknown time" : date.toISOString().slice(0, 16).replace("T", " ");
};
const count = (number) => number.toLocaleString("en-US");
const truncate = (text, max, label = "chars total") =>
  text.length > max ? `${text.slice(0, max)} …[${count(text.length)} ${label}]` : text;

function renderItem(item, out) {
  if (item.kind === "compaction") {
    out.push(`\n${item.text}`);
    return;
  }
  if (item.kind === "toolCall") {
    out.push(`→ ${item.name}(${truncate(item.text, 500)})`);
    return;
  }
  const head =
    item.kind === "user" ? `\n[${stamp(item.time)}] user:`
    : item.kind === "thinking" ? `\n[${stamp(item.time)}] assistant (${item.model ?? "?"}) thinking:`
    : item.kind === "text" ? `\n[${stamp(item.time)}] assistant (${item.model ?? "?"}):`
    : item.kind === "toolResult" ? `\n[${stamp(item.time)}] ${item.toolName} result${item.isError ? " (error)" : ""}:`
    : `\n[${stamp(item.time)}]`;
  out.push(head);
  const capTailBody = item.tail && (item.kind === "thinking" || item.kind === "toolResult");
  out.push(capTailBody ? truncate(item.text, TAIL_BODY_CAP_CHARS, "chars in recent body; capped") : item.text);
}

/** Render anchors, episode summaries, and a bounded recent activity tail. */
export function renderCondensed(segments, threshold, summaries, source, header, window) {
  const bounds = window?.since === undefined
    ? undefined
    : `window: ${new Date(window.since).toISOString()} through ${new Date(window.through ?? window.since).toISOString()}`;
  const out = [
    `=== condensed session ${source ?? header?.id ?? ""} ===`,
    ...(bounds === undefined ? [] : [bounds]),
    `cwd: ${header?.cwd ?? "unknown"} · anchor-to-anchor episodes ≥${count(threshold)} source chars summarized · blocks ≥${count(threshold)} chars pre-summarized inside episodes · last ${VERBATIM_TAIL_CALLS} tool calls retained (large thinking/results capped at ${count(TAIL_BODY_CAP_CHARS)} chars)`,
  ];
  for (const segment of segments) {
    if (segment.type === "item") {
      renderItem(segment.item, out);
      continue;
    }
    out.push(`\n[${stamp(segment.t0)} → ${stamp(segment.t1)}] condensed episode · ${segment.blocks} blocks (${segment.calls} tool calls) · ${count(segment.chars)} source chars · ${segment.chunks.length} summary chunk${segment.chunks.length === 1 ? "" : "s"}:`);
    for (const chunk of segment.chunks) {
      const found = summaries.get(chunk.hash);
      if (found?.summary) out.push(found.summary);
      else {
        const reason = found?.error ? `summarizer failed: ${found.error}` : "not summarized";
        out.push(`[chunk ${reason} · first 800 chars follow]\n${chunk.text.slice(0, 800)}`);
      }
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

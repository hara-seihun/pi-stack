import { readFileSync } from "node:fs";
import { activePath, parseSession, timestampMs } from "./condense.mjs";

const cap = (text, limit) => text.length > limit
  ? `${text.slice(0, limit)} …[${text.length.toLocaleString("en-US")} chars]`
  : text;

const stamp = (value) => {
  const time = timestampMs(value);
  return time === undefined ? "unknown time" : new Date(time).toISOString();
};

const blockText = (block) => block?.type === "text"
  ? String(block.text ?? "")
  : block?.type === "thinking"
    ? String(block.thinking ?? "")
    : "";

const blocks = (content) => Array.isArray(content)
  ? content
  : [{ type: "text", text: String(content ?? "") }];

export function resolveThread(rows, selector) {
  const query = selector.trim();
  if (!query) throw new Error("thread selector cannot be empty");
  const sorted = [...rows].sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)));
  const exactId = sorted.find((row) => row.id === query);
  if (exactId) return exactId;

  if (query.length >= 4) {
    const ids = sorted.filter((row) => String(row.id).startsWith(query));
    if (ids.length === 1) return ids[0];
    if (ids.length > 1) throw ambiguous(query, ids);
  }

  const exactName = sorted.filter((row) => row.name === query);
  if (exactName.length > 0) return exactName[0];
  const folded = query.toLocaleLowerCase();
  const foldedNames = sorted.filter((row) => String(row.name).toLocaleLowerCase() === folded);
  if (foldedNames.length > 0) return foldedNames[0];
  const partial = sorted.filter((row) => String(row.name).toLocaleLowerCase().includes(folded));
  if (partial.length === 1) return partial[0];
  if (partial.length > 1) throw ambiguous(query, partial);
  throw new Error(`no Pi Remote thread matches ${JSON.stringify(query)}; run read-thread --list`);
}

function ambiguous(selector, rows) {
  const choices = rows.slice(0, 12)
    .map((row) => `  ${String(row.id).slice(0, 8)}  ${row.updated_at}  ${row.name}`)
    .join("\n");
  return new Error(`thread selector ${JSON.stringify(selector)} is ambiguous:\n${choices}\nUse an id prefix from read-thread --list.`);
}

export function listThreads(rows) {
  const sorted = [...rows].sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)));
  const lines = ["ID        UPDATED                   STATE     TITLE"];
  for (const row of sorted) {
    lines.push(`${String(row.id).slice(0, 8).padEnd(10)}${String(row.updated_at).padEnd(26)}${String(row.state).padEnd(10)}${row.name}`);
  }
  return lines.join("\n");
}

function entryTime(entry) {
  return timestampMs(entry?.message?.timestamp ?? entry?.timestamp);
}

function renderEntry(entry, options) {
  if (entry.type === "compaction") {
    const summary = String(entry.summary ?? "").trim();
    return `\n[${stamp(entry.timestamp)}] compaction${summary ? `\n${summary}` : ""}`;
  }
  if (entry.type !== "message") return "";
  const message = entry.message ?? {};
  const time = stamp(message.timestamp ?? entry.timestamp);
  if (message.role === "user") {
    const text = blocks(message.content).map((block) => block.type === "image" ? "[image]" : blockText(block)).filter(Boolean).join("\n");
    return text ? `\n[${time}] user\n${text}` : "";
  }
  if (message.role === "toolResult") {
    if (!options.work && !message.isError) return "";
    const text = blocks(message.content).map(blockText).filter(Boolean).join("\n");
    const rendered = options.work ? cap(text, options.bodyCap) : cap(text, options.errorCap);
    return `\n[${time}] ${message.toolName ?? "tool"} result${message.isError ? " ERROR" : ""}\n${rendered}`;
  }
  if (message.role !== "assistant") return "";
  const rendered = [];
  for (const block of blocks(message.content)) {
    if (block.type === "text" && block.text) rendered.push(`\n[${time}] assistant\n${block.text}`);
    else if (block.type === "toolCall") {
      const args = typeof block.arguments === "string" ? block.arguments : JSON.stringify(block.arguments ?? {});
      rendered.push(`\n[${time}] tool ${block.name ?? "unknown"}\n${cap(args, options.argumentCap)}`);
    } else if (options.work && block.type === "thinking" && block.thinking) {
      rendered.push(`\n[${time}] assistant thinking\n${cap(String(block.thinking), options.bodyCap)}`);
    } else if (block.type === "image") rendered.push(`\n[${time}] assistant\n[image]`);
  }
  return rendered.join("\n");
}

export function renderSupervisorRecords(row, work, events, options = {}) {
  let records = [
    ...work.map((item) => ({ time: item.created_at, text: `request ${item.state}, ${item.attempts} attempts\n${item.text}${item.last_error ? `\nLast error: ${item.last_error}` : ""}` })),
    ...events.map((event) => ({ time: event.time, text: `${event.type}\n${event.payload}` })),
  ].sort((a, b) => String(a.time).localeCompare(String(b.time)));
  if (options.since !== undefined) records = records.filter((record) => Date.parse(record.time) >= options.since);
  if (options.tail !== undefined) records = records.slice(-options.tail);
  return [
    `# ${row.name}`, `thread: ${row.id}`, `state: ${row.state}`,
    "Pi session file is not available. These are supervisor request and event records, not a model transcript.",
    ...records.map((record) => `\n[${record.time}] ${record.text}`),
  ].join("\n");
}

export function renderThread(row, options = {}) {
  const settings = {
    work: Boolean(options.work),
    since: options.since,
    tail: options.tail,
    argumentCap: options.argumentCap ?? 1_000,
    bodyCap: options.bodyCap ?? 4_000,
    errorCap: options.errorCap ?? 4_000,
  };
  const entries = activePath(parseSession(readFileSync(row.session_path, "utf8")));
  let selected = settings.since === undefined
    ? entries
    : entries.filter((entry) => {
      const time = entryTime(entry);
      return time !== undefined && time >= settings.since;
    });
  if (settings.tail !== undefined) selected = selected.slice(-settings.tail);
  const body = selected.map((entry) => renderEntry(entry, settings)).filter(Boolean).join("\n").trim();
  const mode = settings.work ? "conversation, actions, bounded thinking and results" : "conversation and actions; successful tool results omitted";
  return [
    `# ${row.name}`,
    `thread: ${row.id}`,
    `updated: ${row.updated_at}`,
    `session: ${row.session_path}`,
    `view: ${mode}`,
    settings.since === undefined ? null : `since: ${new Date(settings.since).toISOString()}`,
    "",
    body || "[no matching transcript entries]",
  ].filter((line) => line !== null).join("\n");
}

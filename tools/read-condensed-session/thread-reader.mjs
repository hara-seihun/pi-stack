import { readFileSync } from "node:fs";
import { activePath, sessionRecords, timestampMs } from "pi-orchestrator/history";

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

export function renderEntry(entry, options) {
  if (entry.type === "compaction" || entry.type === "branch_summary") {
    const summary = String(entry.summary ?? "").trim();
    return `\n[${stamp(entry.timestamp)}] ${entry.type}${summary ? `\n${summary}` : ""}`;
  }
  if (entry.type === "custom_message") {
    return `\n[${stamp(entry.timestamp)}] custom ${entry.customType}\n${blocks(entry.content).map(blockText).join("\n")}`;
  }
  if (entry.type !== "message") return "";
  const message = entry.message ?? {};
  const time = stamp(message.timestamp ?? entry.timestamp);
  if (message.role === "bashExecution") {
    return `\n[${time}] bash ${message.command}\n${cap(String(message.output ?? ""), options.bodyCap)}`;
  }
  if (message.role === "user" || message.role === "custom") {
    const text = blocks(message.content).map((block) => block.type === "image" ? "[image]" : blockText(block)).filter(Boolean).join("\n");
    return text ? `\n[${time}] ${message.role}\n${text}` : "";
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
  if (message.errorMessage) rendered.push(`\n[${time}] assistant ${message.stopReason ?? "error"}\n${message.errorMessage}`);
  return rendered.join("\n");
}

export function renderThreadInputs(row, work, options = {}) {
  let records = work.map(item => ({ time: item.created_at, text: `request ${item.state}\n${item.text}${item.last_error ? `\nLast error: ${item.last_error}` : ""}` }))
    .sort((a, b) => String(a.time).localeCompare(String(b.time)));
  if (options.since !== undefined) records = records.filter((record) => Date.parse(record.time) >= options.since);
  if (options.tail !== undefined) records = records.slice(-options.tail);
  return [
    `# ${row.name}`, `thread: ${row.id}`, `state: ${row.state}`,
    "Pi session file is not available. These are accepted thread inputs, not a model transcript.",
    ...records.map((record) => `\n[${record.time}] ${record.text}`),
  ].join("\n");
}

function searchRecords(records, path, options) {
  const pattern = options.regex ? new RegExp(options.search, "i") : null;
  const needle = options.search.toLowerCase();
  const limit = options.limit ?? 20;
  const offset = options.offset ?? 0;
  const matches = [];
  let count = 0;
  for (const { entry, raw, line } of records) {
    const position = pattern ? raw.search(pattern) : raw.toLowerCase().indexOf(needle);
    if (position < 0) continue;
    if (count++ < offset) continue;
    if (matches.length === limit) break;
    const start = Math.max(0, position - 160);
    const excerpt = `${start ? "…" : ""}${cap(raw.slice(start), 1_000)}`;
    matches.push(`${path}:${line} [entry ${entry.id ?? "header"}] ${excerpt}`);
  }
  if (count > offset + limit) matches.push(`[more matches; next --offset ${offset + limit}]`);
  return matches.join("\n");
}

export function renderThread(row, options = {}) {
  const settings = {
    work: Boolean(options.work || options.full),
    since: options.since,
    tail: options.tail,
    argumentCap: options.full ? Infinity : options.argumentCap ?? 1_000,
    bodyCap: options.full ? Infinity : options.bodyCap ?? 4_000,
    errorCap: options.full ? Infinity : options.errorCap ?? 4_000,
  };
  const records = sessionRecords(readFileSync(row.session_path, "utf8"));
  const branch = options.all ? null : new Set(activePath(records.map((record) => record.entry), options.leaf));
  let selected = records.filter(({ entry }) => !branch || branch.has(entry));
  if (settings.since !== undefined) selected = selected.filter(({ entry }) => {
    const time = entryTime(entry);
    return time !== undefined && time >= settings.since;
  });
  if (settings.tail !== undefined) selected = selected.slice(-settings.tail);
  if (options.raw) return selected.map(({ raw }) => raw).join("\n");
  const scope = options.all ? "all stored branches" : `parent chain through ${options.leaf ?? "newest stored entry"}; includes pre-compaction history`;
  const body = options.search !== undefined
    ? searchRecords(selected, row.session_path, options)
    : selected.map(({ entry, line }) => {
      const rendered = renderEntry(entry, settings);
      return rendered ? `\n[line ${line}, entry ${entry.id}]${rendered}` : "";
    }).filter(Boolean).join("\n").trim();
  const mode = options.full ? "conversation, actions, thinking and results without per-block caps"
    : settings.work ? "conversation, actions, bounded thinking and results"
      : "conversation and actions; successful tool results omitted";
  return [
    `# ${row.name}`,
    `thread: ${row.id}`,
    `updated: ${row.updated_at}`,
    `session: ${row.session_path}`,
    ...records.filter(({ entry }) => entry.type === "session" && entry.parentSession).map(({ entry }) => `parent session: ${entry.parentSession}`),
    `scope: ${scope}`,
    `view: ${options.search !== undefined ? "search of complete stored JSONL records" : mode}`,
    settings.since === undefined ? null : `since: ${new Date(settings.since).toISOString()}`,
    "",
    body || "[no matching transcript entries]",
  ].filter((line) => line !== null).join("\n");
}

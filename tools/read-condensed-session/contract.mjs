export const HISTORY_MARKER = "pi-stored-jsonl-history";

export const READ_THREAD_CONTRACT = {
  historyMarker: HISTORY_MARKER,
  version: 1,
  command: "read-thread",
  usage: "read-thread [OPTIONS] [self | JSONL | THREAD]",
  source: "Stored Pi session JSONL; no model calls, recall cache or index",
  selectors: {
    self: "$PI_SESSION_FILE, resolved by Pi for each shell-tool invocation",
    JSONL: "Explicit session file path; no Remote database required",
    THREAD: "Remote title, UUID or unique UUID prefix",
    omitted: "List Remote threads",
  },
  scope: {
    default: "Parent chain through the newest stored entry, including pre-compaction history",
    explicitLeaf: "--leaf ID selects a stored entry's parent chain. The runtime's live branch tip can differ from the newest stored entry after tree navigation; no live tip is injected into system metadata",
    fullTranscript: "--all --raw emits every complete stored JSONL record across branches",
  },
  options: [
    ["--help", "Print this command's help"],
    ["--contract", "Print this command's machine-readable JSON contract; no session or database required"],
    ["--list", "List Remote threads, newest first"],
    ["--path", "Print only the exact Pi session JSONL path"],
    ["--all", "Include every stored branch, in file order"],
    ["--leaf ID", "Follow this entry's parent chain instead of the newest entry"],
    ["--work", "Include bounded thinking and successful tool results"],
    ["--full", "Include thinking and results without per-block caps"],
    ["--raw", "Emit exact JSONL records from the selected scope"],
    ["--search TEXT", "Case-insensitive search of complete JSONL records; excerpts include source path, line number and entry id"],
    ["--regex", "Interpret --search as a JavaScript regular expression"],
    ["--limit N", "Search matches per page; default 20, maximum 50, at most 1,000 source characters per excerpt"],
    ["--offset N", "Skip N search matches; default 0"],
    ["--since TIMESTAMP", "Include entries at or after this ISO timestamp"],
    ["--tail N", "Include only the last N selected entries, before search"],
    ["--output FILE", "Write output to FILE and print its path"],
    ["--db FILE", "Remote database; default $PI_REMOTE_DATA/supervisor.sqlite3 or the current Unix person's registry"],
  ],
};

export function readerHelp() {
  const contract = READ_THREAD_CONTRACT;
  return [
    `usage: ${contract.usage}`,
    "",
    contract.source,
    ...Object.entries(contract.selectors).map(([selector, meaning]) => `${selector}: ${meaning}`),
    "",
    "options:",
    ...contract.options.map(([option, description]) => `  ${option.padEnd(19)}${description}`),
    "",
    ...Object.values(contract.scope),
  ].join("\n");
}

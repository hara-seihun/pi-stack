export const HISTORY_MARKER = "pi-stored-jsonl-history";

export const READ_THREAD_CONTRACT = {
  historyMarker: HISTORY_MARKER,
  version: 1,
  command: "read-thread",
  usage: "read-thread [OPTIONS] [self | JSONL | THREAD]",
  source: "Stored Pi session JSONL; no model calls, recall cache or index",
  selectors: {
    self: "$PI_SESSION_FILE, resolved by Pi for each shell-tool invocation",
    JSONL: "Explicit session file path; no thread database required",
    THREAD: "Thread title, UUID or unique UUID prefix in the current owner's directory",
    omitted: "List the owner's threads; --subagents instead uses $PI_THREAD_ID",
    subagents: "List direct child threads; self uses $PI_THREAD_ID or $PI_REMOTE_SESSION_ID and requires the owner's thread database",
  },
  scope: {
    default: "Parent chain through the newest stored entry, including pre-compaction history",
    explicitLeaf: "--leaf ID selects a stored entry's parent chain. The runtime's live branch tip can differ from the newest stored entry after tree navigation; no live tip is injected into system metadata",
    fullTranscript: "--all --raw emits every complete stored JSONL record across branches",
    pages: "--json reads the newest active-branch page first, chronological within each page, without deliberation. --cursor continues older entries in the same snapshot. Pages cannot combine with --search, --all, --leaf, --raw, --full, --since, --tail or --output",
  },
  options: [
    ["--help", "Print this command's help"],
    ["--contract", "Print this command's machine-readable JSON contract; no session or database required"],
    ["--list", "List the owner's threads, newest first"],
    ["--subagents", "List direct children as paginated JSON, by most recent user or assistant message; active children by default"],
    ["--include-idle", "With --subagents, include settled and archived children"],
    ["--json", "Read paginated conversation/actions as JSON; --work includes tool results, but deliberation remains omitted"],
    ["--cursor CURSOR", "nextCursor from the preceding --json or --subagents page with the same selector and filters"],
    ["--entry ID", "With --json, read one complete transcript entry in character chunks instead of pages"],
    ["--max-chars N", "Characters per --entry chunk; default 16000, maximum 48000"],
    ["--path", "Print only the exact Pi session JSONL path"],
    ["--all", "Include every stored branch, in file order"],
    ["--leaf ID", "Follow this entry's parent chain instead of the newest entry"],
    ["--work", "Include bounded thinking and successful tool results"],
    ["--full", "Include thinking and results without per-block caps"],
    ["--raw", "Emit exact JSONL records from the selected scope"],
    ["--search TEXT", "Case-insensitive search of complete JSONL records; excerpts include source path, line number and entry id"],
    ["--regex", "Interpret --search as a JavaScript regular expression"],
    ["--limit N", "Page size: --search default 20/max 50, --json default 10/max 20, --subagents default 20/max 100; search excerpts contain at most 1,000 source characters"],
    ["--offset N", "With --search skip N matches; with --json --entry skip N characters. Default 0"],
    ["--since TIMESTAMP", "Include entries at or after this ISO timestamp"],
    ["--tail N", "Include only the last N selected entries, before search"],
    ["--output FILE", "Write output to FILE and print its path"],
    ["--db FILE", "Thread database; $PI_THREAD_DATABASE, otherwise the current person's Remote threads.sqlite3 or Orchestrator threads.sqlite3"],
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

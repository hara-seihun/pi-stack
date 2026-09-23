import type { ContextEntry } from "../../types";

export interface WorkSummary {
  toolCalls: number;
  thinkingBlocks: number;
  files: string[];
  commands: number;
  hasErrors: boolean;
  startedAt?: number;
  endedAt?: number;
}

export type TranscriptItem =
  | { kind: "user"; entry: ContextEntry }
  | { kind: "assistant"; entry: ContextEntry }
  | {
      kind: "work";
      key: string;
      entries: ContextEntry[];
      running: boolean;
      latest: ContextEntry;
      summary: WorkSummary;
    };

function visibleKind(entry: ContextEntry): "user" | "assistant" | undefined {
  if (entry.kind === "user") return "user";
  if (entry.kind === "assistant") return "assistant";
  return undefined;
}

function isRunning(entry: ContextEntry) {
  return entry.streaming === true || entry.kind === "toolCall" && !entry.toolResult;
}

function isError(entry: ContextEntry) {
  return entry.toolResult?.isError === true
    || entry.kind === "notice" && /error|fail/i.test(`${entry.label || ""} ${entry.text || ""}`);
}

function pathFromTool(entry: ContextEntry) {
  if (entry.kind !== "toolCall") return "";
  const name = String(entry.toolCall?.name || "").toLowerCase();
  if (!["read", "edit", "write"].includes(name)) return "";
  const args = entry.toolCall?.arguments || {};
  return typeof args.path === "string" ? args.path : typeof args.file_path === "string" ? args.file_path : "";
}

function summarize(entries: ContextEntry[]): WorkSummary {
  const files = new Set<string>();
  let toolCalls = 0;
  let thinkingBlocks = 0;
  let commands = 0;
  let hasErrors = false;
  let startedAt: number | undefined;
  let endedAt: number | undefined;

  for (const entry of entries) {
    if (entry.kind === "thinking") thinkingBlocks += 1;
    if (isError(entry)) hasErrors = true;
    if (entry.kind !== "toolCall") continue;

    toolCalls += 1;
    const name = String(entry.toolCall?.name || "").toLowerCase();
    if (name === "bash" || name === "exec_command") commands += 1;
    const path = pathFromTool(entry);
    if (path) files.add(path);

    const start = Number(entry.time);
    if (Number.isFinite(start) && start > 0) startedAt = startedAt === undefined ? start : Math.min(startedAt, start);
    const end = Number(entry.toolResult?.timestamp);
    if (Number.isFinite(end) && end > 0) endedAt = endedAt === undefined ? end : Math.max(endedAt, end);
  }

  return { toolCalls, thinkingBlocks, files: [...files], commands, hasErrors, startedAt, endedAt };
}

function workItem(key: string, entries: ContextEntry[]): Extract<TranscriptItem, { kind: "work" }> {
  const active = entries.filter(isRunning);
  const toolCalls = entries.filter(entry => entry.kind === "toolCall");
  return {
    kind: "work",
    key,
    entries,
    running: active.length > 0,
    latest: active.at(-1) || toolCalls.at(-1) || entries.at(-1)!,
    summary: summarize(entries),
  };
}

/**
 * `liveThinking` streams only while the person has the thinking card open, so
 * `thinkingActive` puts the card there before any text exists: a collapsed
 * "Thinking…" step the person can open to subscribe.
 */
export function buildTranscript(entries: ContextEntry[], liveThinking?: string, thinkingActive?: boolean): TranscriptItem[] {
  const text = liveThinking?.trim() ? liveThinking : "";
  const source = text || thinkingActive
    ? [...entries, {
        key: "live-thinking",
        signature: `live-thinking:${text.length}:${thinkingActive ? "active" : "idle"}`,
        kind: "thinking",
        label: text ? "Thinking" : "Thinking…",
        text,
        streaming: true,
        live: true,
      } satisfies ContextEntry]
    : entries;
  const items: TranscriptItem[] = [];
  let work: ContextEntry[] = [];
  let workKey = "work-after:start";

  const flush = () => {
    if (work.length === 0) return;
    items.push(workItem(workKey, work));
    work = [];
  };

  for (const entry of source) {
    const kind = visibleKind(entry);
    if (!kind) {
      work.push(entry);
      continue;
    }
    flush();
    items.push({ kind, entry });
    workKey = `work-after:${entry.key}`;
  }
  flush();
  return items;
}

import type { ContextEntry } from "../../types";
import { assertNever } from "../../../../shared/explicit-state";
import { monoMessage } from "../../app/mono";
import { outgoingAgentMessage } from "./agent-message";
import { SILENT_TURN_TEXT } from "pi-orchestrator/manager-turn";

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
  | { kind: "outgoing"; entry: ContextEntry }
  | {
      kind: "work";
      key: string;
      entries: ContextEntry[];
      running: boolean;
      latest: ContextEntry;
      live?: ContextEntry;
      summary: WorkSummary;
    };

export function emptyAssistantEntry(entry: ContextEntry): boolean {
  return entry.kind === "assistant" && !entry.text?.trim();
}

export function visibleKind(entry: ContextEntry, mono = false): "user" | "assistant" | "outgoing" | undefined {
  switch (entry.kind) {
    case "user": return !mono || entry.monoVisibility !== "hidden" && monoMessage(entry) ? "user" : undefined;
    case "assistant": return mono && (entry.monoVisibility === "hidden" || entry.text === SILENT_TURN_TEXT) ? undefined : "assistant";
    case "toolCall": return !mono && outgoingAgentMessage(entry) ? "outgoing" : undefined;
    case "system": case "tool": case "thinking": case "notice": return undefined;
  }
  return assertNever(entry.kind, "Transcript visible kind");
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
export function buildTranscript(entries: ContextEntry[], liveThinking?: string, thinkingActive?: boolean, mono = false): TranscriptItem[] {
  return appendLiveThinking(buildStableTranscript(entries, mono), liveThinking, thinkingActive, mono);
}

export function appendLiveThinking(items: TranscriptItem[], liveThinking?: string, thinkingActive?: boolean, mono = false): TranscriptItem[] {
  const text = liveThinking?.trim() ? liveThinking : "";
  if (!text && !thinkingActive) return items;
  const live = {
        key: "live-thinking",
        signature: `live-thinking:${text}:${thinkingActive ? "active" : "idle"}`,
        kind: "thinking",
        label: text ? "Thinking" : "Thinking…",
        text,
        streaming: true,
        live: true,
      } satisfies ContextEntry;
  if (!mono) {
    const last = items.at(-1);
    const work = last?.kind === "work"
      ? { ...last, live, running: true, latest: live, summary: { ...last.summary, thinkingBlocks: last.summary.thinkingBlocks + 1 } }
      : workItem(last ? `work-after:${last.entry.key}` : "work-after:start", [live]);
    return [...(last?.kind === "work" ? items.slice(0, -1) : items), work];
  }
  const humanIndex = items.findLastIndex(item => item.kind === "user");
  const workIndex = items.findIndex((item, index) => index > humanIndex && item.kind === "work");
  const existing = items[workIndex];
  if (existing?.kind === "work") {
    const work = { ...existing, live, running: true, latest: live, summary: { ...existing.summary, thinkingBlocks: existing.summary.thinkingBlocks + 1 } };
    return items.map((item, index) => index === workIndex ? work : item);
  }
  const human = items[humanIndex];
  const key = human?.kind === "user" ? `work-after:${human.entry.key}` : "work-after:start";
  const work = { ...workItem(key, [live]), entries: [], live };
  return [...items.slice(0, humanIndex + 1), work, ...items.slice(humanIndex + 1)];
}

export function buildStableTranscript(entries: ContextEntry[], mono = false): TranscriptItem[] {
  const items: TranscriptItem[] = [];
  let work: ContextEntry[] = [];
  let replies: Extract<TranscriptItem, { kind: "assistant" }>[] = [];
  let workKey = "work-after:start";

  const flush = () => {
    if (work.length > 0) items.push(workItem(workKey, work));
    items.push(...replies);
    work = [];
    replies = [];
  };

  for (const entry of entries) {
    if (emptyAssistantEntry(entry) || mono && entry.kind === "assistant" && entry.text === SILENT_TURN_TEXT) continue;
    const kind = visibleKind(entry, mono);
    if (!mono) {
      if (kind) {
        flush();
        items.push({ kind, entry });
        workKey = `work-after:${entry.key}`;
      } else work.push(entry);
    } else if (kind === "user") {
      flush();
      items.push({ kind, entry });
      workKey = `work-after:${entry.key}`;
    } else if (kind === "assistant") {
      replies.push({ kind, entry });
    } else {
      work.push(entry);
    }
  }
  flush();
  return items;
}

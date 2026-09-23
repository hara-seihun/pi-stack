import { memo, useEffect, useMemo, useRef, useState } from "react";

import type { InlineImage } from "../../../../server/inline-image-contract";
import { agentAvatar, AttachmentImage, ChatMessage, CopyButton } from "../../chat-message";
import type { ReplyTarget } from "../../message-reply";
import { InlineImagesContext, Markdown } from "../../context";
import { resourceUrl } from "../../resource-url";
import { formatResponseMetrics } from "../../response-metrics";
import type { ContextEntry } from "../../types";
import { useItemBody } from "./item-bodies";
import { ThreadChips, threadIdsOf } from "./thread-chips";
import { buildTranscript, type TranscriptItem } from "./transcript-model";
import { duration, toolSummary } from "./tool-summary";
import "./transcript.css";

export interface TranscriptProps {
  entries: ContextEntry[];
  liveThinking?: string;
  /** The thread is thinking now, so the live step exists before any text does. */
  thinkingActive?: boolean;
  sessionId: string;
  home: string;
  images: ReadonlyMap<string, InlineImage> | null;
  /** More items exist before the window the client holds. */
  earlierAvailable?: boolean;
  loadingEarlier?: boolean;
  earlierError?: string;
  onShowEarlier?(): void;
  /** Opening the live thinking card subscribes to its text; closing it stops. */
  onThinkingOpen?(open: boolean): void;
  onEdit(entry: ContextEntry): void;
  onReply(target: ReplyTarget): void;
}

function json(value: unknown) {
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

function imageUrl(block: any) {
  if (typeof block?.src === "string" && block.src.startsWith("/v1/sessions/")) return resourceUrl(block.src);
  return block?.data ? `data:${block.mimeType};base64,${block.data}` : "";
}

function resultText(content: any): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return json(content);
  return content.map(block => {
    if (!block || typeof block !== "object") return json(block);
    if (block.type === "text") return String(block.text || "");
    if (block.type === "thinking") return String(block.thinking || "");
    if (block.type === "image") return `Image · ${String(block.mimeType || "application/octet-stream")}`;
    return json(block);
  }).join("\n\n");
}

type VisibleResult = { kind: "text"; text: string } | { kind: "image"; image: any };

function visibleResult(content: any): VisibleResult[] {
  if (!Array.isArray(content)) return [{ kind: "text", text: typeof content === "string" ? content : json(content) }];
  if (content.length === 0) return [{ kind: "text", text: "[]" }];
  return content.map(block => {
    if (block?.type === "image") return { kind: "image", image: block } as const;
    if (block?.type === "text") return { kind: "text", text: String(block.text || "") } as const;
    if (block?.type === "thinking") return { kind: "text", text: String(block.thinking || "") } as const;
    return { kind: "text", text: json(block) } as const;
  });
}

function toolLabel(name: unknown) {
  return String(name || "Tool").replace(/^functions\./, "").replaceAll("_", " ");
}

function useElapsed(startedAt: number | undefined, running: boolean) {
  const [, tick] = useState(0);
  useEffect(() => {
    if (!running || !startedAt) return;
    const timer = setInterval(() => tick(value => value + 1), 1_000);
    return () => clearInterval(timer);
  }, [running, startedAt]);
  return startedAt ? Math.max(0, Date.now() - startedAt) : undefined;
}

const MessageEntry = memo(function MessageEntry({ entry, sessionId, onEdit, onReply }: {
  entry: ContextEntry;
  sessionId: string;
  onEdit(entry: ContextEntry): void;
  onReply(target: ReplyTarget): void;
}) {
  const text = entry.text || "";
  return <ChatMessage
    kind={entry.kind}
    label={entry.label || entry.kind}
    avatar={entry.kind === "assistant" ? agentAvatar() : undefined}
    text={text}
    timestamp={entry.messageTimestamp || undefined}
    identity={entry.identity}
    reactions={entry.reactions}
    reply={entry.reply}
    onReply={onReply}
    responseMetrics={entry.kind === "assistant" ? entry.responseMetrics : undefined}
    contentFormat="markdown"
    renderMarkdown={source => <Markdown source={source} sessionId={sessionId} streaming={entry.streaming} assistant={entry.kind === "assistant"} />}
    menu={entry.kind === "user" && Number(entry.messageTimestamp) > 0 ? [{ label: "Edit and resend from here", onSelect: () => onEdit(entry) }] : []}
  />;
}, (before, after) => before.entry.signature === after.entry.signature && before.sessionId === after.sessionId && before.onEdit === after.onEdit && before.onReply === after.onReply);

function outcome(entry: ContextEntry) {
  if (entry.kind === "toolCall") {
    if (!entry.toolResult) return { status: "running", label: "Running" };
    if (entry.toolResult.isError) return { status: "error", label: "Error" };
    return { status: "done", label: "Done" };
  }
  if (entry.kind === "notice" && /error|fail/i.test(`${entry.label || ""} ${entry.text || ""}`)) return { status: "error", label: "Error" };
  if (entry.streaming) return { status: "running", label: "Running" };
  return { status: "done", label: "Done" };
}

const ToolStep = memo(function ToolStep({ entry, home, forceExpanded = false }: {
  entry: ContextEntry;
  home: string;
  forceExpanded?: boolean;
}) {
  const call = entry.toolCall || {};
  const result = entry.toolResult;
  const state = outcome(entry);
  const [open, setOpen] = useState(forceExpanded || state.status === "error" || !result);
  const body = useItemBody(entry.itemId, open || forceExpanded, entry.size);
  const full = body.body?.kind === "toolCall" ? body.body : null;
  const args = full ? full.arguments : call.arguments ?? {};
  const elapsed = useElapsed(Number(entry.time || 0) || undefined, !result);
  const timing = entry.time ? duration(result ? Number(result.timestamp || entry.time) - Number(entry.time) : elapsed || 0) : "";
  const previewOutput = full?.result ? "" : result ? result.preview || "" : String(call.partialOutput || "");
  const completeOutput = full?.result ? visibleResult(full.result.content) : [];
  const summary = toolSummary(call.name, args, home);
  const threadIds = threadIdsOf(call.name, args);
  const partial = !full && (entry.argumentsTruncated || (result && result.size > (result.preview || "").length));
  const copy = async () => {
    const complete = await body.load();
    const loaded = complete?.kind === "toolCall" ? complete : null;
    return [summary, json(loaded ? loaded.arguments : args), loaded?.result ? resultText(loaded.result.content) : previewOutput].filter(Boolean).join("\n\n");
  };

  return <details className={`conversation-step tool-step ${state.status}`} open={open} aria-busy={state.status === "running" || undefined} onToggle={event => setOpen(event.currentTarget.open)}>
    <summary>
      <span className="step-summary">{open ? toolLabel(call.name) : summary}</span>
      <ThreadChips ids={threadIds} />
      {timing && <span className="step-duration">{timing}</span>}
      {entry.responseMetrics && <span className="step-metrics">{formatResponseMetrics(entry.responseMetrics)}</span>}
      {state.status !== "running" && <span className="step-outcome" data-status={state.status}>{state.label}</span>}
    </summary>
    <div className="step-detail">
      <span className="step-detail-label">Arguments</span>
      <pre>{json(args)}</pre>
      {(previewOutput || completeOutput.length > 0) && <><span className="step-detail-label">Result</span><div className="step-result">
        {previewOutput && <pre>{previewOutput}</pre>}
        {completeOutput.map((part, index) => part.kind === "image"
          ? <AttachmentImage key={index} src={imageUrl(part.image)} alt={`Tool result image, ${String(part.image.mimeType || "application/octet-stream")}`} downloadQuery />
          : <pre key={index}>{part.text}</pre>)}
      </div></>}
      {body.loading && partial && <p className="step-loading" role="status">Loading the full call…</p>}
      {body.error && <p className="step-loading step-failed" role="status">{body.error}</p>}
      <div className="step-copy"><CopyButton text={copy} label="Copy tool call" /></div>
    </div>
  </details>;
}, (before, after) => before.entry.signature === after.entry.signature && before.home === after.home && before.forceExpanded === after.forceExpanded);

function stepLabel(entry: ContextEntry) {
  if (entry.kind === "system") return "System prompt";
  if (entry.kind === "tool") return `Tool schema${entry.label ? ` · ${entry.label.replace(/^Tool\s*·?\s*/i, "")}` : ""}`;
  return entry.label || entry.kind;
}

const TextStep = memo(function TextStep({ entry, sessionId, forceExpanded = false, onOpen }: {
  entry: ContextEntry;
  sessionId: string;
  forceExpanded?: boolean;
  onOpen?(open: boolean): void;
}) {
  const state = outcome(entry);
  const error = state.status === "error";
  const [open, setOpen] = useState(forceExpanded || error || (entry.streaming === true && !entry.live));
  const body = useItemBody(entry.itemId, open || forceExpanded, entry.size);
  const loaded = body.body && body.body.kind !== "toolCall" ? body.body.text : undefined;
  const source = entry.text ?? loaded ?? "";
  const preview = (entry.preview ?? source).trim().replace(/\s+/g, " ").slice(0, 120);
  const thinking = entry.kind === "thinking";
  const waiting = !entry.text && loaded === undefined;
  // Leaving the thread, or losing the live step, closes its subscription.
  const live = useRef({ open, onOpen });
  live.current = { open, onOpen };
  useEffect(() => () => { if (live.current.open) live.current.onOpen?.(false); }, []);
  const toggle = (next: boolean) => {
    setOpen(next);
    onOpen?.(next);
  };
  const detail = loaded ?? entry.text ?? "";
  return <details className={`conversation-step text-step ${state.status}${thinking ? " thinking-step" : ""}`} open={open} aria-busy={state.status === "running" || undefined} onToggle={event => toggle(event.currentTarget.open)}>
    <summary>
      <span className="step-summary"><strong>{stepLabel(entry)}</strong>{!open && preview && <span>{preview}</span>}</span>
      {entry.responseMetrics && <span className="step-metrics">{formatResponseMetrics(entry.responseMetrics)}</span>}
      {state.status !== "running" && <span className="step-outcome" data-status={state.status}>{state.label}</span>}
    </summary>
    <div className="step-detail">
      {waiting && !detail
        ? <p className="step-loading" role="status">{body.error || (entry.live ? "Waiting for the agent's thinking…" : "Loading…")}</p>
        : thinking
          ? <Markdown source={detail} sessionId={sessionId} streaming={entry.streaming} className="markdown-body step-thinking-body" />
          : <pre>{detail}</pre>}
      <div className="step-copy"><CopyButton text={async () => {
        const complete = await body.load();
        return complete && complete.kind !== "toolCall" ? complete.text : detail;
      }} label={`Copy ${stepLabel(entry).toLowerCase()}`} /></div>
    </div>
  </details>;
}, (before, after) => before.entry.signature === after.entry.signature && before.sessionId === after.sessionId && before.forceExpanded === after.forceExpanded && before.onOpen === after.onOpen);

function Step({ entry, sessionId, home, forceExpanded = false, onThinkingOpen }: {
  entry: ContextEntry;
  sessionId: string;
  home: string;
  forceExpanded?: boolean;
  onThinkingOpen?(open: boolean): void;
}) {
  return entry.kind === "toolCall"
    ? <ToolStep entry={entry} home={home} forceExpanded={forceExpanded} />
    : <TextStep entry={entry} sessionId={sessionId} forceExpanded={forceExpanded} onOpen={entry.live ? onThinkingOpen : undefined} />;
}

function workDuration(item: Extract<TranscriptItem, { kind: "work" }>, running: boolean, elapsed: number | undefined) {
  const { startedAt, endedAt } = item.summary;
  if (!startedAt) return "";
  if (running) return duration(elapsed || 0);
  return endedAt ? duration(endedAt - startedAt) : "";
}

function workHeading(item: Extract<TranscriptItem, { kind: "work" }>, running: boolean, elapsed: number | undefined, expanded: boolean) {
  const steps = item.entries.length;
  const time = steps > 1 ? workDuration(item, running, elapsed) : "";
  if (expanded) return `Work${time ? ` · ${time}` : ""}`;
  const parts = [`${steps} ${steps === 1 ? "step" : "steps"}`];
  if (time) parts.unshift(time);
  if (steps > 1) {
    if (item.summary.files.length) parts.push(`${item.summary.files.length} ${item.summary.files.length === 1 ? "file" : "files"}`);
    if (item.summary.commands) parts.push(`${item.summary.commands} ${item.summary.commands === 1 ? "command" : "commands"}`);
  }
  if (item.summary.hasErrors && outcome(item.latest).status !== "error") parts.push("Errors");
  return `Work · ${parts.join(" · ")}`;
}

const WorkCard = memo(function WorkCard({ item, newest, sessionId, home, onThinkingOpen }: {
  item: Extract<TranscriptItem, { kind: "work" }>;
  newest: boolean;
  sessionId: string;
  home: string;
  onThinkingOpen?(open: boolean): void;
}) {
  const [expanded, setExpanded] = useState(false);
  const running = newest && item.running;
  const elapsed = useElapsed(item.summary.startedAt, running);
  return <section className={`work-card${running ? " running" : ""}${item.summary.hasErrors ? " has-errors" : ""}`}>
    <button type="button" className="work-card-header" aria-expanded={expanded} onClick={() => setExpanded(value => !value)}>
      <span className="work-chevron" aria-hidden="true">›</span>
      <span>{workHeading(item, running, elapsed, expanded)}</span>
    </button>
    {expanded
      ? <div className="work-steps">{item.entries.map(entry => <Step key={entry.key} entry={entry} sessionId={sessionId} home={home} onThinkingOpen={onThinkingOpen} />)}</div>
      : <div className="work-latest"><Step entry={item.latest} sessionId={sessionId} home={home} forceExpanded={running && !item.latest.live} onThinkingOpen={onThinkingOpen} /></div>}
  </section>;
}, (before, after) => before.newest === after.newest
  && before.sessionId === after.sessionId
  && before.home === after.home
  && before.onThinkingOpen === after.onThinkingOpen
  && before.item.running === after.item.running
  && before.item.latest.signature === after.item.latest.signature
  && before.item.entries.length === after.item.entries.length
  && before.item.entries.every((entry, index) => entry.signature === after.item.entries[index]?.signature));

const CONTEXT_WINDOW_SIZE = 60;

export function Transcript({ entries, liveThinking, thinkingActive, sessionId, home, images, earlierAvailable, loadingEarlier, earlierError, onShowEarlier, onThinkingOpen, onEdit, onReply }: TranscriptProps) {
  const items = useMemo(() => buildTranscript(entries, liveThinking, thinkingActive), [entries, liveThinking, thinkingActive]);
  const newest = Math.max(0, items.length - CONTEXT_WINDOW_SIZE);
  const [start, setStart] = useState(newest);
  const previousCount = useRef(0);

  useEffect(() => {
    previousCount.current = 0;
    setStart(newest);
  }, [sessionId]);
  useEffect(() => {
    setStart(value => previousCount.current === 0 ? newest : Math.min(value, newest));
    previousCount.current = items.length;
  }, [items.length, newest]);

  const visible = items.slice(start);
  const newestWork = visible.findLastIndex(item => item.kind === "work");
  const earlier = start > 0 || earlierAvailable;
  return <InlineImagesContext.Provider value={images}>
    <div className="transcript conversation-transcript">
      {earlier && <button type="button" className="context-earlier" disabled={loadingEarlier} onClick={() => start > 0 ? setStart(Math.max(0, start - CONTEXT_WINDOW_SIZE)) : onShowEarlier?.()}>
        {loadingEarlier ? "Loading earlier…" : `Show ${start > 0 ? Math.min(CONTEXT_WINDOW_SIZE, start) : CONTEXT_WINDOW_SIZE} earlier`}
      </button>}
      {earlierError && <p className="context-earlier-error" role="status">{earlierError}</p>}
      {visible.map((item, index) => item.kind === "work"
        ? <WorkCard key={`${sessionId}:${item.key}`} item={item} newest={index === newestWork} sessionId={sessionId} home={home} onThinkingOpen={onThinkingOpen} />
        : <MessageEntry key={item.entry.key} entry={item.entry} sessionId={sessionId} onEdit={onEdit} onReply={onReply} />)}
    </div>
  </InlineImagesContext.Provider>;
}

import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { InlineImage } from "../../../../server/inline-image-contract";
import { agentAvatar, AttachmentImage, ChatMessage, CopyButton } from "../../chat-message";
import type { ReplyTarget } from "../../message-reply";
import { InlineImagesContext, Markdown } from "../../context";
import { resourceUrl } from "../../resource-url";
import { formatResponseMetrics } from "../../response-metrics";
import type { ContextEntry } from "../../types";
import { assertNever } from "../../../../shared/explicit-state";
import { AgentDisclosure, AgentRoute, copyOutgoingMessage, outgoingAgentMessage, presentAgentMessage, spawnedThread } from "./agent-message";
import { AGENT_NAME } from "../../../../server/agent-identity";
import { useItemBody } from "./item-bodies";
import { completeMessageEntry, loadMessageEntry } from "./message-body";
import { InputStatus } from "./input-status";
import { bubbleGroups, type BubbleGroup } from "./chat-group";
import { ThreadChips, threadIdsOf } from "./thread-chips";
import { appendLiveThinking, buildStableTranscript, emptyAssistantEntry, messengerWork, visibleKind, type TranscriptItem } from "./transcript-model";
import { VirtualTranscript } from "./VirtualTranscript";
import { useVisualClock } from "../status/visual-clock";
import { useVisibleHeads } from "./visible-heads";
import type { VisibleTranscriptRange } from "./transcript-store";
import { duration, managerToolSummary, toolSummary } from "./tool-summary";
import "./transcript.css";

type RenderedTranscriptItem = TranscriptItem | { kind: "step" | "outgoing" | "incoming"; entry: ContextEntry };
const transcriptMessageIds = (item: RenderedTranscriptItem): readonly string[] => item.kind !== "work" && item.entry.identity ? [item.entry.identity.id] : [];

export interface TranscriptProps {
  working?: boolean;
  entries: ContextEntry[];
  mono?: boolean;
  messenger?: boolean;
  liveThinking?: string;
  /** The thread is thinking now, so the live step exists before any text does. */
  thinkingActive?: boolean;
  autoCollapse?: boolean;
  sessionId: string;
  home: string;
  images: ReadonlyMap<string, InlineImage> | null;
  /** More items exist before the window the client holds. */
  earlierAvailable?: boolean;
  loadingEarlier?: boolean;
  earlierError?: string;
  onShowEarlier?(): void;
  newerAvailable?: boolean;
  onShowNewer?(): void;
  onVisibleRange?(range: VisibleTranscriptRange | null): void;
  /** Opening the live thinking card subscribes to its text; closing it stops. */
  onThinkingOpen?(open: boolean): void;
  onEdit(entry: ContextEntry): void;
  onReply(target: ReplyTarget): void;
  onRetryPrompt?(requestId: string): void;
  onDiscardPrompt?(requestId: string): void;
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

function useElapsed<T extends HTMLElement>(startedAt: number | undefined, running: boolean) {
  const { ref, now } = useVisualClock<T>(running && !!startedAt);
  return { ref, elapsed: startedAt ? Math.max(0, now - startedAt) : undefined };
}

const MessageEntry = memo(function MessageEntry({ entry, sessionId, autoCollapse, mono, bubble, onEdit, onReply, onRetryPrompt, onDiscardPrompt }: {
  entry: ContextEntry;
  sessionId: string;
  autoCollapse: boolean;
  mono: boolean;
  bubble?: BubbleGroup;
  onRetryPrompt?(requestId: string): void;
  onDiscardPrompt?(requestId: string): void;
  onEdit(entry: ContextEntry): void;
  onReply(target: ReplyTarget): void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [receiptOpen, setReceiptOpen] = useState(false);
  const [open, setOpen] = useState(!autoCollapse);
  useEffect(() => setOpen(!autoCollapse), [autoCollapse]);
  const incoming = presentAgentMessage(entry).agentSender;
  const body = useItemBody(entry.itemId, expanded || !!incoming && open || mono && entry.kind === "user" && !incoming && entry.textTruncated === true, entry.size);
  const loaded = body.body ? completeMessageEntry(entry, body.body) : null;
  const presented = presentAgentMessage(loaded?.ok ? loaded.value : entry);
  const text = presented.text || "";
  const sender = presented.agentSender;
  const partial = entry.textTruncated && !loaded?.ok;
  const copy = async () => {
    const full = await loadMessageEntry(entry, body.load);
    if (!full.ok) throw new Error(full.error.message);
    return presentAgentMessage(full.value).text ?? "";
  };
  const edit = async () => {
    setActionError(null);
    const full = await loadMessageEntry(entry, body.load);
    if (!full.ok) { setActionError(full.error.message); return; }
    onEdit(full.value);
  };
  const route = sender ? <AgentRoute direction="incoming" from={{ kind: "peer", threadId: sender.threadId, name: presented.label ?? null }} to={{ kind: "self", threadId: sessionId }} /> : undefined;
  if (emptyAssistantEntry(presented)) return null;
  const failedPrompt = entry.promptDelivery?.state === "failed" ? entry.promptDelivery : null;
  const retryRequestId = failedPrompt?.retryRequestId;
  const promptRequestId = entry.promptRequestId;
  const content = <><ChatMessage
    kind={entry.kind}
    appearance={bubble ? "bubble" : undefined}
    label={entry.kind === "assistant" ? AGENT_NAME : presented.label || entry.kind}
    heading={route}
    avatar={entry.kind === "assistant" ? agentAvatar() : undefined}
    text={text}
    resolveCopyText={copy}
    timestamp={entry.messageTimestamp || undefined}
    identity={entry.identity}
    reactions={entry.reactions}
    reply={entry.reply}
    onReply={onReply}
    responseMetrics={!mono && entry.kind === "assistant" ? entry.responseMetrics : undefined}
    contentFormat="markdown"
    renderMarkdown={source => <Markdown source={source} sessionId={sessionId} streaming={entry.streaming} assistant={entry.kind === "assistant"} />}
    menu={[
      ...(entry.kind === "user" && !presented.agentSender && Number(entry.messageTimestamp) > 0 ? [{ label: "Edit and resend from here", onSelect: edit }] : []),
      ...(bubble && entry.inputId ? [{ label: "Delivery details", onSelect: () => setReceiptOpen(value => !value) }] : []),
      ...(promptRequestId && onDiscardPrompt ? [{ label: "Dismiss saved message", onSelect: () => onDiscardPrompt(promptRequestId) }] : []),
    ]}
  />
    {entry.promptDelivery && <div className="prompt-delivery" data-delivery={entry.promptDelivery.state} role="status" title={entry.promptDelivery.state === "failed" ? entry.promptDelivery.message : undefined}>
      {failedPrompt ? <>{retryRequestId && onRetryPrompt ? <button type="button" onClick={() => onRetryPrompt(retryRequestId)}>Not confirmed · Tap to retry</button> : "Not sent"}<span className="prompt-delivery-error">{failedPrompt.message}</span></> : entry.promptDelivery.state === "sending" ? "Sending…" : entry.promptDelivery.state === "read" ? "Read" : "Delivered"}
    </div>}
    {entry.kind === "user" && entry.inputId && (!bubble || receiptOpen || entry.inputState?.state === "done" && entry.inputState.outcome !== "complete") && <InputStatus inputId={entry.inputId} input={entry.inputState} />}
    {partial && <footer className="message-expansion">
      <button type="button" className="message-expand-action" disabled={body.loading} onClick={() => { setExpanded(true); void body.load(); }}>
        {body.loading ? "Loading full message…" : body.error ? "Retry loading full message" : "Load more"}
      </button>
      <CopyButton text={copy} label="Copy full message" />
    </footer>}
    {(body.error || loaded && !loaded.ok || actionError) && <p className="step-loading step-failed" role="status">{actionError || body.error || loaded && !loaded.ok && loaded.error.message}</p>}
  </>;
  const message = <div className={entry.kind === "user" && !sender ? "transcript-message-human" : "transcript-message-agent"} data-transcript-seq={entry.seq} data-transcript-source={entry.key}>{sender
    ? <AgentDisclosure route={route} open={open} onOpen={setOpen}>{content}</AgentDisclosure>
    : content}
  </div>;
  return bubble ? <div className="chat-row" data-side={entry.kind} data-group-start={bubble.starts} data-group-end={bubble.ends}>
    {bubble.day && <div className="chat-day" role="separator" aria-label={bubble.day}>{bubble.day}</div>}{message}
  </div> : message;
}, (before, after) => before.entry.signature === after.entry.signature && before.sessionId === after.sessionId && before.autoCollapse === after.autoCollapse && before.mono === after.mono && JSON.stringify(before.bubble) === JSON.stringify(after.bubble) && before.onEdit === after.onEdit && before.onReply === after.onReply && before.onRetryPrompt === after.onRetryPrompt && before.onDiscardPrompt === after.onDiscardPrompt);

const OutgoingEntry = memo(function OutgoingEntry({ entry, sessionId, autoCollapse }: { entry: ContextEntry; sessionId: string; autoCollapse: boolean }) {
  const preview = outgoingAgentMessage(entry);
  const [expanded, setExpanded] = useState(false);
  const [open, setOpen] = useState(!autoCollapse);
  useEffect(() => setOpen(!autoCollapse), [autoCollapse]);
  const body = useItemBody(entry.itemId, expanded || open, entry.size);
  const complete = body.body?.kind === "toolCall" ? outgoingAgentMessage(entry, body.body) : null;
  const message = complete ?? preview;
  if (!message) return null;
  const partial = entry.argumentsTruncated && !complete;
  const copy = () => copyOutgoingMessage(entry, body.load);
  const created = message.tool === "spawn" ? spawnedThread(body.body) : null;
  const to = message.tool === "send" ? { kind: "peer" as const, threadId: message.recipientId, name: null }
    : created ? { kind: "peer" as const, threadId: created.id, name: created.name } : { kind: "new" as const, title: message.title };
  const status = message.delivery.state === "sending" ? { status: "sending" }
    : message.delivery.state === "failed" ? { status: "failed", error: message.delivery.error } : undefined;
  const route = <AgentRoute direction="outgoing" from={{ kind: "self", threadId: sessionId }} to={to} />;
  return <div data-transcript-seq={entry.seq}><AgentDisclosure route={route} open={open} onOpen={setOpen}><ChatMessage
    kind="assistant agent-outgoing"
    label={AGENT_NAME}
    heading={route}
    avatar={agentAvatar()}
    text={message.text}
    resolveCopyText={copy}
    timestamp={Number(entry.time) || undefined}
    delivery={status}
    contentFormat="markdown"
    renderMarkdown={source => <Markdown source={source} sessionId={sessionId} assistant />}
  />
    {(partial || message.tool === "spawn" && message.delivery.state === "delivered" && !created) && <footer className="message-expansion">
      <button type="button" className="message-expand-action" disabled={body.loading} onClick={() => { setExpanded(true); void body.load(); }}>
        {body.loading ? "Loading full message…" : body.error ? "Retry loading full message" : "Load more"}
      </button>
      <CopyButton text={copy} label="Copy full message" />
    </footer>}
    {body.error && <p className="step-loading step-failed" role="status">{body.error}</p>}
    {(expanded || open) && body.body && !complete && <p className="step-loading step-failed" role="status">The full outgoing message is invalid.</p>}
  </AgentDisclosure></div>;
}, (before, after) => before.entry.signature === after.entry.signature && before.sessionId === after.sessionId && before.autoCollapse === after.autoCollapse);

function outcome(entry: ContextEntry): { status: "running" | "error" | "done"; label: string } {
  switch (entry.kind) {
    case "toolCall":
      if (!entry.toolResult) return { status: "running", label: "Running" };
      return entry.toolResult.isError ? { status: "error", label: "Error" } : { status: "done", label: "Done" };
    case "notice":
      if (/error|fail/i.test(`${entry.label || ""} ${entry.text || ""}`)) return { status: "error", label: "Error" };
      return { status: "done", label: "Done" };
    case "system": case "tool": case "thinking": case "user": case "assistant":
      return entry.streaming ? { status: "running", label: "Running" } : { status: "done", label: "Done" };
  }
  return assertNever(entry.kind, "Transcript outcome");
}

export const ToolStep = memo(function ToolStep({ entry, home, forceExpanded = false, progressive = false }: {
  entry: ContextEntry;
  home: string;
  forceExpanded?: boolean;
  progressive?: boolean;
}) {
  const call = entry.toolCall || {};
  const result = entry.toolResult;
  const state = outcome(entry);
  const [open, setOpen] = useState(forceExpanded || !progressive && (state.status === "error" || !result));
  const body = useItemBody(entry.itemId, open, entry.size);
  const full = body.body?.kind === "toolCall" ? body.body : null;
  const args = full ? full.arguments : call.arguments ?? {};
  const { ref, elapsed } = useElapsed<HTMLDetailsElement>(Number(entry.time || 0) || undefined, !result);
  const timing = entry.time ? duration(result ? Number(result.timestamp || entry.time) - Number(entry.time) : elapsed || 0) : "";
  const previewOutput = full?.result ? "" : result ? result.preview || "" : String(call.partialOutput || "");
  const completeOutput = full?.result ? visibleResult(full.result.content) : [];
  const summary = progressive
    ? managerToolSummary(call.name, args, home, !result, !!full || entry.argumentsTruncated !== true)
    : toolSummary(call.name, args, home);
  const threadIds = threadIdsOf(call.name, args);
  const partial = !full && (entry.argumentsTruncated || (result && result.size > (result.preview || "").length));
  const copy = async () => {
    const complete = await body.load();
    const loaded = complete?.kind === "toolCall" ? complete : null;
    return [summary, json(loaded ? loaded.arguments : args), loaded?.result ? resultText(loaded.result.content) : previewOutput].filter(Boolean).join("\n\n");
  };

  return <details ref={ref} data-transcript-seq={entry.seq} className={`conversation-step tool-step ${state.status}`} open={open} aria-busy={state.status === "running" || undefined} onToggle={event => setOpen(event.currentTarget.open)}>
    <summary>
      <span className="step-summary">{progressive || !open ? summary : toolLabel(call.name)}</span>
      {!progressive && <ThreadChips ids={threadIds} />}
      {timing && <span className="step-duration">{timing}</span>}
      {!progressive && entry.responseMetrics && <span className="step-metrics">{formatResponseMetrics(entry.responseMetrics)}</span>}
      {state.status !== "running" && <span className="step-outcome" data-status={state.status}>{state.label}</span>}
    </summary>
    {(!progressive || open) && <div className="step-detail">
      {progressive && <ThreadChips ids={threadIds} />}
      {progressive && entry.responseMetrics && <span className="step-metrics">{formatResponseMetrics(entry.responseMetrics)}</span>}
      <span className="step-detail-label">Arguments</span>
      <pre className="step-arguments" tabIndex={0} aria-label="Tool arguments">{json(args)}</pre>
      {(previewOutput || completeOutput.length > 0) && <><span className="step-detail-label">Result</span><div className="step-result" tabIndex={0} role="region" aria-label="Tool result">
        {previewOutput && <pre>{previewOutput}</pre>}
        {completeOutput.map((part, index) => part.kind === "image"
          ? <AttachmentImage key={index} src={imageUrl(part.image)} alt={`Tool result image, ${String(part.image.mimeType || "application/octet-stream")}`} downloadQuery />
          : <pre key={index}>{part.text}</pre>)}
      </div></>}
      {body.loading && partial && <p className="step-loading" role="status">Loading the full call…</p>}
      {body.error && <p className="step-loading step-failed" role="status">{body.error}</p>}
      <div className="step-copy"><CopyButton text={copy} label="Copy tool call" /></div>
    </div>}
  </details>;
}, (before, after) => before.entry.signature === after.entry.signature && before.home === after.home && before.forceExpanded === after.forceExpanded && before.progressive === after.progressive);

function stepLabel(entry: ContextEntry) {
  switch (entry.kind) {
    case "system": return "System prompt";
    case "tool": return `Tool schema${entry.label ? ` · ${entry.label.replace(/^Tool\s*·?\s*/i, "")}` : ""}`;
    case "thinking": case "notice": case "toolCall": case "user": case "assistant": return entry.label || entry.kind;
  }
  return assertNever(entry.kind, "Transcript step label");
}

const TextStep = memo(function TextStep({ entry, sessionId, forceExpanded = false, progressive = false, onOpen }: {
  entry: ContextEntry;
  sessionId: string;
  forceExpanded?: boolean;
  progressive?: boolean;
  onOpen?(open: boolean): void;
}) {
  const state = outcome(entry);
  const error = state.status === "error";
  const [open, setOpen] = useState(forceExpanded || !progressive && (error || entry.streaming === true && !entry.live));
  const body = useItemBody(entry.itemId, open, entry.size);
  const loaded = body.body && body.body.kind !== "toolCall" ? body.body.text : undefined;
  const source = entry.text ?? loaded ?? "";
  const rawPreview = (entry.preview ?? source).trim().replace(/\s+/g, " ").slice(0, 120);
  const preview = progressive && (rawPreview.startsWith("{") || rawPreview.startsWith("[")) ? "" : rawPreview;
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
  return <details data-transcript-seq={entry.seq} className={`conversation-step text-step ${state.status}${thinking ? " thinking-step" : ""}`} open={open} aria-busy={state.status === "running" || undefined} onToggle={event => toggle(event.currentTarget.open)}>
    <summary>
      <span className="step-summary"><strong>{stepLabel(entry)}</strong>{!open && preview && <span>{preview}</span>}</span>
      {!progressive && entry.responseMetrics && <span className="step-metrics">{formatResponseMetrics(entry.responseMetrics)}</span>}
      {state.status !== "running" && <span className="step-outcome" data-status={state.status}>{state.label}</span>}
    </summary>
    {(!progressive || open) && <div className="step-detail">
      {progressive && entry.responseMetrics && <span className="step-metrics">{formatResponseMetrics(entry.responseMetrics)}</span>}
      {waiting && !detail
        ? <p className="step-loading" role="status">{body.error || (entry.live ? "Waiting for the agent's thinking…" : "Loading…")}</p>
        : thinking
          ? <Markdown source={detail} sessionId={sessionId} streaming={entry.streaming} className="markdown-body step-thinking-body" />
          : <pre>{detail}</pre>}
      <div className="step-copy"><CopyButton text={async () => {
        if (entry.textTruncated) {
          const full = await loadMessageEntry(entry, body.load);
          if (!full.ok) throw new Error(full.error.message);
          return full.value.text ?? "";
        }
        const complete = await body.load();
        return complete && complete.kind !== "toolCall" ? complete.text : detail;
      }} label={`Copy ${stepLabel(entry).toLowerCase()}`} /></div>
    </div>}
  </details>;
}, (before, after) => before.entry.signature === after.entry.signature && before.sessionId === after.sessionId && before.forceExpanded === after.forceExpanded && before.progressive === after.progressive && before.onOpen === after.onOpen);

function Step({ entry, sessionId, home, forceExpanded = false, progressive = false, onThinkingOpen }: {
  entry: ContextEntry;
  sessionId: string;
  home: string;
  forceExpanded?: boolean;
  progressive?: boolean;
  onThinkingOpen?(open: boolean): void;
}) {
  switch (entry.kind) {
    case "toolCall": return <ToolStep entry={entry} home={home} forceExpanded={forceExpanded} progressive={progressive} />;
    case "system": case "tool": case "thinking": case "notice": case "user": case "assistant":
      return <TextStep entry={entry} sessionId={sessionId} forceExpanded={forceExpanded} progressive={progressive} onOpen={entry.live ? onThinkingOpen : undefined} />;
  }
  return assertNever(entry.kind, "Transcript step");
}

function workDuration(item: Extract<TranscriptItem, { kind: "work" }>, running: boolean, elapsed: number | undefined) {
  const { startedAt, endedAt } = item.summary;
  if (!startedAt) return "";
  if (running) return duration(elapsed || 0);
  return endedAt ? duration(endedAt - startedAt) : "";
}

function workHeading(item: Extract<TranscriptItem, { kind: "work" }>, running: boolean, elapsed: number | undefined, expanded: boolean) {
  const steps = item.entries.length + (item.live ? 1 : 0);
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

export function WorkEntry({ entry, sessionId, home, mono, autoCollapse, onThinkingOpen, onEdit, onReply }: {
  entry: ContextEntry;
  sessionId: string;
  home: string;
  mono: boolean;
  autoCollapse: boolean;
  onThinkingOpen?(open: boolean): void;
  onEdit(entry: ContextEntry): void;
  onReply(target: ReplyTarget): void;
}) {
  if (outgoingAgentMessage(entry)) return <OutgoingEntry entry={entry} sessionId={sessionId} autoCollapse={mono || autoCollapse} />;
  if (entry.kind === "user" && presentAgentMessage(entry).agentSender) return <MessageEntry entry={entry} sessionId={sessionId} mono={mono} autoCollapse={mono || autoCollapse} onEdit={onEdit} onReply={onReply} />;
  return <Step entry={entry} sessionId={sessionId} home={home} forceExpanded={!mono && !autoCollapse} progressive={mono} onThinkingOpen={onThinkingOpen} />;
}

const WorkCard = memo(function WorkCard({ item, newest, sessionId, home, mono, messenger, expanded, onExpanded, onThinkingOpen, onEdit, onReply }: {
  item: Extract<TranscriptItem, { kind: "work" }>;
  newest: boolean;
  messenger: boolean;
  sessionId: string;
  home: string;
  mono: boolean;
  expanded: boolean;
  onExpanded(key: string, expanded: boolean): void;
  onThinkingOpen?(open: boolean): void;
  onEdit(entry: ContextEntry): void;
  onReply(target: ReplyTarget): void;
}) {
  const running = newest && item.running;
  const { ref, elapsed } = useElapsed<HTMLElement>(item.summary.startedAt, running);
  return <section ref={ref} className={`work-card${messenger ? " chat-work" : ""}${running ? " running" : ""}${item.summary.hasErrors ? " has-errors" : ""}`}>
    <button type="button" className="work-card-header" aria-label={messenger ? running ? "Kenan is typing. Show work" : "Show work for this reply" : undefined} aria-expanded={expanded} onClick={() => onExpanded(`${sessionId}:${item.key}`, !expanded)}>
      {messenger && !expanded ? running
        ? <span className="typing-dots" aria-hidden="true"><span /><span /><span /></span>
        : <span className="chat-work-finished">View work</span>
        : <><span className="work-chevron" aria-hidden="true">›</span><span>{workHeading(item, running, elapsed, expanded)}</span></>}
    </button>
    {expanded
      ? <div className="work-steps"><VirtualTranscript items={item.entries} messageIds={entry => entry.identity ? [entry.identity.id] : []} itemKey={entry => entry.key} render={entry => <WorkEntry entry={entry} sessionId={sessionId} home={home} mono={mono} autoCollapse={false} onThinkingOpen={onThinkingOpen} onEdit={onEdit} onReply={onReply} />} />{item.live && <Step entry={item.live} sessionId={sessionId} home={home} progressive={mono} onThinkingOpen={onThinkingOpen} />}</div>
      : !mono && !messenger && <div className="work-latest">{outgoingAgentMessage(item.latest) || item.latest.kind === "user"
        ? <WorkEntry entry={item.latest} sessionId={sessionId} home={home} mono={mono} autoCollapse onThinkingOpen={onThinkingOpen} onEdit={onEdit} onReply={onReply} />
        : <Step entry={item.latest} sessionId={sessionId} home={home} forceExpanded={running && !item.latest.live} onThinkingOpen={onThinkingOpen} />}</div>}
  </section>;
}, (before, after) => before.newest === after.newest
  && before.sessionId === after.sessionId
  && before.home === after.home
  && before.mono === after.mono
  && before.messenger === after.messenger
  && before.expanded === after.expanded
  && before.onExpanded === after.onExpanded
  && before.onEdit === after.onEdit
  && before.onReply === after.onReply
  && before.onThinkingOpen === after.onThinkingOpen
  && before.item.running === after.item.running
  && before.item.latest.signature === after.item.latest.signature
  && before.item.entries.length === after.item.entries.length
  && before.item.entries.every((entry, index) => entry.signature === after.item.entries[index]?.signature));

export function Transcript({ entries, liveThinking, thinkingActive, autoCollapse = true, mono = false, messenger = false, working, sessionId, home, images, earlierAvailable, loadingEarlier, earlierError, onShowEarlier, newerAvailable, onShowNewer, onVisibleRange, onThinkingOpen, onEdit, onReply, onRetryPrompt, onDiscardPrompt }: TranscriptProps) {
  const [expandedWork, setExpandedWork] = useState<ReadonlySet<string>>(() => new Set());
  const onExpanded = useCallback((key: string, expanded: boolean) => {
    setExpandedWork(previous => {
      const next = new Set(previous);
      if (expanded) next.add(key); else next.delete(key);
      return next;
    });
  }, []);
  const retainedEntries = useMemo(() => entries.filter(entry => !emptyAssistantEntry(entry)), [entries]);
  const stable = useMemo(() => buildStableTranscript(retainedEntries, mono), [retainedEntries, mono]);
  const thinking = useMemo(() => appendLiveThinking(stable, liveThinking, thinkingActive, mono), [stable, liveThinking, thinkingActive, mono]);
  const grouped = useMemo(() => messenger ? messengerWork(thinking, working === true) : thinking, [thinking, messenger, working]);
  const items = useMemo<RenderedTranscriptItem[]>(() => {
    if (mono || autoCollapse) return grouped;
    const expanded: RenderedTranscriptItem[] = retainedEntries.map(entry => {
      const kind = visibleKind(entry);
      return { kind: kind ?? (outgoingAgentMessage(entry) ? "outgoing" : entry.kind === "user" && presentAgentMessage(entry).agentSender ? "incoming" : "step"), entry };
    });
    const liveWork = grouped.findLast(item => item.kind === "work" && (item.live || item.entries.some(entry => entry.live)));
    if (liveWork?.kind === "work") {
      const live = liveWork.live ?? liveWork.entries.find(entry => entry.live);
      if (live) expanded.push({ kind: "step", entry: live });
    }
    return expanded;
  }, [grouped, retainedEntries, autoCollapse, mono]);
  const bubbles = useMemo(() => bubbleGroups(items.flatMap(item => item.kind === "user" || item.kind === "assistant" ? [item.entry] : [])), [items]);
  const ref = useVisibleHeads(items, onVisibleRange);
  const visible = items;
  const newestWork = items.findLastIndex(item => item.kind === "work");
  return <InlineImagesContext.Provider value={images}>
    <div ref={ref} className="transcript conversation-transcript">
      {earlierAvailable && <button type="button" className="context-earlier" disabled={loadingEarlier} onClick={onShowEarlier}>
        {loadingEarlier ? "Loading earlier…" : "Show 60 earlier"}
      </button>}
      {earlierError && <p className="context-earlier-error" role="status">{earlierError}</p>}
      <VirtualTranscript items={visible} messageIds={transcriptMessageIds} itemKey={item => `${sessionId}:${item.kind === "work" ? item.key : item.entry.key}`} render={(item, index) => item.kind === "work"
        ? <WorkCard item={item} newest={index === newestWork} sessionId={sessionId} home={home} mono={mono} messenger={messenger} expanded={expandedWork.has(`${sessionId}:${item.key}`)} onExpanded={onExpanded} onThinkingOpen={onThinkingOpen} onEdit={onEdit} onReply={onReply} />
        : item.kind === "step"
          ? <Step entry={item.entry} sessionId={sessionId} home={home} forceExpanded onThinkingOpen={onThinkingOpen} />
          : item.kind === "outgoing"
            ? <OutgoingEntry entry={item.entry} sessionId={sessionId} autoCollapse={autoCollapse} />
            : <MessageEntry entry={item.entry} sessionId={sessionId} autoCollapse={autoCollapse} mono={mono} bubble={messenger && (item.kind === "user" || item.kind === "assistant") ? bubbles.get(item.entry.key) : undefined} onEdit={onEdit} onReply={onReply} onRetryPrompt={onRetryPrompt} onDiscardPrompt={onDiscardPrompt} />} />
      {newerAvailable && <button type="button" className="context-earlier context-newer" disabled={loadingEarlier} onClick={onShowNewer}>{loadingEarlier ? "Loading newer…" : "Show 60 newer"}</button>}
    </div>
  </InlineImagesContext.Provider>;
}

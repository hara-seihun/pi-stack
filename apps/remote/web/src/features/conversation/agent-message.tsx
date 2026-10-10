import { useContext, useEffect, type ReactNode } from "react";
import { agentMessagePresentation } from "pi-orchestrator/message-format";
import type { ContextEntry, TranscriptItemBody } from "../../types";
import { shortThreadName, ThreadDirectoryContext } from "./thread-chips";

/** Old cached heads and new server projections share the same human presentation. */
export function presentAgentMessage(entry: ContextEntry): ContextEntry {
  if (entry.kind !== "user" || entry.inputOrigin === "human") return entry;
  const envelope = entry.agentSender || entry.text === undefined ? null : agentMessagePresentation(entry.text);
  const sender = entry.agentSender ?? envelope?.sender;
  if (!sender) return entry;
  const label = shortThreadName(sender.threadId);
  const text = envelope ? envelope.text : entry.text;
  if (entry.agentSender && entry.label === label && entry.text === text) return entry;
  return { ...entry, label, text, agentSender: sender, signature: `${entry.signature}:agent:${JSON.stringify(sender)}:${label}` };
}

export type OutgoingDelivery =
  | { state: "sending" }
  | { state: "delivered" }
  | { state: "failed"; error: string };

/** A thread_send or thread_spawn call, read as the message this agent said to another. */
export type OutgoingAgentMessage =
  | { tool: "send"; recipientId: string; text: string; delivery: OutgoingDelivery }
  | { tool: "spawn"; title: string | null; text: string; delivery: OutgoingDelivery };

const toolName = (name: unknown) => String(name ?? "").toLowerCase().replace(/^functions\./, "");

function delivery(entry: ContextEntry): OutgoingDelivery {
  if (!entry.toolResult) return { state: "sending" };
  return entry.toolResult.isError ? { state: "failed", error: String(entry.toolResult.preview || "The thread service rejected the message") } : { state: "delivered" };
}

/** Null for every other step, and for a call whose words did not reach the head (it stays a tool step). */
export function outgoingAgentMessage(entry: ContextEntry, body?: TranscriptItemBody): OutgoingAgentMessage | null {
  if (entry.kind !== "toolCall") return null;
  const args = body?.kind === "toolCall" ? body.arguments : entry.toolCall?.arguments ?? {};
  if (!args || typeof args !== "object") return null;
  const tool = toolName(entry.toolCall?.name);
  if (tool === "thread_send")
    return typeof args.threadId === "string" && args.threadId && typeof args.text === "string"
      ? { tool: "send", recipientId: args.threadId, text: args.text, delivery: delivery(entry) } : null;
  if (tool === "thread_spawn")
    return typeof args.message === "string"
      ? { tool: "spawn", title: typeof args.title === "string" && args.title ? args.title : null, text: args.message, delivery: delivery(entry) } : null;
  return null;
}

export async function copyOutgoingMessage(entry: ContextEntry, load: () => Promise<TranscriptItemBody | undefined>): Promise<string> {
  const body = entry.argumentsTruncated ? await load() : undefined;
  if (entry.argumentsTruncated && body?.kind !== "toolCall") throw new Error("The complete outgoing message could not be loaded");
  const message = outgoingAgentMessage(entry, body);
  if (!message) throw new Error("The complete outgoing message is invalid");
  return message.text;
}

/** The thread a successful spawn created, read from its complete result. */
export function spawnedThread(body: TranscriptItemBody | undefined): { id: string; name: string | null } | null {
  if (body?.kind !== "toolCall" || !body.result || body.result.isError || !Array.isArray(body.result.content)) return null;
  const text = body.result.content.find((block: { type?: unknown }) => block?.type === "text")?.text;
  if (typeof text !== "string") return null;
  try {
    const parsed = JSON.parse(text) as { ok?: unknown; value?: { id?: unknown; title?: unknown } };
    if (parsed.ok !== true || typeof parsed.value?.id !== "string") return null;
    return { id: parsed.value.id, name: typeof parsed.value.title === "string" ? parsed.value.title : null };
  } catch { return null; }
}

export type RouteEnd =
  | { kind: "self"; threadId: string }
  | { kind: "peer"; threadId: string; name: string | null }
  | { kind: "new"; title: string | null };

function RouteName({ end }: { end: RouteEnd }) {
  const directory = useContext(ThreadDirectoryContext);
  const id = end.kind === "new" ? null : end.threadId;
  useEffect(() => { if (directory && id && end.kind === "peer") directory.discover([id]); }, [directory, id, end.kind]);
  if (end.kind === "new") return <span className="agent-route-name new" title={end.title ?? undefined}>New agent</span>;
  const known = directory?.name(end.threadId) ?? null;
  if (end.kind === "self") return <span className="agent-route-name self">{known ?? shortThreadName(end.threadId)}</span>;
  const name = known ?? shortThreadName(end.threadId);
  const title = directory?.name(end.threadId) ?? undefined;
  const error = directory?.lookupError(end.threadId);
  return directory
    ? <button type="button" className="agent-route-name" title={error ? `Name unavailable: ${error}. Open ${name}` : title ? `${name}: ${title}` : `Open ${name}`} onClick={event => { event.stopPropagation(); directory.open(end.threadId); }}>{name}</button>
    : <span className="agent-route-name peer">{name}</span>;
}

export function AgentRoute({ from, to, direction }: { from: RouteEnd; to: RouteEnd; direction: "incoming" | "outgoing" }) {
  const incoming = direction === "incoming";
  return <span className={`agent-route ${direction}`}>
    <RouteName end={incoming ? to : from} />
    <svg className="agent-route-arrow" viewBox="0 0 24 24" role="img" aria-label={incoming ? "from" : "to"}><path d={incoming ? "M20 12H5m5-5-5 5 5 5" : "M4 12h15m-5-5 5 5-5 5"} /></svg>
    <RouteName end={incoming ? from : to} />
  </span>;
}

/** The native disclosure keeps pointer, touch and keyboard semantics identical.
 * Toggle state is owned by the message, not its delivery/streaming state. */
export function AgentDisclosure({ route, open, onOpen, children }: {
  route: ReactNode; open: boolean; onOpen(open: boolean): void; children: ReactNode;
}) {
  return <details className="conversation-step agent-message-step" open={open} onToggle={event => onOpen(event.currentTarget.open)}>
    <summary><span className="agent-message-chevron" aria-hidden="true">›</span>{route}</summary>
    <div className="agent-message-detail">{children}</div>
  </details>;
}

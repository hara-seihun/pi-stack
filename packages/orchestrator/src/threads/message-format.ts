import type { ThreadMessage } from "./contracts.js";

const PREFIX = "<agent_message>\nThis is an agent-to-agent message, not a user message.\n";
const THREAD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface AgentMessagePresentation {
  sender: { threadId: string; name?: string };
  text: string;
}

export function agentSenderLabel(sender: AgentMessagePresentation["sender"]): string {
  return sender.name ?? `Agent · ${sender.threadId.slice(0, 8)}`;
}

/** Display-only decoding of the native transport. It grants no agent authority. */
export function agentMessagePresentation(text: string): AgentMessagePresentation | null {
  if (!text.startsWith(PREFIX)) return null;
  const metadataEnd = text.indexOf("\n\n", PREFIX.length);
  const bodyEnd = text.lastIndexOf("\n</agent_message>");
  if (metadataEnd < 0 || bodyEnd < metadataEnd + 2) return null;
  let metadata: Record<string, unknown>;
  try { metadata = JSON.parse(text.slice(PREFIX.length, metadataEnd)); }
  catch { return null; }
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)
    || typeof metadata.senderThreadId !== "string" || !THREAD_ID.test(metadata.senderThreadId)) return null;
  if (metadata.senderName !== undefined && (typeof metadata.senderName !== "string" || !metadata.senderName.trim())) return null;
  const keys = Object.keys(metadata);
  const notification = keys.every(key => key === "senderThreadId" || key === "senderName");
  if (!notification && (metadata.source !== "explicit"
    || typeof metadata.recipientThreadId !== "string" || !THREAD_ID.test(metadata.recipientThreadId)
    || typeof metadata.messageId !== "string" || !metadata.messageId
    || keys.some(key => !["senderThreadId", "senderName", "recipientThreadId", "messageId", "source", "replyTo"].includes(key))
    || metadata.replyTo !== undefined && (typeof metadata.replyTo !== "string" || !metadata.replyTo))) return null;
  const body = text.slice(metadataEnd + 2, bodyEnd);
  const tail = text.slice(bodyEnd + "\n</agent_message>".length);
  return {
    sender: { threadId: metadata.senderThreadId, ...(typeof metadata.senderName === "string" ? { name: metadata.senderName } : {}) },
    text: (notification ? notificationPresentation(body) : body) + tail,
  };
}

function notificationPresentation(text: string): string {
  const lineEnd = text.indexOf("\n");
  const firstLine = lineEnd < 0 ? text : text.slice(0, lineEnd);
  let notification: Record<string, unknown>;
  try { notification = JSON.parse(firstLine); }
  catch { return text; }
  if (!notification || notification.type !== "thread_idle" || typeof notification.outcome !== "string") return text;
  const report = typeof notification.finalText === "string" ? notification.finalText : finalText(notification.finalMessage);
  const error = typeof notification.error === "string" ? notification.error : null;
  return [report || `Work ${notification.outcome}.`, error].filter(Boolean).join("\n\n") + (lineEnd < 0 ? "" : text.slice(lineEnd));
}

export function finalText(message: unknown): string | null {
  if (typeof message === "string") return message || null;
  if (!message || typeof message !== "object") return null;
  const content = (message as Record<string, unknown>).content;
  if (typeof content === "string") return content || null;
  if (!Array.isArray(content)) return null;
  const text = content.filter((block): block is { type: "text"; text: string } =>
    !!block && typeof block === "object" && block.type === "text" && typeof block.text === "string")
    .map(block => block.text).join("\n");
  return text || null;
}

export function serializeThreadNotification(notification: Record<string, unknown>): string {
  return JSON.stringify({ type: "thread_idle", ...(typeof notification.title === "string" ? { title: notification.title } : {}),
    outcome: notification.outcome, finalText: typeof notification.finalText === "string" ? notification.finalText : finalText(notification.finalMessage),
    ...(notification.error ? { error: notification.error } : {}) });
}

export function readableNotificationText(message: Pick<ThreadMessage, "source" | "text">, text = message.text): string {
  if (message.source !== "notification") return text;
  let notification: Record<string, unknown> | null;
  try { notification = JSON.parse(message.text); }
  catch { return text; }
  if (!notification || notification.type !== "thread_idle") return text;
  // Preparation may append meeting context. Replace only the persisted report body.
  return text.replace(message.text, () => serializeThreadNotification(notification));
}

export function formatThreadMessage(message: ThreadMessage, text: string): string {
  if (!message.senderId && message.source !== "notification") return text;
  text = readableNotificationText(message, text);
  const sender = { senderThreadId: message.senderId, ...(message.senderName ? { senderName: message.senderName } : {}) };
  const metadata = message.source === "notification" ? sender : {
    ...sender,
    recipientThreadId: message.threadId,
    messageId: message.id,
    source: message.source,
    ...(message.replyTo ? { replyTo: message.replyTo } : {}),
  };
  return `<agent_message>\nThis is an agent-to-agent message, not a user message.\n${JSON.stringify(metadata)}\n\n${text}\n</agent_message>`;
}

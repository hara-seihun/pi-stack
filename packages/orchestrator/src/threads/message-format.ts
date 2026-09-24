import type { ThreadMessage } from "./contracts.js";

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
  const metadata = message.source === "notification" ? { senderThreadId: message.senderId } : {
    senderThreadId: message.senderId,
    recipientThreadId: message.threadId,
    messageId: message.id,
    source: message.source,
    ...(message.replyTo ? { replyTo: message.replyTo } : {}),
  };
  return `<agent_message>\nThis is an agent-to-agent message, not a user message.\n${JSON.stringify(metadata)}\n\n${text}\n</agent_message>`;
}

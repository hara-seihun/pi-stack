import type { ThreadMessage } from "./contracts.js";

const opaqueField = /^(?:thinkingSignature|textSignature|thoughtSignature|signature|encrypted_content|encryptedContent)$/i;

function readableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(readableValue).filter(item => item !== undefined);
  if (!value || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  if (record.type === "redacted_thinking") return undefined;
  return Object.fromEntries(Object.entries(record)
    .filter(([key]) => !opaqueField.test(key))
    .map(([key, item]) => [key, record.type === "toolCall" && key === "arguments" ? item : readableValue(item)])
    .filter(([, item]) => item !== undefined));
}

export function serializeThreadNotification(notification: Record<string, unknown>): string {
  return JSON.stringify({ ...notification, finalMessage: readableValue(notification.finalMessage) });
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
  const metadata = {
    senderThreadId: message.senderId,
    recipientThreadId: message.threadId,
    messageId: message.id,
    source: message.source,
    ...(message.replyTo ? { replyTo: message.replyTo } : {}),
  };
  return `<agent_message>\nThis is an agent-to-agent message, not a user message.\n${JSON.stringify(metadata)}\n\n${text}\n</agent_message>`;
}

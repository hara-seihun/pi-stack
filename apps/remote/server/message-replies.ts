import { parseMessageReference, type MessageReply, type MessageSender } from "./message-protocol";

const prefix = "<pi-message-reply>";
const suffix = "</pi-message-reply>\n\n";
export const REPLY_PREVIEW_CHARACTERS = 4_000;

function validReply(value: unknown): value is MessageReply {
  if (!value || typeof value !== "object") return false;
  const reply = value as MessageReply;
  return typeof reply.messageId === "string" && Boolean(parseMessageReference(reply.messageId))
    && typeof reply.sender?.id === "string" && reply.sender.id.length > 0
    && (reply.sender.name === undefined || typeof reply.sender.name === "string")
    && typeof reply.text === "string" && reply.text.length <= REPLY_PREVIEW_CHARACTERS + 1
    && (reply.timestamp === undefined || Number.isFinite(reply.timestamp));
}

/** Stored with the native user input, so the reference survives restarts, forks and context capture. */
export function encodeMessageReply(text: string, reply: MessageReply): string {
  if (!validReply(reply)) throw new Error("Invalid reply reference");
  return prefix + JSON.stringify(reply).replace(/</g, "\\u003c") + suffix + text;
}

export function decodeMessageReply(text: string): { text: string; reply?: MessageReply } {
  if (!text.startsWith(prefix)) return { text };
  const end = text.indexOf(suffix, prefix.length);
  if (end < 0 || end > 20_000) return { text };
  try {
    const reply: unknown = JSON.parse(text.slice(prefix.length, end));
    if (!validReply(reply)) return { text };
    return { text: text.slice(end + suffix.length), reply };
  } catch { return { text }; }
}

function textContent(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value.filter(block => block?.type === "text").map(block => String(block.text ?? "")).join("\n");
}

export function replyFromNativeEntry(messageId: string, entry: unknown, user: MessageSender, assistantName: string): MessageReply | null {
  if (!entry || typeof entry !== "object") return null;
  const source = entry as { type?: string; id?: string; timestamp?: string; message?: any; details?: any; content?: unknown };
  const reference = parseMessageReference(messageId);
  if (reference?.transport !== "pi" || source.id !== reference.messageId) return null;
  const message = source.type === "message" ? source.message
    : source.type === "custom_message" ? { role: "user", content: source.content, ...source.details } : null;
  if (!message || !["user", "assistant"].includes(message.role)) return null;
  if (source.type === "custom_message" && !source.details?.sender?.id && !source.details?.identity?.sender?.id) return null;
  const sender = message.identity?.sender ?? message.sender ?? (message.role === "user" ? user : { id: "assistant", name: assistantName });
  if (typeof sender?.id !== "string") return null;
  const plain = decodeMessageReply(textContent(message.content)).text;
  const preview = plain || (Array.isArray(message.content) && message.content.some((block: any) => block?.type === "image") ? "[Image]" : "[Message without text]");
  const timestamp = typeof message.timestamp === "number" ? message.timestamp : Date.parse(source.timestamp ?? "");
  return { messageId, sender: { id: sender.id, ...(typeof sender.name === "string" ? { name: sender.name } : {}) },
    text: preview.length > REPLY_PREVIEW_CHARACTERS ? preview.slice(0, REPLY_PREVIEW_CHARACTERS) + "…" : preview,
    ...(Number.isFinite(timestamp) ? { timestamp } : {}) };
}

export function projectMessageReply(message: Record<string, unknown>): Record<string, unknown> {
  if (message.role !== "user") return message;
  if (typeof message.content === "string") {
    const parsed = decodeMessageReply(message.content);
    return parsed.reply ? { ...message, content: parsed.text, reply: parsed.reply } : message;
  }
  if (!Array.isArray(message.content)) return message;
  const first = message.content.findIndex(block => block?.type === "text");
  if (first < 0) return message;
  const parsed = decodeMessageReply(String(message.content[first].text ?? ""));
  if (!parsed.reply) return message;
  const content = [...message.content];
  content[first] = { ...content[first], text: parsed.text };
  return { ...message, content, reply: parsed.reply };
}

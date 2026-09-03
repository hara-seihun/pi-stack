import { messageFinalizationKey } from "./sync";

type JsonObject = Record<string, unknown>;

export const COMPACTION_CONTINUATION_MESSAGE =
  "your context was compacted, you now have tons of space to keep working as long as you like";
export const COMPACTION_NOTICE_TYPE = "pi-remote-context-compacted";

function object(value: unknown): JsonObject | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : null;
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((value) => object(value))
    .filter((block): block is JsonObject => block?.type === "text")
    .map((block) => String(block.text ?? ""))
    .join("");
}

function isCompactionContinuation(value: unknown): boolean {
  const message = object(value);
  return message?.role === "user" && contentText(message.content) === COMPACTION_CONTINUATION_MESSAGE;
}

function restoreStreamedThinking(message: JsonObject, fallback: string | undefined): JsonObject {
  if (!fallback || !Array.isArray(message.content)) return message;
  const content = [...message.content];
  const thinkingIndex = content.findIndex((value) => object(value)?.type === "thinking");
  if (thinkingIndex < 0) content.unshift({ type: "thinking", thinking: fallback });
  else {
    const thinking = object(content[thinkingIndex]);
    if (thinking && !String(thinking.thinking ?? "")) content[thinkingIndex] = { ...thinking, thinking: fallback };
  }
  return { ...message, content };
}

/** Builds the smaller transcript-only document shared by the browser and Android clients. */
export function displayContextDocument(document: string, streamedThinking: ReadonlyMap<string, string> = new Map()): string {
  const context = JSON.parse(document) as JsonObject;
  const messages = Array.isArray(context.messages) ? context.messages : [];
  const projected = messages.map((value, index) => {
    const source = object(value);
    if (!source) return value;
    if (source.role === "assistant" && source.stopReason === "aborted"
      && isCompactionContinuation(messages[index + 1])) {
      return {
        role: "custom",
        customType: COMPACTION_NOTICE_TYPE,
        content: "Context compacted",
        timestamp: source.timestamp,
      };
    }
    const original = source.role === "assistant"
      ? restoreStreamedThinking(source, streamedThinking.get(messageFinalizationKey(source)))
      : source;
    const message = { ...original };
    if (message.role === "assistant") {
      for (const key of ["api", "provider", "model", "usage", "stopReason", "responseId", "rawStopReason"])
        delete message[key];
      if (Array.isArray(message.content)) message.content = message.content.map((value) => {
        const originalBlock = object(value);
        if (!originalBlock) return value;
        const block = { ...originalBlock };
        if (block.type === "thinking") delete block.thinkingSignature;
        if (block.type === "text") delete block.textSignature;
        return block;
      });
    } else if (message.role === "toolResult") {
      delete message.details;
    }
    return message;
  });
  return JSON.stringify({ ...context, messages: projected });
}

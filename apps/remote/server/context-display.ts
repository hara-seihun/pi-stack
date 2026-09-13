import { messageFinalizationKey } from "./sync";
import { withToolProgress, type ToolProgress } from "./tool-progress";

type JsonObject = Record<string, unknown>;
export interface ContextImage { data: string; mimeType: string }
export type ImageReference = (image: ContextImage) => string;

function object(value: unknown): JsonObject | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : null;
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
export function displayContextDocument(document: string, streamedThinking: ReadonlyMap<string, string> = new Map(), imageReference?: ImageReference, tools: Iterable<ToolProgress> = []): string {
  const context = JSON.parse(document) as JsonObject;
  const messages = withToolProgress(Array.isArray(context.messages) ? context.messages : [], tools);
  const projected = messages.map((value) => {
    const source = object(value);
    if (!source) return value;
    const original = source.role === "assistant"
      ? restoreStreamedThinking(source, streamedThinking.get(messageFinalizationKey(source)))
      : source;
    const message = { ...original };
    if (message.role === "assistant") {
      for (const key of ["api", "provider", "model", "usage", "stopReason", "responseId", "rawStopReason"])
        delete message[key];
      if (Array.isArray(message.content)) message.content = message.content.filter((value) => {
        const block = object(value);
        return block?.type !== "thinking" || String(block.thinking ?? "").trim().length > 0;
      }).map((value) => {
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
    if (imageReference && Array.isArray(message.content)) message.content = message.content.map((value) => {
      const block = object(value);
      if (block?.type !== "image" || typeof block.data !== "string" || typeof block.mimeType !== "string") return value;
      return { type: "image", mimeType: block.mimeType, src: imageReference({ data: block.data, mimeType: block.mimeType }) };
    });
    return message;
  });
  return JSON.stringify({ ...context, messages: projected });
}

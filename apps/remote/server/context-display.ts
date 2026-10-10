import { projectAnthropicNarrationMessage } from "pi-orchestrator/anthropic-narration";
import { projectMessageReply } from "./message-replies";
import type { ResponseMetrics } from "./protocol";

type JsonObject = Record<string, unknown>;
export interface ContextImage { data: string; mimeType: string }
export type ImageReference = (image: ContextImage) => string;

function object(value: unknown): JsonObject | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : null;
}

/** The page and full-download paths use the same per-record projection. */
export function displayContextMessage(value: unknown, imageReference?: ImageReference, metrics?: ResponseMetrics): unknown {
  const source = object(value);
  if (!source) return value;
  const original = source.role === "assistant" ? projectAnthropicNarrationMessage(source) : source;
  const message = { ...projectMessageReply(original) };
  if (message.role === "assistant") {
    for (const key of ["api", "provider", "model", "usage", "stopReason", "responseId", "rawStopReason"]) delete message[key];
    if (metrics) message.responseMetrics = metrics;
    if (Array.isArray(message.content)) message.content = message.content.filter(value => {
      const block = object(value);
      return block?.type !== "thinking" || String(block.thinking ?? "").trim().length > 0;
    }).map(value => {
      const originalBlock = object(value);
      if (!originalBlock) return value;
      const block = { ...originalBlock };
      if (block.type === "thinking") delete block.thinkingSignature;
      if (block.type === "text") delete block.textSignature;
      return block;
    });
  } else if (message.role === "toolResult") delete message.details;
  if (imageReference && Array.isArray(message.content)) message.content = message.content.map(value => {
    const block = object(value);
    if (block?.type !== "image" || typeof block.data !== "string" || typeof block.mimeType !== "string") return value;
    return { type: "image", mimeType: block.mimeType, src: imageReference({ data: block.data, mimeType: block.mimeType }) };
  });
  return message;
}

import { projectAnthropicNarrationMessage } from "./anthropic-narration.mjs";

export const SILENT_TURN_TEXT = "<silent/>";

export function assistantText(message) {
  if (!message || message.role !== "assistant") return "";
  const content = projectAnthropicNarrationMessage(message).content;
  return typeof content === "string" ? content : Array.isArray(content)
    ? content.filter(block => block.type === "text" && typeof block.text === "string").map(block => block.text).join("\n") : "";
}

export function isSilentAssistant(message) {
  return assistantText(message) === SILENT_TURN_TEXT;
}

/** Hold only the ambiguous prefix; a completed non-sentinel prefix is ordinary text. */
export function managerLiveText(text, complete = false) {
  return text === SILENT_TURN_TEXT || !complete && SILENT_TURN_TEXT.startsWith(text) ? "" : text;
}

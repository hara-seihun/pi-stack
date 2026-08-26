type JsonObject = Record<string, unknown>;

function object(value: unknown): JsonObject | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : null;
}

/** Removes provider continuation metadata that no transcript renderer displays. */
export function displayContextDocument(document: string): string {
  const context = JSON.parse(document) as JsonObject;
  const messages = Array.isArray(context.messages) ? context.messages : [];
  const projected = messages.map((value) => {
    const original = object(value);
    if (!original) return value;
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

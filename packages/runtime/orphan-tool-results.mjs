export function projectOrphanToolResults(messages) {
  const result = [];
  let pending = new Set();
  let receipts = [];
  const flush = () => {
    result.push(...receipts);
    receipts = [];
    pending = new Set();
  };
  for (const message of messages) {
    if (message.role === "toolResult") {
      if (pending.delete(message.toolCallId)) result.push(message);
      else receipts.push({
        role: "user",
        content: [{ type: "text", text: `[Historical tool receipt: ${message.toolName}; call ${message.toolCallId}; ${message.isError ? "error" : "success"}. The originating call is not replayable in this context. This is preserved evidence, not a new request to execute the tool.]` }, ...message.content],
        timestamp: message.timestamp,
      });
    } else if (message.role === "system") {
      result.push(message);
    } else if (message.role === "assistant" && (message.stopReason === "error" || message.stopReason === "aborted")) {
      flush();
      result.push(message);
    } else {
      flush();
      result.push(message);
      if (message.role === "assistant") pending = new Set(message.content.filter(block => block.type === "toolCall").map(block => block.id));
    }
  }
  flush();
  return result;
}

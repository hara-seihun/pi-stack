export interface ToolProgress {
  id: string;
  name: string;
  args: unknown;
  startedAt: number;
  observedStart?: boolean;
  output: string;
  result?: { content: Array<{ type: "text"; text: string }>; timestamp: number; isError: boolean };
}

const OUTPUT_LIMIT = 20_000;
export function updateToolProgress(tool: ToolProgress, output: string): ToolProgress {
  return { ...tool, output: output.length > OUTPUT_LIMIT ? `…${output.slice(-OUTPUT_LIMIT)}` : output };
}

/** Overlay execution events until the canonical context contains their results. */
export function withToolProgress(messages: any[], tools: Iterable<ToolProgress>): any[] {
  const pending = new Map([...tools].map(tool => [tool.id, tool]));
  for (const message of messages) if (message?.role === "toolResult") pending.delete(message.toolCallId);
  const seen = new Set<string>();
  const result = messages.map(message => {
    if (message?.role !== "assistant" || !Array.isArray(message.content)) return message;
    const content = message.content.map((block: any) => {
      const tool = block?.type === "toolCall" ? pending.get(block.id) : undefined;
      if (!tool) return block;
      seen.add(tool.id);
      return { ...block, partialOutput: tool.output, ...(tool.observedStart ? { observedStart: true } : {}) };
    });
    return { ...message, content };
  });
  for (const tool of pending.values()) {
    if (!seen.has(tool.id)) result.push({ role: "assistant", timestamp: tool.startedAt, content: [{
      type: "toolCall", id: tool.id, name: tool.name, arguments: tool.args, partialOutput: tool.output,
      ...(tool.observedStart ? { observedStart: true } : {}),
    }] });
    if (tool.result) result.push({ role: "toolResult", toolCallId: tool.id, toolName: tool.name, ...tool.result });
  }
  return result;
}

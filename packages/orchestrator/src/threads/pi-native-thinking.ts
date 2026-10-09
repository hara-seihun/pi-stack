import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { ThinkingContent } from "@earendil-works/pi-ai";

export function retainNativeThinking(session: AgentSession): void {
  const thinking = new Map<number, ThinkingContent>();
  session.subscribe(event => {
    if (event.type === "message_start" && event.message.role === "assistant") thinking.clear();
    if (event.type === "message_update") {
      const update = event.assistantMessageEvent;
      if (update.type === "thinking_delta" || update.type === "thinking_end") {
        const block = update.partial.content[update.contentIndex];
        if (block?.type === "thinking") {
          const previous = thinking.get(update.contentIndex);
          const text = block.thinking || (update.type === "thinking_delta" ? (previous?.thinking ?? "") + update.delta : update.content || previous?.thinking || "");
          thinking.set(update.contentIndex, { ...previous, ...block, thinking: text });
        }
      }
    }
    if (event.type !== "message_end" || event.message.role !== "assistant") return;
    // SDK listeners run before native appendMessage and share the finalized agent object.
    const hasFinalThinking = event.message.content.some(block => block.type === "thinking" && (block.thinking || block.redacted));
    for (const [index, streamed] of thinking) {
      if (!streamed.thinking) continue;
      const final = event.message.content[index];
      if (final?.type === "thinking") {
        if (!final.thinking && !final.redacted) event.message.content[index] = { ...streamed, ...final, thinking: streamed.thinking };
      } else if (!hasFinalThinking) {
        event.message.content.splice(index, 0, streamed);
      }
    }
    thinking.clear();
  });
}

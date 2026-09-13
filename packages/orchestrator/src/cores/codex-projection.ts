import type { CoreOutput, PortableConversation } from "./contracts.js";
import type { ThreadItem } from "./codex-protocol/v2/ThreadItem.js";
import type { Turn } from "./codex-protocol/v2/Turn.js";
import type { UserInput } from "./codex-protocol/v2/UserInput.js";

export type Message = Record<string, unknown> & { id: string; role: string; content: Record<string, unknown>[]; timestamp: number };
export type Entry = { id: string; parentId: string | null; type: "message"; timestamp: string; message: Message; nativeTurnId: string };
const text = (value: string) => ({ type: "text", text: value });
export function portableInput(input: UserInput[]): Record<string, unknown>[] {
  return input.map(item => {
    switch (item.type) {
      case "text": return text(item.text);
      case "image": return { type: "image", url: item.url };
      case "localImage": return { type: "image", path: item.path };
      case "audio": return { type: "audio", url: item.url };
      case "localAudio": return { type: "audio", path: item.path };
      case "skill": case "mention": return { type: item.type, name: item.name, path: item.path };
    }
  });
}
export function toolName(item: ThreadItem): string | undefined {
  switch (item.type) {
    case "commandExecution": return "exec_command";
    case "fileChange": return "apply_patch";
    case "mcpToolCall": return `${item.server}/${item.tool}`;
    case "dynamicToolCall": case "collabAgentToolCall": return item.tool;
    case "webSearch": return "web_search";
    case "imageView": return "view_image";
    case "imageGeneration": return "image_generation";
    case "sleep": return "sleep";
    default: return undefined;
  }
}
function toolArgs(item: ThreadItem): unknown {
  switch (item.type) {
    case "commandExecution": return { command: item.command, cwd: item.cwd };
    case "fileChange": return { changes: item.changes };
    case "mcpToolCall": case "dynamicToolCall": return item.arguments;
    case "collabAgentToolCall": return { prompt: item.prompt, receiverThreadIds: item.receiverThreadIds, model: item.model, reasoningEffort: item.reasoningEffort };
    default: return { ...item };
  }
}
function toolResult(item: ThreadItem): { content: Record<string, unknown>[]; isError: boolean } {
  if (item.type === "commandExecution") return { content: [text(item.aggregatedOutput ?? "")], isError: item.status === "failed" || (item.exitCode !== null && item.exitCode !== 0) };
  if (item.type === "mcpToolCall") return { content: [text(JSON.stringify(item.result ?? item.error))], isError: item.error !== null || item.status === "failed" };
  return { content: [text(JSON.stringify(item))], isError: "status" in item && (item.status === "failed" || item.status === "declined") };
}
export class CodexProjection {
  readonly entries: Entry[] = [];
  private readonly tools = new Set<string>();
  private readonly live = new Map<string, Message>();
  constructor(private readonly model: () => string, private readonly emit: (event: CoreOutput) => void,
    private readonly stamp: (id: string, suggested?: number) => number,
    private readonly provider: () => string = () => "openai-codex") {}

  liveState() {
    const blocks = [...this.live.values()].flatMap(message => message.content);
    return {
      text: blocks.filter(block => block.type === "text").map(block => String(block.text ?? "")).join("\n"),
      thinking: blocks.filter(block => block.type === "thinking").map(block => String(block.thinking ?? "")).join("\n"),
      isThinking: blocks.some(block => block.type === "thinking"),
      tools: blocks.filter(block => block.type === "toolCall").map(block => ({
        toolCallId: String(block.id), toolName: String(block.name), args: block.arguments,
      })),
    };
  }

  clearLive() { this.live.clear(); }

  context() {
    this.emit({ type: "context_update", projection: "activity", core: "codex", context: {
      systemPrompt: "", tools: [...this.tools].map(name => ({ name, activityOnly: true })),
      messages: this.entries.map(entry => entry.message),
    } });
  }
  private message(item: ThreadItem, turnId: string, suggested?: number): Message | undefined {
    const base = { id: item.id, timestamp: this.stamp(item.id, suggested), nativeTurnId: turnId };
    const assistant = { ...base, role: "assistant", provider: this.provider(), model: this.model(), api: "codex-app-server", stopReason: "stop" };
    switch (item.type) {
      case "userMessage": return { ...base, role: "user", content: portableInput(item.content) };
      case "agentMessage": case "plan": return { ...assistant, content: [text(item.text)] };
      case "reasoning": return { ...assistant, content: [{ type: "thinking", thinking: (item.summary.length ? item.summary : item.content).join("\n") }] };
      case "hookPrompt": return { ...base, role: "custom", content: [text(JSON.stringify(item.fragments))] };
      case "enteredReviewMode": case "exitedReviewMode": return { ...base, role: "custom", content: [text(item.review)] };
      default: {
        const name = toolName(item);
        if (!name) return undefined;
        this.tools.add(name);
        return { ...assistant, stopReason: "toolUse", content: [{ type: "toolCall", id: item.id, name, arguments: toolArgs(item) }] };
      }
    }
  }
  private append(message: Message, turnId: string) {
    const existing = this.entries.findIndex(entry => entry.id === message.id);
    if (existing >= 0) { this.entries[existing].message = message; return; }
    this.entries.push({ id: message.id, parentId: this.entries.at(-1)?.id ?? null, type: "message",
      timestamp: new Date(message.timestamp).toISOString(), message, nativeTurnId: turnId });
  }
  item(item: ThreadItem, turnId: string, completed: boolean, emit = true, suggested?: number) {
    const message = this.message(item, turnId, suggested);
    if (!message) return;
    const name = toolName(item);
    if (!completed) {
      this.live.set(item.id, message);
      if (emit) {
        this.emit({ type: "message_start", message });
        if (name) this.emit({ type: "tool_execution_start", toolCallId: item.id, toolName: name, args: toolArgs(item) });
        if (item.type === "reasoning") this.emit({ type: "message_update", message, assistantMessageEvent: { type: "thinking_start", contentIndex: 0 } });
      }
      return;
    }
    const streamed = this.live.get(item.id);
    this.live.delete(item.id);
    if (streamed) for (const [index, block] of message.content.entries()) {
      const key = block.type === "thinking" ? "thinking" : block.type === "text" ? "text" : undefined;
      if (key && !block[key] && streamed.content[index]?.type === block.type) block[key] = streamed.content[index][key];
    }
    if (item.type === "reasoning") {
      const content = String(message.content[0]?.thinking ?? "");
      if (emit) this.emit({ type: "message_update", message, assistantMessageEvent: { type: "thinking_end", contentIndex: 0, content } });
      if (!content.trim()) return;
    }
    this.append(message, turnId);
    if (emit) { this.emit({ type: "message_end", message }); this.context(); }
    if (name) {
      const result = toolResult(item);
      const toolMessage: Message = { id: `${item.id}:result`, role: "toolResult", toolCallId: item.id, toolName: name,
        content: result.content, isError: result.isError, timestamp: this.stamp(`${item.id}:result`, suggested) };
      this.append(toolMessage, turnId);
      if (emit) {
        this.emit({ type: "tool_execution_end", toolCallId: item.id, toolName: name, result: { content: result.content }, isError: result.isError });
        this.emit({ type: "message_end", message: toolMessage });
        this.context();
      }
    }
  }
  delta(id: string, delta: string, thinking: boolean) {
    const message = this.live.get(id);
    if (!message) return;
    const block = message.content[0];
    const key = thinking ? "thinking" : "text";
    block[key] = String(block[key] ?? "") + delta;
    this.emit({ type: "message_update", message, assistantMessageEvent: { type: thinking ? "thinking_delta" : "text_delta", contentIndex: 0, delta } });
  }
  finish(turn: Turn, emit = true) {
    if (turn.status !== "inProgress") this.clearLive();
    if (turn.status !== "failed" && turn.status !== "interrupted") return;
    const id = `${turn.id}:failure`;
    const message: Message = { id, role: "assistant", content: [], timestamp: this.stamp(id), model: this.model(), provider: this.provider(),
      stopReason: turn.status === "interrupted" ? "aborted" : "error", errorMessage: turn.error?.message ?? "Codex turn interrupted" };
    this.append(message, turn.id);
    if (emit) { this.emit({ type: "message_end", message }); this.context(); }
  }
  restore(turns: Turn[], transferred: Record<string, unknown>[] = []) {
    this.entries.length = 0; this.tools.clear(); this.live.clear();
    for (const [index, source] of transferred.entries()) {
      const id = typeof source.id === "string" ? source.id : `transfer:${index}`;
      const message: Message = { ...source, id, role: typeof source.role === "string" ? source.role : "custom",
        content: Array.isArray(source.content) ? source.content : [text(String(source.content ?? ""))],
        timestamp: this.stamp(id, typeof source.timestamp === "number" ? source.timestamp : undefined) };
      this.append(message, "transfer");
    }
    for (const turn of turns) {
      for (const [index, item] of turn.items.entries()) {
        const completed = turn.status !== "inProgress" || !("status" in item) || item.status !== "inProgress";
        this.item(item, turn.id, completed, false, (turn.startedAt ?? 0) * 1000 + index);
      }
      this.finish(turn, false);
    }
  }
}

/** Imported content stays conversation data. It never becomes system/developer instructions. */
export function transferItems(transfer: PortableConversation): Record<string, unknown>[] {
  if (transfer.version !== 1) throw new Error("Unsupported Codex transfer version");
  return transfer.messages.map(message => {
    const role = message.role === "assistant" ? "assistant" : "user";
    const content = Array.isArray(message.content) ? message.content : [{ type: "text", text: String(message.content ?? "") }];
    // Tool results and non-text blocks retain their structure as attributed data, not executable calls.
    const plain = (message.role === "user" || message.role === "assistant") && content.every(block => block?.type === "text");
    return { type: "message", role, content: [{ type: role === "assistant" ? "output_text" : "input_text",
      text: plain ? content.map(block => block.text).join("\n") : JSON.stringify({ sourceCore: transfer.sourceCore, message }) }] };
  });
}

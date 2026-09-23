// Transcript items are the delivery form of Pi's model context. The supervisor
// derives them from the display projection (`context-display.ts`), so the
// assistant 👍 substitution, the restored streamed thinking and the running
// tool overlay are already in place and nothing is added here.
//
// One item is one slice of the context: the system prompt, one tool schema,
// one user message, one assistant content block, one thinking block, or one
// tool call together with its result. A head is small enough to travel on the
// stream; the body carries the complete slice and is fetched by content hash.
//
// Item order and pairing follow what the client used to compute in the browser
// from the whole document, so a rendered transcript keeps its shape.

import { AGENT_NAME } from "./agent-identity";
import { sha256 } from "./sync";
import { isResponseMetrics } from "./response-metrics";
import type { ToolCallResultHead, TranscriptItemBody, TranscriptItemHead } from "./protocol";

/** Collapsed rows show this much of a lazily fetched item. */
export const PREVIEW_CHARACTERS = 120;
/** Shown in an opened step only until its body arrives. */
export const RESULT_PREVIEW_CHARACTERS = 80;
/** Longer strings inside tool-call arguments travel only in the body. */
export const ARGUMENT_STRING_LIMIT = 120;
/** Arrays inside tool-call arguments keep this many leading entries in the head. */
export const ARGUMENT_ARRAY_LIMIT = 5;
/** A running tool's partial output rides on the head only to this tail length. */
export const PARTIAL_OUTPUT_LIMIT = 4_000;
/** The newest window carries the body of its last item inline when it is at most this large. */
export const INLINE_BODY_LIMIT = 8_000;
/** How many trailing items the newest window carries. */
export const WINDOW_ITEMS = 120;
/** Derived lists kept in memory, newest use last. */
const CACHED_SESSIONS = 4;

export interface DerivedItem {
  /** Identity of the slice, independent of its content. Generations compare these. */
  key: string;
  head: TranscriptItemHead;
  /** The body exactly as `GET /v1/sessions/:sessionId/items/:itemId` returns it. */
  body: string;
}

function formatJson(value: unknown): string {
  try { return JSON.stringify(value ?? {}, null, 2); }
  catch { return String(value ?? ""); }
}

function fenced(value: unknown, language = "json"): string {
  const text = String(value ?? "");
  const longest = Math.max(2, ...[...text.matchAll(/`+/g)].map((match) => match[0].length));
  const fence = "`".repeat(longest + 1);
  return `${fence}${language}\n${text}\n${fence}`;
}

function imageMarkdown(block: any): string {
  const source = typeof block.src === "string" && block.src
    ? block.src
    : typeof block.data === "string" && block.data ? `data:${block.mimeType};base64,${block.data}` : "";
  return source ? `![Context image](${source})` : `*Image · ${String(block.mimeType || "application/octet-stream")}*`;
}

/** The text the client renders for a message's content, one block or all of them. */
export function contentMarkdown(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return fenced(formatJson(content));
  return content.map((block: any) => {
    if (!block || typeof block !== "object") return fenced(formatJson(block));
    if (block.type === "text") return String(block.text || "");
    if (block.type === "thinking") return `*Thinking*\n\n${String(block.thinking || "")}`;
    if (block.type === "image") return imageMarkdown(block);
    if (block.type === "toolCall") {
      const namespace = block.namespace ? `${block.namespace}.` : "";
      return `**Tool call · ${namespace}${String(block.name || "tool")}**\n\n${fenced(formatJson(block.arguments))}`;
    }
    return fenced(formatJson(block));
  }).filter(Boolean).join("\n\n");
}

function preview(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit)}…`;
}

/**
 * Arguments as the collapsed row needs them: what `toolSummary` reads to name
 * the step, with long strings cut, long arrays shortened and the fields that
 * are bodies rather than names (a written file, an edit's old and new text, a
 * delegated task's message) left to the body. `truncated` says the body has
 * more.
 */
export function boundedArguments(value: unknown, limit = ARGUMENT_STRING_LIMIT, name = ""): { value: unknown; truncated: boolean } {
  let truncated = false;
  const walk = (input: unknown, depth: number): unknown => {
    if (typeof input === "string") {
      if (input.length <= limit) return input;
      truncated = true;
      return `${input.slice(0, limit)}…`;
    }
    if (Array.isArray(input)) {
      if (input.length > ARGUMENT_ARRAY_LIMIT) truncated = true;
      return input.slice(0, ARGUMENT_ARRAY_LIMIT).map((entry) => walk(entry, depth + 1));
    }
    if (input && typeof input === "object") {
      if (depth >= 2) { truncated = true; return {}; }
      return Object.fromEntries(Object.entries(input as Record<string, unknown>).map(([key, entry]) => [key, walk(entry, depth + 1)]));
    }
    return input;
  };
  const tool = name.toLowerCase().replace(/^functions\./, "");
  let source = value;
  if (source && typeof source === "object" && !Array.isArray(source)) {
    const record = { ...(source as Record<string, unknown>) };
    const drop = (key: string) => { if (key in record) { delete record[key]; truncated = true; } };
    if (tool === "write") drop("content");
    if (tool === "edit" && Array.isArray(record.edits)) { record.editCount = record.edits.length; drop("edits"); }
    if (tool.startsWith("thread_")) { drop("message"); drop("text"); }
    source = record;
  }
  return { value: walk(source, 0), truncated };
}

function outputTail(output: string): string {
  return output.length <= PARTIAL_OUTPUT_LIMIT ? output : `…${output.slice(-PARTIAL_OUTPUT_LIMIT)}`;
}

function imageCount(content: unknown): number {
  return Array.isArray(content) ? content.filter((block: any) => block?.type === "image").length : 0;
}

function resultHead(result: any): ToolCallResultHead {
  const text = contentMarkdown(result?.content);
  return {
    isError: Boolean(result?.isError),
    size: Buffer.byteLength(JSON.stringify(result?.content ?? null)),
    ...(Number(result?.timestamp) ? { timestamp: Number(result.timestamp) } : {}),
    preview: preview(text, RESULT_PREVIEW_CHARACTERS),
    imageCount: imageCount(result?.content),
  };
}

type DistributiveOmit<T, K extends keyof any> = T extends unknown ? Omit<T, K> : never;
type PartialHead = DistributiveOmit<TranscriptItemHead, "seq" | "id" | "size">;

/** Ordered items of one captured display context. */
export function deriveTranscriptItems(context: any): DerivedItem[] {
  const items: DerivedItem[] = [];
  const add = (key: string, head: PartialHead, body: TranscriptItemBody) => {
    const encoded = JSON.stringify(body);
    items.push({
      key,
      body: encoded,
      head: { ...head, seq: items.length, id: sha256(encoded), size: Buffer.byteLength(encoded) } as TranscriptItemHead,
    });
  };
  const lazy = (kind: "system" | "tool" | "thinking", key: string, label: string, text: string, timestamp?: number) =>
    add(key, { kind, label, preview: preview(text, PREVIEW_CHARACTERS), ...(timestamp ? { timestamp } : {}) }, { kind, text });
  const inline = (kind: "user" | "assistant" | "notice", key: string, label: string, text: string, timestamp?: number) =>
    add(key, { kind, label, text, ...(timestamp ? { timestamp } : {}) }, { kind, text });
  // How fast the response arrived belongs to the whole assistant message, so it
  // rides on the last item that message produced: its closing text for an
  // ordinary answer, its last tool call for a turn that only called tools.
  const attachResponseMetrics = (message: any, from: number) => {
    const metrics = message?.responseMetrics;
    if (items.length > from && isResponseMetrics(metrics)) items.at(-1)!.head.responseMetrics = metrics;
  };

  const attachIdentity = (message: any, from: number) => {
    if (!message.identity?.id) return;
    for (let i = items.length - 1; i >= from; i--) {
      const head = items[i]!.head;
      if (head.kind !== "user" && head.kind !== "assistant") continue;
      head.identity = message.identity;
      head.reactions = message.reactions ?? [];
      head.label = message.identity.sender.name || message.identity.sender.id;
      break;
    }
  };

  if (!context) return items;
  lazy("system", "system", "System", String(context.systemPrompt || ""));
  for (const tool of (context.tools || []) as any[]) {
    const name = String(tool?.name || "tool");
    lazy("tool", `tool:${name}`, `Tool · ${name}`, `${String(tool?.description || "")}\n\n${fenced(formatJson(tool?.parameters))}`.trim());
  }

  const messages: any[] = Array.isArray(context.messages) ? context.messages : [];
  const results = new Map(messages.filter((message) => message?.role === "toolResult")
    .map((message) => [String(message.toolCallId || ""), message]));
  const paired = new Set<any>();
  for (const [messageIndex, message] of messages.entries()) {
    const role = String(message?.role || "message");
    const stamp = Number(message?.timestamp) || 0;
    const identity = message?.timestamp || messageIndex;
    const itemsBefore = items.length;
    if (role === "assistant" && Array.isArray(message.content)) {
      for (const [blockIndex, block] of message.content.entries()) {
        if (block?.type === "toolCall") {
          const result = results.get(String(block.id || ""));
          if (result) paired.add(result);
          const callId = String(block.id || `${identity}:${blockIndex}`);
          const name = `${block.namespace ? `${block.namespace}.` : ""}${String(block.name || "tool")}`;
          const args = boundedArguments(block.arguments, ARGUMENT_STRING_LIMIT, String(block.name || ""));
          add(`toolCall:${callId}`, {
            kind: "toolCall",
            callId,
            name,
            arguments: args.value,
            argumentsTruncated: args.truncated,
            ...(typeof block.partialOutput === "string" ? { partialOutput: outputTail(block.partialOutput) } : {}),
            ...(result ? { result: resultHead(result) } : {}),
            ...(stamp ? { timestamp: stamp } : {}),
          }, {
            kind: "toolCall",
            arguments: block.arguments ?? null,
            result: result
              ? { content: result.content ?? null, isError: Boolean(result.isError), ...(Number(result.timestamp) ? { timestamp: Number(result.timestamp) } : {}) }
              : null,
          });
        } else if (block?.type === "thinking") {
          if (String(block.thinking || "").trim()) {
            lazy("thinking", `thinking:${identity}:${blockIndex}`, "Thinking", String(block.thinking), stamp);
          }
        } else {
          inline("assistant", `assistant:${identity}:${blockIndex}`, AGENT_NAME, contentMarkdown([block]), stamp);
        }
      }
      if (message.content.length === 0 && message.errorMessage) {
        inline("notice", `notice:assistant:${identity}`, `${AGENT_NAME} error`, String(message.errorMessage), stamp);
      }
      attachResponseMetrics(message, itemsBefore);
      attachIdentity(message, itemsBefore);
      continue;
    }
    if (role === "toolResult" && paired.has(message)) continue;
    const text = contentMarkdown(message?.content);
    if (role === "user") inline("user", `user:${identity}`, "User", text, stamp);
    else if (role === "assistant") {
      inline("assistant", `assistant:${identity}`, AGENT_NAME, text, stamp);
      attachResponseMetrics(message, itemsBefore);
    }
    else if (role === "toolResult") {
      const label = `Tool result · ${String(message.toolName || "tool")}`;
      const key = `toolResult:${String(message.toolCallId || identity)}`;
      if (message?.isError) inline("notice", `notice:${key}`, label, text, stamp);
      else lazy("tool", key, label, text, stamp);
    } else lazy("tool", `message:${role}:${identity}`, role, text, stamp);
    attachIdentity(message, itemsBefore);
  }
  return items;
}

/** The last item's head with its body inline when small: it is the step the
 * client opens first, so this saves the round trip that would follow. */
export function withInlineBody(item: DerivedItem): TranscriptItemHead {
  if (item.head.size > INLINE_BODY_LIMIT) return item.head;
  return { ...item.head, body: JSON.parse(item.body) } as TranscriptItemHead;
}

/** The newest window: the leading system and tool schemas, then the last items. */
export function transcriptWindow(items: DerivedItem[], limit = WINDOW_ITEMS): TranscriptItemHead[] {
  let prefix = 0;
  while (prefix < items.length && (items[prefix].head.kind === "system" || items[prefix].head.kind === "tool")) prefix++;
  const start = Math.max(prefix, items.length - limit);
  const heads = [...items.slice(0, prefix), ...items.slice(start)].map((item) => item.head);
  if (items.length > prefix) heads[heads.length - 1] = withInlineBody(items[items.length - 1]);
  return heads;
}

/** Older heads for `GET /v1/sessions/:sessionId/transcript`. */
export function transcriptPage(items: DerivedItem[], before: number, limit: number): TranscriptItemHead[] {
  return items.filter((item) => item.head.seq < before).slice(-Math.max(1, limit)).map((item) => item.head);
}

export interface TranscriptGeneration {
  sessionId: string;
  /** Hash of the display document these items came from. */
  sourceHash: string;
  generation: string;
  items: DerivedItem[];
  bodies: Map<string, string>;
}

export interface TranscriptUpdate {
  current: TranscriptGeneration;
  /** The previous list's identities did not survive: clients reload their window. */
  reset: boolean;
  /** Items that are new or whose content changed inside the same generation. */
  changed: TranscriptItemHead[];
}

/**
 * Derived lists per session, with the generation identity that tells a client
 * whether it can keep what it already holds. A capture that keeps every earlier
 * item's identity extends the generation; compaction, a fork or tree navigation
 * replaces it.
 */
export class TranscriptItems {
  private readonly cache = new Map<string, TranscriptGeneration>();

  constructor(private readonly limit = CACHED_SESSIONS, private readonly mintGeneration: () => string = () => crypto.randomUUID()) {}

  derive(sessionId: string, sourceHash: string, load: () => unknown): TranscriptUpdate {
    const previous = this.cache.get(sessionId);
    if (previous?.sourceHash === sourceHash) {
      this.touch(sessionId, previous);
      return { current: previous, reset: false, changed: [] };
    }
    const items = deriveTranscriptItems(load());
    const extended = Boolean(previous) && previous!.items.length <= items.length
      && previous!.items.every((item, index) => item.key === items[index].key);
    const current: TranscriptGeneration = {
      sessionId,
      sourceHash,
      generation: extended ? previous!.generation : this.mintGeneration(),
      items,
      bodies: new Map(items.map((item) => [item.head.id, item.body])),
    };
    this.touch(sessionId, current);
    // The newest item is the step a client opens first; a small body rides along.
    // Heads are compared whole: a running tool's partial output and a response's
    // speed change the head while its body hash stays the same.
    const changed = extended
      ? items.filter((item, index) => index >= previous!.items.length
        || JSON.stringify(item.head) !== JSON.stringify(previous!.items[index].head))
        .map((item) => item === items.at(-1) ? withInlineBody(item) : item.head)
      : [];
    return { current, reset: !extended, changed };
  }

  get(sessionId: string): TranscriptGeneration | null {
    return this.cache.get(sessionId) ?? null;
  }

  forget(sessionId: string) {
    this.cache.delete(sessionId);
  }

  private touch(sessionId: string, entry: TranscriptGeneration) {
    this.cache.delete(sessionId);
    this.cache.set(sessionId, entry);
    while (this.cache.size > this.limit) this.cache.delete(this.cache.keys().next().value!);
  }
}

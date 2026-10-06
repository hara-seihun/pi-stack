import { createHash } from "node:crypto";
import type { CompletionOutcome, CompletionRecord } from "pi-orchestrator/api";

export const THREAD_NAMING_INSTRUCTION = "This is a thread. Please make a title for this thread that, in one to three words, summarises what the thread is about";
export const THREAD_NAMING_INTERVAL = 20;
export const THREAD_NAMING_HISTORY = 12;

// A local engine prefills at roughly 150 tokens per second, so its prompt stays tiny: a one-line
// instruction, the opening request and the two latest messages, each cut short.
export const LOCAL_THREAD_NAMING_INSTRUCTION = "Title this chat in 1-3 words. Output only the title.";
export const LOCAL_THREAD_NAMING_FIRST_CHARS = 600;
export const LOCAL_THREAD_NAMING_RECENT_CHARS = 300;
export const LOCAL_THREAD_NAMING_MAX_TOKENS = 16;
export const LOCAL_THREAD_NAMING_MAX_BYTES = 1400;

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
export type ThreadNamingSelection =
  | { kind: "completion"; model: string; thinkingLevel?: ThinkingLevel }
  | { kind: "local"; engine: string; model: string; thinkingLevel: ThinkingLevel };

const THINKING = "(?:off|minimal|low|medium|high|xhigh|max)";
const COMPLETION = new RegExp(`^(?:openai|openai-codex)(?:-\\d+)?/([^/:\\s]+):(${THINKING})$`);
const LOCAL = new RegExp(`^local/([a-z][a-z0-9-]*)/([^/:\\s]+)(?::(${THINKING}))?$`);
const SHAPE = "PI_REMOTE_THREAD_NAMING_MODEL must name an OpenAI model as openai/MODEL:THINKING or openai-codex/MODEL:THINKING (numbered account aliases are supported), or a local engine from ~/.pi/agent/local-models.json as local/ENGINE/MODEL[:THINKING]";

export function parseThreadNamingModel(value: string | undefined): ThreadNamingSelection {
  const selection = value?.trim() ?? "";
  const local = LOCAL.exec(selection);
  if (local) return { kind: "local", engine: local[1]!, model: local[2]!, thinkingLevel: (local[3] as ThinkingLevel | undefined) ?? "off" };
  const completion = COMPLETION.exec(selection);
  if (completion) return { kind: "completion", model: completion[1]!, thinkingLevel: completion[2] as ThinkingLevel };
  throw new Error(SHAPE);
}

export function threadNamingModel(value: string | undefined): string {
  parseThreadNamingModel(value);
  return value!.trim();
}

/** The `reasoning_effort` an OpenAI-compatible local engine receives; `off` and `minimal` disable thinking. */
export function localReasoningEffort(level: ThinkingLevel): "none" | "low" | "medium" | "xhigh" {
  return level === "off" || level === "minimal" ? "none" : level === "low" || level === "medium" ? level : "xhigh";
}

export interface NamingMessage { role: "user" | "assistant"; text: string }
const cut = (text: string, chars: number) => text.replace(/\s+/g, " ").trim().slice(0, chars);
const line = (message: NamingMessage, chars: number) => `${message.role === "user" ? "User" : "Agent"}: ${cut(message.text, chars)}`;

/** Oldest-first messages become the short prompt a local engine can prefill in a couple of seconds. */
export function localNamingPrompt(messages: NamingMessage[]): string {
  const first = messages.findIndex((message) => message.role === "user");
  const opening = first >= 0 ? messages[first]! : messages[0];
  if (!opening) return "";
  const recent = messages.slice(Math.max(first + 1, messages.length - 2)).filter((message) => message !== opening);
  const prompt = [line(opening, LOCAL_THREAD_NAMING_FIRST_CHARS), ...recent.map((message) => line(message, LOCAL_THREAD_NAMING_RECENT_CHARS))].join("\n");
  let bytes = 0;
  let result = "";
  for (const character of prompt) {
    const size = Buffer.byteLength(character);
    if (bytes + size > LOCAL_THREAD_NAMING_MAX_BYTES) break;
    result += character;
    bytes += size;
  }
  return result;
}

/** Oldest-first messages become the completion prompt. */
export function namingTranscript(messages: NamingMessage[], chars = 3_000): string {
  return messages.map((message) => `${message.role === "user" ? "User" : "Agent"}: ${message.text.slice(0, chars)}`).join("\n\n");
}

/** The request ID carries its input's digest, so one ID can only ever mean one prompt. A thread
 * whose mirror filled in between attempts submits a new request instead of conflicting with the
 * ID it already used. */
export function namingRequestId(sessionId: string, messageCount: number, input: unknown, attempt = 0): string {
  return `remote-name:${sessionId}:${messageCount}:${createHash("sha256").update(JSON.stringify(input)).digest("hex").slice(0, 12)}${attempt ? `:${attempt}` : ""}`;
}

export class NamingConfigurationError extends Error {}

export const THREAD_NAMING_RETRY_DELAYS = [30_000, 120_000] as const;
export function namingRetryAt(failures: number, now: number, required = false): number | null {
  const delay = THREAD_NAMING_RETRY_DELAYS[failures - 1];
  return required || delay === undefined ? null : now + delay;
}

export type NamingOutcome =
  | { kind: "pending" }
  | { kind: "title"; text: string }
  | { kind: "failed"; message: string; keepReceipt: boolean; recovery: "automatic" | "required" };

/** Terminal receipts cannot recover through polling. Transport failures retain their receipt;
 * retryable terminal attempts need a fresh ID, while unsupported inputs need a configuration repair. */
export function namingOutcome(result: CompletionOutcome<CompletionRecord>): NamingOutcome {
  if (!result.ok) {
    const required = ["invalid-request", "unsupported-option", "invalid-state"].includes(result.error.code);
    return { kind: "failed", message: result.error.message, keepReceipt: !required && result.error.code !== "request-conflict", recovery: required ? "required" : "automatic" };
  }
  const record = result.value;
  if (record.state === "queued" || record.state === "running") return { kind: "pending" };
  if (record.state === "completed") return { kind: "title", text: record.result.text };
  const required = "error" in record && ["invalid-request", "unsupported-option", "invalid-state"].includes(record.error.code);
  return { kind: "failed", message: "error" in record ? record.error.message : `Completion ${record.state}.`, keepReceipt: false, recovery: required ? "required" : "automatic" };
}

export interface ThreadNamingView { name: string; titleSource?: unknown; messageCount: number; namedAtMessageCount: number; attemptedCount: number; hasReceipt: boolean; retryAt?: number | null; now?: number }
/** What a naming tick owes this thread: finish the request it already submitted, ask for a title, or
 * nothing. Any thread that answers `generate` is due, whether or not its last attempt left a receipt. */
export function namingStep(view: ThreadNamingView): "poll" | "generate" | "idle" {
  if (view.titleSource === "manual") return "idle";
  if (view.retryAt !== undefined && (view.retryAt === null || (view.now ?? Date.now()) < view.retryAt)) return "idle";
  if (view.hasReceipt) return "poll";
  return shouldNameThread(view.name, view.messageCount, view.namedAtMessageCount)
    && (view.retryAt !== undefined || view.messageCount > view.attemptedCount) ? "generate" : "idle";
}

/** A thread still carrying the name it was created with. */
export function unnamedThread(name: string): boolean {
  return /^\d+$/.test(name) || /^Thread [0-9a-f]{8}$/i.test(name);
}

export function shouldNameThread(name: string, messageCount: number, namedAtMessageCount: number): boolean {
  if (messageCount < 1) return false;
  if (unnamedThread(name)) return true;
  const latestInterval = Math.floor(messageCount / THREAD_NAMING_INTERVAL) * THREAD_NAMING_INTERVAL;
  return latestInterval >= THREAD_NAMING_INTERVAL && namedAtMessageCount < latestInterval;
}

function titleFromLine(line: string): string | null {
  const name = line
    .trim()
    .replace(/^#{1,6}\s*/, "")
    .replace(/^(?:title|name)\s*:\s*/i, "")
    .replace(/^[`"']+|[`"'.!?]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return name.length >= 3 && name.length <= 60 && !name.endsWith(":")
    && !/^\d+$/.test(name) && !/[\u0000-\u001f\u007f]/.test(name) ? name : null;
}

export function generatedThreadName(output: string): string {
  for (const line of output.split(/\r?\n/)) {
    const name = titleFromLine(line);
    if (name) return name;
  }
  throw new Error("Thread naming model returned an invalid title");
}

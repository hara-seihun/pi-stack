// The wire shapes both clients and the supervisor agree on. Server modules
// import these types and produce values that satisfy them; the React client
// imports the same file, so a field renamed on one side fails to compile on
// the other instead of silently reading undefined at runtime.

import type { ThreadState } from "pi-orchestrator/api";
import type { MessagingSnapshot } from "./messaging/protocol.js";
import type { ReconcileFrame } from "../shared/reconcile.js";
export type ChatId = `ai:${string}` | `human:${string}`;
export type FileBrowserEntry = { name: string; path: string; kind: "directory" | "file" | "other" };
import type { InlineImage, InlineImageSnapshot } from "./inline-image-contract.js";
export type { InlineImage, InlineImageSnapshot };

export interface HostAuthentication { type: "oidc"; loginPath: "/v1/auth/login"; label: string }

export interface EnvironmentEndpoint {
  id: string;
  name: string;
  icon?: string;
  baseUrl: string;
}

export type ContextSplice = {
  baseHash: string;
  targetHash: string;
  prefixBytes: number;
  deleteBytes: number;
  insertBase64: string;
};

export type Activity = ThreadState | "awaiting" | "thinking" | "compacting" | "retrying" | "waiting_on_tool";

export interface IdleNotification { seq: number; sessionId: string; name: string; time: string }
export interface IdleNotificationFeed { cursor: number; notifications: IdleNotification[] }

export interface QueuedMessage {
  id: string;
  text: string;
  delivery: string;
  /** Where the message is: waiting for its turn, or taken by the runtime and
   * not yet in the agent's context. The client words it. */
  state: "queued" | "dispatched";
  canSteer: boolean;
  canHardSteer: boolean;
  canCancel: boolean;
  createdAt: string;
}

export const THREAD_COLORS = ["red", "orange", "yellow", "green", "blue", "purple"] as const;
export type ThreadColor = typeof THREAD_COLORS[number];
export function isThreadColor(value: unknown): value is ThreadColor {
  return THREAD_COLORS.some(color => color === value);
}

export interface Session {
  id: string;
  parentId: string | null;
  hasChildren: boolean;
  origin: "person" | "fleet";
  model: string;
  name: string;
  color?: ThreadColor | null;
  cwd: string;
  workspaceName: string;
  environment: string;
  state: ThreadState;
  /** Halted with cancellation confirmed, holding its pending messages. */
  held: boolean;
  activity: Activity;
  /** Every tool running right now, in the order they started. */
  activeTools: string[];
  provider: string;
  createdAt: string;
  updatedAt: string;
  revision: number;
  idleUnread: boolean;
  /** Full rows only for the stream's subscribed session; other rows carry an empty list. */
  queuedMessages: QueuedMessage[];
  archivedAt: string | null;
}

export interface SessionEvent {
  seq: number;
  time: string;
  type: string;
  [key: string]: unknown;
}

export interface PlanAccountRow {
  accountId: string;
  accountLabel: string;
  state: "ready" | "stale" | "unavailable";
  percentLeft: number | null;
  usedPercent: number | null;
  meterId: string | null;
  windowHours: number | null;
  readingAt: string | null;
  resetAt: string | null;
  /** Rate-limit resets banked on this account, or null where the provider reports none. */
  bankedResets: number | null;
  bankedResetsAt: string | null;
  bankedResetExpiresAt: string | null;
}

export interface PlanMetricRow {
  id: string;
  model: string;
  modelLabel: string;
  text: string;
  cacheText: string;
  description: string;
  accounts: PlanAccountRow[];
}

export interface PlanCard {
  id: string;
  label: string;
  icon: string;
  state: string;
  text: string;
  description: string;
  metrics: PlanMetricRow[];
}

export type GovernorProvider = "openai" | "anthropic";
/** The drawer button's four states, in cycle order: normal pace, 3× (green),
 * 10× (blue), and background halted (red). Forced runs bypass these controls;
 * running sessions finish naturally. */
export type GovernorState = "off" | "green" | "blue" | "red";
export interface Governor {
  state: GovernorState;
  boosted: boolean;
  multiplier: number;
  boostedMultiplier: number;
}
export type GovernorControls = Record<GovernorProvider, Governor>;

export interface MachineActionState {
  id: string;
  label: string;
  icon: string;
  active: boolean;
}

export interface MachineUsage {
  cpuPercent: number | null;
  gpuPercent: number | null;
  memory: { usedBytes: number; totalBytes: number; percentUsed: number };
  disk: { usedBytes: number; totalBytes: number; availableBytes: number; percentUsed: number } | null;
}

export interface ThreadStartModel {
  id: string;
  label: string;
  icon: string;
  accent?: string;
}

/** A Markdown file the destination offers as optional thread context, with its measured size. */
export interface ThreadStartContext {
  name: string;
  tokens: number;
  bytes: number;
}

export interface ThreadStart {
  id: string;
  label: string;
  icon: string;
  accent?: string;
  defaultModel?: string;
  models: ThreadStartModel[];
  /** Present only for destinations with a context folder; empty when the folder has no Markdown files. */
  contexts?: ThreadStartContext[];
}

export interface AgentModelCount {
  key: string;
  label: string;
  count: number;
}

/** Facts every client needs once: where new threads can start and the
 * person's home. Sent with `hello` and again only when they change. */
export interface Bootstrap {
  environmentId: string;
  home: string;
  threadStarts: ThreadStart[];
  /** Text-to-speech engines this host configures; null when it reads nothing aloud. */
  speech: SpeechCatalog | null;
}

/** `GET /v1/speech`. Voices come from `GET /v1/speech/engines/:engineId/voices`. */
export interface SpeechCatalog {
  engines: Array<{ id: string; name: string; defaultVoice: string | null }>;
}

export interface SpeechVoice {
  id: string;
  name: string;
  description?: string;
}

/** `POST /v1/speech/utterances` with `{ text, engine?, voice? }` registers a
 * text; `GET /v1/speech/utterances/:utteranceId/audio` streams it as Ogg/Opus
 * while the engine speaks, and the status route explains a playback failure. */
export interface SpeechUtterance {
  id: string;
  engine: string;
  voice: string;
  characters: number;
  segmentCount: number;
  state: "ready" | "speaking" | "spoken" | "failed";
  error: string | null;
}

/** The Machine screen. It changes on its own clock (meters, load, agent
 * lifecycles) and travels only to streams that subscribed to it. */
export interface Dashboard {
  plans: PlanCard[];
  governors: GovernorControls | null;
  actions: MachineActionState[];
  machine: MachineUsage | null;
  modelCounts: AgentModelCount[];
}

/** Every thread the inbox and worker tree list, as `GET /v1/sessions` returns
 * it. The stream delivers the same directory as a reconciled snapshot. */
export interface SupervisorState {
  sessions: Session[];
  archivedTotal: number;
  ownerErrors: Array<{ id: string; owner: string; message: string }>;
}

export const BASH_TIMEOUT_OPTIONS = [60, 300, 1800] as const;
export type BashTimeoutSeconds = (typeof BASH_TIMEOUT_OPTIONS)[number];
export const DEFAULT_BASH_TIMEOUT_SECONDS: BashTimeoutSeconds = 1800;

export interface ThreadSettings {
  models: Array<{ id: string; name?: string; provider: string; common?: boolean }>;
  model: { id: string; provider: string } | null;
  thinkingLevels: string[];
  thinkingLevel: string | null;
  speedModes: string[];
  speedMode: string | null;
  bashTimeoutSeconds: BashTimeoutSeconds;
}

export interface SlashCommand {
  name: string;
  description?: string;
  source?: string;
}

// ---------------------------------------------------------------------------
// Transcript items
//
// The supervisor derives an ordered list of items from the display projection
// of Pi's model context at every durable boundary. Each item is an exact slice
// of that context: the system prompt, one tool schema, one user message, one
// assistant text block, one thinking block, or one tool call paired with its
// result. Heads are small and travel on the stream; bodies are fetched on
// demand by content hash and cached forever by the client.
//
// `seq` is the item's position within a generation. A generation is the
// identity of the list prefix: when a capture keeps every earlier item's
// identity (same user timestamp, same tool call id, ...) the generation stays
// and the client only receives new or replaced items. Compaction, fork and
// tree navigation produce a new generation, and the client reloads its window.

export type TranscriptItemKind = "system" | "tool" | "user" | "assistant" | "thinking" | "toolCall" | "notice";

/** How fast one model response arrived, measured by the supervisor from the
 * events Pi streams: `ttftMs` is the wait from the request to the first text or
 * thinking delta, `generationMs` the streaming that followed, and
 * `tokensPerSecond` the provider's output tokens over that streaming time.
 * Carried by the last item an assistant message produced. */
export interface ResponseMetrics {
  ttftMs: number;
  generationMs: number;
  outputTokens: number;
  tokensPerSecond: number | null;
}

interface TranscriptItemBase {
  seq: number;
  /** SHA-256 of the item's complete body. Changes when a result lands on a call. */
  id: string;
  kind: TranscriptItemKind;
  /** Bytes of the complete body, so the client can decide what to prefetch. */
  size: number;
  /** Milliseconds since the epoch of the originating message, when known. */
  timestamp?: number;
  /** Speed of the model response this item came from. Present on the last item
   * an assistant message produced, once the response has finished streaming. */
  responseMetrics?: ResponseMetrics;
  /** The complete body, present only on the newest item of a window or an
   * incremental update when it is small: the step a client opens first. */
  body?: TranscriptItemBody;
}

/** Text that is always inline: the person's and the agent's visible words. */
export interface InlineTextItem extends TranscriptItemBase {
  identity?: import("./message-protocol.js").MessageIdentity;
  reactions?: import("./message-protocol.js").MessageReaction[];
  kind: "user" | "assistant" | "notice";
  label?: string;
  text: string;
}

/** Text shown only on expansion: system prompt, tool schemas, thinking. */
export interface LazyTextItem extends TranscriptItemBase {
  kind: "system" | "tool" | "thinking";
  label?: string;
  /** First characters of the text for the collapsed row. */
  preview: string;
}

export interface ToolCallResultHead {
  isError: boolean;
  size: number;
  timestamp?: number;
  /** First characters of the result text for the collapsed row. */
  preview: string;
  imageCount: number;
}

/** A tool call and, once the context contains it, its result. */
export interface ToolCallItem extends TranscriptItemBase {
  kind: "toolCall";
  callId: string;
  name: string;
  /** What names the step: strings cut at 120 characters, arrays at five entries, and
   * fields that are bodies rather than names (a written file's `content`, an edit's
   * `edits` replaced by `editCount`, a delegated `message`) left out.
   * `argumentsTruncated` says the body has more. */
  arguments: unknown;
  argumentsTruncated: boolean;
  /** Trailing output of a still-running tool, at most 4,000 characters. */
  partialOutput?: string;
  result?: ToolCallResultHead;
}

export type TranscriptItemHead = InlineTextItem | LazyTextItem | ToolCallItem;

/** `GET /v1/sessions/:sessionId/items/:id`, immutable by content hash. */
export type TranscriptItemBody =
  | { kind: "system" | "tool" | "thinking" | "user" | "assistant" | "notice"; text: string }
  | { kind: "toolCall"; arguments: unknown; result: { content: unknown; isError: boolean; timestamp?: number } | null };

/** `GET /v1/sessions/:sessionId/transcript?generation=&before=&limit=` pages
 * older heads; the stream delivers the newest window and every change. */
export interface TranscriptPage {
  sessionId: string;
  generation: string;
  /** Number of items in the generation. */
  total: number;
  items: TranscriptItemHead[];
}

// ---------------------------------------------------------------------------
// The stream
//
// `POST /v1/stream` with a StreamSubscription body answers with
// `text/event-stream`. The first event is `hello`. `POST /v1/stream/:streamId`
// with a partial StreamSubscription changes what the stream carries; the
// server answers 204 and pushes whatever the change now requires. Every event
// is JSON; `event:` names the StreamEvent variant. The server writes a comment
// line at least every 15 seconds so proxies and the client can detect a dead
// connection.

export interface StreamSubscription {
  /** Thread whose transcript, live output and images this stream carries. */
  session?: string | null;
  /** True only while the person can see that conversation. */
  viewing?: boolean;
  /** Earliest transcript seq the selected thread has loaded; null requests the latest 60. */
  transcriptFrom?: number | null;
  /** Revisions actually held in the client replica. */
  have?: Record<string, string>;
  /** Resources to carry. Session-scoped resources also require `session` authorization. */
  want?: string[];
  /** Stream live thinking text. Off by default; the client turns it on when the thinking card is opened. */
  thinking?: boolean;
  /** Carry the Machine screen. */
  dashboard?: boolean;
  /** Carry this environment's idle notifications after this cursor. */
  notificationsAfter?: number | null;
  /** Voice: carry durable session events after this cursor. */
  eventsAfter?: number | null;
}

export type StreamSnapshot =
  | { type: "bootstrap"; bootstrap: Bootstrap }
  | ({ type: "state" } & SupervisorState)
  | { type: "messaging"; snapshot: MessagingSnapshot }
  | { type: "dashboard"; dashboard: Dashboard }
  | ({ type: "transcript" } & TranscriptPage)
  | { type: "live"; sessionId: string; text: string; thinking?: string }
  | { type: "images"; sessionId: string; snapshot: InlineImageSnapshot };

export type StreamEvent =
  | { type: "hello"; epoch: string; streamId: string; bootstrap: Bootstrap }
  | ({ type: "reconcile" } & ReconcileFrame)
  | StreamSnapshot
  | { type: "notifications"; feed: IdleNotificationFeed }
  | { type: "events"; sessionId: string; events: SessionEvent[] }
  | { type: "error"; message: string };

export type StreamWireEvent = Exclude<StreamEvent, StreamSnapshot>;

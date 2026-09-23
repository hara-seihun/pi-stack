// One client, one server-sent event stream. The stream carries what the client
// subscribed to and nothing else: inbox rows that actually changed, the
// messaging inbox, the transcript of the open thread, its live output, and —
// only for clients that ask — the Machine screen, notifications and Voice
// events.
//
// Everything a stream must remember to send differences (which session rows it
// already holds, how much live text it already wrote) lives on the stream, so
// the server encodes shared state once and every client still receives only
// its own delta.

import type { LiveTextChange, Session, SessionPatch, StreamEvent, StreamSubscription } from "./protocol";
import type { MessagingSnapshot } from "./messaging/protocol";

/** Comment line interval. Below the supervisor's 30 s socket idle timeout. */
export const PING_INTERVAL_MS = 10_000;

/**
 * The inbox lists open conversations with activity in the last two weeks, plus
 * any open conversation with unread messages. Kenan's Signal directory holds
 * over a hundred open conversations; the rest stay behind `GET /v1/messaging`,
 * which the picker calls when the person opens it.
 */
export const INBOX_CONVERSATION_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;

export function inboxMessaging(snapshot: MessagingSnapshot, now = Date.now()): MessagingSnapshot {
  return {
    ...snapshot,
    conversations: snapshot.conversations.filter((conversation) =>
      conversation.current && (conversation.unread > 0 || conversation.updatedAt >= now - INBOX_CONVERSATION_WINDOW_MS)),
  };
}

/**
 * Live text is append-only until the runtime shortens or replaces it, which
 * happens when a captured context acknowledges the message or the thread
 * settles.
 */
export function liveTextChange(sent: string, current: string): LiveTextChange | null {
  if (sent === current) return null;
  if (current.startsWith(sent)) return { append: current.slice(sent.length), length: current.length };
  return { reset: current };
}

function optionalString(value: unknown): string | null | undefined {
  if (value === null) return null;
  return typeof value === "string" && value ? value : undefined;
}

function optionalCursor(value: unknown): number | null | undefined {
  if (value === null) return null;
  const cursor = Number(value);
  return Number.isSafeInteger(cursor) && cursor >= 0 ? cursor : undefined;
}

/** A subscription body from a client, with unknown or malformed fields dropped. */
export function readSubscription(body: unknown): Partial<StreamSubscription> {
  const input = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const subscription: Partial<StreamSubscription> = {};
  if ("session" in input) {
    const session = optionalString(input.session);
    if (session !== undefined) subscription.session = session;
    else if (input.session === undefined) subscription.session = null;
  }
  for (const flag of ["viewing", "thinking", "dashboard"] as const) {
    if (typeof input[flag] === "boolean") subscription[flag] = input[flag] as boolean;
  }
  if ("notificationsAfter" in input) {
    const cursor = optionalCursor(input.notificationsAfter);
    if (cursor !== undefined) subscription.notificationsAfter = cursor;
  }
  if ("eventsAfter" in input) {
    const cursor = optionalCursor(input.eventsAfter);
    if (cursor !== undefined) subscription.eventsAfter = cursor;
  }
  return subscription;
}

export function mergeSubscription(current: StreamSubscription, patch: Partial<StreamSubscription>): StreamSubscription {
  return { ...current, ...patch };
}

export interface StreamSink {
  write(chunk: string): void;
  close(): void;
}

export class ClientStream {
  readonly id = crypto.randomUUID();
  subscription: StreamSubscription = {};
  /** Encoded session rows this client already holds, by session id. */
  readonly sentSessions = new Map<string, string>();
  /** Encoded `archivedTotal` and `ownerErrors` this client already holds. */
  sentSummary = "";
  /** The session whose live output and images the counters below describe. */
  liveSession: string | null = null;
  sentText = "";
  sentThinking = "";
  sentImagesVersion = -1;
  transcript: { sessionId: string; generation: string } | null = null;
  private open = true;

  constructor(private readonly sink: StreamSink) {}

  get closed() { return !this.open; }

  send(event: StreamEvent): void {
    this.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  }

  ping(): void {
    this.write(": ping\n\n");
  }

  /** Forget everything remembered about the previously subscribed session. */
  resetSession(): void {
    this.liveSession = this.subscription.session ?? null;
    this.sentText = "";
    this.sentThinking = "";
    this.sentImagesVersion = -1;
    this.transcript = null;
  }

  close(): void {
    if (!this.open) return;
    this.open = false;
    try { this.sink.close(); } catch {}
  }

  private write(chunk: string): void {
    if (!this.open) return;
    try { this.sink.write(chunk); }
    catch { this.open = false; }
  }
}

/**
 * Which rows of a fresh projection this stream has not seen, and which of the
 * rows it holds are gone. Applying the result to `sentSessions` is part of
 * sending it, so a failed write cannot make the server believe a client is up
 * to date.
 */
export function sessionDelta(sent: Map<string, string>, rows: Array<{ session: Session; encoded: string }>):
  { sessions: Session[]; patches: SessionPatch[]; removed: string[] } {
  const present = new Set<string>();
  const sessions: Session[] = [];
  const patches: SessionPatch[] = [];
  for (const row of rows) {
    present.add(row.session.id);
    const held = sent.get(row.session.id);
    if (held === row.encoded) continue;
    if (held === undefined) { sessions.push(row.session); continue; }
    patches.push(sessionPatch(JSON.parse(held) as Session, row.session));
  }
  const removed = [...sent.keys()].filter((id) => !present.has(id));
  return { sessions, patches, removed };
}

/**
 * A working thread changes `activity` and `activeTool` at every tool call;
 * sending the row again would repeat its name, path, model and queue for a
 * few bytes of change. The patch names only the fields whose value differs.
 */
export function sessionPatch(held: Session, current: Session): SessionPatch {
  const patch: SessionPatch = { id: current.id };
  for (const key of new Set([...Object.keys(held), ...Object.keys(current)]) as Set<keyof Session>) {
    if (key === "id") continue;
    if (JSON.stringify(held[key]) !== JSON.stringify(current[key])) (patch as Record<string, unknown>)[key] = current[key] ?? null;
  }
  return patch;
}

export function applySessionDelta(sent: Map<string, string>, rows: Array<{ session: Session; encoded: string }>, removed: string[]): void {
  for (const row of rows) sent.set(row.session.id, row.encoded);
  for (const id of removed) sent.delete(id);
}

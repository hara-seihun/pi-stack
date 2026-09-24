import type { MessagingHistory, MessagingHistoryChanges, MessagingResult, MessagingSnapshot } from "../../server/messaging/protocol";
import { mergeHumanMessages } from "./messaging-state";

export const MESSAGING_PRELOAD_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
export interface MessagingHistorySource {
  window(id: string, signal: AbortSignal, since: number): Promise<MessagingResult<MessagingHistory>>;
  changes(id: string, signal: AbortSignal, after: number, from: number): Promise<MessagingResult<MessagingHistoryChanges>>;
}
export interface CachedMessagingHistory {
  history?: MessagingHistory;
  /** Every message id the server removed from this window during this unlocked lifetime. */
  removed: ReadonlySet<string>;
  error: string;
}
interface Entry {
  value: CachedMessagingHistory;
  /** Highest conversation revision the inbox has announced. */
  wanted: number;
  /** `wanted` when the last load began; a failed load waits for a newer announcement or a refresh. */
  attempted: number;
  forced: boolean;
  loading: boolean;
}
const empty: CachedMessagingHistory = { removed: new Set(), error: "" };

/**
 * Owned by the unlocked app, never persisted to device storage. Each
 * conversation loads its recent window once; afterwards only messages revised
 * after the held revision travel, and only when the inbox announces a newer one.
 */
export class MessagingHistoryCache {
  private readonly entries = new Map<string, Entry>();
  private readonly listeners = new Set<() => void>();
  private lifetime = new AbortController();
  private readonly queue = new Set<string>();
  private running = 0;

  constructor(private readonly source: MessagingHistorySource, private readonly now = Date.now) {}

  get = (id: string): CachedMessagingHistory => this.entries.get(id)?.value ?? empty;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  reconcile(snapshot: MessagingSnapshot): void {
    for (const conversation of snapshot.conversations) {
      const entry = this.entry(conversation.id);
      if (entry) entry.wanted = Math.max(entry.wanted, conversation.revision);
      this.enqueue(conversation.id, false);
    }
    this.drain();
  }

  ensure(id: string): void {
    this.entry(id);
    this.enqueue(id, true);
    this.drain();
  }

  /** Fetch changes now for one conversation, or retry every conversation whose last load failed. */
  refresh(id?: string): void {
    for (const [key, entry] of id ? [[id, this.entry(id)] as const] : this.entries) {
      if (!entry || (!id && !entry.value.error)) continue;
      entry.forced = true;
      this.enqueue(key, !!id);
    }
    this.drain();
  }

  start(): void {
    if (this.lifetime.signal.aborted) this.lifetime = new AbortController();
  }

  dispose(): void {
    this.lifetime.abort();
    this.running = 0;
    this.queue.clear();
    this.entries.clear();
    this.listeners.clear();
  }

  private entry(id: string): Entry | undefined {
    if (this.lifetime.signal.aborted) return undefined;
    let entry = this.entries.get(id);
    if (!entry) this.entries.set(id, entry = { value: empty, wanted: 0, attempted: -1, forced: false, loading: false });
    return entry;
  }

  private stale(entry: Entry): boolean {
    if (entry.forced) return true;
    if (entry.value.error && entry.attempted >= entry.wanted) return false;
    const history = entry.value.history;
    return !history || history.revision < entry.wanted;
  }

  private enqueue(id: string, priority: boolean): void {
    const entry = this.entries.get(id);
    if (!entry || entry.loading || !this.stale(entry)) return;
    if (priority) {
      const waiting = [...this.queue];
      this.queue.clear();
      this.queue.add(id);
      for (const key of waiting) this.queue.add(key);
    } else this.queue.add(id);
  }

  private drain(): void {
    while (!this.lifetime.signal.aborted && this.running < 4 && this.queue.size) {
      const id = this.queue.values().next().value!;
      this.queue.delete(id);
      const entry = this.entries.get(id)!;
      if (entry.loading || !this.stale(entry)) continue;
      entry.loading = true;
      entry.forced = false;
      entry.attempted = entry.wanted;
      this.running++;
      void this.load(id, entry);
    }
  }

  private async load(id: string, entry: Entry): Promise<void> {
    const signal = this.lifetime.signal;
    const held = entry.value.history;
    const result = held
      ? await this.source.changes(id, signal, held.revision, held.before ?? 0)
      : await this.source.window(id, signal, Math.max(0, this.now() - MESSAGING_PRELOAD_WINDOW_MS));
    if (signal.aborted) return;
    entry.loading = false;
    this.running--;
    if (!result.ok) entry.value = { ...entry.value, error: result.error.message };
    else if (!held) entry.value = { history: result.value as MessagingHistory, removed: entry.value.removed, error: "" };
    else {
      const changes = result.value as MessagingHistoryChanges;
      const removed = changes.removed.length ? new Set([...entry.value.removed, ...changes.removed]) : entry.value.removed;
      const kept = changes.removed.length ? held.messages.filter(message => !removed.has(message.id)) : held.messages;
      const history = changes.messages.length || changes.removed.length || changes.revision !== held.revision
        ? { messages: mergeHumanMessages(kept, changes.messages), before: held.before, revision: changes.revision }
        : held;
      entry.value = { history, removed, error: "" };
    }
    for (const listener of this.listeners) listener();
    this.enqueue(id, false);
    this.drain();
  }
}

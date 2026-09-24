import type { MessagingHistory, MessagingResult, MessagingSnapshot } from "../../server/messaging/protocol";

export const MESSAGING_PRELOAD_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
type FetchHistory = (id: string, signal: AbortSignal, since: number) => Promise<MessagingResult<MessagingHistory>>;
export interface CachedMessagingHistory { history?: MessagingHistory; error: string }
interface Entry {
  value: CachedMessagingHistory;
  wanted: number;
  attempted: number;
  loading: boolean;
}
const empty: CachedMessagingHistory = { error: "" };

/** Owned by the unlocked app, never persisted to device storage. */
export class MessagingHistoryCache {
  private readonly entries = new Map<string, Entry>();
  private readonly listeners = new Set<() => void>();
  private lifetime = new AbortController();
  private readonly queue = new Set<string>();
  private running = 0;
  private version = 0;

  constructor(private readonly fetchHistory: FetchHistory, private readonly now = Date.now) {}

  get = (id: string): CachedMessagingHistory => this.entries.get(id)?.value ?? empty;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  reconcile(snapshot: MessagingSnapshot): void {
    this.version = snapshot.version;
    for (const conversation of snapshot.conversations) this.enqueue(conversation.id, false);
    this.drain();
  }

  ensure(id: string): void {
    this.enqueue(id, true);
    this.drain();
  }

  refresh(id?: string): void {
    for (const key of id ? [id] : this.entries.keys()) {
      const entry = this.entries.get(key);
      if (entry) entry.attempted = -1;
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

  private enqueue(id: string, priority: boolean): void {
    if (this.lifetime.signal.aborted) return;
    let entry = this.entries.get(id);
    if (!entry) {
      entry = { value: empty, wanted: this.version, attempted: -1, loading: false };
      this.entries.set(id, entry);
    }
    entry.wanted = this.version;
    if (entry.loading || entry.attempted === entry.wanted) return;
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
      if (entry.loading || entry.attempted === entry.wanted) continue;
      entry.loading = true;
      entry.attempted = entry.wanted;
      this.running++;
      void this.load(id, entry);
    }
  }

  private async load(id: string, entry: Entry): Promise<void> {
    const signal = this.lifetime.signal;
    const result = await this.fetchHistory(id, signal, Math.max(0, this.now() - MESSAGING_PRELOAD_WINDOW_MS));
    if (signal.aborted) return;
    entry.loading = false;
    this.running--;
    entry.value = result.ok ? { history: result.value, error: "" } : { ...entry.value, error: result.error.message };
    for (const listener of this.listeners) listener();
    if (entry.attempted !== entry.wanted) this.queue.add(id);
    this.drain();
  }
}

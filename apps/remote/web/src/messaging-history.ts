import type { MessagingHistory, MessagingHistoryChanges, MessagingMessage, MessagingResult, MessagingSnapshot } from "../../server/messaging/protocol";
import { mergeHumanMessages } from "./messaging-state";

export interface MessagingHistorySource {
  window(id: string, signal: AbortSignal, priority: "high" | "low"): Promise<MessagingResult<MessagingHistory>>;
  changes(id: string, signal: AbortSignal, after: number, from: number, priority: "high" | "low"): Promise<MessagingResult<MessagingHistoryChanges>>;
}
export interface CachedMessagingHistory {
  history?: MessagingHistory;
  /** Every message id the server removed from this window during this unlocked lifetime. */
  removed: ReadonlySet<string>;
  error: string;
  newer: boolean;
}
interface Entry {
  value: CachedMessagingHistory;
  /** Highest conversation revision the inbox has announced. */
  wanted: number;
  /** `wanted` when the last load began; a failed load waits for a newer announcement or a refresh. */
  attempted: number;
  forced: boolean;
  loading: boolean;
  usedAt: number;
}
const empty: CachedMessagingHistory = { removed: new Set(), error: "", newer: false };
export const MESSAGING_HISTORY_BUDGET = { conversations: 32, messages: 2_000, bytes: 16 * 1024 * 1024, perConversation: 200 };
export type MessagingHistoryBudget = typeof MESSAGING_HISTORY_BUDGET;
export const DISPLAYED_MESSAGE_BUDGET = 600;
export const DISPLAYED_MESSAGE_BYTES = 8 * 1024 * 1024;

export function trimMessagingHistory(history: MessagingHistory, limit: number, direction: "older" | "newer"): MessagingHistory | null {
  if (history.messages.length <= limit && JSON.stringify(history).length * 2 <= DISPLAYED_MESSAGE_BYTES) return history;
  if (history.messages.some(message => message.seq === undefined)) return null;
  const ordered = [...history.messages].sort((a, b) => direction === "older" ? a.seq! - b.seq! : b.seq! - a.seq!);
  const held: MessagingMessage[] = [];
  let bytes = 0;
  for (const message of ordered) {
    const size = JSON.stringify(message).length * 2;
    if (held.length >= limit || held.length && bytes + size > DISPLAYED_MESSAGE_BYTES) break;
    held.push(message);
    bytes += size;
  }
  return { ...history, messages: mergeHumanMessages([], held), before: direction === "newer" ? oldestSeq(held) : history.before };
}

const oldestSeq = (messages: readonly MessagingMessage[]) => Math.min(...messages.map(message => message.seq ?? Infinity));
const newestSeq = (messages: readonly MessagingMessage[]) => Math.max(...messages.map(message => message.seq ?? -1));

/**
 * Owned by the unlocked app, never persisted to device storage. Each
 * conversation loads its newest page once; afterwards only messages revised
 * after the held revision travel, and only when the inbox announces a newer one.
 */
export class MessagingHistoryCache {
  private readonly entries = new Map<string, Entry>();
  private readonly listeners = new Set<() => void>();
  private lifetime = new AbortController();
  private readonly queue = new Set<string>();
  private running = 0;
  private selected: string | null = null;
  private visible: { from: number; to: number } | null = null;

  constructor(private readonly source: MessagingHistorySource, private readonly budget: MessagingHistoryBudget = MESSAGING_HISTORY_BUDGET) {}

  /** The displayed conversation is a lease: budget pressure must not erase its held page. */
  select(id: string | null): void {
    if (id !== this.selected) this.visible = null;
    this.selected = id;
    this.prune();
  }

  protect(id: string, range: { from: number; to: number } | null): void {
    if (id === this.selected) this.visible = range;
  }

  acceptPage(id: string, page: MessagingHistory, direction: "older" | "latest"): void {
    const entry = this.entry(id);
    if (!entry) return;
    const previous = entry.value.history;
    const history = direction === "older" && previous
      ? { messages: mergeHumanMessages(page.messages, previous.messages), before: page.before, revision: Math.max(page.revision, previous.revision) }
      : page;
    const bounded = trimMessagingHistory(history, DISPLAYED_MESSAGE_BUDGET, direction === "older" ? "older" : "newer");
    if (!bounded) entry.value = { ...entry.value, error: "Messaging history has no paging cursors; reload the app to update its protocol." };
    else entry.value = { history: bounded, removed: entry.value.removed, error: "", newer: direction === "older" && (!!entry.value.newer || newestSeq(bounded.messages) < newestSeq(history.messages)) };
    this.prune();
    for (const listener of this.listeners) listener();
  }

  private prune(): void {
    let messages = 0, bytes = 0;
    for (const [id, entry] of this.entries) {
      const history = entry.value.history;
      if (id !== this.selected && history) {
        const bounded = trimMessagingHistory(history, this.budget.perConversation, "newer");
        entry.value = bounded
          ? { ...entry.value, history: bounded, removed: entry.value.removed.size > this.budget.perConversation ? new Set([...entry.value.removed].slice(-this.budget.perConversation)) : entry.value.removed }
          : { ...empty, error: "Messaging history has no paging cursors; reload the app to update its protocol." };
      }
      messages += entry.value.history?.messages.length ?? 0;
      bytes += JSON.stringify(entry.value.history ?? null).length * 2 + [...entry.value.removed].join("").length * 2;
    }
    for (const [id, entry] of [...this.entries].sort((a, b) => a[1].usedAt - b[1].usedAt)) {
      if (this.entries.size <= this.budget.conversations && messages <= this.budget.messages && bytes <= this.budget.bytes) break;
      if (id === this.selected || entry.loading) continue;
      messages -= entry.value.history?.messages.length ?? 0;
      bytes -= JSON.stringify(entry.value.history ?? null).length * 2 + [...entry.value.removed].join("").length * 2;
      if (this.entries.size > this.budget.conversations) this.entries.delete(id);
      else { entry.value = empty; entry.attempted = entry.wanted; entry.forced = false; }
      this.queue.delete(id);
    }
  }

  get = (id: string): CachedMessagingHistory => this.entries.get(id)?.value ?? empty;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  reconcile(snapshot: MessagingSnapshot): void {
    const recent = [...snapshot.conversations].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, this.budget.conversations);
    const eligible = new Set([...recent.map(conversation => conversation.id), ...(this.selected ? [this.selected] : [])]);
    for (const id of this.entries.keys()) if (!eligible.has(id) && !this.entries.get(id)!.loading) { this.entries.delete(id); this.queue.delete(id); }
    for (const conversation of recent) {
      const entry = this.entry(conversation.id);
      if (entry) { entry.wanted = Math.max(entry.wanted, conversation.revision); entry.usedAt = Math.max(entry.usedAt, conversation.updatedAt); }
      this.enqueue(conversation.id, false);
    }
    this.drain();
  }

  ensure(id: string): void {
    this.select(id);
    const entry = this.entry(id);
    if (entry) entry.usedAt = Date.now();
    if (entry && !entry.value.history && !entry.loading) entry.forced = true;
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
    this.selected = null;
    this.queue.clear();
    this.entries.clear();
    this.listeners.clear();
  }

  private entry(id: string): Entry | undefined {
    if (this.lifetime.signal.aborted) return undefined;
    let entry = this.entries.get(id);
    if (!entry) this.entries.set(id, entry = { value: empty, wanted: 0, attempted: -1, forced: false, loading: false, usedAt: 0 });
    return entry;
  }

  private stale(entry: Entry): boolean {
    if (entry.forced) return true;
    if (entry.value.error && entry.attempted >= entry.wanted) return false;
    const history = entry.value.history;
    return history ? history.revision < entry.wanted : entry.attempted < entry.wanted;
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
    while (!this.lifetime.signal.aborted && this.queue.size) {
      const selected = this.selected && this.queue.has(this.selected) ? this.selected : null;
      // Keep one connection available for a tap even while other chats preload.
      if (this.running >= (selected ? 4 : 3)) return;
      const id = selected ?? this.queue.values().next().value!;
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
    const priority = id === this.selected ? "high" : "low";
    const result = held
      ? await this.source.changes(id, signal, held.revision, held.before ?? 0, priority)
      : await this.source.window(id, signal, priority);
    if (signal.aborted || this.entries.get(id) !== entry) return;
    entry.loading = false;
    this.running--;
    if (!result.ok) entry.value = { ...entry.value, error: result.error.message };
    else if (!held) {
      const history = trimMessagingHistory(result.value as MessagingHistory, id === this.selected ? DISPLAYED_MESSAGE_BUDGET : this.budget.perConversation, "newer");
      entry.value = history ? { history, removed: entry.value.removed, error: "", newer: false } : { ...empty, error: "Messaging history has no paging cursors; reload the app to update its protocol." };
    }
    else {
      const changes = result.value as MessagingHistoryChanges;
      const removed = changes.removed.length ? new Set([...entry.value.removed, ...changes.removed]) : entry.value.removed;
      const kept = changes.removed.length ? held.messages.filter(message => !removed.has(message.id)) : held.messages;
      const history = changes.messages.length || changes.removed.length || changes.revision !== held.revision
        ? { messages: mergeHumanMessages(kept, changes.messages), before: held.before, revision: changes.revision }
        : held;
      const bounded = trimMessagingHistory(history, id === this.selected ? DISPLAYED_MESSAGE_BUDGET : this.budget.perConversation, "newer");
      if (!bounded) entry.value = { ...entry.value, error: "Messaging history has no paging cursors; reload the app to update its protocol." };
      else if (id === this.selected && (entry.value.newer || this.visible && this.visible.from < oldestSeq(bounded.messages))) {
        const updated = new Map(changes.messages.map(message => [message.id, message]));
        entry.value = { history: { ...held, messages: kept.map(message => updated.get(message.id) ?? message), revision: changes.revision }, removed, error: "", newer: true };
      } else entry.value = { history: bounded, removed, error: "", newer: newestSeq(bounded.messages) < newestSeq(history.messages) };
      if (entry.value.removed.size > DISPLAYED_MESSAGE_BUDGET) entry.value = { ...entry.value, removed: new Set([...entry.value.removed].slice(-DISPLAYED_MESSAGE_BUDGET)) };
    }
    this.prune();
    for (const listener of this.listeners) listener();
    this.enqueue(id, false);
    this.drain();
  }
}

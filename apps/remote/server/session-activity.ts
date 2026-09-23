// What a thread is doing right now, for the features that watch rather than
// read: Voice narrating the agent's work, and the meeting panel's per-thread
// activity. It is a bounded window in memory, not a conversation store — the
// native transcript and the captured context own history, and a supervisor
// restart simply starts the window again.

export interface ActivityEvent {
  seq: number;
  time: string;
  type: string;
  [key: string]: unknown;
}

/** Enough for Voice to catch up on a turn and for the meeting panel's last
 * steps, small enough that a thousand idle threads cost nothing. */
const WINDOW = 200;

export class SessionActivity {
  private readonly windows = new Map<string, ActivityEvent[]>();
  private readonly receipts = new Map<string, Set<string>>();
  private sequence = 0;

  constructor(private readonly clock: () => string = () => new Date().toISOString()) {}

  /** Records one event and returns its sequence, or 0 when a receipt says this
   * event already happened. Receipts are why a replayed settlement or a
   * re-observed message does not narrate itself twice. */
  add(sessionId: string, type: string, payload: Record<string, unknown> = {}, receiptId: string | null = null): number {
    if (receiptId) {
      const seen = this.receipts.get(sessionId) ?? new Set<string>();
      if (seen.has(receiptId)) return 0;
      seen.add(receiptId);
      if (seen.size > WINDOW * 2) for (const value of [...seen].slice(0, WINDOW)) seen.delete(value);
      this.receipts.set(sessionId, seen);
    }
    const event: ActivityEvent = { seq: ++this.sequence, time: this.clock(), type, ...payload };
    const window = this.windows.get(sessionId) ?? [];
    window.push(event);
    if (window.length > WINDOW) window.splice(0, window.length - WINDOW);
    this.windows.set(sessionId, window);
    return event.seq;
  }

  /** Events after a cursor, oldest first. A cursor of 0 opens on the tail, and
   * so does a cursor from a supervisor that has been replaced: its sequence is
   * ahead of this window and would otherwise hold a client silent forever. */
  since(sessionId: string, after: number, limit = 150): ActivityEvent[] {
    const window = this.windows.get(sessionId) ?? [];
    const tail = after <= 0 || after > this.sequence;
    const visible = tail ? window.slice(-50) : window.filter(event => event.seq > after);
    return visible.slice(0, limit);
  }

  /** The last events of a kind, oldest first: what the meeting panel shows. */
  recent(sessionId: string, types: readonly string[], limit: number): ActivityEvent[] {
    const window = this.windows.get(sessionId) ?? [];
    return window.filter(event => types.includes(event.type)).slice(-limit);
  }

  forget(sessionId: string): void {
    this.windows.delete(sessionId);
    this.receipts.delete(sessionId);
  }
}

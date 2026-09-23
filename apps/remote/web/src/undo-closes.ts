import type { Chat } from "./chats";

export interface UndoClose { chat: Chat; order: number }
export interface UndoCloseState { entries: readonly UndoClose[]; restoring: boolean; error: string }
export type CloseResult = { ok: true } | { ok: false; error: string };

const failure = (cause: unknown) => cause instanceof Error ? cause.message : String(cause);

/** Successful closes are kept in tap order, even when their requests finish out of order. */
export class UndoCloses {
  private scope = "";
  private sequence = 0;
  private pending = new Set<string>();
  private listeners = new Set<() => void>();
  private current: UndoCloseState = { entries: [], restoring: false, error: "" };
  private restoringId: string | null = null;

  snapshot = () => this.current;
  isBusy = (id: string) => this.pending.has(id) || this.restoringId === id;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private publish(state: UndoCloseState) { this.current = state; for (const listener of this.listeners) listener(); }

  setScope(scope: string) {
    if (this.scope === scope) return;
    this.scope = scope;
    this.pending.clear();
    this.restoringId = null;
    this.publish({ entries: [], restoring: false, error: "" });
  }

  async close(chat: Chat, request: () => Promise<unknown>): Promise<CloseResult | null> {
    if (this.pending.has(chat.id) || this.restoringId === chat.id) return null;
    this.pending.add(chat.id);
    const scope = this.scope;
    const order = ++this.sequence;
    try {
      await request();
      if (scope !== this.scope) return null;
      const entries = [...this.current.entries.filter(entry => entry.chat.id !== chat.id), { chat, order }].sort((a, b) => a.order - b.order);
      this.publish({ entries, restoring: this.current.restoring, error: "" });
      return { ok: true };
    } catch (cause) {
      return scope === this.scope ? { ok: false, error: failure(cause) } : null;
    } finally {
      if (scope === this.scope) this.pending.delete(chat.id);
    }
  }

  async undo(request: (chat: Chat) => Promise<unknown>): Promise<CloseResult | null> {
    const entry = this.current.entries.at(-1);
    if (!entry || this.current.restoring || this.pending.has(entry.chat.id)) return null;
    const scope = this.scope;
    this.restoringId = entry.chat.id;
    this.publish({ ...this.current, restoring: true, error: "" });
    try {
      await request(entry.chat);
      if (scope !== this.scope) return null;
      this.publish({ entries: this.current.entries.filter(item => item.order !== entry.order), restoring: false, error: "" });
      return { ok: true };
    } catch (cause) {
      if (scope !== this.scope) return null;
      const error = failure(cause);
      this.publish({ ...this.current, restoring: false, error });
      return { ok: false, error };
    } finally {
      if (scope === this.scope) this.restoringId = null;
    }
  }
}

/** Let the focused editor, drawing canvas, or open dialog own its own undo. */
export function shouldUndoClose(event: KeyboardEvent, root: Document = document): boolean {
  if (event.defaultPrevented || event.repeat || event.isComposing || event.key.toLowerCase() !== "z" || event.altKey || event.shiftKey || event.ctrlKey === event.metaKey) return false;
  if (root.querySelector("dialog[open], [role='dialog'], .drawing-canvas")) return false;
  const target = event.target;
  if (!(target instanceof Element)) return true;
  return !target.closest("input, textarea, select, [contenteditable], [role='textbox'], [role='combobox']") && !(target as HTMLElement).isContentEditable;
}

// A thread tool call is about other threads, and a person reading the
// transcript wants to go to them. The call's arguments already name them by
// id; the client knows what the naming agent called each one, so the step
// shows those names as buttons that open the thread.

import { createContext, useContext, useEffect, type ReactNode } from "react";

export interface ThreadDirectory {
  /** The thread's name, or null while the client has not learned it. */
  name(id: string): string | null;
  /** True while that thread has work of its own. */
  busy(id: string): boolean;
  open(id: string): void;
  /** Ask for names this client does not hold. Safe to call on every render. */
  discover(ids: string[]): void;
}

export const ThreadDirectoryContext = createContext<ThreadDirectory | null>(null);

export function ThreadDirectoryProvider({ value, children }: { value: ThreadDirectory; children: ReactNode }) {
  return <ThreadDirectoryContext.Provider value={value}>{children}</ThreadDirectoryContext.Provider>;
}

const THREAD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The threads a tool call names, in the order the call gave them. */
export function threadIdsOf(name: unknown, args: unknown): string[] {
  const tool = String(name ?? "").toLowerCase().replace(/^functions\./, "");
  if (!tool.startsWith("thread_")) return [];
  const fields = (args ?? {}) as { threadId?: unknown; threadIds?: unknown; id?: unknown };
  const found: string[] = [];
  const take = (value: unknown) => {
    const id = typeof value === "string" ? value.trim() : "";
    if (THREAD_ID.test(id) && !found.includes(id)) found.push(id);
  };
  take(fields.threadId);
  take(fields.id);
  if (Array.isArray(fields.threadIds)) for (const value of fields.threadIds) take(value);
  return found;
}

export function shortThreadName(id: string): string {
  return `Thread ${id.slice(0, 8)}`;
}

export function ThreadChips({ ids, label }: { ids: string[]; label?: string }) {
  const directory = useContext(ThreadDirectoryContext);
  const key = ids.join(",");
  useEffect(() => {
    if (directory && ids.length) directory.discover(ids);
    // `key` stands in for the array identity, which changes on every render.
  }, [directory, key]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!directory || !ids.length) return null;
  return <span className="thread-chips" aria-label={label ?? "Threads this step is about"}>
    {ids.map(id => {
      const name = directory.name(id) || shortThreadName(id);
      return <button key={id} type="button" className={`thread-chip${directory.busy(id) ? " busy" : ""}`}
        title={`Open ${name}`}
        onClick={event => { event.preventDefault(); event.stopPropagation(); directory.open(id); }}>
        {name}
      </button>;
    })}
  </span>;
}

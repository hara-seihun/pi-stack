import type { ContextEntry } from "../../types";

export interface LiveText { text: string; thinking: string; messageTimestamp: number | null }
const EMPTY: LiveText = { text: "", thinking: "", messageTimestamp: null };
export type LiveTextStore = ReturnType<typeof createLiveText>;

export function visibleLiveText(live: LiveText, entries: readonly ContextEntry[]): LiveText {
  return live.messageTimestamp !== null && entries.some(entry => entry.kind === "assistant" && entry.messageTimestamp === live.messageTimestamp)
    ? EMPTY : live;
}

export function createLiveText() {
  let value = EMPTY;
  const listeners = new Set<() => void>();
  const publish = (next: LiveText) => {
    value = next;
    for (const listener of listeners) listener();
  };
  return {
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    snapshot: () => value,
    apply(frame: { text: string; thinking?: string; messageTimestamp?: number | null }) {
      const next = { text: frame.text, thinking: frame.thinking ?? "", messageTimestamp: frame.messageTimestamp ?? null };
      if (next.text !== value.text || next.thinking !== value.thinking || next.messageTimestamp !== value.messageTimestamp) publish(next);
    },
    reset() { if (value !== EMPTY) publish(EMPTY); },
    clearThinking() { if (value.thinking) publish({ ...value, thinking: "" }); },
  };
}

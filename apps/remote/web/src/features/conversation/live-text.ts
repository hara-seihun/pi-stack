// Live answer and thinking text stay outside app state so only the open
// conversation re-renders for stream frames.

export interface LiveText { text: string; thinking: string }

const EMPTY: LiveText = { text: "", thinking: "" };

export type LiveTextStore = ReturnType<typeof createLiveText>;

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
    apply(frame: { text: string; thinking?: string }) {
      const next = { text: frame.text, thinking: frame.thinking ?? "" };
      if (next.text !== value.text || next.thinking !== value.thinking) publish(next);
    },
    reset() { if (value !== EMPTY) publish(EMPTY); },
    clearThinking() { if (value.thinking) publish({ text: value.text, thinking: "" }); },
  };
}

// The answer and the thinking a thread is producing right now arrive as `live`
// frames, coalesced by the server at 33 ms. Holding them in the app's state
// would re-render the whole client thirty times a second — inbox rows, worker
// tree, tab badges — for text only the open conversation shows. They live in
// this small store instead, and only the component that renders them
// subscribes.

import type { LiveTextChange } from "../../../../server/protocol";

export interface LiveText { text: string; thinking: string }

const EMPTY: LiveText = { text: "", thinking: "" };

/** Live text is append-only until the server shortens or replaces it. */
export function applyLiveText(current: string, change: LiveTextChange | undefined, resync: () => void): string {
  if (!change) return current;
  if ("reset" in change) return change.reset;
  const next = current + change.append;
  if (Number.isFinite(change.length) && next.length !== change.length) resync();
  return next;
}

export type LiveTextStore = ReturnType<typeof createLiveText>;

/** `resync` is called when an append lands on text the client did not have. */
export function createLiveText(resync: () => void) {
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
    apply(frame: { text?: LiveTextChange; thinking?: LiveTextChange }) {
      if (!frame.text && !frame.thinking) return;
      publish({
        text: applyLiveText(value.text, frame.text, resync),
        thinking: applyLiveText(value.thinking, frame.thinking, resync),
      });
    },
    /** Leaving a thread, or a window that replaces what was streaming. */
    reset() {
      if (value !== EMPTY) publish(EMPTY);
    },
    /** Closing the thinking card unsubscribes from it; what was shown goes too. */
    clearThinking() {
      if (value.thinking) publish({ text: value.text, thinking: "" });
    },
  };
}

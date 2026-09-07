import { abortable } from "./abortable";

export interface SyncLoop {
  start(): void;
  kick(): void;
  stop(): void;
}

export function createSyncLoop(
  run: (signal: AbortSignal, waitMs: number) => Promise<void>,
  failed: (error: unknown) => void,
  { timeoutMs = 35_000, retryMs = 1_000, longPollMs = 25_000 } = {},
): SyncLoop {
  let stopped = true;
  let active: AbortController | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let failures = 0;
  const poll = (immediate: boolean) => {
    if (stopped) return;
    if (timer) clearTimeout(timer);
    active?.abort();
    const controller = new AbortController();
    active = controller;
    const deadline = setTimeout(() => controller.abort(new Error("Synchronization timed out")), timeoutMs);
    let delay = 0;
    void abortable(Promise.resolve().then(() => run(controller.signal, immediate ? 0 : longPollMs)), controller.signal)
      .then(() => { failures = 0; })
      .catch((error) => {
        if (active !== controller || stopped || error?.name === "AbortError") return;
        failed(error);
        delay = Math.min(5_000, retryMs * 2 ** Math.min(failures++, 3));
      })
      .finally(() => {
        clearTimeout(deadline);
        if (active !== controller || stopped) return;
        active = null;
        timer = setTimeout(() => poll(delay > 0), delay);
      });
  };
  return {
    start() { if (stopped) { stopped = false; poll(true); } },
    kick() { if (!stopped) poll(true); },
    stop() {
      stopped = true;
      active?.abort();
      active = null;
      if (timer) clearTimeout(timer);
      timer = null;
    },
  };
}

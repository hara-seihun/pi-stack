import type { StreamSubscription } from "./protocol";

export const THREAD_REFRESH_MS = 3_000;

export function startThreadRefresh(options: {
  subscriptions(): Iterable<StreamSubscription>;
  refreshPeers(): Promise<void>;
  inspect(id: string): Promise<void>;
  onError(cause: unknown): void;
}, intervalMs = THREAD_REFRESH_MS): () => void {
  let refreshing = false;
  const inspecting = new Set<string>();
  const timer = setInterval(() => {
    const subscriptions = [...options.subscriptions()];
    if (!subscriptions.length) return;
    // Every connected client displays the directory, even without an open
    // worker or the Machine screen. Its owner can change outside Remote.
    if (!refreshing) {
      refreshing = true;
      void options.refreshPeers().catch(options.onError).finally(() => { refreshing = false; });
    }
    for (const id of new Set(subscriptions.map(value => value.session).filter((id): id is string => Boolean(id)))) {
      if (inspecting.has(id)) continue;
      inspecting.add(id);
      void options.inspect(id).catch(options.onError).finally(() => { inspecting.delete(id); });
    }
  }, intervalMs);
  return () => clearInterval(timer);
}

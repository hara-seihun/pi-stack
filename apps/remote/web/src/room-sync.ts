import { consumeRoomFeed, readRoomRevisions, type RoomRevisions } from "../../shared/room-sync";
import { piFetch } from "./client";
import { ReconcileReplica, type ReconcileFrame } from "../../shared/reconcile";

export class RoomResource<T> {
  private replica = new ReconcileReplica({ maxEntries: 1, maxBytes: 32 * 1024 * 1024, maxValueBytes: 32 * 1024 * 1024, maxHistoryPerResource: 1 });
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private path: string, private fetchResource: typeof piFetch = piFetch) {}
  read(signal?: AbortSignal): Promise<T | null> {
    const operation = this.queue.catch(() => {}).then(() => this.request(signal));
    this.queue = operation;
    return operation;
  }
  private async request(signal?: AbortSignal): Promise<T | null> {
    if (signal?.aborted) return null;
    const have = this.replica.have()[this.path];
    const response = await this.fetchResource(`${this.path}?sync=1${have ? `&have=${encodeURIComponent(have)}` : ""}`, { signal, cache: "no-store" });
    if (signal?.aborted) { await response.body?.cancel(); return null; }
    if (response.status === 304) return null;
    if (!response.ok) {
      await response.body?.cancel();
      if (response.status === 403 || response.status === 404) this.replica.clear();
      throw new RoomResourceError(response.status);
    }
    const frame = await response.json() as ReconcileFrame;
    if (signal?.aborted) return null;
    if (frame.resource !== this.path) throw new Error("Room synchronization resource mismatch");
    const applied = this.replica.apply(frame);
    if (!applied.ok) {
      this.replica.clear();
      throw new Error(`Room synchronization failed: ${applied.reason}`);
    }
    return applied.value as T;
  }
}
export class RoomResourceError extends Error {
  constructor(readonly status: number) { super(`Room resource returned HTTP ${status}`); }
}

type RoomFeedEvent = { type: "revisions"; value: RoomRevisions } | { type: "error"; message: string } | { type: "connected" };
export interface RoomFeedPort {
  fetch(path: string, signal: AbortSignal): Promise<Response>;
  visible(): boolean;
  visibility(listener: () => void): () => void;
}

export class RoomRevisionFeed {
  private listeners = new Set<(event: RoomFeedEvent) => void>();
  private current: RoomRevisions | null = null;
  private controller: AbortController | null = null;
  private retry: ReturnType<typeof setTimeout> | undefined;
  private disposeVisibility: (() => void) | null = null;
  private failures = 0;
  constructor(private port: RoomFeedPort) {}
  subscribe(listener: (event: RoomFeedEvent) => void): () => void {
    this.listeners.add(listener);
    if (this.current) listener({ type: "revisions", value: this.current });
    if (!this.disposeVisibility) {
      this.disposeVisibility = this.port.visibility(this.reconcile);
      this.reconcile();
    }
    return () => {
      this.listeners.delete(listener);
      if (!this.listeners.size) {
        this.stop();
        this.disposeVisibility?.(); this.disposeVisibility = null;
        this.current = null; this.failures = 0;
      }
    };
  }
  private emit(event: RoomFeedEvent) { for (const listener of this.listeners) listener(event); }
  private stop() {
    const controller = this.controller;
    this.controller = null;
    controller?.abort();
    clearTimeout(this.retry); this.retry = undefined;
  }
  private reconcile = () => {
    if (!this.port.visible() || !this.listeners.size) { this.stop(); return; }
    if (this.controller || this.retry !== undefined) return;
    const controller = new AbortController();
    this.controller = controller;
    void this.connect(controller);
  };
  private async connect(controller: AbortController) {
    const signal = controller.signal;
    try {
      const cursor = this.current ? `?cursor=${encodeURIComponent(this.current.cursor)}` : "";
      const response = await this.port.fetch(`/v1/rooms/changes${cursor}`, signal);
      if (signal.aborted) { await response.body?.cancel(); return; }
      if (!response.ok || !response.body) {
        await response.body?.cancel();
        throw new Error(`Room changes returned HTTP ${response.status}`);
      }
      this.emit({ type: "connected" });
      await consumeRoomFeed(response.body, value => {
        if (signal.aborted) return;
        const revisions = readRoomRevisions(value);
        this.failures = 0;
        if (revisions.cursor === this.current?.cursor) return;
        this.current = revisions;
        this.emit({ type: "revisions", value: revisions });
      });
      if (!signal.aborted) throw new Error("Room changes disconnected");
    } catch (cause) {
      if (signal.aborted || this.controller !== controller) return;
      this.controller = null;
      this.emit({ type: "error", message: String(cause) });
      this.retry = setTimeout(() => { this.retry = undefined; this.reconcile(); }, Math.min(30_000, 1_000 * 2 ** Math.min(this.failures++, 5)));
    }
  }
}

export function watchRoomRevision(
  select: (value: RoomRevisions) => string | undefined,
  load: (signal: AbortSignal) => Promise<void>,
  error: (message: string) => void,
): () => void {
  let desired: string | undefined;
  let applied: string | undefined;
  let known = false;
  let failed = false;
  let feedFailed = false;
  let controller: AbortController | null = null;
  let disposed = false;
  const reconcile = () => {
    if (document.visibilityState !== "visible") {
      controller?.abort(); controller = null;
      return;
    }
    if (disposed || controller || !known || desired === applied) return;
    const candidate = new AbortController();
    controller = candidate;
    const target = desired;
    void load(candidate.signal).then(() => {
      if (!candidate.signal.aborted) { applied = target; failed = false; }
    }).catch(cause => {
      if (!candidate.signal.aborted) { applied = target; failed = true; error(String(cause)); }
    }).finally(() => {
      if (controller !== candidate) return;
      controller = null;
      reconcile();
    });
  };
  const unsubscribe = roomRevisions.subscribe(event => {
    if (event.type === "error") { feedFailed = true; error(event.message); return; }
    if (event.type === "connected") {
      if (feedFailed) { feedFailed = false; error(""); }
      return;
    }
    known = true;
    desired = select(event.value) ?? "missing";
    reconcile();
  });
  const resume = () => {
    if (failed && document.visibilityState === "visible") applied = undefined;
    reconcile();
  };
  document.addEventListener("visibilitychange", resume);
  window.addEventListener("online", resume);
  return () => {
    disposed = true;
    unsubscribe();
    controller?.abort();
    document.removeEventListener("visibilitychange", resume);
    window.removeEventListener("online", resume);
  };
}

export const roomRevisions = new RoomRevisionFeed({
  fetch: (path, signal) => piFetch(path, { signal, cache: "no-store", headers: { accept: "text/event-stream" } }),
  visible: () => document.visibilityState === "visible",
  visibility: listener => {
    document.addEventListener("visibilitychange", listener);
    window.addEventListener("pi-app-foreground", listener);
    window.addEventListener("online", listener);
    return () => {
      document.removeEventListener("visibilitychange", listener);
      window.removeEventListener("pi-app-foreground", listener);
      window.removeEventListener("online", listener);
    };
  },
});

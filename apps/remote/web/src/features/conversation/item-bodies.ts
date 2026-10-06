// Immutable bodies belong to ClientCache. Mounted open steps hold leases;
// closed and off-window bodies can be evicted and loaded again from disk.

import { createContext, useContext, useEffect, useSyncExternalStore } from "react";
import { API } from "../../../../server/api";
import type { TranscriptItemBody, TranscriptItemHead } from "../../../../server/protocol";
import { piFetch } from "../../client";
import type { BodyCache } from "../../client-cache";
import { ResourceCache } from "../../../../shared/resource-cache";

export type BodyFetch = (sessionId: string, id: string) => Promise<TranscriptItemBody>;

const requestBody: BodyFetch = async (sessionId, id) => {
  const response = await piFetch(API.sessionItem.path({ sessionId, itemId: id }), { headers: { accept: "application/json" }, signal: AbortSignal.timeout(20_000) });
  const text = await response.text();
  const body = text ? JSON.parse(text) : {};
  if (!response.ok) throw new Error(body.error || `Transcript item returned HTTP ${response.status}`);
  return body as TranscriptItemBody;
};

export class ItemBodies {
  private errors = new ResourceCache<string>({ entries: 128, bytes: 64 * 1024 });
  private displayed = new Map<string, { users: number; error: string }>();
  private pending = new Map<string, Promise<TranscriptItemBody>>();
  private listeners = new Set<() => void>();
  private revision = 0;

  constructor(
    private readonly sessionId: string,
    private readonly fetcher: BodyFetch = requestBody,
    private readonly cache: BodyCache,
  ) {}

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  snapshot = () => this.revision;

  private changed() {
    this.revision += 1;
    for (const listener of this.listeners) listener();
  }

  get(id: string | undefined): TranscriptItemBody | undefined {
    return id ? this.cache.getBody(id) : undefined;
  }

  error(id: string | undefined): string {
    return id ? this.displayed.get(id)?.error || this.errors.get(id) || "" : "";
  }

  loading(id: string | undefined): boolean {
    return !!id && this.pending.has(id);
  }

  /** Resolves with the complete body from the shared owner or the server. */
  load(id: string, size = 0): Promise<TranscriptItemBody> {
    const known = this.get(id);
    if (known) return Promise.resolve(known);
    const running = this.pending.get(id);
    if (running) return running;
    const operation = this.cache.loadBody(id, size, () => this.fetcher(this.sessionId, id)).then((body) => {
      this.errors.delete(id);
      const displayed = this.displayed.get(id);
      if (displayed) displayed.error = "";
      this.pending.delete(id);
      this.changed();
      return body;
    }, (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      this.errors.set(id, message);
      const displayed = this.displayed.get(id);
      if (displayed) displayed.error = message;
      this.pending.delete(id);
      this.changed();
      throw error;
    });
    this.pending.set(id, operation);
    this.changed();
    return operation;
  }

  /**
   * Takes the bodies the stream sent inline. The newest item of a window, and
   * of every incremental update, carries its complete body when it is small:
   * that is the step a person opens first, so it renders whole without a
   * request. The body is remembered in the cache too, so a reload of the same
   * thread still opens it offline.
   */
  accept(heads: readonly TranscriptItemHead[]) {
    let added = false;
    for (const head of heads) {
      const body = head.body;
      if (!body || this.cache.getBody(head.id)) continue;
      this.errors.delete(head.id);
      const displayed = this.displayed.get(head.id);
      if (displayed) displayed.error = "";
      this.pending.delete(head.id);
      this.cache.acceptBody(head.id, body, head.size);
      added = true;
    }
    if (added) this.changed();
  }

  /** Fire-and-forget load for a step that just opened. */
  request(id: string | undefined, size = 0) {
    if (!id || this.get(id) || this.pending.has(id) || this.error(id)) return;
    void this.load(id, size).catch(() => {});
  }

  retain(id: string): () => void {
    const release = this.cache.retainBody(id);
    let displayed = this.displayed.get(id);
    if (!displayed) this.displayed.set(id, displayed = { users: 0, error: this.errors.get(id) ?? "" });
    displayed.users++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      release();
      displayed.users--;
      if (!displayed.users) this.displayed.delete(id);
    };
  }

  retry(id: string | undefined, size = 0) {
    if (!id) return;
    this.errors.delete(id);
    const displayed = this.displayed.get(id);
    if (displayed) displayed.error = "";
    this.request(id, size);
  }
}

export const ItemBodiesContext = createContext<ItemBodies | null>(null);

export interface BodyState {
  body: TranscriptItemBody | undefined;
  loading: boolean;
  error: string;
  /** Loads the body and resolves with it, for copy actions. */
  load(): Promise<TranscriptItemBody | undefined>;
}

export function useItemBody(id: string | undefined, wanted: boolean, size = 0): BodyState {
  const bodies = useContext(ItemBodiesContext);
  useSyncExternalStore(
    bodies ? bodies.subscribe : noSubscribe,
    bodies ? bodies.snapshot : zero,
    zero,
  );
  useEffect(() => {
    if (!bodies || !wanted || !id) return;
    const release = bodies.retain(id);
    bodies.request(id, size);
    return release;
  }, [bodies, wanted, id, size]);
  return {
    body: wanted ? bodies?.get(id) : undefined,
    loading: !!bodies?.loading(id),
    error: bodies?.error(id) ?? "",
    load: async () => id && bodies ? bodies.load(id, size).catch(() => undefined) : undefined,
  };
}

const noSubscribe = () => () => {};
const zero = () => 0;

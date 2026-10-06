import type { InlineImageSnapshot, TranscriptItemBody } from "../../server/protocol";
import { ResourceCache } from "../../shared/resource-cache";
import { CACHED_HEADS, deleteCachedWindow, readCachedBody, readCachedWindow, readCachedMedia, writeCachedMedia, writeCachedBody, writeCachedWindow, type CachedWindow } from "./transcript-cache";

export interface CachedThread { transcript: CachedWindow | null; images: InlineImageSnapshot | null }
export interface BodyCache {
  retainBody(id: string): () => void;
  getBody(id: string): TranscriptItemBody | undefined;
  acceptBody(id: string, body: TranscriptItemBody, size: number): void;
  loadBody(id: string, size: number, fetcher: () => Promise<TranscriptItemBody>): Promise<TranscriptItemBody>;
}

export interface MediaLease { url: string; release(): void }
interface MediaValue { blob: Blob; url: string; retained: boolean; users: number }

const MiB = 1024 * 1024;

/** One owner per authenticated app, shared by every thread rather than every mount. */
export class ClientCache implements BodyCache {
  private threads = new ResourceCache<CachedThread>({ entries: 32, bytes: 8 * MiB, idleMs: 30 * 60_000 });
  private bodies = new ResourceCache<TranscriptItemBody>({ entries: 2_000, bytes: 32 * MiB });
  private pendingBodies = new Map<string, Promise<TranscriptItemBody>>();
  private bodyLeases = new Map<string, { users: number; body?: TranscriptItemBody }>();
  private bodyGeneration = 0;
  private writes = new Map<string, { window: CachedWindow; timer: ReturnType<typeof setTimeout> }>();
  private diskAvailable = true;
  private mediaValues = new Set<MediaValue>();
  private media = new ResourceCache<MediaValue>({ entries: 512, bytes: 32 * MiB }, Date.now, value => {
    value.retained = false;
    this.releaseMedia(value);
  });
  private pendingMedia = new Map<string, Promise<MediaValue>>();
  private mediaController = new AbortController();

  constructor(private readonly scope: () => Promise<string>) {}

  private async disk<T>(operation: () => Promise<T>, missing: T): Promise<T> {
    if (!this.diskAvailable) return missing;
    try { return await operation(); }
    catch (error) {
      if (this.diskAvailable) console.warn("Client disk cache unavailable; retaining the bounded memory cache", error);
      this.diskAvailable = false;
      return missing;
    }
  }

  thread(id: string) { return this.threads.get(id); }

  rememberThread(id: string, update: Partial<CachedThread>) {
    const current = this.threads.get(id) ?? { transcript: null, images: null };
    const transcript = update.transcript === undefined ? current.transcript : update.transcript;
    const bounded = transcript ? { ...transcript, items: transcript.items.slice(-CACHED_HEADS) } : null;
    this.threads.set(id, { ...current, ...update, transcript: bounded });
    if (update.transcript) {
      const previous = this.writes.get(id);
      if (previous) { previous.window = bounded!; return; }
      const write = { window: bounded!, timer: setTimeout(() => {
        this.writes.delete(id);
        this.persistWindow(id, write.window);
      }, 500) };
      this.writes.set(id, write);
    }
  }

  private persistWindow(id: string, window: CachedWindow) {
    void this.disk(async () => writeCachedWindow(`${await this.scope()}:${id}`, window), undefined);
  }

  async restoreThread(id: string): Promise<CachedWindow | null> {
    return this.disk(async () => readCachedWindow(`${await this.scope()}:${id}`), null);
  }

  forgetThread(id: string) {
    this.threads.delete(id);
    const write = this.writes.get(id);
    if (write) clearTimeout(write.timer);
    this.writes.delete(id);
    void this.disk(async () => deleteCachedWindow(`${await this.scope()}:${id}`), undefined);
  }

  getBody(id: string) { return this.bodyLeases.get(id)?.body ?? this.bodies.get(id); }

  retainBody(id: string): () => void {
    let lease = this.bodyLeases.get(id);
    if (!lease) this.bodyLeases.set(id, lease = { users: 0, body: this.bodies.get(id) });
    lease.users++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      lease.users--;
      if (!lease.users && this.bodyLeases.get(id) === lease) this.bodyLeases.delete(id);
    };
  }

  acceptBody(id: string, body: TranscriptItemBody, size: number) {
    if (this.getBody(id)) return;
    const lease = this.bodyLeases.get(id);
    if (lease) lease.body = body;
    this.bodies.set(id, body);
    void this.disk(async () => writeCachedBody(`${await this.scope()}:body:${id}`, body, size), undefined);
  }

  loadBody(id: string, size: number, fetcher: () => Promise<TranscriptItemBody>): Promise<TranscriptItemBody> {
    const body = this.getBody(id);
    if (body) return Promise.resolve(body);
    const running = this.pendingBodies.get(id);
    if (running) return running;
    const generation = this.bodyGeneration;
    const pending = (async () => {
      const cached = await this.disk(async () => readCachedBody(`${await this.scope()}:body:${id}`), null);
      const value = this.getBody(id) ?? cached ?? await fetcher();
      if (generation !== this.bodyGeneration) return value;
      const lease = this.bodyLeases.get(id);
      if (lease) lease.body = value;
      if (cached) this.bodies.set(id, value);
      else {
        this.bodies.set(id, value);
        void this.disk(async () => writeCachedBody(`${await this.scope()}:body:${id}`, value, size), undefined);
      }
      return value;
    })().finally(() => { if (this.pendingBodies.get(id) === pending) this.pendingBodies.delete(id); });
    this.pendingBodies.set(id, pending);
    return pending;
  }

  getMedia(id: string): string | undefined { return this.media.get(id)?.url; }

  private releaseMedia(value: MediaValue) {
    if (value.retained || value.users) return;
    if (value.url) URL.revokeObjectURL(value.url);
    value.url = "";
    this.mediaValues.delete(value);
  }

  async acquireMedia(id: string, fetcher: (signal: AbortSignal) => Promise<Blob>): Promise<MediaLease> {
    const signal = this.mediaController.signal;
    let value = this.media.get(id);
    if (!value) {
      let pending = this.pendingMedia.get(id);
      if (!pending) {
        pending = (async () => {
          const key = `${await this.scope()}:media:${id}`;
          signal.throwIfAborted();
          const cached = await this.disk(() => readCachedMedia(key), null);
          signal.throwIfAborted();
          const blob = cached ?? await fetcher(signal);
          signal.throwIfAborted();
          const entry: MediaValue = { blob, url: URL.createObjectURL(blob), retained: false, users: 0 };
          this.mediaValues.add(entry);
          entry.retained = this.media.set(id, entry, blob.size);
          if (!cached) void this.disk(() => writeCachedMedia(key, blob), undefined);
          return entry;
        })();
        this.pendingMedia.set(id, pending);
        const settled = () => { if (this.pendingMedia.get(id) === pending) this.pendingMedia.delete(id); };
        void pending.then(settled, settled);
      }
      value = await pending;
    }
    signal.throwIfAborted();
    // An entry can be evicted between its shared load and a consumer taking a lease.
    if (!value.url) { value.url = URL.createObjectURL(value.blob); this.mediaValues.add(value); }
    value.users++;
    let released = false;
    return { url: value.url, release: () => {
      if (released) return;
      released = true;
      value.users--;
      this.releaseMedia(value);
    } };
  }

  dispose() {
    for (const [id, write] of this.writes) {
      clearTimeout(write.timer);
      this.persistWindow(id, write.window);
    }
    this.writes.clear();
    this.threads.clear();
    this.bodyGeneration++;
    this.pendingBodies.clear();
    this.bodyLeases.clear();
    this.bodies.clear();
    this.mediaController.abort();
    this.mediaController = new AbortController();
    this.pendingMedia.clear();
    this.media.clear();
    for (const value of this.mediaValues) {
      if (value.url) URL.revokeObjectURL(value.url);
      value.url = "";
    }
    this.mediaValues.clear();
  }
}

import type { InlineImageSnapshot, TranscriptItemBody } from "../../server/protocol";
import { ResourceCache } from "./resource-cache";
import { CACHED_HEADS, deleteCachedWindow, readCachedBody, readCachedWindow, writeCachedBody, writeCachedWindow, type CachedWindow } from "./transcript-cache";

export interface CachedThread { transcript: CachedWindow | null; images: InlineImageSnapshot | null }
export interface BodyCache {
  getBody(id: string): TranscriptItemBody | undefined;
  acceptBody(id: string, body: TranscriptItemBody, size: number): void;
  loadBody(id: string, size: number, fetcher: () => Promise<TranscriptItemBody>): Promise<TranscriptItemBody>;
}

const MiB = 1024 * 1024;

/** One owner per authenticated app, shared by every thread rather than every mount. */
export class ClientCache implements BodyCache {
  private threads = new ResourceCache<CachedThread>({ entries: 32, bytes: 8 * MiB, idleMs: 30 * 60_000 });
  private bodies = new ResourceCache<TranscriptItemBody>({ entries: 2_000, bytes: 32 * MiB });
  private pendingBodies = new Map<string, Promise<TranscriptItemBody>>();
  private writes = new Map<string, { window: CachedWindow; timer: ReturnType<typeof setTimeout> }>();
  private diskAvailable = true;

  constructor(private readonly scope: () => Promise<string>) {}

  private async disk<T>(operation: () => Promise<T>, missing: T): Promise<T> {
    if (!this.diskAvailable) return missing;
    try { return await operation(); }
    catch (error) {
      if (this.diskAvailable) console.warn("Transcript disk cache unavailable; retaining the bounded memory cache", error);
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

  getBody(id: string) { return this.bodies.get(id); }

  acceptBody(id: string, body: TranscriptItemBody, size: number) {
    if (this.bodies.get(id)) return;
    this.bodies.set(id, body);
    void this.disk(async () => writeCachedBody(`${await this.scope()}:body:${id}`, body, size), undefined);
  }

  loadBody(id: string, size: number, fetcher: () => Promise<TranscriptItemBody>): Promise<TranscriptItemBody> {
    const body = this.bodies.get(id);
    if (body) return Promise.resolve(body);
    const running = this.pendingBodies.get(id);
    if (running) return running;
    const pending = (async () => {
      const cached = await this.disk(async () => readCachedBody(`${await this.scope()}:body:${id}`), null);
      const value = this.bodies.get(id) ?? cached ?? await fetcher();
      if (cached) this.bodies.set(id, value);
      else this.acceptBody(id, value, size);
      return value;
    })().finally(() => { this.pendingBodies.delete(id); });
    this.pendingBodies.set(id, pending);
    return pending;
  }

  dispose() {
    for (const [id, write] of this.writes) {
      clearTimeout(write.timer);
      this.persistWindow(id, write.window);
    }
    this.writes.clear();
    this.threads.clear();
    this.bodies.clear();
  }
}

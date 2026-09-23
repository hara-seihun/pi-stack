import { abortable } from "./abortable";
import { appStorageKey } from "./app-path";
import type { TranscriptItemBody, TranscriptItemHead } from "../../server/protocol";

const DATABASE = "pi-remote-transcript";
const DATABASE_VERSION = 2;
const BODIES = "bodies";
const WINDOWS = "windows";
const METADATA = "metadata";
const USED_AT = "bucketUsedAt";
const MAX_BODIES = 2_000;
const MAX_BODY_BYTES = 64 * 1024 * 1024;
const MAX_WINDOWS = 32;
const MAX_WINDOW_BYTES = 8 * 1024 * 1024;
export const CACHED_HEADS = 200;

export interface CachedWindow { generation: string; total: number; items: TranscriptItemHead[] }

interface StoredBody { id: string; body: TranscriptItemBody; size?: unknown; usedAt?: unknown }
interface StoredWindow extends CachedWindow { key: string; updatedAt?: unknown }
type Bucket = typeof BODIES | typeof WINDOWS;

interface CacheEntry {
  key: [Bucket, string];
  bucket: Bucket;
  entryKey: string;
  size: number;
  usedAt: number;
}

interface CacheStats {
  key: [Bucket];
  count: number;
  bytes: number;
  clock: number;
}

let databasePromise: Promise<IDBDatabase> | null = null;

function jsonBytes(value: unknown) {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

function storedSize(value: unknown, maximum: number): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= maximum ? value : null;
}

function usageTime(stats: CacheStats) {
  stats.clock = Math.max(Date.now(), stats.clock + 1);
  return stats.clock;
}

function emptyStats(bucket: Bucket): CacheStats {
  return { key: [bucket], count: 0, bytes: 0, clock: 0 };
}

function migrateStore(
  transaction: IDBTransaction,
  metadata: IDBObjectStore,
  bucket: Bucket,
  maximumCount: number,
  maximumBytes: number,
  entry: (value: unknown) => CacheEntry | null,
) {
  const payloads = transaction.objectStore(bucket);
  const entries: CacheEntry[] = [];
  const cursorRequest = payloads.openCursor();
  cursorRequest.onsuccess = () => {
    const cursor = cursorRequest.result;
    if (cursor) {
      const candidate = entry(cursor.value);
      if (candidate) entries.push(candidate);
      else cursor.delete();
      cursor.continue();
      return;
    }

    entries.sort((left, right) => left.usedAt - right.usedAt || left.entryKey.localeCompare(right.entryKey));
    let count = entries.length;
    let bytes = entries.reduce((total, candidate) => total + candidate.size, 0);
    let first = 0;
    while (first < entries.length && (count > maximumCount || bytes > maximumBytes)) {
      const expired = entries[first++]!;
      payloads.delete(expired.entryKey);
      count -= 1;
      bytes -= expired.size;
    }
    for (let index = first; index < entries.length; index++) metadata.put(entries[index]!);
    metadata.put({
      key: [bucket], count, bytes,
      clock: entries.reduce((latest, candidate) => Math.max(latest, candidate.usedAt), 0),
    } satisfies CacheStats);
  };
}

function database() {
  if (typeof indexedDB === "undefined") return Promise.reject(new Error("This browser has no IndexedDB"));
  if (!databasePromise) {
    const opening = new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(appStorageKey(DATABASE), DATABASE_VERSION);
      request.onupgradeneeded = (event) => {
        const db = request.result;
        const transaction = request.transaction!;
        if (!db.objectStoreNames.contains(BODIES)) db.createObjectStore(BODIES, { keyPath: "id" });
        if (!db.objectStoreNames.contains(WINDOWS)) db.createObjectStore(WINDOWS, { keyPath: "key" });
        if ((event as IDBVersionChangeEvent).oldVersion >= DATABASE_VERSION) return;

        const metadata = db.createObjectStore(METADATA, { keyPath: "key" });
        metadata.createIndex(USED_AT, ["bucket", "usedAt"]);
        migrateStore(transaction, metadata, BODIES, MAX_BODIES, MAX_BODY_BYTES, (raw) => {
          const value = raw as StoredBody;
          if (typeof value?.id !== "string" || !value.body) return null;
          const hasRecordedSize = typeof value.size === "number" && Number.isSafeInteger(value.size) && value.size >= 0;
          const recordedSize = hasRecordedSize ? storedSize(value.size, MAX_BODY_BYTES) : 0;
          if (recordedSize === null) return null;
          const size = Math.max(recordedSize, jsonBytes(value.body));
          if (size > MAX_BODY_BYTES) return null;
          return {
            key: [BODIES, value.id], bucket: BODIES, entryKey: value.id, size,
            usedAt: typeof value.usedAt === "number" && Number.isFinite(value.usedAt) ? Math.max(0, value.usedAt) : 0,
          };
        });
        migrateStore(transaction, metadata, WINDOWS, MAX_WINDOWS, MAX_WINDOW_BYTES, (raw) => {
          const value = raw as StoredWindow;
          if (typeof value?.key !== "string") return null;
          const size = jsonBytes(value);
          if (size > MAX_WINDOW_BYTES) return null;
          return {
            key: [WINDOWS, value.key], bucket: WINDOWS, entryKey: value.key, size,
            usedAt: typeof value.updatedAt === "number" && Number.isFinite(value.updatedAt) ? Math.max(0, value.updatedAt) : 0,
          };
        });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error("Could not open the transcript cache"));
    });
    databasePromise = opening;
    const reset = () => { if (databasePromise === opening) databasePromise = null; };
    void opening.then((db) => {
      db.onversionchange = () => { db.close(); reset(); };
      db.onclose = reset;
    }, reset);
  }
  return abortable(databasePromise, AbortSignal.timeout(2_000));
}

function completion(transaction: IDBTransaction) {
  return new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error || new Error("Transcript cache transaction failed"));
    transaction.onabort = () => reject(transaction.error || new Error("Transcript cache transaction aborted"));
  });
}

function result<T>(request: IDBRequest<T>) {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("Transcript cache request failed"));
  });
}

async function loadStats(store: IDBObjectStore, bucket: Bucket) {
  return (await result<CacheStats | undefined>(store.get([bucket]))) ?? emptyStats(bucket);
}

function removeEntry(stats: CacheStats, entry: CacheEntry) {
  stats.count = Math.max(0, stats.count - 1);
  stats.bytes = Math.max(0, stats.bytes - entry.size);
}

function trim(
  transaction: IDBTransaction,
  stats: CacheStats,
  maximumCount: number,
  maximumBytes: number,
) {
  if (stats.count <= maximumCount && stats.bytes <= maximumBytes) return Promise.resolve();
  const metadata = transaction.objectStore(METADATA);
  const range = IDBKeyRange.bound([stats.key[0], 0], [stats.key[0], Number.MAX_SAFE_INTEGER]);
  return new Promise<void>((resolve, reject) => {
    const request = metadata.index(USED_AT).openCursor(range);
    request.onerror = () => reject(request.error || new Error("Could not trim the transcript cache"));
    request.onsuccess = () => {
      if (stats.count <= maximumCount && stats.bytes <= maximumBytes) {
        resolve();
        return;
      }
      const cursor = request.result;
      if (!cursor) {
        stats.count = 0;
        stats.bytes = 0;
        resolve();
        return;
      }
      const expired = cursor.value as CacheEntry;
      transaction.objectStore(expired.bucket).delete(expired.entryKey);
      cursor.delete();
      removeEntry(stats, expired);
      cursor.continue();
    };
  });
}

export async function readCachedBody(id: string): Promise<TranscriptItemBody | null> {
  const db = await database();
  const transaction = db.transaction([BODIES, METADATA], "readwrite");
  const done = completion(transaction);
  const metadata = transaction.objectStore(METADATA);
  const [stored, entry, stats] = await Promise.all([
    result<StoredBody | undefined>(transaction.objectStore(BODIES).get(id)),
    result<CacheEntry | undefined>(metadata.get([BODIES, id])),
    loadStats(metadata, BODIES),
  ]);
  if (!stored) {
    if (entry) {
      metadata.delete(entry.key);
      removeEntry(stats, entry);
      metadata.put(stats);
    }
    await done;
    return null;
  }
  if (entry) {
    entry.usedAt = usageTime(stats);
    metadata.put(entry);
    metadata.put(stats);
  }
  await done;
  return stored.body;
}

export async function writeCachedBody(id: string, body: TranscriptItemBody, size: number) {
  const recordedSize = storedSize(size, MAX_BODY_BYTES);
  const acceptedSize = recordedSize === null ? null : storedSize(Math.max(recordedSize, jsonBytes(body)), MAX_BODY_BYTES);
  const db = await database();
  const transaction = db.transaction([BODIES, METADATA], "readwrite");
  const done = completion(transaction);
  const payloads = transaction.objectStore(BODIES);
  const metadata = transaction.objectStore(METADATA);
  const [previous, stats] = await Promise.all([
    result<CacheEntry | undefined>(metadata.get([BODIES, id])),
    loadStats(metadata, BODIES),
  ]);
  if (acceptedSize === null) {
    payloads.delete(id);
    if (previous) {
      metadata.delete(previous.key);
      removeEntry(stats, previous);
      metadata.put(stats);
    }
    await done;
    return;
  }

  const entry: CacheEntry = {
    key: [BODIES, id], bucket: BODIES, entryKey: id, size: acceptedSize, usedAt: usageTime(stats),
  };
  payloads.put({ id, body } satisfies StoredBody);
  metadata.put(entry);
  if (previous) stats.bytes += acceptedSize - previous.size;
  else {
    stats.count += 1;
    stats.bytes += acceptedSize;
  }
  await trim(transaction, stats, MAX_BODIES, MAX_BODY_BYTES);
  metadata.put(stats);
  await done;
}

export async function readCachedWindow(key: string): Promise<CachedWindow | null> {
  const db = await database();
  const transaction = db.transaction([WINDOWS, METADATA], "readwrite");
  const done = completion(transaction);
  const metadata = transaction.objectStore(METADATA);
  const [stored, entry, stats] = await Promise.all([
    result<StoredWindow | undefined>(transaction.objectStore(WINDOWS).get(key)),
    result<CacheEntry | undefined>(metadata.get([WINDOWS, key])),
    loadStats(metadata, WINDOWS),
  ]);
  if (!stored || typeof stored.generation !== "string" || !Array.isArray(stored.items)) {
    if (entry) {
      metadata.delete(entry.key);
      removeEntry(stats, entry);
      metadata.put(stats);
    }
    await done;
    return null;
  }
  if (entry) {
    entry.usedAt = usageTime(stats);
    metadata.put(entry);
    metadata.put(stats);
  }
  await done;
  return { generation: stored.generation, total: Number(stored.total) || stored.items.length, items: stored.items };
}

export async function writeCachedWindow(key: string, window: CachedWindow) {
  const stored: StoredWindow = {
    key, generation: window.generation, total: window.total, items: window.items.slice(-CACHED_HEADS),
  };
  const size = jsonBytes(stored);
  const db = await database();
  const transaction = db.transaction([WINDOWS, METADATA], "readwrite");
  const done = completion(transaction);
  const payloads = transaction.objectStore(WINDOWS);
  const metadata = transaction.objectStore(METADATA);
  const [previous, stats] = await Promise.all([
    result<CacheEntry | undefined>(metadata.get([WINDOWS, key])),
    loadStats(metadata, WINDOWS),
  ]);
  if (size > MAX_WINDOW_BYTES) {
    payloads.delete(key);
    if (previous) {
      metadata.delete(previous.key);
      removeEntry(stats, previous);
      metadata.put(stats);
    }
    await done;
    return;
  }

  const entry: CacheEntry = {
    key: [WINDOWS, key], bucket: WINDOWS, entryKey: key, size, usedAt: usageTime(stats),
  };
  payloads.put(stored);
  metadata.put(entry);
  if (previous) stats.bytes += size - previous.size;
  else {
    stats.count += 1;
    stats.bytes += size;
  }
  await trim(transaction, stats, MAX_WINDOWS, MAX_WINDOW_BYTES);
  metadata.put(stats);
  await done;
}

export async function deleteCachedWindow(key: string) {
  const db = await database();
  const transaction = db.transaction([WINDOWS, METADATA], "readwrite");
  const done = completion(transaction);
  const metadata = transaction.objectStore(METADATA);
  const [entry, stats] = await Promise.all([
    result<CacheEntry | undefined>(metadata.get([WINDOWS, key])),
    loadStats(metadata, WINDOWS),
  ]);
  transaction.objectStore(WINDOWS).delete(key);
  if (entry) {
    metadata.delete(entry.key);
    removeEntry(stats, entry);
    metadata.put(stats);
  }
  await done;
}

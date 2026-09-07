import { abortable } from "./abortable";
import { updateDocument } from "./sync";

const DATABASE = "pi-remote-contexts";
const STORE = "contexts";
const MAX_CONTEXTS = 32;
const MAX_CONTEXT_BYTES = 2 * 1024 * 1024;

export interface CachedContext extends SyncDocument { key: string; updatedAt: number }
let databasePromise: Promise<IDBDatabase> | null = null;

function database() {
  if (!databasePromise) {
    const opening = new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(DATABASE, 2);
      request.onupgradeneeded = () => {
        // Cache only the small display projection, not prior canonical images.
        if (request.result.objectStoreNames.contains(STORE)) request.result.deleteObjectStore(STORE);
        const store = request.result.createObjectStore(STORE, { keyPath: "key" });
        store.createIndex("updatedAt", "updatedAt");
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error("Could not open the context cache"));
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
    transaction.onerror = () => reject(transaction.error || new Error("Context cache transaction failed"));
    transaction.onabort = () => reject(transaction.error || new Error("Context cache transaction aborted"));
  });
}

export async function readCachedContext(key: string): Promise<CachedContext | null> {
  const db = await database();
  const transaction = db.transaction(STORE, "readonly");
  const done = completion(transaction);
  const request = transaction.objectStore(STORE).get(key);
  const [value] = await Promise.all([new Promise<CachedContext | null>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result || null);
    request.onerror = () => reject(request.error || new Error("Could not read cached context"));
  }), done]);
  if (!value) return null;
  try {
    if (typeof value.document !== "string" || value.document.length * 2 > MAX_CONTEXT_BYTES) throw new Error("Invalid cached context size");
    await updateDocument(null, { kind: "full", document: value.document, hash: value.hash, capturedAt: value.capturedAt ?? 0 });
    JSON.parse(value.document);
    return value;
  } catch {
    await deleteCachedContext(key);
    return null;
  }
}

export async function writeCachedContext(key: string, context: SyncDocument) {
  if (context.document.length * 2 > MAX_CONTEXT_BYTES) return deleteCachedContext(key);
  const db = await database();
  const transaction = db.transaction(STORE, "readwrite");
  const done = completion(transaction);
  const store = transaction.objectStore(STORE);
  store.put({ key, ...context, updatedAt: Date.now() });
  const request = store.index("updatedAt").getAllKeys();
  request.onsuccess = () => {
    const keys = request.result;
    for (const expired of keys.slice(0, Math.max(0, keys.length - MAX_CONTEXTS))) store.delete(expired);
  };
  await done;
}

export async function deleteCachedContext(key: string) {
  const db = await database();
  const transaction = db.transaction(STORE, "readwrite");
  const done = completion(transaction);
  transaction.objectStore(STORE).delete(key);
  await done;
}

const DATABASE = "pi-remote-contexts";
const STORE = "contexts";
const MAX_CONTEXTS = 32;

export interface CachedContext extends SyncDocument { key: string; updatedAt: number }
let databasePromise: Promise<IDBDatabase> | null = null;

function database() {
  if (!databasePromise) databasePromise = new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DATABASE, 1);
    request.onupgradeneeded = () => {
      const store = request.result.createObjectStore(STORE, { keyPath: "key" });
      store.createIndex("updatedAt", "updatedAt");
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("Could not open the context cache"));
  });
  return databasePromise;
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
  const value = await new Promise<CachedContext | null>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result || null);
    request.onerror = () => reject(request.error || new Error("Could not read cached context"));
  });
  await done;
  return value;
}

export async function writeCachedContext(key: string, context: SyncDocument) {
  const db = await database();
  const transaction = db.transaction(STORE, "readwrite");
  const done = completion(transaction);
  const store = transaction.objectStore(STORE);
  store.put({ key, ...context, updatedAt: Date.now() });
  const keys = await new Promise<IDBValidKey[]>((resolve, reject) => {
    const request = store.index("updatedAt").getAllKeys();
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("Could not prune cached contexts"));
  });
  for (const expired of keys.slice(0, Math.max(0, keys.length - MAX_CONTEXTS))) store.delete(expired);
  await done;
}

export async function deleteCachedContext(key: string) {
  const db = await database();
  const transaction = db.transaction(STORE, "readwrite");
  const done = completion(transaction);
  transaction.objectStore(STORE).delete(key);
  await done;
}

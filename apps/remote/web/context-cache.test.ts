import { afterEach, beforeEach, expect, test } from "bun:test";
import { IDBFactory } from "fake-indexeddb";
import { sha256 } from "../server/sync";
import { readCachedContext, writeCachedContext } from "./src/context-cache";

const original = globalThis.indexedDB;
const originalLocation = Object.getOwnPropertyDescriptor(globalThis, "location");
let factory: IDBFactory;
beforeEach(() => {
  Object.defineProperty(globalThis, "location", { configurable: true, value: new URL("https://router.test/") });
  factory = new IDBFactory(); globalThis.indexedDB = factory;
});
afterEach(async () => {
  await new Promise<void>((resolve, reject) => {
    const request = factory.deleteDatabase("pi-remote-contexts");
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
  globalThis.indexedDB = original;
  if (originalLocation) Object.defineProperty(globalThis, "location", originalLocation);
  else delete (globalThis as any).location;
});
function document(text: string) {
  return { document: text, hash: sha256(text), capturedAt: 1 };
}

test("the display cache discards canonical-image records on upgrade", async () => {
  const db = await new Promise<IDBDatabase>((resolve) => {
    const request = factory.open("pi-remote-contexts", 1);
    request.onupgradeneeded = () => {
      const store = request.result.createObjectStore("contexts", { keyPath: "key" });
      store.createIndex("updatedAt", "updatedAt");
      store.put({ key: "canonical", ...document('{"image":"data:image/png;base64,AAAA"}'), updatedAt: 1 });
    };
    request.onsuccess = () => resolve(request.result);
  });
  db.close();
  expect(await readCachedContext("canonical")).toBeNull();
  await writeCachedContext("display", document('{"messages":[]}'));
  expect((await readCachedContext("display"))?.document).toBe('{"messages":[]}');
});

test("an upgrade blocked by another tab times out without poisoning the eventual connection", async () => {
  const blocker = await new Promise<IDBDatabase>((resolve) => {
    const request = factory.open("pi-remote-contexts", 1);
    request.onsuccess = () => resolve(request.result);
  });
  try {
    await expect(readCachedContext("thread")).rejects.toMatchObject({ name: "TimeoutError" });
  } finally { blocker.close(); }
  await writeCachedContext("thread", document('{"messages":[]}'));
  expect(await readCachedContext("thread")).not.toBeNull();
});

test("a failed open is retryable and damaged cached documents are removed", async () => {
  const open = factory.open.bind(factory);
  let fail = true;
  factory.open = (...args) => {
    if (fail) { fail = false; throw new Error("Storage is temporarily unavailable"); }
    return open(...args);
  };
  await expect(readCachedContext("thread")).rejects.toThrow("Storage is temporarily unavailable");
  await writeCachedContext("thread", { ...document('{"messages":[]}'), hash: "corrupt" });
  expect(await readCachedContext("thread")).toBeNull();
  await writeCachedContext("thread", document("invalid JSON"));
  expect(await readCachedContext("thread")).toBeNull();
  await writeCachedContext("thread", document('{"messages":[]}'));
  expect((await readCachedContext("thread"))?.hash).toBe(sha256('{"messages":[]}'));
});

test("cache bounds count and size, removing a previous copy when its replacement is too large", async () => {
  for (let i = 0; i < 40; i++) await writeCachedContext(`thread-${String(i).padStart(2, "0")}`, document(JSON.stringify({ i })));
  expect(await readCachedContext("thread-00")).toBeNull();
  expect(await readCachedContext("thread-39")).not.toBeNull();
  await writeCachedContext("thread-39", document(JSON.stringify("A".repeat(2 * 1024 * 1024))));
  expect(await readCachedContext("thread-39")).toBeNull();
});

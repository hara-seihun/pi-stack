import { afterEach, beforeEach, expect, test } from "bun:test";
import { IDBFactory } from "fake-indexeddb";
import { sha256 } from "../server/sync";
import { readCachedContext, writeCachedContext } from "./src/context-cache";

const original = globalThis.indexedDB;
let factory: IDBFactory;
beforeEach(() => { factory = new IDBFactory(); globalThis.indexedDB = factory; });
afterEach(async () => {
  await new Promise<void>((resolve, reject) => {
    const request = factory.deleteDatabase("pi-remote-contexts");
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
  globalThis.indexedDB = original;
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
  expect(await readCachedContext("canonical", "generation-1")).toBeNull();
  await writeCachedContext("display", "generation-1", document('{"messages":[]}'));
  expect((await readCachedContext("display", "generation-1"))?.document).toBe('{"messages":[]}');
});

test("an upgrade blocked by another tab times out without poisoning the eventual connection", async () => {
  const blocker = await new Promise<IDBDatabase>((resolve) => {
    const request = factory.open("pi-remote-contexts", 1);
    request.onsuccess = () => resolve(request.result);
  });
  try {
    await expect(readCachedContext("thread", "generation-1")).rejects.toMatchObject({ name: "TimeoutError" });
  } finally { blocker.close(); }
  await writeCachedContext("thread", "generation-1", document('{"messages":[]}'));
  expect(await readCachedContext("thread", "generation-1")).not.toBeNull();
});

test("a failed open is retryable and damaged cached documents are removed", async () => {
  const open = factory.open.bind(factory);
  let fail = true;
  factory.open = (...args) => {
    if (fail) { fail = false; throw new Error("Storage is temporarily unavailable"); }
    return open(...args);
  };
  await expect(readCachedContext("thread", "generation-1")).rejects.toThrow("Storage is temporarily unavailable");
  await writeCachedContext("thread", "generation-1", { ...document('{"messages":[]}'), hash: "corrupt" });
  expect(await readCachedContext("thread", "generation-1")).toBeNull();
  await writeCachedContext("thread", "generation-1", document("invalid JSON"));
  expect(await readCachedContext("thread", "generation-1")).toBeNull();
  await writeCachedContext("thread", "generation-1", document('{"messages":[]}'));
  expect((await readCachedContext("thread", "generation-1"))?.hash).toBe(sha256('{"messages":[]}'));
});

test("a core switch removes the previous generation instead of hydrating it", async () => {
  await writeCachedContext("thread", "generation-1", document('{"messages":["old"]}'));
  expect(await readCachedContext("thread", "generation-2")).toBeNull();
  expect(await readCachedContext("thread", "generation-1")).toBeNull();
});

test("cache bounds count and size, removing a previous copy when its replacement is too large", async () => {
  for (let i = 0; i < 40; i++) await writeCachedContext(`thread-${String(i).padStart(2, "0")}`, "generation-1", document(JSON.stringify({ i })));
  expect(await readCachedContext("thread-00", "generation-1")).toBeNull();
  expect(await readCachedContext("thread-39", "generation-1")).not.toBeNull();
  await writeCachedContext("thread-39", "generation-1", document(JSON.stringify("A".repeat(2 * 1024 * 1024))));
  expect(await readCachedContext("thread-39", "generation-1")).toBeNull();
});

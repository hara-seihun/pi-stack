import { afterAll, expect, test } from "bun:test";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { ClientCache } from "./src/client-cache";
import { ResourceCache } from "../shared/resource-cache";
import { ItemBodies } from "./src/features/conversation/item-bodies";
import { readCachedBody, readCachedWindow, writeCachedBody, writeCachedWindow } from "./src/transcript-cache";
import type { TranscriptItemBody } from "../server/protocol";

const previousLocation = globalThis.location;
const previousDatabase = globalThis.indexedDB;
const previousKeyRange = globalThis.IDBKeyRange;
globalThis.indexedDB ??= new IDBFactory();
globalThis.IDBKeyRange ??= IDBKeyRange;
globalThis.location ??= new URL("http://localhost/") as unknown as Location;
afterAll(() => { globalThis.location = previousLocation; globalThis.indexedDB = previousDatabase; globalThis.IDBKeyRange = previousKeyRange; });

const body: TranscriptItemBody = { kind: "assistant", text: "A cached answer" };

test("memory eviction uses access order, byte and entry budgets, and idle expiry", () => {
  let now = 0;
  const cache = new ResourceCache<string>({ entries: 2, bytes: 8, idleMs: 10 }, () => now);
  cache.set("a", "A", 3);
  cache.set("b", "B", 3);
  expect(cache.get("a")).toBe("A");
  cache.set("c", "C", 3);
  expect(cache.get("b")).toBeUndefined();
  expect(cache.byteSize).toBe(6);
  cache.set("d", "D", 7);
  expect(cache.size).toBe(1);
  expect(cache.set("too-big", "large", 9)).toBe(false);
  expect(cache.get("d")).toBe("D");
  now = 10;
  expect(cache.get("d")).toBeUndefined();
  expect(cache.byteSize).toBe(0);
});

test("reopening a thread returns heads, images and exact bodies synchronously", async () => {
  const cache = new ClientCache(async () => "reopen");
  let requests = 0;
  const fetcher = async () => { requests++; return body; };
  const first = new ItemBodies("thread-a", fetcher, cache);
  await first.load("answer", 100);
  cache.rememberThread("thread-a", { transcript: { generation: "one", total: 0, items: [] }, images: { version: 4, images: [] } });
  const reopened = new ItemBodies("thread-a", fetcher, cache);
  expect(reopened.get("answer")).toEqual(body);
  expect(cache.thread("thread-a")?.transcript?.generation).toBe("one");
  expect(cache.thread("thread-a")?.images?.version).toBe(4);
  await reopened.load("answer", 100);
  expect(requests).toBe(1);
  cache.rememberThread("thread-a", { transcript: { generation: "two", total: 0, items: [] } });
  expect(cache.thread("thread-a")?.transcript?.generation).toBe("two");
  cache.forgetThread("thread-a");
  expect(cache.thread("thread-a")).toBeUndefined();
  cache.dispose();
});

test("in-flight bodies survive navigation without duplicate requests, and failures can retry", async () => {
  const cache = new ClientCache(async () => "in-flight");
  let requests = 0;
  let finish!: (body: TranscriptItemBody) => void;
  let started!: () => void;
  const requestStarted = new Promise<void>(resolve => { started = resolve; });
  const fetcher = () => { requests++; started(); return new Promise<TranscriptItemBody>(resolve => { finish = resolve; }); };
  const first = new ItemBodies("thread", fetcher, cache);
  const reopened = new ItemBodies("thread", fetcher, cache);
  const a = first.load("pending", 100);
  const b = reopened.load("pending", 100);
  await requestStarted;
  expect(requests).toBe(1);
  finish(body);
  expect(await a).toEqual(await b);
  await expect(cache.loadBody("failure", 100, async () => { throw new Error("offline"); })).rejects.toThrow("offline");
  expect(await cache.loadBody("failure", 100, async () => body)).toEqual(body);
  cache.dispose();
});

test("persistent budgets evict by read order and reject oversized replacements", async () => {
  const MiB = 1024 * 1024;
  await writeCachedBody("disk-a", body, 24 * MiB);
  await writeCachedBody("disk-b", body, 24 * MiB);
  expect(await readCachedBody("disk-a")).toEqual(body);
  await writeCachedBody("disk-c", body, 24 * MiB);
  expect(await readCachedBody("disk-b")).toBeNull();
  expect(await readCachedBody("disk-a")).toEqual(body);
  await writeCachedBody("disk-a", body, 65 * MiB);
  expect(await readCachedBody("disk-a")).toBeNull();
  const window = { generation: "disk", total: 0, items: [] };
  for (let i = 0; i < 32; i++) await writeCachedWindow(`disk-window-${i}`, window);
  await readCachedWindow("disk-window-0");
  await writeCachedWindow("disk-window-32", window);
  expect(await readCachedWindow("disk-window-1")).toBeNull();
  expect(await readCachedWindow("disk-window-0")).toEqual(window);
});

test("cache ownership isolates people and environments even for identical body ids", async () => {
  const first = new ClientCache(async () => "person-a:local");
  const second = new ClientCache(async () => "person-b:remote");
  await first.loadBody("same-id", 100, async () => body);
  expect(second.getBody("same-id")).toBeUndefined();
  const other: TranscriptItemBody = { kind: "assistant", text: "Other person" };
  expect(await second.loadBody("same-id", 100, async () => other)).toEqual(other);
  first.dispose(); second.dispose();
});

import { afterAll, expect, test } from "bun:test";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { ClientCache } from "./src/client-cache";
import { CachedImage, ClientCacheContext, mediaCacheKey } from "./src/cached-media";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

const previous = { location: globalThis.location, indexedDB: globalThis.indexedDB, IDBKeyRange: globalThis.IDBKeyRange };
globalThis.location ??= new URL("https://router.test/pi-stack/") as unknown as Location;
globalThis.indexedDB ??= new IDBFactory();
globalThis.IDBKeyRange ??= IDBKeyRange;
afterAll(() => Object.assign(globalThis, previous));

const picture = () => new Blob(["picture"], { type: "image/png" });

test("avatar identity changes with its version, not credentials; mutable files bypass persistence", () => {
  const path = "https://router.test/pi-stack/v1/remotes/home/v1/messaging/backends/slack/avatars/alice";
  const key = mediaCacheKey(`${path}?v=1&user=alice&session=secret`);
  expect(key).toBe(`${path}?v=1`);
  expect(mediaCacheKey(`${path}?v=1&user=alice&session=renewed`)).toBe(key);
  expect(mediaCacheKey(`${path}?v=2&session=secret`)).not.toBe(key);
  expect(mediaCacheKey(path)).toBeNull();
  expect(mediaCacheKey("/v1/files/download?path=/mutable.png")).toBeNull();
  expect(mediaCacheKey("https://images.example/photo.jpg")).toBeNull();
  expect(mediaCacheKey("/v1/messaging/preview-images/hash?session=secret")).not.toContain("secret");
});

test("navigation and simultaneous avatar consumers share one load and a synchronously reusable URL", async () => {
  const cache = new ClientCache(async () => "media-navigation");
  let requests = 0;
  const fetcher = async () => { requests++; return picture(); };
  const [row, header] = await Promise.all([cache.acquireMedia("avatar-v1", fetcher), cache.acquireMedia("avatar-v1", fetcher)]);
  expect(requests).toBe(1);
  expect(row.url).toBe(header.url);
  row.release(); header.release();
  expect(cache.getMedia("avatar-v1")).toBe(row.url);
  const reopened = await cache.acquireMedia("avatar-v1", fetcher);
  expect(reopened.url).toBe(row.url);
  expect(requests).toBe(1);
  reopened.release();
  cache.dispose();
});

test("a remounted avatar paints the retained image before effects or network", async () => {
  const cache = new ClientCache(async () => "media-paint");
  const src = "https://router.test/v1/messaging/backends/slack/avatars/alice?v=1&session=secret";
  const lease = await cache.acquireMedia(mediaCacheKey(src)!, async () => picture());
  lease.release();
  const markup = renderToStaticMarkup(createElement(ClientCacheContext.Provider, { value: cache },
    createElement(CachedImage, { src, alt: "Alice", fallback: "loading-picture" })));
  expect(markup).toContain(`src="${lease.url}"`);
  expect(markup).not.toContain("loading-picture");
  cache.dispose();
});

test("restarting restores media from the same shared disk owner, with person/environment isolation", async () => {
  const first = new ClientCache(async () => "media-person:home");
  const lease = await first.acquireMedia("avatar", async () => picture());
  lease.release(); first.dispose();
  const reopened = new ClientCache(async () => "media-person:home");
  const restored = await reopened.acquireMedia("avatar", async () => { throw new Error("must not refetch persisted image"); });
  expect(await (await fetch(restored.url)).text()).toBe("picture");
  const other = new ClientCache(async () => "media-other:home");
  const remote = new ClientCache(async () => "media-person:work");
  let requests = 0;
  const load = async () => { requests++; return picture(); };
  const b = await other.acquireMedia("avatar", load);
  const c = await remote.acquireMedia("avatar", load);
  expect(requests).toBe(2);
  restored.release(); b.release(); c.release();
  reopened.dispose(); other.dispose(); remote.dispose();
});

test("eviction keeps mounted pictures alive and releases blob URLs after their last consumer", async () => {
  const cache = new ClientCache(async () => "media-eviction");
  const large = () => Promise.resolve(new Blob([new Uint8Array(17 * 1024 * 1024)], { type: "image/png" }));
  const first = await cache.acquireMedia("one", large);
  const second = await cache.acquireMedia("two", large);
  expect(cache.getMedia("one")).toBeUndefined();
  expect((await fetch(first.url)).ok).toBe(true);
  first.release();
  await expect(fetch(first.url)).rejects.toThrow();
  second.release();
  cache.dispose();
  await expect(fetch(second.url)).rejects.toThrow();
});

test("failure retries and dispose cancels late loads without poisoning a remounted owner", async () => {
  const cache = new ClientCache(async () => "media-cancellation");
  await expect(cache.acquireMedia("retry", async () => { throw new Error("offline"); })).rejects.toThrow("offline");
  const retry = await cache.acquireMedia("retry", async () => picture());
  retry.release();
  let started!: () => void;
  const began = new Promise<void>(resolve => { started = resolve; });
  let finish!: (blob: Blob) => void;
  const loading = cache.acquireMedia("late", async () => { started(); return new Promise<Blob>(resolve => { finish = resolve; }); });
  await began;
  cache.dispose();
  finish(picture());
  await expect(loading).rejects.toThrow();
  expect(cache.getMedia("late")).toBeUndefined();
  const fresh = await cache.acquireMedia("late", async () => picture());
  expect(cache.getMedia("late")).toBe(fresh.url);
  fresh.release(); cache.dispose();
});

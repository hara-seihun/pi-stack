import { afterAll, expect, test } from "bun:test";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { readCachedMedia, writeCachedMedia } from "./src/transcript-cache";

const previousDatabase = globalThis.indexedDB;
const previousKeyRange = globalThis.IDBKeyRange;
const previousLocation = globalThis.location;
globalThis.indexedDB ??= new IDBFactory();
globalThis.IDBKeyRange ??= IDBKeyRange;
globalThis.location ??= new URL("http://localhost/") as unknown as Location;
afterAll(() => {
  globalThis.indexedDB = previousDatabase;
  globalThis.IDBKeyRange = previousKeyRange;
  globalThis.location = previousLocation;
});

const text = async (key: string) => (await readCachedMedia(key))?.text();

test("media persists Blob bytes and MIME type, with independent byte and entry LRU budgets", async () => {
  const MiB = 1024 * 1024;
  const blob = (size: number) => new Blob([new Uint8Array(size)], { type: "image/png" });
  const original = new Blob(["person A"], { type: "image/webp" });
  await writeCachedMedia("media:person-a:local:v1:avatar", original);
  expect(await text("media:person-a:local:v1:avatar")).toBe("person A");
  expect((await readCachedMedia("media:person-a:local:v1:avatar"))?.type).toBe("image/webp");
  expect(await readCachedMedia("media:person-b:local:v1:avatar")).toBeNull();
  await writeCachedMedia("media:person-b:local:v1:avatar", new Blob(["person B"]));
  expect(await text("media:person-a:local:v1:avatar")).toBe("person A");

  await writeCachedMedia("media:bytes-a", blob(24 * MiB));
  await writeCachedMedia("media:bytes-b", blob(24 * MiB));
  await readCachedMedia("media:bytes-a");
  await writeCachedMedia("media:bytes-c", blob(24 * MiB));
  expect(await readCachedMedia("media:bytes-b")).toBeNull();
  expect((await readCachedMedia("media:bytes-a"))?.size).toBe(24 * MiB);
  await writeCachedMedia("media:bytes-a", blob(65 * MiB));
  expect(await readCachedMedia("media:bytes-a")).toBeNull();

  for (let i = 0; i < 512; i++) await writeCachedMedia(`media:count-${i}`, new Blob([`${i}`]));
  await readCachedMedia("media:count-0");
  await writeCachedMedia("media:count-512", new Blob(["new"]));
  expect(await readCachedMedia("media:count-1")).toBeNull();
  expect(await text("media:count-0")).toBe("0");
  expect(await text("media:count-512")).toBe("new");
});

test("opening a v2 database preserves existing payloads and metadata while adding media", () => {
  const source = `
    import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
    globalThis.indexedDB = new IDBFactory();
    globalThis.IDBKeyRange = IDBKeyRange;
    globalThis.location = new URL("http://localhost/");
    const opened = indexedDB.open("pi-remote-transcript", 2);
    opened.onupgradeneeded = () => {
      const db = opened.result;
      db.createObjectStore("bodies", { keyPath: "id" });
      db.createObjectStore("windows", { keyPath: "key" });
      const metadata = db.createObjectStore("metadata", { keyPath: "key" });
      metadata.createIndex("bucketUsedAt", ["bucket", "usedAt"]);
    };
    const request = (r) => new Promise((resolve, reject) => { r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
    const db = await request(opened);
    const tx = db.transaction(["bodies", "windows", "metadata"], "readwrite");
    tx.objectStore("bodies").put({ id: "kept", body: { kind: "assistant", text: "survived" } });
    tx.objectStore("windows").put({ key: "kept", generation: "v2", total: 0, items: [] });
    for (const bucket of ["bodies", "windows"]) {
      tx.objectStore("metadata").put({ key: [bucket, "kept"], bucket, entryKey: "kept", size: 42, usedAt: 123 });
      tx.objectStore("metadata").put({ key: [bucket], count: 1, bytes: 42, clock: 123 });
    }
    await new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onerror = reject; });
    db.close();
    const { readCachedMedia, writeCachedMedia } = await import(${JSON.stringify(new URL("./src/transcript-cache.ts", import.meta.url).href)});
    if (await readCachedMedia("new") !== null) throw Error("expected empty media store");
    await writeCachedMedia("new", new Blob(["persisted"], { type: "image/png" }));
    if ((await readCachedMedia("new"))?.type !== "image/png") throw Error("media did not persist");
    const check = await request(indexedDB.open("pi-remote-transcript", 3));
    const verify = check.transaction(["bodies", "windows", "metadata"], "readonly");
    if ((await request(verify.objectStore("bodies").get("kept")))?.body.text !== "survived") throw Error("body lost");
    if ((await request(verify.objectStore("windows").get("kept")))?.generation !== "v2") throw Error("window lost");
    for (const bucket of ["bodies", "windows"]) {
      if ((await request(verify.objectStore("metadata").get([bucket, "kept"])))?.usedAt !== 123) throw Error(bucket + " entry metadata lost");
      const stats = await request(verify.objectStore("metadata").get([bucket]));
      if (stats?.count !== 1 || stats.bytes !== 42 || stats.clock !== 123) throw Error(bucket + " stats lost");
    }
    check.close();
  `;
  const result = Bun.spawnSync({ cmd: [process.execPath, "-e", source], cwd: import.meta.dir, stdout: "pipe", stderr: "pipe" });
  expect(new TextDecoder().decode(result.stderr)).toBe("");
  expect(result.exitCode).toBe(0);
});

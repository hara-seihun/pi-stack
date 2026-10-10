import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { appendFileSync, mkdtempSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CoreImages, parseCoreImagesConfig, type CoreImagesSpec } from "../src/core/images.js";
import { InlineImages as Registry } from "../src/core/image-registry.js";
import { Store } from "../src/store.js";
import type { ThreadServiceEvent } from "../src/threads/service.js";
import type { Thread } from "../src/threads/contracts.js";
import { indexedThreadHistory } from "../src/threads/history.mjs";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });

async function fixture(native?: { watermarked: boolean }) {
  const root = mkdtempSync(join(tmpdir(), "core-image-adoption-"));
  const databasePath = join(root, "supervisor.sqlite3"), artifactRoot = join(root, "images"), adoptionReceiptPath = join(root, "adopt.json");
  mkdirSync(artifactRoot);
  const db = new Database(databasePath);
  db.exec("PRAGMA foreign_keys=ON; CREATE TABLE thread_views(id TEXT PRIMARY KEY); INSERT INTO thread_views VALUES('thread')");
  const previous = new Registry(db, artifactRoot, async () => { throw new Error("Previous controller must not generate"); }, () => {});
  db.exec("INSERT INTO core_image_threads VALUES('thread')");
  const source = join(root, "source.png"); writeFileSync(source, Buffer.from("89504e470d0a1a0a", "hex"));
  previous.accept("thread", "retained-message", `<pi-remote-image id="retained" path="${source}" />`);
  db.exec("PRAGMA foreign_keys=OFF");
  for (const name of ["inline_images", "inline_image_versions", "inline_image_messages", "core_image_acceptance"]) {
    const schema = (db.query("SELECT sql FROM sqlite_master WHERE name=?").get(name) as { sql: string }).sql;
    db.exec(`${schema.replace(name, `prior_${name}`).replaceAll("core_image_threads", "thread_views")};
      INSERT INTO prior_${name} SELECT * FROM ${name}; DROP TABLE ${name}; ALTER TABLE prior_${name} RENAME TO ${name}`);
  }
  db.exec("DROP TABLE core_image_threads");
  db.close();
  const identity = statSync(databasePath, { bigint: true });
  const nativePath = join(root, "native.jsonl");
  let watermark: unknown;
  const nativeText = `<pi-remote-image id="after-watermark" path="${source}" />`;
  if (native) {
    writeFileSync(nativePath, JSON.stringify({ type: "session", version: 3, id: "session", timestamp: new Date().toISOString(), cwd: root }) + "\n"
      + JSON.stringify({ type: "message", id: "first", parentId: null, message: { role: "assistant", content: [{ type: "text", text: "Before custody transfer" }], timestamp: Date.now() } }) + "\n");
    const history = indexedThreadHistory(nativePath);
    if (!history.ok) throw new Error(history.error.message);
    const last = history.value.entries.at(-1)!;
    watermark = { threadId: "thread", path: nativePath, revision: history.value.source.revision, lastOffset: last.offset, lastDigest: last.digest };
    appendFileSync(nativePath, JSON.stringify({ type: "message", id: "after", parentId: "first", message: { role: "assistant", content: [{ type: "text", text: nativeText }], timestamp: Date.now() } }) + "\n");
  }
  writeFileSync(adoptionReceiptPath, JSON.stringify({ version: 1, state: "detached", scopeId: "person:images", databasePath,
    tableNames: ["inline_images", "inline_image_versions", "inline_image_messages", "core_image_acceptance", "core_image_sources", "core_image_ingress_errors", "core_image_threads"],
    ...(native?.watermarked ? { nativeImageSources: [watermark] } : {}),
    databaseIdentity: { dev: String(identity.dev), ino: String(identity.ino) }, previousOwner: { identity: "previous-image-controller", detachedAt: new Date().toISOString() } }), { mode: 0o600 });
  const spec: CoreImagesSpec = { scopeId: "person", databasePath, artifactRoot, adoptionReceiptPath, allowedRoots: [root],
    dataResource: { id: "person:images", kind: "data", owner: "person", privacy: "private", subjects: ["person"], consent: "not-required" } };
  const accountStore = Store.open(join(root, "accounts.sqlite3"));
  let allowed = false;
  const seen: readonly string[][] = [];
  let listener: ((event: ThreadServiceEvent) => void) | null = null;
  const service = new CoreImages({ kind: "configured", registries: [spec] }, { accounts: { store: accountStore, shared: undefined },
    scope: () => ({ ok: true, value: { runtime: { path: path => path }, uid: process.getuid!(), allowsThread: id => id === "thread",
      threads: { snapshot: () => native ? [{ id: "thread", sessionFile: nativePath } as Thread] : [], subscribe: value => { listener = value; return () => { listener = null; }; } } } }),
    authorizeNative: () => ({ ok: true, value: undefined }),
    authorize: (_request, _scope, _resource, actions) => {
      (seen as string[][]).push([...actions]);
      return allowed ? { ok: true, value: undefined } : { ok: false, error: { code: "ownership-conflict", message: "No scope grant" } };
    } });
  const request = (suffix: string, body: unknown) => service.handle(new Request(`http://127.0.0.1/v1/scopes/person/images/${suffix}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));
  cleanups.push(async () => { await service.close(); accountStore.close(); rmSync(root, { recursive: true, force: true }); });
  return { root, service, spec, source, request, seen, nativeText, emit: (text: string) => listener?.({ threadId: "thread", event: { type: "message_end", message: { role: "assistant", content: [{ type: "text", text }] } } }), allow: () => { allowed = true; } };
}

test("images require explicit configuration and cannot infer filesystem grants", () => {
  expect(parseCoreImagesConfig(undefined).ok).toBe(false);
  expect(parseCoreImagesConfig({ kind: "disabled" })).toEqual({ ok: true, value: { kind: "disabled" } });
  expect(parseCoreImagesConfig({ kind: "configured", registries: [] }).ok).toBe(false);
});

test("core adopts retained registry/artifacts in place, gates all requests, and rejects changed message identities", async () => {
  const f = await fixture();
  expect((await f.service.start()).ok).toBe(true);
  const denied = await f.request("sync", { have: {} });
  expect(denied!.status).toBe(403);
  f.allow();
  const projection = new Database(f.spec.databasePath);
  const identities = projection.query("SELECT id FROM core_image_threads").all();
  expect(identities).toEqual([{ id: "thread" }]);
  projection.exec("PRAGMA foreign_keys=ON; DELETE FROM thread_views WHERE id='thread'");
  expect(projection.query("SELECT COUNT(*) AS n FROM inline_images").get()).toEqual({ n: 1 });
  projection.close();
  const deadline = Date.now() + 1500;
  let snapshots: any;
  while (Date.now() < deadline) {
    snapshots = (await (await f.request("sync", { have: {} }))!.json()).value.snapshots;
    if (snapshots.thread?.images[0]?.state === "complete") break;
    await Bun.sleep(2);
  }
  expect(snapshots.thread.images[0]).toMatchObject({ id: "retained", sourcePath: f.source, state: "complete", model: null });
  expect(snapshots.thread.images[0].path).toStartWith(f.spec.artifactRoot);
  const body = { threadId: "thread", messageKey: "new-message", text: `<pi-remote-image id="new" path="${f.source}" />` };
  expect((await f.request("accept", body))!.status).toBe(200);
  expect((await f.request("accept", body))!.status).toBe(200);
  expect((await f.request("accept", { ...body, text: '<pi-remote-image id="new" prompt="changed" />' }))!.status).toBe(409);
  expect((await f.request("accept", { ...body, threadId: "outside" }))!.status).toBe(403);
  expect(f.seen).toContainEqual(["execute", "use"]);
});

test("post-watermark native images recover with Remote offline and live messages use the same durable receipt", async () => {
  const f = await fixture({ watermarked: true });
  expect((await f.service.start()).ok).toBe(true);
  f.allow();
  const result = await (await f.request("sync", { have: {} }))!.json();
  expect(result.value.snapshots.thread.images.map((image: any) => image.id)).toContain("after-watermark");
  f.emit(f.nativeText);
  expect((await f.request("accept", { threadId: "thread", messageKey: "remote-replay", text: f.nativeText }))!.status).toBe(200);
  const images = (await (await f.request("sync", { have: {} }))!.json()).value.snapshots.thread.images;
  expect(images.filter((image: any) => image.id === "after-watermark")).toHaveLength(1);
});

test("a historical gap without a trustworthy watermark is explicit and never generates old tags", async () => {
  const f = await fixture({ watermarked: false });
  expect((await f.service.start()).ok).toBe(true);
  f.allow();
  const result = await (await f.request("sync", { have: {} }))!.json();
  expect(result.value.snapshots.thread.images.map((image: any) => image.id)).not.toContain("after-watermark");
  expect(result.value.errors[0]).toContain("historical image messages");
  f.emit(`<pi-remote-image id="new-live" path="${f.source}" />`);
  const updated = await (await f.request("sync", { have: {} }))!.json();
  expect(updated.value.snapshots.thread.images.map((image: any) => image.id)).toContain("new-live");
});

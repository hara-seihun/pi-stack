import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { appendFileSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CoreImages, parseCoreImagesConfig, type CoreImagesSpec, type CoreImagesOptions } from "../src/core/images.js";
import { InlineImages as Registry } from "../src/core/image-registry.js";
import { Store } from "../src/store.js";
import type { ThreadServiceEvent } from "../src/threads/service.js";
import type { Thread } from "../src/threads/contracts.js";
import { captureNativeHistoryWatermark } from "../src/threads/history.mjs";
import { createImageReader } from "../src/core/image-read.js";
import { CustodyResources } from "../src/core/custody-resources.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });

async function fixture(native?: { watermarked: boolean; baselineTag?: boolean; noSuffix?: boolean; largePrefix?: boolean; largeSuffix?: boolean }, unavailable = false, related = false) {
  const root = mkdtempSync(join(tmpdir(), "core-image-adoption-"));
  const databasePath = join(root, "supervisor.sqlite3"), artifactRoot = join(root, "images"), adoptionReceiptPath = join(root, "adopt.json");
  mkdirSync(artifactRoot);
  const db = new Database(databasePath);
  db.exec("PRAGMA foreign_keys=ON; CREATE TABLE thread_views(id TEXT PRIMARY KEY); INSERT INTO thread_views VALUES('thread')");
  const previous = new Registry(db, artifactRoot, async () => { throw new Error("Previous controller must not generate"); }, () => {});
  db.exec("INSERT INTO core_image_threads VALUES('thread')");
  const source = join(root, "source.png"); writeFileSync(source, Buffer.from("89504e470d0a1a0a", "hex"));
  previous.accept("thread", "retained-message", `<pi-remote-image id="retained" path="${source}" />`);
  if (related) {
    db.exec("INSERT INTO thread_views VALUES('fleet-id'); INSERT INTO core_image_threads VALUES('fleet-id')");
    previous.accept("fleet-id", "retained-fleet-message", `<pi-remote-image id="fleet-retained" path="${source}" />`);
  }
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
      + JSON.stringify({ type: "message", id: "first", parentId: null, message: { role: "assistant", content: [{ type: "text", text: native.baselineTag ? `<pi-remote-image id="before-watermark" path="${source}" />` : "Before custody transfer" }], timestamp: Date.now() } }) + "\n");
    if (native.largePrefix) appendFileSync(nativePath, JSON.stringify({ type: "message", id: "giant-old-tool", parentId: "first", message: { role: "toolResult", content: [{ type: "text", text: "x".repeat(9 * 1024 * 1024) }] } }) + "\n");
    const captured = captureNativeHistoryWatermark(nativePath);
    if (!captured.ok) throw new Error(captured.error.message);
    watermark = { threadId: related ? "fleet-id" : "thread", path: nativePath, ...captured.value };
    if (native.largeSuffix) appendFileSync(nativePath, JSON.stringify({ type: "message", id: "giant-new-tool", parentId: "first", message: { role: "toolResult", content: [{ type: "text", text: "x".repeat(9 * 1024 * 1024) }] } }) + "\n");
    if (!native.noSuffix) appendFileSync(nativePath, JSON.stringify({ type: "message", id: "after", parentId: "first", message: { role: "assistant", content: [{ type: "text", text: nativeText }], timestamp: Date.now() } }) + "\n");
  }
  writeFileSync(adoptionReceiptPath, JSON.stringify({ version: 1, state: "detached", scopeId: "person:images", databasePath,
    tableNames: ["inline_images", "inline_image_versions", "inline_image_messages", "core_image_acceptance", "core_image_sources", "core_image_ingress_errors", "core_image_threads"],
    ...(native?.watermarked ? { nativeImageSources: [watermark] } : {}),
    databaseIdentity: { dev: String(identity.dev), ino: String(identity.ino) }, previousOwner: { identity: "previous-image-controller", detachedAt: new Date().toISOString() } }), { mode: 0o600 });
  const spec: CoreImagesSpec = { scopeId: "person", databasePath, artifactRoot, adoptionReceiptPath, allowedRoots: [root], relatedThreadScopeIds: related ? ["person:fleet"] : [],
    dataResource: { id: "person:images", kind: "data", owner: "person", privacy: "private", subjects: ["person"], consent: "not-required" } };
  const accountStore = Store.open(join(root, "accounts.sqlite3"));
  let allowed = false;
  const seen: readonly string[][] = [];
  let listener: ((event: ThreadServiceEvent) => void) | null = null;
  const processStat = readFileSync(`/proc/${process.pid}/stat`, "utf8");
  const namespace = { kind: "process" as const, pid: process.pid, startTicks: processStat.slice(processStat.lastIndexOf(")") + 2).split(/\s+/)[19]!, mountNamespaceInode: statSync("/proc/self/ns/mnt", { bigint: true }).ino.toString() };
  const custody = new CustodyResources({ uid: process.getuid!(), gid: process.getgid!(), namespace, retainedRunnerNamespace: namespace, dataDir: root, socketDir: root });
  const options: CoreImagesOptions = { accounts: { store: accountStore, shared: undefined },
    scope: () => ({ ok: true, value: unavailable ? null : { runtime: { path: path => path, readImage: createImageReader(custody) }, uid: process.getuid!(), gid: process.getgid!(), allowsThread: id => id === "thread",
      threads: { snapshot: () => native && !related ? [{ id: "thread", sessionFile: nativePath } as Thread] : [], subscribe: value => { if (!related) listener = value; return () => { if (!related) listener = null; }; } } } }),
    relatedScope: (_registryId, id) => related && id === "person:fleet" ? { ok: true, value: {
      runtime: { path: path => path, readImage: createImageReader(custody) }, uid: process.getuid!(), gid: process.getgid!(), allowsThread: id => id === "fleet-id",
      threads: { snapshot: () => native ? [{ id: "fleet-id", sessionFile: nativePath } as Thread] : [], subscribe: value => { listener = value; return () => { listener = null; }; } },
    } } : ({ ok: false, error: { code: "invalid-config", message: "Unconfigured related scope" } }),
    authorizeNative: () => ({ ok: true, value: undefined }),
    authorize: (_request, _scope, _resource, actions) => {
      (seen as string[][]).push([...actions]);
      return allowed ? { ok: true, value: undefined } : { ok: false, error: { code: "ownership-conflict", message: "No scope grant" } };
    } };
  const service = new CoreImages({ kind: "configured", registries: [spec] }, options);
  const request = (suffix: string, body: unknown) => service.handle(new Request(`http://127.0.0.1/v1/scopes/person/images/${suffix}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));
  cleanups.push(async () => { await service.close(); custody.close(); accountStore.close(); rmSync(root, { recursive: true, force: true }); });
  return { root, service, options, spec, source, request, seen, nativeText, emit: (text: string) => listener?.({ threadId: related ? "fleet-id" : "thread", event: { type: "message_end", message: { role: "assistant", content: [{ type: "text", text }] } } }), allow: () => { allowed = true; } };
}

test("captured absent legacy history stays explicitly unknown without opening an unregistered path", async () => {
  const f = await fixture({ watermarked: true, noSuffix: true });
  const path = join(f.root, "native.jsonl");
  const receipt = JSON.parse(readFileSync(f.spec.adoptionReceiptPath, "utf8"));
  receipt.nativeImageSources = [{ threadId: "thread", path, revision: "unstarted", lastOffset: -1, lastDigest: "", priorSource: { kind: "absent", observedAt: new Date().toISOString() } }];
  writeFileSync(f.spec.adoptionReceiptPath, JSON.stringify(receipt));
  rmSync(path);
  const original = f.options.scope;
  f.options.scope = id => {
    const r = original(id);
    if (r.ok && r.value) r.value.runtime.path = value => { if (value === path) throw new Error("Unregistered core resource path"); return value; };
    return r;
  };
  expect((await f.service.start()).ok).toBe(true);
  const db = new Database(f.spec.databasePath, { readonly: true });
  expect(db.query("SELECT error FROM core_image_ingress_errors WHERE thread_id='thread' AND message_key='source-missing'").get()).toMatchObject({ error: expect.stringContaining("historical effects remain unknown") });
  expect(db.query("SELECT last_offset FROM core_image_sources WHERE thread_id='thread'").get()).toEqual({ last_offset: -1 });
  db.close();
});

test("images require explicit configuration and cannot infer filesystem grants", () => {
  expect(parseCoreImagesConfig(undefined).ok).toBe(false);
  expect(parseCoreImagesConfig({ kind: "disabled" })).toEqual({ ok: true, value: { kind: "disabled" } });
  expect(parseCoreImagesConfig({ kind: "configured", registries: [] }).ok).toBe(false);
});

test("unavailable image scope retains its descriptor without opening missing storage", async () => {
  const f = await fixture(undefined, true);
  rmSync(f.spec.databasePath);
  rmSync(f.spec.adoptionReceiptPath);
  expect((await f.service.start()).ok).toBe(true);
  expect((await f.request("sync", { have: {} }))!.status).toBe(503);
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

test("full source proof excludes the old prefix without claiming its tags were accepted", async () => {
  for (const noSuffix of [true, false]) {
    const f = await fixture({ watermarked: true, baselineTag: true, noSuffix });
    expect((await f.service.start()).ok).toBe(true);
    f.allow();
    const result = await (await f.request("sync", { have: {} }))!.json();
    expect(result.value.snapshots.thread.images.map((image: any) => image.id)).not.toContain("before-watermark");
    expect(result.value.errors).toEqual([]);
    if (!noSuffix) expect(result.value.snapshots.thread.images.map((image: any) => image.id)).toContain("after-watermark");
  }
});

test("a historical gap without a trustworthy watermark is explicit and never generates old tags", async () => {
  const f = await fixture({ watermarked: false });
  expect((await f.service.start()).ok).toBe(true);
  f.allow();
  const result = await (await f.request("sync", { have: {} }))!.json();
  expect(result.value.snapshots.thread.images.map((image: any) => image.id)).not.toContain("after-watermark");
  expect(result.value.errors[0]).toContain("no full trustworthy source watermark");
  f.emit(`<pi-remote-image id="new-live" path="${f.source}" />`);
  const updated = await (await f.request("sync", { have: {} }))!.json();
  expect(updated.value.snapshots.thread.images.map((image: any) => image.id)).toContain("new-live");
});


test("one canonical registry retains fleet IDs and ingests only explicitly related owning scopes", async () => {
  const f = await fixture({ watermarked: true }, false, true);
  expect((await f.service.start()).ok).toBe(true);
  f.allow();
  let result = await (await f.request("sync", { have: {} }))!.json();
  const deadline = Date.now() + 1500;
  while (result.value.snapshots["fleet-id"].images.find((image: any) => image.id === "fleet-retained")?.state !== "complete" && Date.now() < deadline) {
    await Bun.sleep(2);
    result = await (await f.request("sync", { have: {} }))!.json();
  }
  expect(result.value.snapshots["fleet-id"].images.find((image: any) => image.id === "fleet-retained")).toMatchObject({ state: "complete", sourcePath: f.source });
  expect(result.value.snapshots["fleet-id"].images.map((image: any) => image.id)).toContain("fleet-retained");
  expect(result.value.snapshots["fleet-id"].images.map((image: any) => image.id)).toContain("after-watermark");
  f.emit(`<pi-remote-image id="fleet-live" path="${f.source}" />`);
  result = await (await f.request("sync", { have: {} }))!.json();
  expect(result.value.snapshots["fleet-id"].images.map((image: any) => image.id)).toContain("fleet-live");
  expect((await f.request("accept", { threadId: "fleet-id", messageKey: "same-registry", text: `<pi-remote-image id="fleet-live" path="${f.source}" />` }))!.status).toBe(200);
  expect((await f.request("accept", { threadId: "another-person-id", messageKey: "unrelated", text: `<pi-remote-image id="other" path="${f.source}" />` }))!.status).toBe(403);
});

test("undeclared or unresolved related source never opens a broader thread directory", async () => {
  const f = await fixture();
  f.spec.relatedThreadScopeIds = ["another-person"];
  expect((await f.service.start()).ok).toBe(false);
});

test("large historical tool records are metadata-only while trusted image suffix still recovers", async () => {
  const f = await fixture({ watermarked: true, largePrefix: true });
  expect((await f.service.start()).ok).toBe(true);
  f.allow();
  const result = await (await f.request("sync", { have: {} }))!.json();
  expect(result.value.snapshots.thread.images.map((image: any) => image.id)).toContain("after-watermark");
  expect(result.value.errors).toEqual([]);
});

test("large suffix records remain explicit uncertainty without hiding later image output", async () => {
  const f = await fixture({ watermarked: true, largeSuffix: true });
  expect((await f.service.start()).ok).toBe(true);
  f.allow();
  const result = await (await f.request("sync", { have: {} }))!.json();
  expect(result.value.snapshots.thread.images.map((image: any) => image.id)).toContain("after-watermark");
  expect(result.value.errors).toHaveLength(1);
  expect(result.value.errors[0]).toContain("uncertain record");
});

test("legacy five-field source receipt never grants historical replay", async () => {
  const f = await fixture({ watermarked: true });
  const receipt = JSON.parse(readFileSync(f.spec.adoptionReceiptPath, "utf8"));
  receipt.nativeImageSources = receipt.nativeImageSources.map((proof: any) => ({ threadId: proof.threadId, path: proof.path, revision: proof.revision, lastOffset: proof.lastOffset, lastDigest: proof.lastDigest }));
  writeFileSync(f.spec.adoptionReceiptPath, JSON.stringify(receipt));
  expect((await f.service.start()).ok).toBe(true);
  f.allow();
  const result = await (await f.request("sync", { have: {} }))!.json();
  expect(result.value.snapshots.thread.images.map((image: any) => image.id)).not.toContain("after-watermark");
  expect(result.value.errors[0]).toContain("no full trustworthy source watermark");
});

test("explicit absent and newly-created source receipts conserve the first fresh finalized output", async () => {
  for (const kind of ["absent", "created-after-baseline"] as const) {
    const before = new Date(Date.now() - 1000).toISOString();
    const f = await fixture({ watermarked: false });
    const receipt = JSON.parse(readFileSync(f.spec.adoptionReceiptPath, "utf8"));
    const path = join(f.root, "native.jsonl");
    const saved = readFileSync(path);
    rmSync(path);
    const priorSource = kind === "absent" ? { kind, observedAt: before } : { kind, createdAt: new Date().toISOString(), baselineStartedAt: before };
    receipt.nativeImageSources = [{ threadId: "thread", path, revision: kind, lastOffset: -1, lastDigest: "", priorSource }];
    writeFileSync(f.spec.adoptionReceiptPath, JSON.stringify(receipt));
    expect((await f.service.start()).ok).toBe(true);
    await f.service.close();
    writeFileSync(path, saved);
    const replacement = new CoreImages({ kind: "configured", registries: [f.spec] }, f.options);
    cleanups.unshift(() => replacement.close());
    expect((await replacement.start()).ok).toBe(true);
    f.allow();
    const response = await replacement.handle(new Request("http://127.0.0.1/v1/scopes/person/images/sync", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ have: {} }) }));
    const result = await response!.json();
    expect(result.value.snapshots.thread.images.map((image: any) => image.id)).toContain("after-watermark");
    expect(result.value.errors).toEqual([]);
  }
});

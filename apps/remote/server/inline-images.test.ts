import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseInlineImageTags } from "./inline-image-contract";
import { InlineImages, type InlineImageGenerator } from "./inline-images";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); });
const png = Buffer.from("89504e470d0a1a0a", "hex");
const success = () => ({ ok: true as const, images: [{ id: "provider-image", bytes: png }], model: "test", responseId: "response", usage: {} });
async function fixture(generate: InlineImageGenerator, concurrency = 2) {
  const root = await mkdtemp(join(tmpdir(), "pi-inline-images-"));
  const db = new Database(join(root, "state.sqlite3"));
  db.exec("PRAGMA journal_mode=WAL; CREATE TABLE sessions(id TEXT PRIMARY KEY); INSERT INTO sessions VALUES('thread'),('other');");
  let wake = () => {};
  const service = new InlineImages(db, join(root, "images"), generate, () => wake(), concurrency);
  cleanup.push(async () => { service.stop(); db.close(); await rm(root, { recursive: true, force: true }); });
  const until = (condition: () => boolean) => new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Image service did not settle")), 1500);
    wake = () => { if (condition()) { clearTimeout(timer); resolve(); } };
    wake();
  });
  return { root, db, service, until };
}

test("shared parser excludes examples, escaped tags and raw code; decodes multiline attributes", () => {
  const tag = '<pi-remote-image id="example" prompt="Example" />';
  const source = ['`' + tag + '`', '````md', tag, '````', '~~~', tag, '~~~', '    ' + tag, '> ```', '> ' + tag, '> ```', '\\' + tag,
    '<!-- ' + tag + ' -->', '<pre>' + tag + '</pre>', '<pi-remote-image id="scene"\nprompt="A &quot;blue&quot; sky > mountains" refs=\'["previous","/a,b.png"]\' />', '<pi-remote-image id="scene" />'].join('\n');
  const tags = parseInlineImageTags(source);
  expect(tags).toHaveLength(2);
  expect(tags[0].definition).toEqual({ id: "scene", prompt: 'A "blue" sky > mountains', refs: ["previous", "/a,b.png"] });
  expect(source.slice(tags[0].start, tags[0].end)).toStartWith('<pi-remote-image id="scene"');
  expect(tags[1].definition).toBeNull();
  expect(parseInlineImageTags('<pi-remote-image id="x" prompt="partial')).toEqual([]);
  expect(parseInlineImageTags('<pi-remote-image id="x" prompt="a" prompt="b" />')[0].error).toContain("Duplicate");
});

test("durable queue chains ID and file inputs, enforces concurrency, publishes after the turn", async () => {
  const calls: Array<{ prompt: string; inputPaths: string[]; finish: () => void }> = [];
  const f = await fixture(async input => { await new Promise<void>(resolve => calls.push({ ...input, finish: resolve })); return success(); }, 2);
  const source = join(f.root, "source.png"); await writeFile(source, png);
  f.service.accept("thread", "message", `<pi-remote-image id="first" prompt="First" refs="${source}" />\n<pi-remote-image id="second" prompt="Second" refs="first" />\n<pi-remote-image id="third" prompt="Third" />`);
  expect(f.service.snapshot("thread").images.every(image => image.state === "queued")).toBe(true);
  await f.service.start();
  // The generator starts after asynchronous input snapshots. A changed event follows completion,
  // so await its first calls directly through the next event-loop boundary.
  await new Promise(resolve => setTimeout(resolve, 15));
  expect(calls.map(call => call.prompt).sort()).toEqual(["First", "Third"]);
  expect(await readFile(calls.find(call => call.prompt === "First")!.inputPaths[0])).toEqual(png);
  calls.find(call => call.prompt === "First")!.finish();
  await f.until(() => f.service.snapshot("thread").images.find(image => image.id === "first")?.state === "complete");
  await new Promise(resolve => setTimeout(resolve, 15));
  expect(calls.find(call => call.prompt === "Second")).toBeDefined();
  calls.find(call => call.prompt === "Second")!.finish(); calls.find(call => call.prompt === "Third")!.finish();
  await f.until(() => f.service.snapshot("thread").images.every(image => image.state === "complete"));
  const snapshot = f.service.snapshot("thread");
  expect(snapshot.version).toBeGreaterThan(3);
  f.service.accept("thread", "message", '<pi-remote-image id="first" prompt="Changed" />');
  f.service.accept("thread", "other-message", '<pi-remote-image id="first" prompt="Changed" />');
  expect(f.service.snapshot("thread").images[0]).toMatchObject({ prompt: "First", state: "complete", conflict: expect.any(String) });
  expect(calls).toHaveLength(3);
});

test("missing dependencies, cycles, failed parents and display-only tags never call the provider", async () => {
  let calls = 0;
  const f = await fixture(async () => { calls++; return { ok: false, error: { message: "Provider refused" } }; });
  f.service.accept("thread", "definition", '<pi-remote-image id="missing" prompt="M" refs="absent" />\n<pi-remote-image id="a" prompt="A" refs="b" />\n<pi-remote-image id="b" prompt="B" refs="a" />\n<pi-remote-image id="parent" prompt="P" />\n<pi-remote-image id="child" prompt="C" refs="parent" />\n<pi-remote-image id="display" />');
  await f.service.start();
  await f.until(() => f.service.snapshot("thread").images.every(image => image.state === "error"));
  const images = f.service.snapshot("thread").images;
  expect(images).toHaveLength(5);
  expect(images.find(image => image.id === "missing")?.error?.code).toBe("missing_dependency");
  expect(images.find(image => image.id === "child")?.error?.code).toBe("dependency_failed");
  expect(calls).toBe(1);
  expect(f.service.snapshot("other").images).toEqual([]);
});

test("restart resumes queued rows but never resubmits a claimed provider attempt", async () => {
  let calls = 0;
  const f = await fixture(async (_input, signal) => { calls++; await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true })); return { ok: false, error: { message: "interrupted" } }; }, 1);
  f.service.accept("thread", "request", '<pi-remote-image id="claimed" prompt="One" />\n<pi-remote-image id="queued" prompt="Two" />');
  await f.service.start();
  await new Promise(resolve => setTimeout(resolve, 15));
  expect(calls).toBe(1);
  f.service.stop();
  await new Promise(resolve => setTimeout(resolve, 1));
  let recoveredCalls = 0;
  const replacement = new InlineImages(f.db, join(f.root, "images"), async () => { recoveredCalls++; return success(); }, () => {});
  await replacement.start();
  expect(replacement.snapshot("thread").images[0].error?.code).toBe("interrupted");
  await new Promise(resolve => setTimeout(resolve, 20));
  expect(recoveredCalls).toBe(1);
  expect(replacement.snapshot("thread").images[1].state).toBe("complete");
  replacement.stop();
});

test("restart publishes an fsynced provider receipt without another request", async () => {
  const f = await fixture(async () => success());
  f.service.accept("thread", "request", '<pi-remote-image id="saved" prompt="Saved" />');
  await f.service.start();
  await f.until(() => f.service.snapshot("thread").images[0]?.state === "complete");
  f.service.stop();
  const image = f.service.snapshot("thread").images[0];
  f.db.query("UPDATE inline_images SET value=?").run(JSON.stringify({ ...image, state: "generating", paths: [], path: null }));
  let calls = 0;
  const replacement = new InlineImages(f.db, join(f.root, "images"), async () => { calls++; return success(); }, () => {});
  await replacement.start();
  expect(replacement.snapshot("thread").images[0]).toMatchObject({ state: "complete", path: image.path });
  expect(calls).toBe(0);
  replacement.stop();
});

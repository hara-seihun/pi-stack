import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, readFile, readdir, rm, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseInlineImageTags } from "./inline-image-contract";
import { InlineImages, type InlineImageGenerator } from "./inline-images";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); });
const png = Buffer.from("89504e470d0a1a0a", "hex");
const success = () => ({ ok: true as const, images: [{ id: "provider-image", bytes: png }], model: "test", responseId: "response", usage: {} });
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
async function fixture(generate: InlineImageGenerator, concurrency = 2) {
  const root = await mkdtemp(join(tmpdir(), "pi-inline-images-"));
  const db = new Database(join(root, "state.sqlite3"));
  db.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; CREATE TABLE thread_views(id TEXT PRIMARY KEY); INSERT INTO thread_views VALUES('thread'),('other');");
  const listeners = new Set<() => void>();
  const changed = () => { for (const listener of listeners) listener(); };
  const service = new InlineImages(db, join(root, "images"), generate, changed, concurrency);
  cleanup.push(async () => { await service.close(); db.close(); await rm(root, { recursive: true, force: true }); });
  const until = (condition: () => boolean) => new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { listeners.delete(check); reject(new Error("Image service did not settle")); }, 1500);
    const check = () => { if (condition()) { clearTimeout(timer); listeners.delete(check); resolve(); } };
    listeners.add(check);
    check();
  });
  return { root, db, service, until, changed };
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

test("multiline prompt contents cannot change Markdown state or submit embedded tags", () => {
  const source = [
    '<pi-remote-image id="outer" prompt=\'An image containing literal text:',
    '```',
    '<pi-remote-image id="embedded" prompt="Not a request" />',
    '`unmatched backtick and <!-- comment-looking text',
    'Last line\' /> <pi-remote-image id="following" prompt="A real request" />',
    '`<pi-remote-image id="code" prompt="An example" />`',
    '\\<pi-remote-image id="escaped" prompt="Another example" />',
  ].join('\n');
  const tags = parseInlineImageTags(source);
  expect(tags.map(tag => tag.id)).toEqual(["outer", "following"]);
  expect(tags.every(tag => tag.error === null)).toBe(true);
  expect(tags[0].definition?.prompt).toContain('<pi-remote-image id="embedded" prompt="Not a request" />');
  expect(source.slice(tags[1].start, tags[1].end)).toBe('<pi-remote-image id="following" prompt="A real request" />');
});

test("streaming mode exposes unfinished spans without changing closed-only acceptance or code exclusions", () => {
  for (const fragment of ["<pi-remote-i", "<pi-remote-image", '<pi-remote-image id="sce', '<pi-remote-image id="scene" prompt="A scene',
    '<pi-remote-image id="scene" prompt=\'A scene\n<pi-remote-image id="nested" prompt="Not a request" />',
    '<pi-remote-image id="scene" prompt=\'A scene\n```\n<pi-remote-image id="nested" prompt="Not a request" />']) {
    const source = "Before\n" + fragment;
    const tags = parseInlineImageTags(source, { streaming: true });
    expect(tags).toHaveLength(1);
    expect(tags[0]).toMatchObject({ start: 7, end: source.length, partial: true, definition: null, error: null });
    expect(tags[0].id).toBe(fragment.includes('id="scene"') ? "scene" : "");
    expect(parseInlineImageTags(source)).toEqual([]);
  }
  const fragment = '<pi-remote-image id="scene" prompt="A scene';
  for (const prefix of ["`", "```xml\n", "~~~\n", "    ", "> ```\n> ", "\\", "<!-- ", "<pre>"]) {
    expect(parseInlineImageTags(prefix + fragment, { streaming: true })).toEqual([]);
  }
  const closed = '<pi-remote-image id="ready" prompt="Ready" />';
  const tags = parseInlineImageTags(closed + "\n" + fragment, { streaming: true });
  expect(tags).toHaveLength(2);
  expect(tags[0].partial).toBeUndefined();
  expect(tags[0].definition?.id).toBe("ready");
  expect(tags[1].partial).toBe(true);
  expect(parseInlineImageTags('<pi-remote-image id="scene">', { streaming: true })).toEqual([]);
});

test("durable queue chains ID and file inputs, enforces concurrency, publishes after the turn", async () => {
  const calls: Array<{ prompt: string; inputPaths: string[]; finish: () => void }> = [];
  const started = new Map(["First", "Second", "Third"].map(prompt => [prompt, deferred()]));
  const f = await fixture(async input => {
    const completion = deferred();
    calls.push({ ...input, finish: completion.resolve });
    started.get(input.prompt)!.resolve();
    await completion.promise;
    return success();
  }, 2);
  const source = join(f.root, "source.png"); await writeFile(source, png);
  f.service.accept("thread", "message", `<pi-remote-image id="first" prompt="First" refs="${source}" />\n<pi-remote-image id="second" prompt="Second" refs="first" />\n<pi-remote-image id="third" prompt="Third" />`);
  expect(f.service.snapshot("thread").images.every(image => image.state === "queued")).toBe(true);
  await f.service.start();
  await Promise.all([started.get("First")!.promise, started.get("Third")!.promise]);
  expect(calls.map(call => call.prompt).sort()).toEqual(["First", "Third"]);
  expect(await readFile(calls.find(call => call.prompt === "First")!.inputPaths[0])).toEqual(png);
  calls.find(call => call.prompt === "First")!.finish();
  await f.until(() => f.service.snapshot("thread").images.find(image => image.id === "first")?.state === "complete");
  await started.get("Second")!.promise;
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

test("persisted context accepts assistant text only and replay reuses its completed image", async () => {
  const calls: string[] = [];
  const f = await fixture(async input => { calls.push(input.prompt); return success(); });
  const tag = (id: string) => `<pi-remote-image id="${id}" prompt="${id}" />`;
  const assistantText = tag("accepted");
  const context = JSON.stringify({
    systemPrompt: tag("systemPrompt"), tools: [{ description: tag("schema") }],
    messages: [
      { role: "system", content: tag("system") },
      { role: "user", content: [{ type: "text", text: tag("user") }] },
      { role: "toolResult", content: [{ type: "text", text: tag("result") }] },
      { role: "assistant", content: [
        { type: "thinking", thinking: tag("thinking") },
        { type: "toolCall", name: "example", arguments: { text: tag("arguments") } },
        { type: "text", text: '```xml\n' + tag("code") + '\n```\n' + assistantText.slice(0, 30) },
        { type: "text", text: assistantText.slice(30) },
      ] },
    ],
  });
  f.db.exec("CREATE TABLE persisted_context(document TEXT NOT NULL)");
  f.db.query("INSERT INTO persisted_context VALUES(?)").run(context);
  const saved = () => (f.db.query("SELECT document FROM persisted_context").get() as { document: string }).document;
  expect(f.service.snapshot("thread")).toEqual({ version: 0, images: [] });
  f.service.acceptContext("thread", saved());
  expect(f.service.snapshot("thread").images.map(image => [image.id, image.state])).toEqual([["accepted", "queued"]]);
  await f.service.start();
  await f.until(() => f.service.snapshot("thread").images[0]?.state === "complete");
  const completed = f.service.snapshot("thread");
  f.service.acceptContext("thread", saved());
  expect(f.service.snapshot("thread")).toEqual(completed);
  expect(calls).toEqual(["accepted"]);
  expect(await readFile(completed.images[0].path!)).toEqual(png);
});

test("combined reference size is rejected before any input copy or provider call", async () => {
  let calls = 0;
  const f = await fixture(async () => { calls++; return success(); });
  const paths = [join(f.root, "first input.png"), join(f.root, "second, input.png")];
  for (const path of paths) { await writeFile(path, ""); await truncate(path, 20 * 1024 * 1024); }
  f.service.accept("thread", "large-inputs", `<pi-remote-image id="large" prompt="Too large" refs='${JSON.stringify(paths)}' />`);
  await f.service.start();
  await f.until(() => f.service.snapshot("thread").images[0]?.state === "error");
  expect(f.service.snapshot("thread").images[0].error).toMatchObject({ code: "input_error", message: expect.stringContaining("32 MiB") });
  const row = f.db.query("SELECT attempt_dir FROM inline_images").get() as { attempt_dir: string };
  expect(await readdir(row.attempt_dir)).toEqual([]);
  expect(calls).toBe(0);
});

test.each([true, false])("session deletion during provider completion cannot resurrect jobs, success=%s", async successful => {
  let release!: () => void;
  let started!: () => void;
  const claimed = new Promise<void>(resolve => { started = resolve; });
  const response = new Promise<void>(resolve => { release = resolve; });
  const f = await fixture(async request => {
    if (request.prompt === "Delete me") {
      started(); await response;
      return successful ? success() : { ok: false, error: { message: "Provider failed" } };
    }
    return success();
  }, 1);
  f.service.accept("thread", "deleted", '<pi-remote-image id="deleted" prompt="Delete me" />');
  f.service.accept("other", "retained", '<pi-remote-image id="retained" prompt="Keep me" />');
  await f.service.start();
  await claimed;
  f.db.query("DELETE FROM thread_views WHERE id='thread'").run();
  release();
  await f.until(() => f.service.snapshot("other").images[0]?.state === "complete");
  expect(f.service.snapshot("thread")).toEqual({ version: 0, images: [] });
  expect(f.db.query("SELECT * FROM inline_image_messages WHERE session_id='thread'").all()).toEqual([]);
});

test("restart resumes queued rows but never resubmits a claimed provider attempt", async () => {
  let calls = 0;
  const started = deferred();
  const interrupted = deferred();
  const f = await fixture(async (_input, signal) => {
    calls++;
    const aborted = new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }));
    started.resolve();
    await aborted;
    interrupted.resolve();
    return { ok: false, error: { message: "interrupted" } };
  }, 1);
  f.service.accept("thread", "request", '<pi-remote-image id="claimed" prompt="One" />\n<pi-remote-image id="queued" prompt="Two" />');
  await f.service.start();
  await started.promise;
  expect(calls).toBe(1);
  const closing = f.service.close();
  await interrupted.promise;
  await closing;
  let recoveredCalls = 0;
  const replacement = new InlineImages(f.db, join(f.root, "images"), async () => { recoveredCalls++; return success(); }, f.changed);
  await replacement.start();
  expect(replacement.snapshot("thread").images[0].error?.code).toBe("interrupted");
  await f.until(() => replacement.snapshot("thread").images[1]?.state === "complete");
  expect(recoveredCalls).toBe(1);
  expect(replacement.snapshot("thread").images[1].state).toBe("complete");
  await replacement.close();
});

test("graceful close drains successful publication before the next supervisor recovers it", async () => {
  const returned = deferred();
  const f = await fixture(async () => { returned.resolve(); return success(); });
  f.service.accept("thread", "request", '<pi-remote-image id="published" prompt="Published" />');
  await f.service.start();
  await returned.promise;
  await f.service.close();
  expect(f.service.snapshot("thread").images[0].state).toBe("generating");
  const row = f.db.query("SELECT attempt_dir FROM inline_images").get() as { attempt_dir: string };
  const receipt = JSON.parse(await readFile(join(row.attempt_dir, "receipt.json"), "utf8"));
  expect(await readFile(receipt.path)).toEqual(png);
  let calls = 0;
  const replacement = new InlineImages(f.db, join(f.root, "images"), async () => { calls++; return success(); }, f.changed);
  await replacement.start();
  expect(replacement.snapshot("thread").images[0]).toMatchObject({ state: "complete", path: receipt.path });
  expect(calls).toBe(0);
  await replacement.close();
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
  await replacement.close();
});

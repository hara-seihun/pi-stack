#!/usr/bin/env bun
/** Finite synthetic provider proof against the exact original installed image class. */
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const source = resolve(process.argv[2] ?? "");
if (!process.argv[2]) throw new Error("Explicit original InlineImages source path required");
const gates = await Bun.stdin.json() as Record<string, string>;
const { InlineImages } = await import(pathToFileURL(source).href);
const root = mkdtempSync(join(tmpdir(), "pi-image-handoff-proof-"));
const db = new Database(join(root, "images.sqlite3"));
let images: any;
try {
  db.exec("CREATE TABLE thread_views(id TEXT PRIMARY KEY);INSERT INTO thread_views VALUES('thread')");
  const started = Promise.withResolvers<void>(), terminal = Promise.withResolvers<void>(), second = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  let calls = 0, aborted = false;
  images = new InlineImages(db, join(root, "artifacts"), async (_request: unknown, signal: AbortSignal) => {
    calls++;
    signal.addEventListener("abort", () => { aborted = true; });
    if (calls === 1) { started.resolve(); await release.promise; }
    return { ok: true, model: "synthetic", responseId: `receipt-${calls}`, usage: {}, images: [{ id: `image-${calls}`, bytes: Buffer.from("synthetic") }] };
  }, () => {
    const state = images.snapshot("thread").images;
    if (state.find((image: any) => image.id === "first")?.state === "complete") terminal.resolve();
    if (state.find((image: any) => image.id === "second")?.state === "complete") second.resolve();
  }, 1);
  await images.start();
  images.accept("thread", "one", '<pi-remote-image id="first" prompt="first" />');
  await started.promise;
  for (const sql of Object.values(gates)) db.exec(sql);
  images.accept("thread", "two", '<pi-remote-image id="second" prompt="second" />');
  const racedClaim = images.save("thread", { ...images.snapshot("thread").images.find((image: any) => image.id === "second"), state: "generating" });
  if (racedClaim !== false) throw new Error("Original save accepted a fenced raced claim");
  release.resolve();
  await terminal.promise;
  if (calls !== 1 || aborted || images.snapshot("thread").images.find((image: any) => image.id === "second")?.state !== "queued") throw new Error("Fence did not conserve accepted/queued work");
  for (const name of Object.keys(gates)) db.exec(`DROP TRIGGER ${name}`);
  images.pump();
  await second.promise;
  await images.close();
  if (calls !== 2 || aborted) throw new Error("Queued work did not resume exactly once without aborting accepted work");
  console.log(JSON.stringify({ ok: true, sourceSha256: createHash("sha256").update(readFileSync(source)).digest("hex"), providerCalls: calls, acceptedAborted: aborted, raceRefused: true, queuePreserved: true }));
} finally {
  if (images) await images.close();
  db.close(); rmSync(root, { recursive: true, force: true });
}

import { expect, test } from "bun:test";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CustodyResources } from "../src/core/custody-resources.js";
import { createImageReader } from "../src/core/image-read.js";
import { loadImageInputs } from "../src/image-service.js";

const png = Buffer.from("89504e470d0a1a0a", "hex");
function resources(root: string, uid: number, gid: number) {
  const source = readFileSync(`/proc/${process.pid}/stat`, "utf8");
  const namespace = { kind: "process" as const, pid: process.pid, startTicks: source.slice(source.lastIndexOf(")") + 2).split(/\s+/)[19]!, mountNamespaceInode: statSync("/proc/self/ns/mnt", { bigint: true }).ino.toString() };
  return new CustodyResources({ uid, gid, namespace, retainedRunnerNamespace: namespace, dataDir: root, socketDir: root });
}

test("fixed namespace reader enforces owner UID even with a slash-wide lexical grant", async () => {
  const root = mkdtempSync(join(tmpdir(), "image-uid-proof-"));
  chmodSync(root, 0o755);
  const shared = join(root, "shared.png"), privateFile = join(root, "private.png");
  writeFileSync(shared, png, { mode: 0o644 });
  chmodSync(shared, 0o644);
  writeFileSync(privateFile, png, { mode: 0o600 });
  const owned = resources(root, 65534, 65534);
  try {
    const read = createImageReader(owned), signal = new AbortController().signal;
    expect(await read(shared, ["/"], signal)).toEqual({ ok: true, value: png });
    const denied = await read(privateFile, ["/"], signal);
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.error.message).toContain("Permission denied");
    const secretDir = join(root, "separate-owner");
    mkdirSync(secretDir, { mode: 0o700 });
    const nested = join(secretDir, "private.png");
    writeFileSync(nested, png, { mode: 0o644 });
    chmodSync(nested, 0o644);
    expect((await read(nested, ["/"], signal)).ok).toBe(false);
    expect((await read(shared, [secretDir], signal)).ok).toBe(false);
  } finally { owned.close(); rmSync(root, { recursive: true, force: true }); }
});

test("bounded reader rejects redirection, nonregular inputs and excessive files", async () => {
  const root = mkdtempSync(join(tmpdir(), "image-read-proof-"));
  const granted = join(root, "granted"); mkdirSync(granted);
  const source = join(root, "outside.png"); writeFileSync(source, png);
  const redirected = join(granted, "redirect.png"); symlinkSync(source, redirected);
  const large = join(granted, "large.png"); writeFileSync(large, Buffer.alloc(32 * 1024 * 1024 + 1));
  const owned = resources(root, process.getuid!(), process.getgid!());
  try {
    const read = createImageReader(owned), signal = new AbortController().signal;
    expect((await read(redirected, [granted], signal)).ok).toBe(false);
    expect((await read(granted, [granted], signal)).ok).toBe(false);
    expect((await read(large, [granted], signal)).ok).toBe(false);
  } finally { owned.close(); rmSync(root, { recursive: true, force: true }); }
});

test("provider consumes accepted byte snapshots without reopening filesystem references", async () => {
  const signal = new AbortController().signal;
  expect(await loadImageInputs({ prompt: "Edit", inputBytes: [png] }, "/missing", signal)).toEqual({ ok: true, value: [`data:image/png;base64,${png.toString("base64")}`] });
  const ambiguous = { prompt: "Edit", inputBytes: [png], inputPaths: ["/must-not-read"] };
  expect((await loadImageInputs(ambiguous as never, "/", signal)).ok).toBe(false);
  expect((await loadImageInputs({ prompt: "Edit", inputBytes: [Buffer.alloc(32 * 1024 * 1024 + 1)] }, "/", signal)).ok).toBe(false);
});

import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KenanKeys, type CustodyResult } from "./one-kenan-keys";
import { custodyVerify } from "./one-kenan";
import { verifyOwnedCustodyKey } from "./one-kenan-verify";
import type { Person } from "./persons";
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "custody-verify-")); roots.push(root);
  const path = join(root, "keys.json");
  const person: Person = { version: 1, user: "alice", displayName: "Alice", port: 1, unlock: { cipherDir: join(root, "cipher"), mountpoint: join(root, "private") }, environment: {} };
  let mounts = 0;
  const mount = async (): Promise<CustodyResult> => { mounts++; return { ok: true }; };
  const first = new KenanKeys(path, [person], mount);
  expect(await first.authenticate("alice", "fixture-key")).toEqual({ ok: true });
  mounts = 0;
  return { root, path, person, mount, mounts: () => mounts, keys: () => new KenanKeys(path, [person], mount) };
}
test("verification validates existing custody while preserving locked state, store inode and every mount", async () => {
  const f = await fixture();
  const before = readFileSync(f.path), inode = statSync(f.path).ino;
  const keys = f.keys(), status = keys.status();
  expect(await keys.verify("alice", "fixture-key")).toEqual({ ok: true });
  expect(await keys.verify("alice", "wrong-key")).toMatchObject({ ok: false, status: 403 });
  expect(await keys.verify("mallory", "fixture-key")).toMatchObject({ ok: false, status: 403 });
  expect(keys.status()).toEqual(status);
  expect(f.mounts()).toBe(0);
  expect(readFileSync(f.path)).toEqual(before);
  expect(statSync(f.path).ino).toBe(inode);
});
test("malformed and tampered custody never verify", async () => {
  const f = await fixture(), original = readFileSync(f.path, "utf8"), disk = JSON.parse(original);
  disk.wrappers.alice.salt = "invalid"; writeFileSync(f.path, JSON.stringify(disk));
  expect(await f.keys().verify("alice", "fixture-key")).toMatchObject({ ok: false, status: 503 });
  disk.wrappers.alice.salt = Buffer.alloc(32).toString("base64");
  delete disk.wrappers.alice; writeFileSync(f.path, JSON.stringify(disk));
  expect(await f.keys().verify("alice", "fixture-key")).toMatchObject({ ok: false, status: 503 });
  const tampered = JSON.parse(original); tampered.vault.tag = Buffer.alloc(16).toString("base64");
  writeFileSync(f.path, JSON.stringify(tampered));
  expect(await f.keys().verify("alice", "fixture-key")).toMatchObject({ ok: false, status: 503 });
  expect(f.mounts()).toBe(0);
});
test("helper refuses unavailable, nonprivate and symlink stores without exposing input", async () => {
  const f = await fixture(), input = { user: "alice", key: "fixture-key" };
  expect(await verifyOwnedCustodyKey(join(f.root, "absent"), [f.person], input)).toMatchObject({ ok: false, status: 503 });
  if (process.getuid?.() === 0) {
    expect(await verifyOwnedCustodyKey(f.path, [f.person], input)).toEqual({ ok: true });
    expect(await verifyOwnedCustodyKey(f.path, [f.person], { ...input, key: "wrong" })).toMatchObject({ ok: false, status: 403 });
    chmodSync(f.path, 0o644);
    expect(await verifyOwnedCustodyKey(f.path, [f.person], input)).toMatchObject({ ok: false, status: 503 });
    chmodSync(f.path, 0o600);
    symlinkSync(f.path, join(f.root, "linked"));
    expect(await verifyOwnedCustodyKey(join(f.root, "linked"), [f.person], input)).toMatchObject({ ok: false, status: 503 });
    writeFileSync(f.path, "not json");
    expect(await verifyOwnedCustodyKey(f.path, [f.person], input)).toMatchObject({ ok: false, status: 503 });
  } else expect(await verifyOwnedCustodyKey(f.path, [f.person], input)).toMatchObject({ ok: false, status: 503 });
  expect(f.mounts()).toBe(0);
});
test("router authority transport rejects missing/malformed/failed verifiers, accepting only typed results", async () => {
  const f = await fixture();
  const command = join(f.root, "verify");
  const config = { version: 1 as const, executionUser: "pi-kenan", custodySocket: "/fixture", keyVerifier: command };
  expect(await custodyVerify(config, "alice", "fixture-key")).toMatchObject({ ok: false, status: 503 });
  const script = (body: string) => { writeFileSync(command, `#!/usr/bin/python3\nimport json,sys\nx=json.load(sys.stdin)\n${body}\n`, { mode: 0o700 }); };
  script(`assert x == {"user":"alice","key":"fixture-key"}\nprint(json.dumps({"ok":True}))`);
  expect(await custodyVerify(config, "alice", "fixture-key")).toEqual({ ok: true });
  script(`print(json.dumps({"ok":True,"master":"leak"}))`);
  expect(await custodyVerify(config, "alice", "fixture-key")).toMatchObject({ ok: false, status: 503 });
  script(`print(json.dumps({"ok":False,"status":403,"error":"Wrong key"}))`);
  expect(await custodyVerify(config, "alice", "fixture-key")).toEqual({ ok: false, status: 403, error: "Wrong key" });
  script(`print("invalid")`);
  expect(await custodyVerify(config, "alice", "fixture-key")).toMatchObject({ ok: false, status: 503 });
});

test("fixed helper CLI returns only typed verification, leaving authority bytes unchanged", async () => {
  if (process.getuid?.() !== 0) return;
  const f = await fixture();
  const directory = join(f.root, "people"); mkdirSync(directory);
  const host = join(f.root, "host.json"), config = join(f.root, "owner.json"), personFile = join(directory, "alice.json");
  writeFileSync(host, JSON.stringify({ oneKenan: true }));
  writeFileSync(config, JSON.stringify({ version: 1, executionUser: "pi-kenan", custodySocket: "/fixture", keyStore: f.path }));
  writeFileSync(personFile, JSON.stringify(f.person));
  const before = readFileSync(f.path);
  for (const [key, expected] of [["fixture-key", 200], ["wrong", 403]] as const) {
    const child = Bun.spawn([process.execPath, join(import.meta.dir, "one-kenan-verify.ts")], { stdin: "pipe", stdout: "pipe", stderr: "pipe", env: { ...process.env, PI_STACK_HOST_FILE: host, PI_KENAN_CONFIG: config, PI_REMOTE_PERSONS_DIR: directory } });
    child.stdin.write(JSON.stringify({ user: "alice", key })); child.stdin.end();
    const [code, text] = await Promise.all([child.exited, new Response(child.stdout).text()]);
    expect(code).toBe(0);
    const result = JSON.parse(text);
    expect(result.ok ? 200 : result.status).toBe(expected);
    expect(text).not.toContain(key);
    expect(readFileSync(f.path)).toEqual(before);
  }
});

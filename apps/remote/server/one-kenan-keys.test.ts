import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KenanKeys, type CustodyResult } from "./one-kenan-keys";
import type { Person } from "./persons";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "kenan-keys-")); roots.push(root);
  const path = join(root, "keys.json");
  const people: Person[] = ["alice", "bob"].map(user => ({ version: 1, user, displayName: user, port: 19881, unlock: { cipherDir: join(root, user, "cipher"), mountpoint: join(root, user, "private") }, environment: {} }));
  const mounted = new Set<string>();
  const calls: string[] = [];
  const mount = async (person: Person, key: string): Promise<CustodyResult> => {
    calls.push(person.user);
    if (key !== `${person.user}-fixture-key`) return { ok: false, status: 403, error: "Wrong key" };
    mounted.add(person.user);
    return { ok: true };
  };
  return { path, people, mounted, calls, mount, create: () => new KenanKeys(path, people, mount) };
}
test("only validated keys initialize custody; unknown/wrong keys never enter disk", async () => {
  const f = fixture(), keys = f.create();
  expect((await keys.authenticate("alice", "wrong")).ok).toBe(false);
  expect(keys.status().initialized).toBe(false);
  expect((await keys.authenticate("mallory", "alice-fixture-key")).ok).toBe(false);
  expect((await keys.authenticate("alice", "alice-fixture-key")).ok).toBe(true);
  const disk = readFileSync(f.path, "utf8");
  expect(disk).not.toContain("alice-fixture-key");
  expect(statSync(f.path).mode & 0o777).toBe(0o600);
});
test("any enrolled person's first post-reboot login opens all known folders", async () => {
  const f = fixture(), keys = f.create();
  expect((await keys.authenticate("alice", "alice-fixture-key")).ok).toBe(true);
  expect((await keys.authenticate("bob", "bob-fixture-key")).ok).toBe(true);
  f.mounted.clear(); f.calls.length = 0;
  const reboot = f.create();
  expect(reboot.status().locked).toBe(true);
  expect((await reboot.authenticate("bob", "wrong")).ok).toBe(false);
  expect(f.mounted.size).toBe(0);
  expect((await reboot.authenticate("bob", "bob-fixture-key")).ok).toBe(true);
  expect([...f.mounted].sort()).toEqual(["alice", "bob"]);
  expect(reboot.status().locked).toBe(false);
  expect((await reboot.authenticate("alice", "wrong")).ok).toBe(false);
});
test("unenrolled person's valid key waits in RAM and is retained when custody opens", async () => {
  const f = fixture(), first = f.create();
  await first.authenticate("alice", "alice-fixture-key");
  const reboot = f.create();
  expect((await reboot.authenticate("bob", "bob-fixture-key")).ok).toBe(true);
  expect(reboot.status()).toMatchObject({ locked: true, pending: ["bob"] });
  expect((await reboot.authenticate("bob", "wrong")).ok).toBe(false);
  await reboot.authenticate("alice", "alice-fixture-key");
  expect(reboot.status()).toMatchObject({ locked: false, pending: [], enrolled: ["alice", "bob"] });
  expect((await f.create().authenticate("bob", "bob-fixture-key")).ok).toBe(true);
  const original = readFileSync(f.path, "utf8");
  await reboot.authenticate("bob", "bob-fixture-key");
  expect(readFileSync(f.path, "utf8")).toBe(original);
});
test("concurrent first logins cannot overwrite each other's custody", async () => {
  const f = fixture(), keys = f.create();
  const results = await Promise.all([keys.authenticate("alice", "alice-fixture-key"), keys.authenticate("bob", "bob-fixture-key")]);
  expect(results.every(result => result.ok)).toBe(true);
  expect(keys.status().enrolled).toEqual(["alice", "bob"]);
  expect((await f.create().authenticate("bob", "bob-fixture-key")).ok).toBe(true);
});
test("tampering cannot mint a login or mount a folder", async () => {
  const f = fixture(); await f.create().authenticate("alice", "alice-fixture-key");
  const disk = JSON.parse(readFileSync(f.path, "utf8")); disk.vault.tag = Buffer.alloc(16).toString("base64");
  writeFileSync(f.path, JSON.stringify(disk)); f.calls.length = 0;
  expect(await f.create().authenticate("alice", "alice-fixture-key")).toMatchObject({ ok: false, status: 503 });
  expect(f.calls).toEqual([]);
});

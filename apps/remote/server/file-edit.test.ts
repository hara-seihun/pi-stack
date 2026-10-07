import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileEditResponse } from "./file-edit";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "remote-file-edit-"));
  roots.push(root);
  const path = join(root, "claims.md");
  writeFileSync(path, "# Claims\n\nUnclaimed.\n", { mode: 0o640 });
  const backups = join(root, "backups");
  const read = (target = path) => fileEditResponse(new Request(`http://fixture/v1/files/edit?path=${encodeURIComponent(target)}`), backups);
  const save = (body: unknown) => fileEditResponse(new Request("http://fixture/v1/files/edit", {
    method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  }), backups);
  return { path, root, backups, read, save };
}

test("edit/save uses fresh content, retains symlink and inode, rejects stale drafts", async () => {
  const f = fixture();
  const alias = join(f.root, "shared.md");
  symlinkSync(f.path, alias);
  const before = statSync(f.path);
  const response = await f.read(alias);
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  const snapshot = await response.json();
  expect(snapshot.path).toBe(alias);
  const saved = await f.save({ ...snapshot, content: "# Claims\n\nClaimed.\n" });
  expect(saved.status).toBe(200);
  const next = await saved.json();
  expect(readFileSync(alias, "utf8")).toBe(next.content);
  expect(next.revision).not.toBe(snapshot.revision);
  expect(statSync(f.path).ino).toBe(before.ino);
  expect(statSync(f.path).mode).toBe(before.mode);
  expect((await f.save({ ...snapshot, content: "stale" })).status).toBe(409);
  expect(readFileSync(f.path, "utf8")).toBe(next.content);
});

test("independent helper processes cannot both save the same revision", async () => {
  const f = fixture();
  const snapshot = await (await f.read()).json();
  const responses = await Promise.all(["first", "second"].map(content => f.save({ ...snapshot, content })));
  expect(responses.map(response => response.status).sort()).toEqual([200, 409]);
  const winner = await responses.find(response => response.status === 200)!.json();
  expect(readFileSync(f.path, "utf8")).toBe(winner.content);
});

test("writable Unix permission, existing regular UTF-8 and bounded payload are mandatory", async () => {
  const f = fixture();
  chmodSync(f.path, 0o400);
  if (process.getuid?.() !== 0) expect((await f.read()).status).toBe(403);
  chmodSync(f.path, 0o600);
  expect((await f.read("relative.md")).status).toBe(400);
  expect((await f.read(join(f.root, "missing"))).status).toBe(404);
  expect((await f.read(f.root)).status).toBe(409);
  expect((await f.save({ path: f.path, content: "bad" })).status).toBe(400);
  expect((await f.save({ path: f.path, revision: "a".repeat(64), content: "x".repeat(1_048_577) })).status).toBe(413);
  expect(existsSync(f.backups)).toBe(false);
  writeFileSync(f.path, Buffer.from([0xff, 0xfe]));
  expect((await f.read()).status).toBe(415);
  writeFileSync(f.path, "binary\0text");
  expect((await f.read()).status).toBe(415);
});

test("save rejects a replaced path even when bytes are identical", async () => {
  const f = fixture();
  const snapshot = await (await f.read()).json();
  const other = join(f.root, "other.md");
  writeFileSync(other, snapshot.content);
  rmSync(f.path);
  symlinkSync(other, f.path);
  expect((await f.save({ ...snapshot, content: "attack" })).status).toBe(409);
  expect(readFileSync(other, "utf8")).toBe(snapshot.content);
});

test("HTTP parser rejects malformed and oversized bodies without dispatching a write", async () => {
  const f = fixture();
  const call = (body: string, type = "application/json") => fileEditResponse(new Request("http://fixture/v1/files/edit", {
    method: "PUT", headers: { "content-type": type }, body,
  }), f.backups);
  expect((await call("{bad")).status).toBe(400);
  expect((await call("[]")).status).toBe(400);
  expect((await call("{}", "text/plain")).status).toBe(415);
  expect((await call(" ".repeat(6 * 1_048_576 + 4097))).status).toBe(413);
  expect(readFileSync(f.path, "utf8")).toBe("# Claims\n\nUnclaimed.\n");
  expect(existsSync(f.backups)).toBe(false);
});

test("Python failure-injection fixtures run in the normal Remote test gate", () => {
  const result = Bun.spawnSync(["python3", "-B", "-m", "unittest", "discover", "-s", import.meta.dir, "-p", "file_edit_test.py"], {
    stdout: "pipe", stderr: "pipe", timeout: 15_000,
  });
  expect(result.stderr.toString()).toContain("OK");
  expect(result.exitCode).toBe(0);
});

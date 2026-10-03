import assert from "node:assert/strict";
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { cleanShellSpills } from "../deploy/clean-shell-spills.mjs";

function fixture(t) {
  const directory = fs.mkdtempSync(join(tmpdir(), "pi-spill-cleanup-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test("cleanup removes and counts only top-level regular spill logs", t => {
  const directory = fixture(t);
  fs.writeFileSync(join(directory, "pi-bash-one.log"), "synthetic output");
  fs.writeFileSync(join(directory, "pi-bash-two.log"), "synthetic output");
  fs.writeFileSync(join(directory, "keep.log"), "preserve");
  fs.writeFileSync(join(directory, "pi-bash-three.log.extra"), "preserve");
  fs.mkdirSync(join(directory, "pi-bash-directory.log"));
  fs.writeFileSync(join(directory, "pi-bash-directory.log", "pi-bash-nested.log"), "preserve");
  fs.symlinkSync("keep.log", join(directory, "pi-bash-link.log"));
  fs.symlinkSync("absent", join(directory, "pi-bash-dangling.log"));

  const result = spawnSync(process.execPath, [new URL("../deploy/clean-shell-spills.mjs", import.meta.url).pathname, directory], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "2\n");
  assert.deepEqual(fs.readdirSync(directory).sort(), [
    "keep.log", "pi-bash-dangling.log", "pi-bash-directory.log", "pi-bash-link.log", "pi-bash-three.log.extra",
  ]);
  assert.equal(fs.readFileSync(join(directory, "keep.log"), "utf8"), "preserve");
  assert.equal(fs.readFileSync(join(directory, "pi-bash-directory.log", "pi-bash-nested.log"), "utf8"), "preserve");
  assert.equal(cleanShellSpills(directory), 0);
});

test("cleanup never stats unrelated entries, including broken mountpoints", t => {
  const directory = fixture(t);
  fs.mkdirSync(join(directory, "broken-remote"));
  fs.writeFileSync(join(directory, "pi-bash-one.log"), "synthetic output");
  const lstat = fs.lstatSync;
  t.mock.method(fs, "lstatSync", (path, ...args) => {
    assert.notEqual(path, join(directory, "broken-remote"), "unrelated mount must not be inspected");
    return lstat(path, ...args);
  });
  assert.equal(cleanShellSpills(directory), 1);
});

for (const operation of ["lstatSync", "unlinkSync"]) {
  test(`cleanup tolerates a candidate disappearing during ${operation}`, t => {
    const directory = fixture(t);
    const path = join(directory, "pi-bash-race.log");
    fs.writeFileSync(path, "synthetic output");
    const original = fs[operation];
    const unlink = fs.unlinkSync;
    t.mock.method(fs, operation, (candidate, ...args) => {
      if (candidate === path) unlink(candidate);
      return original(candidate, ...args);
    });
    assert.equal(cleanShellSpills(directory), 0);
    assert.equal(fs.existsSync(path), false);
  });

  test(`cleanup propagates ${operation} errors other than absence`, t => {
    const directory = fixture(t);
    const path = join(directory, "pi-bash-denied.log");
    fs.writeFileSync(path, "synthetic output");
    const original = fs[operation];
    t.mock.method(fs, operation, (candidate, ...args) => {
      if (candidate === path) throw Object.assign(new Error("permission denied"), { code: "EACCES" });
      return original(candidate, ...args);
    });
    assert.throws(() => cleanShellSpills(directory), { code: "EACCES" });
    assert.equal(fs.readFileSync(path, "utf8"), "synthetic output");
  });
}

test("cleanup fails when its root cannot be read", t => {
  const directory = fixture(t);
  assert.throws(() => cleanShellSpills(join(directory, "missing")), { code: "ENOENT" });
});

import assert from "node:assert/strict";
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { cleanShellSpills } from "../deploy/clean-shell-spills.mjs";

function fixture(t) {
  const directory = fs.mkdtempSync(join(tmpdir(), "pi-spill-cleanup-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test("native owner bundles its own package helpers and loads with only external runtime dependencies", t => {
  const directory = fixture(t);
  const root = fileURLToPath(new URL("../", import.meta.url));
  const modules = process.env.PI_TEST_RUNTIME_MODULES ?? join(root, "node_modules");
  const esbuild = join(modules, "esbuild/bin/esbuild");
  const stage = join(directory, "runtime");
  fs.mkdirSync(join(stage, "capacity"), { recursive: true });
  fs.writeFileSync(join(stage, "package.json"), '{"type":"module"}');
  fs.copyFileSync(join(root, "packages/runtime/managed-agent.mjs"), join(stage, "managed-agent.mjs"));
  const recipe = fs.readFileSync(join(root, "deploy/runtime"), "utf8").split("\n")
    .find(line => line.includes('--outfile="$stage/capacity/native-session.js"'));
  assert.ok(recipe, "deployment must declare its native-session build");
  const build = spawnSync("bash", ["-euo", "pipefail", "-c",
    `${recipe.replace('"$root/node_modules/esbuild/bin/esbuild"', '"$esbuild"')} --metafile="$stage/inputs.json"`], {
    env: { ...process.env, root, stage, esbuild }, encoding: "utf8", timeout: 5000,
  });
  assert.equal(build.status, 0, build.stderr);
  const metadata = JSON.parse(fs.readFileSync(join(stage, "inputs.json"), "utf8"));
  const imports = Object.values(metadata.outputs).flatMap(output => output.imports).filter(entry => entry.external);
  const packages = new Set();
  for (const { path } of imports) {
    if (path.startsWith("node:")) continue;
    const name = path.startsWith("@") ? path.split("/").slice(0, 2).join("/") : path.split("/")[0];
    assert.notEqual(name, "pi-orchestrator", `native owner leaked a self-import: ${path}`);
    packages.add(name);
  }
  for (const name of packages) {
    const target = join(stage, "node_modules", name);
    fs.mkdirSync(dirname(target), { recursive: true });
    fs.symlinkSync(join(modules, name), target);
  }
  const load = spawnSync(process.execPath, ["--input-type=module", "-e", `
    import assert from 'node:assert/strict';
    import { pathToFileURL } from 'node:url';
    const sdk = await import(pathToFileURL(${JSON.stringify(join(stage, "node_modules/@earendil-works/pi-coding-agent/dist/index.js"))}));
    const owner = await import(pathToFileURL(${JSON.stringify(join(stage, "managed-agent.mjs"))}));
    assert.equal(typeof sdk.main, 'function');
    assert.equal(typeof owner.createManagedAgentSession, 'function');
    assert.equal(typeof owner.recoverNativeSessionOwners, 'function');
  `], { env: { ...process.env, PI_STACK_NATIVE_SESSION_MODULE: `file://${stage}/capacity/native-session.js` }, encoding: "utf8", timeout: 8000 });
  assert.equal(load.status, 0, `${load.stdout}\n${load.stderr}`);
});

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

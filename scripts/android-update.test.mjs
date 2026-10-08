import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { webBundleBytes } from "../deploy/android-web-bundle.mjs";

const bundleModule = new URL("../deploy/android-web-bundle.mjs", import.meta.url).href;
const installer = fileURLToPath(new URL("../deploy/android-update", import.meta.url));
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const run = (command, args, options = {}) => execFileSync(command, args, { encoding: "utf8", timeout: 5_000, ...options });
function scratch(t) {
  const root = mkdtempSync(join(tmpdir(), "android-update-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}
function apk(root, name, files) {
  const path = join(root, name);
  run("zip", ["-q", path, "-@"], { cwd: root, input: files.map(file => `assets/public/${file}`).join("\n") + "\n" });
  return path;
}

test("web bundle preserves client bytes and ignores extraction metadata, file order, timezone and umask", t => {
  const root = scratch(t);
  const client = {
    "index.html": "<script src='assets/app.js'></script>",
    "assets/app.js": "console.log('client');",
    "vendor/fonts/font with spaces.woff": Buffer.from([0, 255, 3, 7]),
  };
  for (const [name, content] of Object.entries(client)) {
    const path = join(root, "assets/public", name);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, content);
  }
  const first = apk(root, "first.apk", Object.keys(client));
  for (const name of Object.keys(client)) {
    const path = join(root, "assets/public", name);
    utimesSync(path, 1700000000, 1700000000);
    chmodSync(path, 0o600);
  }
  const second = apk(root, "second.apk", Object.keys(client).reverse());
  const bundled = [];
  for (const [index, input, timezone, mask] of [[0, first, "Pacific/Honolulu", 0o077], [1, first, "Asia/Tokyo", 0o022], [2, second, "UTC", 0o002]]) {
    const output = join(root, `${index}.zip`);
    run(process.execPath, ["--input-type=module", "-e", `
      import { writeFileSync } from 'node:fs';
      import { webBundleBytes } from ${JSON.stringify(bundleModule)};
      process.umask(${mask});
      writeFileSync(process.argv[2], webBundleBytes(process.argv[1]));
    `, input, output], { env: { ...process.env, TZ: timezone } });
    bundled.push(readFileSync(output));
  }
  assert.deepEqual(bundled[0], bundled[1]);
  assert.deepEqual(bundled[0], bundled[2]);
  assert.deepEqual(bundled[0], webBundleBytes(join(root, "assets/public"), "directory"));
  const output = join(root, "0.zip");
  assert.deepEqual(run("unzip", ["-Z1", output]).trim().split("\n"), Object.keys(client).sort());
  for (const [name, content] of Object.entries(client)) {
    assert.deepEqual(run("unzip", ["-p", output, name], { encoding: "buffer" }), Buffer.from(content));
  }
  writeFileSync(join(root, "assets/public/assets/app.js"), "console.log('changed');");
  assert.notEqual(hash(webBundleBytes(apk(root, "changed.apk", Object.keys(client)))), hash(bundled[0]));
});

for (const bundled of [false, true]) test(`${bundled ? "standalone bundled" : "source"} installer repeats unchanged artifacts but refuses to replace published web bytes`, t => {
  const root = scratch(t);
  const entry = bundled ? join(root, "android-update.js") : installer;
  if (bundled) {
    const receipt = JSON.parse(run("bun", [installer, "bundle", entry]));
    assert.equal(receipt.sha256, hash(readFileSync(entry)));
  }
  const source = join(root, "source");
  const destination = join(root, "installed");
  mkdirSync(source);
  const identity = { revision: "a".repeat(40), versionCode: 2000, applicationId: "works.kenan.piremote.kenan", shellId: "b".repeat(16) };
  const record = (manifest, suffix, bytes) => {
    const release = { ...identity, sha256: hash(bytes), size: bytes.length, fileName: `${identity.revision}.${suffix}` };
    writeFileSync(join(source, release.fileName), bytes);
    writeFileSync(join(source, manifest), JSON.stringify(release));
    return release;
  };
  record("manifest.json", "apk", Buffer.from("fixed APK"));
  const web = record("web-manifest.json", "web.zip", Buffer.from("fixed bundle"));
  const install = () => spawnSync("bun", [entry, "install", source], {
    cwd: root, encoding: "utf8", timeout: 5_000, env: { ...process.env, PI_REMOTE_APP_UPDATES_DIR: destination },
  });
  for (let i = 0; i < 2; i++) {
    const result = install();
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout).web, web);
  }
  record("web-manifest.json", "web.zip", Buffer.from("different bundle"));
  const result = install();
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Published web bundle bytes cannot change for an existing revision/);
  assert.deepEqual(JSON.parse(readFileSync(join(destination, "current/web-manifest.json"))), web);
  assert.equal(hash(readFileSync(join(destination, "current", web.fileName))), web.sha256);
});

test("web-only generations retain the native APK and reject compatibility, rollback and mutation errors", t => {
  const root = scratch(t);
  const destination = join(root, "installed");
  const source = join(root, "source");
  mkdirSync(source);
  const nativeBytes = Buffer.from("immutable native APK");
  const native = { revision: "a".repeat(40), versionCode: 10001, applicationId: "works.kenan.piremote.kenan", shellId: "b".repeat(16),
    sha256: hash(nativeBytes), size: nativeBytes.length, fileName: `${"a".repeat(40)}.apk` };
  writeFileSync(join(source, native.fileName), nativeBytes);
  writeFileSync(join(source, "manifest.json"), JSON.stringify(native));
  const install = () => spawnSync("bun", [installer, "install", source], { encoding: "utf8", timeout: 5_000,
    env: { ...process.env, PI_REMOTE_APP_UPDATES_DIR: destination } });
  let web;
  for (let index = 1; index < 8; index++) {
    const revision = index.toString(16).repeat(40);
    const bytes = Buffer.from(`web client ${index}`);
    web = { ...native, revision, versionCode: native.versionCode + index, sha256: hash(bytes), size: bytes.length, fileName: `${revision}.web.zip` };
    writeFileSync(join(source, web.fileName), bytes);
    writeFileSync(join(source, "web-manifest.json"), JSON.stringify(web));
    const result = install();
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), { ...native, web });
    assert.deepEqual(JSON.parse(readFileSync(join(destination, "current/web-manifest.json"))), web);
    assert.equal(hash(readFileSync(join(destination, "releases", native.revision, native.fileName))), native.sha256);
  }
  assert.equal(existsSync(join(destination, "releases", "1".repeat(40))), false, "old web client collected");
  const selected = JSON.parse(readFileSync(join(destination, "current/web-manifest.json")));
  writeFileSync(join(source, "web-manifest.json"), JSON.stringify({ ...web, shellId: "c".repeat(16) }));
  assert.match(install().stderr, /Web bundle does not belong/);
  writeFileSync(join(source, "web-manifest.json"), JSON.stringify({ ...web, versionCode: web.versionCode - 1 }));
  assert.match(install().stderr, /newer or conflicting/);
  writeFileSync(join(source, web.fileName), "mutated");
  writeFileSync(join(source, "web-manifest.json"), JSON.stringify({ ...web, size: 7, sha256: hash(Buffer.from("mutated")) }));
  assert.match(install().stderr, /Published web bundle bytes cannot change/);
  assert.deepEqual(JSON.parse(readFileSync(join(destination, "current/web-manifest.json"))), selected);
});

test("a committed web change reuses the checked shared web build without Gradle or another Vite build", t => {
  const root = scratch(t);
  const repository = join(root, "repository");
  const destination = join(root, "installed");
  mkdirSync(join(repository, "deploy"), { recursive: true });
  mkdirSync(join(repository, "apps/kenan/android"), { recursive: true });
  copyFileSync(fileURLToPath(new URL("../apps/kenan/release-info.mjs", import.meta.url)), join(repository, "apps/kenan/release-info.mjs"));
  writeFileSync(join(repository, "apps/kenan/capacitor.config.json"), JSON.stringify({ appId: "works.kenan.piremote.kenan" }));
  writeFileSync(join(repository, "apps/kenan/android/shell.java"), "native source");
  writeFileSync(join(repository, "package-lock.json"), JSON.stringify({ packages: { "apps/kenan": {} } }));
  writeFileSync(join(repository, ".gitignore"), "dist/\n");
  const git = (...args) => run("git", ["-C", repository, ...args]);
  git("init", "-q");
  git("config", "user.email", "fixture@example.test");
  git("config", "user.name", "Fixture");
  const commit = () => { git("add", "."); git("commit", "-qm", "fixture"); return JSON.parse(run("node", [join(repository, "apps/kenan/release-info.mjs")])); };
  const identity = commit();
  const source = join(root, "source");
  mkdirSync(source);
  const bytes = Buffer.from("previously checked native APK");
  const native = { ...identity, sha256: hash(bytes), size: bytes.length, fileName: `${identity.revision}.apk` };
  writeFileSync(join(source, native.fileName), bytes);
  writeFileSync(join(source, "manifest.json"), JSON.stringify(native));
  run("bun", [installer, "install", source], { env: { ...process.env, PI_REMOTE_APP_UPDATES_DIR: destination } });
  const entry = join(repository, "deploy/android-update.js");
  run("bun", [installer, "bundle", entry]);
  const invoke = (...args) => run("bun", [entry, ...args], { env: { ...process.env, PI_REMOTE_APP_UPDATES_DIR: destination } });
  writeFileSync(join(repository, "web.ts"), "new shared web source");
  const current = commit();
  assert.equal(current.shellId, identity.shellId);
  const plan = JSON.parse(invoke("plan"));
  assert.equal(plan.kind, "web");
  assert.deepEqual(plan.release, native);
  mkdirSync(join(repository, "apps/remote/web/dist"), { recursive: true });
  writeFileSync(join(repository, "apps/remote/web/dist/index.html"), "new shared client");
  const output = join(root, "prepared");
  invoke("prepare-web", output, plan.nativeDirectory);
  assert.deepEqual(JSON.parse(readFileSync(join(output, "manifest.json"))), native);
  const web = JSON.parse(readFileSync(join(output, "web-manifest.json")));
  assert.equal(web.revision, current.revision);
  assert.equal(web.versionCode, current.versionCode);
  assert.equal(web.shellId, native.shellId);
  assert.equal(run("unzip", ["-p", join(output, web.fileName), "index.html"]), "new shared client");
  assert.equal(existsSync(join(repository, "apps/kenan/android/app/build")), false);
  mkdirSync(join(repository, "apps/kenan/android/app/src/test"), { recursive: true });
  writeFileSync(join(repository, "apps/kenan/android/app/src/test/Test.java"), "new native test");
  commit();
  assert.equal(JSON.parse(invoke("plan")).kind, "native", "changed native tests still run the full native gate");
  writeFileSync(join(repository, "apps/kenan/android/shell.java"), "different native source");
  commit();
  assert.equal(JSON.parse(invoke("plan")).kind, "native");
});

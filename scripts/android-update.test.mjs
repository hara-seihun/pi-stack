import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
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
  const output = join(root, "0.zip");
  assert.deepEqual(run("unzip", ["-Z1", output]).trim().split("\n"), Object.keys(client).sort());
  for (const [name, content] of Object.entries(client)) {
    assert.deepEqual(run("unzip", ["-p", output, name], { encoding: "buffer" }), Buffer.from(content));
  }
  writeFileSync(join(root, "assets/public/assets/app.js"), "console.log('changed');");
  assert.notEqual(hash(webBundleBytes(apk(root, "changed.apk", Object.keys(client)))), hash(bundled[0]));
});

test("installation repeats unchanged artifacts but refuses to replace published web bytes", t => {
  const root = scratch(t);
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
  const install = () => spawnSync("bun", [installer, "install", source], {
    encoding: "utf8", timeout: 5_000, env: { ...process.env, PI_REMOTE_APP_UPDATES_DIR: destination },
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

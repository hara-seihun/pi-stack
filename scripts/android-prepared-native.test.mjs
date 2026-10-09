import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const installer = fileURLToPath(new URL("../deploy/android-update", import.meta.url));
const run = (command, args, options = {}) => execFileSync(command, args, { encoding: "utf8", timeout: 5_000, ...options });

test("checked prepared native artifacts can outlive failed host activation, but not changed inputs, missing proof or corrupt bytes", t => {
  const root = mkdtempSync(join(tmpdir(), "android-prepared-native-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repository = join(root, "repository");
  const requests = join(root, "requests");
  const destination = join(root, "never-activated");
  const directory = join(root, "prepared-native");
  mkdirSync(join(repository, "deploy"), { recursive: true });
  mkdirSync(join(repository, "apps/kenan/android/app/src/test"), { recursive: true });
  mkdirSync(requests);
  mkdirSync(directory);
  copyFileSync(fileURLToPath(new URL("../apps/kenan/release-info.mjs", import.meta.url)), join(repository, "apps/kenan/release-info.mjs"));
  writeFileSync(join(repository, "apps/kenan/capacitor.config.json"), JSON.stringify({ appId: "works.kenan.piremote.kenan" }));
  writeFileSync(join(repository, "apps/kenan/android/shell.java"), "native shell");
  writeFileSync(join(repository, "apps/kenan/android/app/src/test/Test.java"), "checked native test");
  writeFileSync(join(repository, "package-lock.json"), JSON.stringify({ packages: { "apps/kenan": {} } }));
  writeFileSync(join(repository, ".gitignore"), "dist/\n");
  const git = (...args) => run("git", ["-C", repository, ...args]);
  git("init", "-q");
  git("config", "user.email", "fixture@example.test");
  git("config", "user.name", "Fixture");
  const commit = () => {
    git("add", "."); git("commit", "-qm", "fixture");
    return JSON.parse(run("node", [join(repository, "apps/kenan/release-info.mjs")]));
  };
  const identity = commit();
  const bytes = Buffer.from("immutable checked native package");
  const release = { ...identity, sha256: createHash("sha256").update(bytes).digest("hex"), size: bytes.length, fileName: `${identity.revision}.apk` };
  writeFileSync(join(directory, release.fileName), bytes);
  writeFileSync(join(directory, "manifest.json"), JSON.stringify(release));
  const request = { requestId: "PUB-prepared", integrationSha: identity.revision, status: "failed",
    checks: { status: "passed", command: "npm run check && npm run android:test --workspace=kenan", at: "2026-10-09T00:00:00Z", androidPlan: { kind: "native", identity } },
    android: { directory, release, status: "prepared", hosts: {} } };
  const save = () => writeFileSync(join(requests, "PUB-prepared.json"), JSON.stringify(request));
  save();
  const entry = join(repository, "deploy/android-update.js");
  run("bun", [installer, "bundle", entry]);
  writeFileSync(join(repository, "web.ts"), "current shared web source");
  const current = commit();
  const invoke = (...args) => spawnSync("bun", [entry, ...args], { encoding: "utf8", timeout: 5_000,
    env: { ...process.env, PI_REMOTE_APP_UPDATES_DIR: destination } });
  const plan = () => {
    const result = invoke("plan", requests);
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  };
  const selected = plan();
  assert.equal(selected.kind, "web");
  assert.equal(selected.nativeDirectory, directory);
  assert.equal(selected.nativeProof.revision, identity.revision);
  assert.deepEqual(selected.release, release);
  mkdirSync(join(repository, "apps/remote/web/dist"), { recursive: true });
  writeFileSync(join(repository, "apps/remote/web/dist/index.html"), "current web client");
  const output = join(root, "prepared-web");
  const prepared = invoke("prepare-web", output, selected.nativeDirectory);
  assert.equal(prepared.status, 0, prepared.stderr);
  assert.deepEqual(readFileSync(join(output, release.fileName)), bytes);
  assert.equal(JSON.parse(readFileSync(join(output, "web-manifest.json"))).revision, current.revision);
  assert.equal(existsSync(destination), false);
  assert.equal(existsSync(join(repository, "apps/kenan/android/app/build")), false);

  request.checks.status = "failed"; save();
  assert.equal(plan().kind, "native", "aggregate failure does not prove native checks ran");
  request.nativeChecks = { status: "passed", revision: identity.revision, identity, command: "npm run android:test --workspace=kenan", at: "2026-10-09T00:00:00Z" }; save();
  assert.equal(plan().kind, "web", "independent successful native proof survives an unrelated source check failure");
  request.nativeChecks.revision = current.revision; save();
  assert.equal(plan().kind, "native", "native proof must bind to the prepared APK revision");
  delete request.nativeChecks;
  request.checks.status = "passed";
  request.checks.androidPlan.kind = "web"; save();
  assert.equal(plan().kind, "native", "web checks are not native proof");
  request.checks.androidPlan.kind = "native"; save();
  writeFileSync(join(directory, release.fileName), "corrupt bytes");
  assert.equal(plan().kind, "native");
  writeFileSync(join(directory, release.fileName), bytes);
  writeFileSync(join(repository, "apps/kenan/android/local.properties"), "piRemoteRouterUrl=https://changed.test\n");
  assert.equal(plan().kind, "native", "host-owned compiled inputs belong to shell identity");
  rmSync(join(repository, "apps/kenan/android/local.properties"));
  writeFileSync(join(repository, "apps/kenan/android/app/src/test/Test.java"), "different native test");
  const changedTests = commit();
  assert.equal(changedTests.shellId, current.shellId);
  assert.equal(plan().kind, "native", "test-only changes require new native checks");
  writeFileSync(join(repository, "apps/kenan/android/app/src/test/Test.java"), "checked native test");
  writeFileSync(join(repository, "apps/kenan/android/shell.java"), "different native shell");
  commit();
  assert.equal(plan().kind, "native");
});

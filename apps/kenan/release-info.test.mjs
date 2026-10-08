import assert from "node:assert/strict";
import { test } from "node:test";
import { bootstrapConfiguration, nativeDependencyClosure, shellIdentity, versionCodeFromCommitCount } from "./release-info.mjs";

test("a fresh public root can update the already installed Android app", () => {
  const installedVersionCode = 2_270;
  assert.ok(versionCodeFromCommitCount(1) > installedVersionCode);
  assert.equal(versionCodeFromCommitCount(2), versionCodeFromCommitCount(1) + 1);
  assert.throws(() => versionCodeFromCommitCount(0));
});

test("commit count and unit tests do not change native shell identity", () => {
  const native = "100644 blob aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\tapps/kenan/android/app/src/main/AndroidManifest.xml";
  const git = (command, _recursive, _fullTree, revision) => command === "show" ? JSON.stringify({ packages: { "apps/kenan": {} } })
    : `${native}\n100644 blob ${(revision === "first" ? "b" : "c").repeat(40)}\tapps/kenan/android/app/src/test/ExampleTest.java`;
  assert.equal(shellIdentity(git, "first"), shellIdentity(git, "second"));
  assert.notEqual(shellIdentity(git, "first"), shellIdentity((command, ...args) => command === "show" ? git(command, ...args) : native.replace("aaaa", "dddd"), "native-change"));
  assert.notEqual(shellIdentity(git, "first", bootstrapConfiguration("piRemoteRouterUrl=https://old.test")),
    shellIdentity(git, "first", bootstrapConfiguration("piRemoteRouterUrl=https\\://new.test/")));
  assert.equal(bootstrapConfiguration("sdk.dir=/x\npiRemoteRouterUrl = https\\://a.test/\n"), "router=https://a.test\npublic=");
});

test("native identity covers resolved native dependencies but not web-only lock changes", () => {
  const packages = {
    "apps/kenan": { dependencies: { "@capacitor/core": "8.5.0" }, devDependencies: { "@capacitor/cli": "8.4.3" } },
    "node_modules/@capacitor/core": { version: "8.5.0", integrity: "core" },
    "node_modules/@capacitor/cli": { version: "8.4.3", integrity: "cli", dependencies: { support: "1" } },
    "node_modules/support": { version: "1", integrity: "support" },
    "node_modules/react": { version: "19", integrity: "web" },
  };
  const git = () => JSON.stringify({ packages });
  const first = nativeDependencyClosure(git, "HEAD");
  packages["node_modules/react"].integrity = "changed web";
  assert.equal(nativeDependencyClosure(git, "HEAD"), first);
  packages["node_modules/support"].integrity = "changed native dependency";
  assert.notEqual(nativeDependencyClosure(git, "HEAD"), first);
  delete packages["node_modules/support"];
  assert.throws(() => nativeDependencyClosure(git, "HEAD"), /cannot resolve support/);
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { shellIdentity, versionCodeFromCommitCount } from "./release-info.mjs";

test("a fresh public root can update the already installed Android app", () => {
  const installedVersionCode = 2_270;
  assert.ok(versionCodeFromCommitCount(1) > installedVersionCode);
  assert.equal(versionCodeFromCommitCount(2), versionCodeFromCommitCount(1) + 1);
  assert.throws(() => versionCodeFromCommitCount(0));
});

test("commit count and unit tests do not change native shell identity", () => {
  const native = "100644 blob aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\tapps/kenan/android/app/src/main/AndroidManifest.xml";
  const git = (_command, _recursive, _fullTree, revision) => `${native}\n100644 blob ${(revision === "first" ? "b" : "c").repeat(40)}\tapps/kenan/android/app/src/test/ExampleTest.java`;
  assert.equal(shellIdentity(git, "first"), shellIdentity(git, "second"));
  assert.notEqual(shellIdentity(git, "first"), shellIdentity(() => native.replace("aaaa", "dddd"), "native-change"));
});

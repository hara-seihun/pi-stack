import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { browserExecutable } from "./browser-executable.mjs";

const configuration = nodeModules => ({ nodeModules, platform: "linux", architecture: "x64" });

test("ignored install scripts require explicit executable preparation before freeze", () => {
  const root = mkdtempSync(join(tmpdir(), "browser-executable-"));
  try {
    const bin = join(root, "agent-browser", "bin");
    mkdirSync(bin, { recursive: true });
    const path = join(bin, "agent-browser-linux-x64");
    writeFileSync(path, "#!/bin/sh\nprintf 'fixture-version\\n'\n", { mode: 0o644 });
    chmodSync(path, 0o644);
    const original = readFileSync(path);
    assert.equal(browserExecutable({ ...configuration(root), action: "verify" }).ok, false);
    assert.equal(browserExecutable({ ...configuration(root), action: "prepare" }).ok, true);
    assert.deepEqual(readFileSync(path), original);
    chmodSync(path, statSync(path).mode & 0o555);
    assert.equal(statSync(path).mode & 0o777, 0o555);
    assert.equal(browserExecutable({ ...configuration(root), action: "verify" }).ok, true);
    assert.equal(execFileSync(path, [], { encoding: "utf8" }), "fixture-version\n");
    const launcher = "#!/bin/sh\nprintf 'launcher-only\\n'\n";
    writeFileSync(join(bin, "agent-browser.js"), launcher, { mode: 0o755 });
    chmodSync(path, 0o444);
    assert.equal(browserExecutable({ ...configuration(root), action: "verify" }).ok, false);
    assert.equal(statSync(path).mode & 0o777, 0o444, "verify never mutates a frozen artifact");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("missing, unsupported and linked binaries produce errors, not another executable", () => {
  const root = mkdtempSync(join(tmpdir(), "browser-executable-"));
  try {
    assert.equal(browserExecutable({ ...configuration(root), action: "prepare" }).error, "browser_executable_unavailable");
    assert.equal(browserExecutable({ ...configuration(root), architecture: "unknown", action: "prepare" }).error, "browser_executable_platform");
    assert.equal(browserExecutable({ ...configuration(root), action: "unknown" }).error, "browser_executable_arguments");
    const bin = join(root, "agent-browser", "bin");
    mkdirSync(bin, { recursive: true });
    symlinkSync("/bin/true", join(bin, "agent-browser-linux-x64"));
    assert.equal(browserExecutable({ ...configuration(root), action: "prepare" }).error, "browser_executable_not_regular");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

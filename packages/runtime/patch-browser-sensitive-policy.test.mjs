import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { patchBrowserSensitivePolicy } from "./patch-browser-sensitive-policy.mjs";

function fixture(t, version = "0.6.6") {
  const root = mkdtempSync(join(tmpdir(), "browser-policy-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "dist/extensions/agent-browser"), { recursive: true });
  mkdirSync(join(root, "docs"));
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "pi-agent-browser-native", version }));
  writeFileSync(join(root, "dist/extensions/agent-browser/index.js"), 'const tool = { description: "Browse; experimental `sourceLookup` / `networkSourceLookup` for candidates only.", execute: originalExecute };');
  for (const file of ["README.md", "docs/TOOL_CONTRACT.md", "docs/COMMAND_REFERENCE.md"]) writeFileSync(join(root, file), "# Original docs\n");
  return root;
}

test("native metadata and installed docs describe protection without changing execution", t => {
  const root = fixture(t);
  patchBrowserSensitivePolicy(root);
  const entry = join(root, "dist/extensions/agent-browser/index.js");
  const source = readFileSync(entry, "utf8");
  assert.match(source, /SENSITIVE_OUTPUT_UNSUPPORTED/);
  assert.match(source, /execute: originalExecute/);
  const docs = readFileSync(join(root, "docs/TOOL_CONTRACT.md"), "utf8");
  assert.match(docs, /cross-origin frames and shadow roots/);
  assert.match(docs, /outputPath/);
  patchBrowserSensitivePolicy(root);
  assert.equal(readFileSync(entry, "utf8"), source);
  assert.equal(readFileSync(join(root, "docs/TOOL_CONTRACT.md"), "utf8"), docs);
});

test("unknown wrapper and changed metadata are explicit errors", t => {
  assert.throws(() => patchBrowserSensitivePolicy(fixture(t, "1.0.0")), /Unsupported native browser/);
  const root = fixture(t);
  writeFileSync(join(root, "dist/extensions/agent-browser/index.js"), "const tool = {};");
  assert.throws(() => patchBrowserSensitivePolicy(root), /description anchor changed/);
});

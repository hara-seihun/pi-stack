import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { patchBrowserSemanticFill, semanticFillTarget } from "./patch-browser-semantic-fill.mjs";

const require = createRequire(import.meta.url);
const nativeRoot = dirname(require.resolve("pi-agent-browser-native/package.json"));
function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "browser-semantic-fill-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  cpSync(join(nativeRoot, "dist/extensions/agent-browser/lib"), join(directory, "dist/extensions/agent-browser/lib"), { recursive: true });
  writeFileSync(join(directory, "package.json"), JSON.stringify({ name: "pi-agent-browser-native", version: "0.6.6", type: "module" }));
  return directory;
}

test("semantic fill preserves empty, zero, whitespace and nonempty text while rejecting unset and invalid text", async t => {
  const root = fixture(t);
  patchBrowserSemanticFill(root);
  const { compileAgentBrowserSemanticAction: compile } = await import(pathToFileURL(join(root, semanticFillTarget)).href);
  for (const [target, prefix, suffix] of [
    [{ selector: "#input" }, ["fill", "#input"], []],
    [{ locator: "label", value: "Input" }, ["find", "label", "Input", "fill"], []],
    [{ locator: "role", role: "textbox", name: "Input" }, ["find", "role", "textbox", "fill"], ["--name", "Input"]],
  ]) {
    for (const text of ["", "0", " ", "nonempty"]) {
      const result = compile({ action: "fill", ...target, text });
      assert.deepEqual(result.compiled.args, [...prefix, text, ...suffix]);
      assert.equal(result.error, undefined);
      assert.deepEqual(compile({ action: "fill", ...target, text, session: "owned" }).compiled.args, ["--session", "owned", ...prefix, text, ...suffix]);
    }
    const missing = compile({ action: "fill", ...target });
    assert.equal(missing.error, "semanticAction.text is required for fill.");
    assert.equal(missing.compiled, undefined);
    for (const text of [null, 0, false, {}]) {
      const invalid = compile({ action: "fill", ...target, text });
      assert.equal(invalid.error, "semanticAction.text must be a string when provided.");
      assert.equal(invalid.compiled, undefined);
    }
    assert.equal(compile({ action: "click", ...target, text: "" }).error, "semanticAction.text is only supported for fill actions.");
  }
});

test("semantic fill patch is idempotent and rejects unexpected source before mutation", t => {
  const root = fixture(t), target = join(root, semanticFillTarget);
  patchBrowserSemanticFill(root);
  const patched = readFileSync(target, "utf8");
  patchBrowserSemanticFill(root);
  assert.equal(readFileSync(target, "utf8"), patched);
  writeFileSync(target, `${patched}\nunknown source change\n`);
  assert.throws(() => patchBrowserSemanticFill(root), /differs from pinned/);
  assert.equal(readFileSync(target, "utf8"), `${patched}\nunknown source change\n`);
});

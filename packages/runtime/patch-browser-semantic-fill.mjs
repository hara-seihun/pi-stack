#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

// fitchmultz/pi-agent-browser-native v0.6.6, fe59ce7e5e4b2f4ba3312a1d4ac3b42fa5fe2cb9.
export const semanticFillTarget = "dist/extensions/agent-browser/lib/input-modes/semantic-action.js";
const originalSha256 = "a4d66dc8326bf9f7df6479b8802d0f7058d566fcecd198a95a05947a303d013b";
const patchedSha256 = "a55e2044196e9c7ab4858b5f0a3c0202ab87b7e30bb6084314acb4ee21bb5af0";
const digest = source => createHash("sha256").update(source).digest("hex");

export function patchBrowserSemanticFill(root) {
  const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  if (manifest.name !== "pi-agent-browser-native" || manifest.version !== "0.6.6") throw new Error("Unsupported native browser wrapper for semantic fill repair");
  const target = join(root, semanticFillTarget);
  const source = readFileSync(target, "utf8");
  if (digest(source) === patchedSha256) return;
  if (digest(source) !== originalSha256) throw new Error("Native semantic fill source differs from pinned v0.6.6");
  const before = 'action === "fill" && (typeof text !== "string" || text.length === 0)';
  if (source.split(before).length !== 3) throw new Error("Native semantic fill validation anchors changed");
  const patched = source.replaceAll(before, 'action === "fill" && text === undefined');
  if (digest(patched) !== patchedSha256) throw new Error("Native semantic fill patch output differs from expected source");
  writeFileSync(target, patched);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.length !== 3) throw new Error("usage: patch-browser-semantic-fill.mjs NATIVE_PACKAGE_ROOT");
  patchBrowserSemanticFill(process.argv[2]);
}

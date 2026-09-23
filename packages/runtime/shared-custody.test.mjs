import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { patchSessionDurability } from "./patch-session-durability.mjs";
import { patchSharedCustody } from "./patch-shared-custody.mjs";

const base = dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent")));
const chunks = join(base, "bundle/chunks");
const paths = ["session-manager", "settings-manager", "auth-storage"].map(name => join(base, `core/${name}.js`));
paths.push(...readdirSync(chunks).filter(name => name.endsWith(".js")).map(name => join(chunks, name))
  .filter(path => readFileSync(path, "utf8").includes("var SessionManager=class _SessionManager")));

for (const path of paths) test(`shared custody patches the pinned writer ${path.slice(base.length + 1)}`, () => {
  let source = readFileSync(path, "utf8");
  if (source.includes("SessionManager=class") || source.includes("export class SessionManager")) source = patchSessionDurability(source);
  const patched = patchSharedCustody(source);
  assert.equal(patchSharedCustody(patched), patched);
  assert.match(patched, /custodyFs\.fchownSync\(target, owner.uid, owner.gid\)/);
  if (path.includes("settings-manager") || path.includes("chunks")) assert.match(patched, /custodyReplaceFileSync\(path(?:13|14)?,\s*next\)/);
  if (path.includes("auth-storage") || path.includes("chunks")) assert.match(patched, /fs:\s*custodyLockFs/);
  const dir = mkdtempSync(join(tmpdir(), "pi-custody-patch-"));
  try {
    const candidate = join(dir, "writer.mjs");
    writeFileSync(candidate, patched);
    const result = spawnSync(process.execPath, ["--check", candidate], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

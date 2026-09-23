import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { patchSessionDurability } from "./patch-session-durability.mjs";

const base = dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent")));
const chunks = join(base, "bundle/chunks");
const paths = [
  join(base, "core/session-manager.js"),
  ...readdirSync(chunks)
    .filter((name) => name.endsWith(".js"))
    .map((name) => join(chunks, name))
    .filter((path) => readFileSync(path, "utf8").includes("var SessionManager=class _SessionManager")),
];

for (const path of paths) {
  const copy = path.includes("bundle/chunks") ? "bundled CLI" : "SDK";
  test(`Pi makes every session-file mutation durable in the ${copy}`, () => {
    const source = patchSessionDurability(readFileSync(path, "utf8"));
    assert.equal(patchSessionDurability(source), source);
    assert.match(source, /fsync(?:SessionFile)?Sync/u);
    assert.match(source, /syncSessionDirectory/u);
    assert.match(source, /replaceSessionFileDurably\(this\.sessionFile/u);
    assert.match(source, /appendSessionFileDurably\(this\.sessionFile/u);
    assert.match(source, /writeSessionFileDurably\(newSessionFile/u);
    const sessionManagerSource = source.slice(source.indexOf("function syncSessionDirectory"), source.indexOf(copy === "bundled CLI" ? "static async list(" : "    static async list(", source.indexOf("function syncSessionDirectory")));
    assert.doesNotMatch(sessionManagerSource, /appendFileSync/u);
    assert.ok([...sessionManagerSource.matchAll(/appendSessionFileDurably\(this\.sessionFile/gu)].length >= 2);

    const directory = mkdtempSync(join(tmpdir(), "pi-session-durability-"));
    const candidate = join(directory, "session-manager.mjs");
    try {
      writeFileSync(candidate, source);
      const checked = spawnSync(process.execPath, ["--check", candidate], { encoding: "utf8" });
      assert.equal(checked.status, 0, checked.stderr);
    }
    finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
}

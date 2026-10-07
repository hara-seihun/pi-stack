import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { rollbackCompatibility } from "../deploy/remote-rollback-compatible.mjs";

function releases(t, current, previous) {
  const root = mkdtempSync(join(tmpdir(), "remote-rollback-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const paths = [join(root, "selected"), join(root, "previous")];
  for (const [index, value] of [current, previous].entries()) {
    mkdirSync(paths[index]);
    if (value !== undefined) writeFileSync(join(paths[index], "data-contract.json"), JSON.stringify(value));
  }
  return paths;
}
const naming = { version: 1, schema: "thread-views-without-retired-naming-columns-v1" };

test("rollback is permitted only within an explicit unchanged persistent data contract", t => {
  assert.deepEqual(rollbackCompatibility(...releases(t, naming, naming)), { ok: true });
  const paths = releases(t, naming, { version: 1, schema: "retired-naming-columns" });
  assert.equal(rollbackCompatibility(...paths).ok, false);
  const command = spawnSync(process.execPath, ["deploy/remote-rollback-compatible.mjs", ...paths], { encoding: "utf8" });
  assert.equal(command.status, 1);
  assert.match(command.stderr, /retain forward selection/);
});

test("unmarked, malformed and unknown contracts never manufacture safe rollback", t => {
  for (const invalid of [undefined, null, {}, { version: 2, schema: naming.schema }, { version: 1, schema: "" }]) {
    assert.equal(rollbackCompatibility(...releases(t, naming, invalid)).ok, false);
    assert.equal(rollbackCompatibility(...releases(t, invalid, naming)).ok, false);
  }
});

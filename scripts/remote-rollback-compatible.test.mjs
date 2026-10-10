import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { rollbackCompatibility, providerRestartCompatibility } from "../deploy/remote-rollback-compatible.mjs";

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

test("persisted and interrupted provider cutovers refuse old restart while retaining forward-capable intake", t => {
  const paths = releases(t, naming, naming);
  const transition = join(paths[0], "host-transition.json");
  const boundary = { version: 1, boundary: "host-declared-provider-v1", phase: "installing" };
  writeFileSync(join(paths[0], "provider-contract.json"), JSON.stringify({ version: 1, rawOutboundProviders: boundary.boundary }));
  for (const phase of ["installing", "installed"]) {
    writeFileSync(transition, JSON.stringify({ ...boundary, phase }));
    assert.deepEqual(providerRestartCompatibility(paths[0], transition), { ok: true });
    assert.equal(providerRestartCompatibility(paths[1], transition).ok, false);
    assert.match(rollbackCompatibility(paths[0], paths[1], transition).error, /old-provider restart is forbidden/);
  }
  writeFileSync(join(paths[1], "provider-contract.json"), JSON.stringify({ version: 1, rawOutboundProviders: boundary.boundary }));
  assert.deepEqual(rollbackCompatibility(paths[0], paths[1], transition), { ok: true });
});

test("unknown boundary evidence and provider contract fail closed; absent boundary has no expanded rule", t => {
  const [selected] = releases(t, naming, naming);
  const transition = join(selected, "host-transition.json");
  assert.deepEqual(providerRestartCompatibility(selected, transition), { ok: true });
  for (const value of ["broken-json", JSON.stringify({ version: 2 }), JSON.stringify({ version: 1, boundary: "host-declared-provider-v1", phase: "unknown" })]) {
    writeFileSync(transition, value);
    assert.equal(providerRestartCompatibility(selected, transition).ok, false);
  }
  writeFileSync(transition, JSON.stringify({ version: 1, boundary: "host-declared-provider-v1", phase: "installed" }));
  for (const value of [{ version: 2, rawOutboundProviders: "host-declared-provider-v1" }, { version: 1, rawOutboundProviders: "unknown" }, {}]) {
    writeFileSync(join(selected, "provider-contract.json"), JSON.stringify(value));
    assert.equal(providerRestartCompatibility(selected, transition).ok, false);
  }
});

test("host gates provider capability before changing router or restarting rollback supervisors", () => {
  const source = readFileSync("deploy/host", "utf8");
  const activate = source.slice(source.indexOf("activate_remote() {"), source.indexOf("activate_daemons() {"));
  const restartGate = activate.indexOf("remote-rollback-compatible.mjs\" --restart");
  assert.ok(restartGate >= 0);
  assert.ok(restartGate < activate.indexOf("systemctl restart pi-remote-router.service"));
  const rollback = source.slice(source.indexOf("if (( smoke_failed )); then"));
  assert.ok(rollback.indexOf("remote-rollback-compatible.mjs") < rollback.indexOf('mv -Tf "$candidate" "$remote"'));
  assert.ok(rollback.indexOf("remote-rollback-compatible.mjs") < rollback.indexOf("systemctl reset-failed"));
});

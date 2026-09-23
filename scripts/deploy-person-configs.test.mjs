import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

const root = resolve(import.meta.dirname, "..");
test("deployment checks every person as its own user before changing releases", () => {
  const dir = mkdtempSync(join(tmpdir(), "person-preflight-"));
  const user = process.env.USER;
  const path = join(dir, `${user}.json`);
  const config = { version: 1, user };
  const run = () => spawnSync("bash", ["-c", `
    source "$1/deploy/lib"
    # Simulate the service's read permission, including when CI itself is root.
    pi_stack_run_as() {
      [[ $1 == "$USER" && $(stat -c %a "$PI_REMOTE_PERSONS_DIR/$1.json") == 644 ]] || return 1
      shift
      "$@"
    }
    pi_stack_check_person_configs
  `, "preflight", root], { encoding: "utf8", env: { ...process.env, PI_REMOTE_PERSONS_DIR: dir, PI_STACK_DEPLOY_NO_SUDO: "1" } });
  try {
    writeFileSync(path, JSON.stringify(config), { mode: 0o600 });
    let result = run();
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /not readable valid configuration/);
    chmodSync(path, 0o644);
    result = run();
    assert.equal(result.status, 0, result.stderr);
    writeFileSync(path, "{");
    assert.notEqual(run().status, 0);
    writeFileSync(path, JSON.stringify({ ...config, user: "another-person" }));
    assert.notEqual(run().status, 0);
    const host = readFileSync(join(root, "deploy/host"), "utf8");
    assert.ok(host.indexOf("pi_stack_check_person_configs") < host.indexOf('"$root/deploy/runtime"'));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

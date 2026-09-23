import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import test from "node:test";

function check(active, discoveryStatus = 0) {
  const root = mkdtempSync(join(tmpdir(), "pi-voice-check-"));
  try {
    mkdirSync(join(root, "deploy"));
    mkdirSync(join(root, "bin"));
    for (const file of ["voice", "lib", "release-checkout"]) copyFileSync(new URL(`../deploy/${file}`, import.meta.url), join(root, "deploy", file));
    writeFileSync(join(root, "bin/systemctl"), `#!/bin/sh
case "$1" in
  show) case "$*" in *LoadState*) echo loaded;; esac;;
  list-units) printf '%s' "$TEST_ACTIVE_UNITS"; exit "$TEST_DISCOVERY_STATUS";;
  *) exit 99;;
esac
`, { mode: 0o755 });
    writeFileSync(join(root, "bin/sudo"), "#!/bin/sh\n[ \"$1 $2 $3\" = '-n test -s' ]\n", { mode: 0o755 });
    return spawnSync("bash", [join(root, "deploy/voice"), "--check"], {
      encoding: "utf8",
      env: { ...process.env, PATH: `${root}/bin:${process.env.PATH}`, TEST_ACTIVE_UNITS: active,
        TEST_DISCOVERY_STATUS: String(discoveryStatus), PI_STACK_DEPLOY_DEADLINE_ACTIVE: "1",
        PI_STACK_HOST_LOCK_HELD: "1", PI_STACK_DEPLOY_LOCK_HELD: "1", PI_STACK_GIT_CHECKOUT: root },
    });
  } finally { rmSync(root, { recursive: true, force: true }); }
}

test("production preflight rejects development instances and accepts an idle host", () => {
  assert.equal(check("").status, 0);
  for (const unit of ["pi-remote-dev-web@alex.service", "pi-remote-dev-supervisor@sam.service", "pi-remote-dev-web.service"]) {
    const result = check(`${unit} loaded active running\n`);
    assert.equal(result.status, 66, result.stderr);
    assert.ok(result.stderr.includes(unit));
  }
  assert.equal(check("", 1).status, 1, "failed service discovery must fail preflight");
});

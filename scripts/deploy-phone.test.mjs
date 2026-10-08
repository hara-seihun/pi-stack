import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import test from "node:test";

function activate(state, bindings = "pi-remote@alex.service", restartStatus = 0, discoveryStatus = 0) {
  const root = mkdtempSync(join(tmpdir(), "pi-phone-activate-"));
  try {
    mkdirSync(join(root, "deploy"));
    mkdirSync(join(root, "bin"));
    for (const file of ["phone", "lib", "release-checkout"]) copyFileSync(new URL(`../deploy/${file}`, import.meta.url), join(root, "deploy", file));
    const trace = join(root, "trace");
    writeFileSync(trace, "");
    writeFileSync(join(root, "bin/systemctl"), `#!/bin/sh
printf '%s\\n' "$*" >> "$TEST_TRACE"
case "$1" in
  show)
    case "$*" in
      *LoadState*) echo loaded;;
      *BindsTo*) printf '%s\\n' "$TEST_BINDINGS"; exit "$TEST_DISCOVERY_STATUS";;
      *ActiveState*) printf '%s\\n' "$TEST_STATE"; exit "$TEST_DISCOVERY_STATUS";;
      *) exit 99;;
    esac;;
  restart) exit "$TEST_RESTART_STATUS";;
  stop) touch "$TEST_TRACE.unloaded"; exit 0;;
  reset-failed) [ ! -e "$TEST_TRACE.unloaded" ] || { echo 'Unit pi-stack-phone.service not loaded.' >&2; exit 1; }; exit 0;;
  is-active) exit 0;;
  *) exit 99;;
esac
`, { mode: 0o755 });
    writeFileSync(join(root, "bin/sudo"), '#!/bin/sh\n[ "$1" = -n ] || exit 99\nshift\nexec "$@"\n', { mode: 0o755 });
    const result = spawnSync("bash", [join(root, "deploy/phone"), "--activate"], {
      encoding: "utf8",
      env: { ...process.env, PATH: `${root}/bin:${process.env.PATH}`, TEST_STATE: state,
        TEST_BINDINGS: bindings, TEST_RESTART_STATUS: String(restartStatus),
        TEST_DISCOVERY_STATUS: String(discoveryStatus), TEST_TRACE: trace,
        PI_STACK_DEPLOY_DEADLINE_ACTIVE: "1", PI_STACK_HOST_LOCK_HELD: "1",
        PI_STACK_DEPLOY_LOCK_HELD: "1", PI_STACK_GIT_CHECKOUT: root },
    });
    return { ...result, trace: readFileSync(trace, "utf8") };
  } finally { rmSync(root, { recursive: true, force: true }); }
}

test("locked owner clears failed state before stop can unload the phone unit", () => {
  const result = activate("inactive");
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.trace, /reset-failed pi-stack-phone.service\nstop pi-stack-phone.service/);
  assert.doesNotMatch(result.trace, /^(start|restart) /m);
});

test("unlocked owner resets exhausted phone starts and activates calling", () => {
  const result = activate("active", "system.slice pi-remote@alex.service");
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.trace, /reset-failed pi-stack-phone.service\nrestart pi-stack-phone.service\nis-active --quiet pi-stack-phone.service/);
  assert.equal(activate("active", "pi-remote@alex.service", 1).status, 1);
});

test("failed, transitioning, unknown or undiscoverable owners never masquerade as locked success", () => {
  for (const state of ["failed", "", "unexpected"]) assert.equal(activate(state).status, 66);
  for (const state of ["activating", "deactivating", "reloading", "refreshing"]) assert.equal(activate(state).status, 75);
  for (const bindings of ["", "system.slice", "pi-remote@alex.service pi-remote@sam.service"]) assert.equal(activate("active", bindings).status, 66);
  assert.equal(activate("active", "pi-remote@alex.service", 0, 1).status, 1);
});

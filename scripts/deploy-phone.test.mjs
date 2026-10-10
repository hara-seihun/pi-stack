import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { phoneConfiguration } from '../deploy/phone-configuration.mjs';

function activate(state, bindings = "pi-remote@alex.service", restartStatus = 0, discoveryStatus = 0, phoneState = "inactive", action = "--activate", census = '{"activeCalls":0}') {
  const root = mkdtempSync(join(tmpdir(), "pi-phone-activate-"));
  try {
    mkdirSync(join(root, "deploy"));
    mkdirSync(join(root, "bin"));
    for (const file of ["phone", "phone-census", "phone-configuration.mjs", "lib", "release-checkout"]) copyFileSync(new URL(`../deploy/${file}`, import.meta.url), join(root, "deploy", file));
    assert.equal(spawnSync("git", ["init", "--quiet", root]).status, 0);
    assert.equal(spawnSync("git", ["-C", root, "-c", "user.name=Phone fixture", "-c", "user.email=fixture@example.invalid", "commit", "--quiet", "--allow-empty", "-m", "Phone fixture"]).status, 0);
    const host = join(root, 'host.json'), canonical = join(root, 'phone.json');
    writeFileSync(host, '{}');
    writeFileSync(canonical, '{}');
    const trace = join(root, "trace");
    writeFileSync(trace, "");
    writeFileSync(join(root, "bin/systemctl"), `#!/bin/sh
printf '%s\\n' "$*" >> "$TEST_TRACE"
case "$1" in
  show)
    case "$*" in
      *LoadState*) echo loaded;;
      *BindsTo*) printf '%s\\n' "$TEST_BINDINGS"; exit "$TEST_DISCOVERY_STATUS";;
      *pi-stack-phone.service*ActiveState*) printf '%s\\n' "$TEST_PHONE_STATE"; exit "$TEST_DISCOVERY_STATUS";;
      *ActiveState*) printf '%s\\n' "$TEST_STATE"; exit "$TEST_DISCOVERY_STATUS";;
      *) exit 99;;
    esac;;
  restart) exit "$TEST_RESTART_STATUS";;
  stop) touch "$TEST_TRACE.unloaded"; exit 0;;
  reset-failed) [ "$TEST_PHONE_STATE" = failed ] && [ ! -e "$TEST_TRACE.unloaded" ] || { echo 'Unit pi-stack-phone.service not loaded.' >&2; exit 1; }; exit 0;;
  is-active) exit 0;;
  *) exit 99;;
esac
`, { mode: 0o755 });
    writeFileSync(join(root, "bin/sudo"), '#!/bin/sh\n[ "$1" = -n ] || exit 99\nshift\nexec "$@"\n', { mode: 0o755 });
    writeFileSync(join(root, "bin/bun"), `#!/bin/sh
case "$1" in
  */config-check.ts) exit 0;;
  */pi-call) printf '%s\\n' "$TEST_CENSUS";;
  *) exit 99;;
esac
`, { mode: 0o755 });
    const result = spawnSync("bash", [join(root, "deploy/phone"), action], {
      encoding: "utf8",
      env: { ...process.env, PATH: `${root}/bin:${process.env.PATH}`, TEST_STATE: state,
        TEST_BINDINGS: bindings, TEST_RESTART_STATUS: String(restartStatus),
        TEST_DISCOVERY_STATUS: String(discoveryStatus), TEST_PHONE_STATE: phoneState, TEST_TRACE: trace,
        TEST_CENSUS: census, PI_STACK_PHONE_CONFIG: canonical,
        PI_STACK_DEPLOY_DEADLINE_ACTIVE: "1", PI_STACK_HOST_FILE: host, PI_STACK_HOST_LOCK_HELD: "1",
        PI_STACK_DEPLOY_LOCK_HELD: "1", PI_STACK_GIT_CHECKOUT: root,
        PI_STACK_HOST_LOCK_PATH: join(root, "host.lock") },
    });
    return { ...result, trace: readFileSync(trace, "utf8") };
  } finally { rmSync(root, { recursive: true, force: true }); }
}

test("Phone check admits idle and marks only genuine live calls as a deployment deferral", () => {
  const check = census => activate("active", "pi-remote@alex.service", 0, 0, "active", "--check", census);
  const idle = check('{"activeCalls":0}');
  assert.equal(idle.status, 0, idle.stderr);
  const live = check('{"activeCalls":1}');
  assert.equal(live.status, 75, live.stderr);
  assert.match(live.stderr, /^Live telephone calls; defer deployment$/m);
  const invalid = check('{"activeCalls":null}');
  assert.equal(invalid.status, 66, invalid.stderr);
  assert.match(invalid.stderr, /Phone census unavailable/);
  for (const result of [idle, live, invalid]) assert.doesNotMatch(result.trace, /^(reset-failed|stop|restart|start) /m);
});

test("locked owner stops an inactive phone without resetting an unloaded unit", () => {
  const result = activate("inactive");
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.trace, /stop pi-stack-phone.service/);
  assert.doesNotMatch(result.trace, /^(start|restart|reset-failed) /m);
});

test("locked owner clears actual failure before stopping the phone", () => {
  const result = activate("inactive", "pi-remote@alex.service", 0, 0, "failed");
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.trace, /reset-failed pi-stack-phone.service\nstop pi-stack-phone.service/);
  assert.doesNotMatch(result.trace, /^(start|restart) /m);
});

test("unlocked owner resets exhausted phone starts and activates calling", () => {
  const result = activate("active", "system.slice pi-remote@alex.service", 0, 0, "failed");
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.trace, /reset-failed pi-stack-phone.service\nrestart pi-stack-phone.service\nis-active --quiet pi-stack-phone.service/);
  assert.equal(activate("active", "pi-remote@alex.service", 1).status, 1);
});

test("active and inactive phones restart without unnecessary failure reset", () => {
  for (const phoneState of ["active", "inactive"]) {
    const result = activate("active", "pi-remote@alex.service", 0, 0, phoneState);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.trace, /restart pi-stack-phone.service/);
    assert.doesNotMatch(result.trace, /reset-failed/);
  }
});

test("transitioning or unknown phone state defers or rejects without effects", () => {
  for (const phoneState of ["activating", "deactivating", "reloading", "refreshing"]) {
    const result = activate("inactive", "pi-remote@alex.service", 0, 0, phoneState);
    assert.equal(result.status, 75);
    assert.doesNotMatch(result.trace, /^(reset-failed|stop|restart) /m);
  }
  for (const phoneState of ["", "unexpected"]) assert.equal(activate("inactive", "pi-remote@alex.service", 0, 0, phoneState).status, 66);
});

test("failed, transitioning, unknown or undiscoverable owners never masquerade as locked success", () => {
  for (const state of ["failed", "", "unexpected"]) assert.equal(activate(state).status, 66);
  for (const state of ["activating", "deactivating", "reloading", "refreshing"]) assert.equal(activate(state).status, 75);
  for (const bindings of ["", "system.slice", "pi-remote@alex.service pi-remote@sam.service"]) assert.equal(activate("active", bindings).status, 66);
  assert.equal(activate("active", "pi-remote@alex.service", 0, 1).status, 1);
});


test("prepared Phone configuration stays private and changes only at activation, with exact rollback custody", t => {
  const root = mkdtempSync(join(tmpdir(), 'phone-configuration-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const host = join(root, 'host.json'), canonical = join(root, 'serving.json'), candidate = join(root, 'candidate.json');
  const revision = 'a'.repeat(40), state = join(root, 'state');
  writeFileSync(host, JSON.stringify({ phoneConfigurationCandidate: candidate }));
  writeFileSync(canonical, 'serving', { mode: 0o600 });
  writeFileSync(candidate, 'prepared', { mode: 0o600 });
  const run = action => phoneConfiguration(action, host, revision, canonical, state);
  assert.equal(run('inspect').value.path, candidate);
  assert.equal(run('activate').ok, false, 'unproved configuration cannot activate');
  assert.equal(run('prepare').ok, true);
  assert.equal(readFileSync(canonical, 'utf8'), 'serving');
  assert.equal(run('activate').ok, true);
  assert.equal(readFileSync(canonical, 'utf8'), 'prepared');
  assert.equal(run('activate').ok, true, 'same preparation resumes without duplicating activation');
  assert.equal(run('restore').ok, true);
  assert.equal(readFileSync(canonical, 'utf8'), 'serving');
  assert.equal(run('restore').ok, true);
  assert.equal(run('activate').ok, false, 'restored attempt cannot rearm');
});

test("Phone configuration refuses changed candidates and serving generations without replacing either", t => {
  const root = mkdtempSync(join(tmpdir(), 'phone-configuration-refusal-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const host = join(root, 'host.json'), canonical = join(root, 'serving.json'), candidate = join(root, 'candidate.json');
  writeFileSync(host, JSON.stringify({ phoneConfigurationCandidate: candidate }));
  writeFileSync(canonical, 'serving', { mode: 0o600 }); writeFileSync(candidate, 'prepared', { mode: 0o600 });
  const run = action => phoneConfiguration(action, host, 'b'.repeat(40), canonical, join(root, 'state'));
  assert.equal(run('prepare').ok, true);
  writeFileSync(candidate, 'changed'); assert.equal(run('activate').ok, false);
  assert.equal(readFileSync(canonical, 'utf8'), 'serving');
  writeFileSync(candidate, 'prepared'); writeFileSync(canonical, 'another-owner-change');
  assert.equal(run('activate').ok, false);
  assert.equal(readFileSync(canonical, 'utf8'), 'another-owner-change');
  writeFileSync(canonical, 'serving'); assert.equal(run('activate').ok, true);
  writeFileSync(canonical, 'new-generation'); assert.equal(run('restore').ok, false);
  assert.equal(readFileSync(canonical, 'utf8'), 'new-generation');
});

test("unset Phone preparation retains canonical configuration; null and relative candidates are explicit errors", t => {
  const root = mkdtempSync(join(tmpdir(), 'phone-configuration-input-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const host = join(root, 'host.json'), canonical = join(root, 'serving.json');
  writeFileSync(host, '{}');
  assert.deepEqual(phoneConfiguration('inspect', host, 'c'.repeat(40), canonical), { ok: true, value: { kind: 'canonical', path: canonical } });
  for (const value of [null, '', 'relative', canonical]) {
    writeFileSync(host, JSON.stringify({ phoneConfigurationCandidate: value }));
    assert.equal(phoneConfiguration('inspect', host, 'c'.repeat(40), canonical).ok, false);
  }
});

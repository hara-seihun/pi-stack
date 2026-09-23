import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

const script = resolve("deploy/check-services");
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "pi-check-services-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const trace = join(dir, "trace");
  writeFileSync(join(dir, "curl"), `#!/usr/bin/env bash
printf '%s\\n' "curl $*" >> "$TRACE"
[[ ",$*," == *"/v1/router-health," ]] || exit 90
printf '%s\\n' "$ROUTER"
exit "\${CURL_STATUS:-0}"
`, { mode: 0o755 });
  writeFileSync(join(dir, "systemctl"), `#!/usr/bin/env bash
printf '%s\\n' "systemctl $*" >> "$TRACE"
case "$1" in
  is-active) [[ "$3" != "$INACTIVE" ]];;
  --failed) printf '%s\\n' "$FAILED"; exit "\${SYSTEMCTL_STATUS:-0}";;
  *) exit 91;;
esac
`, { mode: 0o755 });
  const router = { ok: true, environmentId: "local", people: [
    { user: "kenan", unlocked: false },
    { user: "sybil", unlocked: true },
  ] };
  const run = (overrides = {}) => {
    writeFileSync(trace, "");
    const result = spawnSync("bash", [script, "kenan", "local"], {
      encoding: "utf8", timeout: 3000,
      env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, TRACE: trace,
        ROUTER: JSON.stringify(router), INACTIVE: "pi-remote@kenan.service", FAILED: "", ...overrides },
    });
    return { ...result, trace: readFileSync(trace, "utf8") };
  };
  return { run, router };
}

test("locked Kenan stays stopped while every unlocked supervisor is checked", (t) => {
  const { run } = fixture(t);
  const result = run();
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.trace, /is-active --quiet pi-remote@sybil.service/);
  assert.doesNotMatch(result.trace, /pi-remote@kenan.service/);
  assert.doesNotMatch(result.trace, /\b(start|restart|unlock)\b/);
});

test("an inactive unlocked supervisor or shared service fails", (t) => {
  const { run, router } = fixture(t);
  for (const unit of ["pi-remote@sybil.service", "pi-orchestrator@kenan.service", "pi-remote-router.service", "pi-stack-voice.service"]) {
    const result = run({ INACTIVE: unit });
    assert.equal(result.status, 1);
    assert.ok(result.stderr.includes(`${unit} is not active`));
  }
  router.people[0].unlocked = true;
  const result = run({ ROUTER: JSON.stringify(router) });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /pi-remote@kenan.service is not active/);
});

test("an all-locked host still requires shared services and valid router health", (t) => {
  const { run, router } = fixture(t);
  router.people.forEach((person) => { person.unlocked = false; });
  const result = run({ ROUTER: JSON.stringify(router) });
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.trace, /pi-remote@/);
  for (const body of ["bad json", "{}", JSON.stringify({ ...router, ok: false }),
    JSON.stringify({ ...router, environmentId: "wrong" }),
    JSON.stringify({ ...router, people: [{ user: "kenan" }] }),
    JSON.stringify({ ...router, people: [{ user: "../kenan", unlocked: true }] })]) {
    assert.notEqual(run({ ROUTER: body }).status, 0, body);
  }
  assert.notEqual(run({ CURL_STATUS: "22" }).status, 0);
});

test("failed Pi units and failed unit enumeration remain errors", (t) => {
  const { run } = fixture(t);
  const result = run({ FAILED: "pi-remote@kenan.service loaded failed failed Remote" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /failed Pi units after release:\npi-remote@kenan.service/);
  assert.notEqual(run({ SYSTEMCTL_STATUS: "1" }).status, 0);
  assert.equal(run({ FAILED: "unrelated.service loaded failed failed Unrelated" }).status, 0);
});

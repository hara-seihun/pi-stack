import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { terminalTimezoneEnvironment } from "../packages/runtime/stack-pi.mjs";

const source = path => readFileSync(new URL(path, import.meta.url), "utf8");

test("terminal resolves its own declared projection, never another inherited person", () => {
  const original = { PI_PERSON_TIMEZONE_FILE: "/var/lib/pi-timezones/alice/timezone.json", HOME: "/fixture" };
  const env = terminalTimezoneEnvironment(original, "bob", path => path === "/var/lib/pi-timezones/bob");
  assert.equal(env.PI_PERSON_TIMEZONE_FILE, "/var/lib/pi-timezones/bob/timezone.json");
  assert.equal(original.PI_PERSON_TIMEZONE_FILE, "/var/lib/pi-timezones/alice/timezone.json");
  assert.equal(terminalTimezoneEnvironment(original, "unregistered", () => false).PI_PERSON_TIMEZONE_FILE, undefined);
});

test("fleet activation follows Remote's canonical projection readiness", () => {
  const host = source("../deploy/host");
  const activation = host.slice(host.indexOf('[[ $PI_STACK_HOST_PHASE == activation ]]'));
  assert.ok(activation.indexOf('activate_remote "$expected"') < activation.indexOf('"$root/deploy/timezone-ready"'));
  assert.ok(activation.indexOf('"$root/deploy/timezone-ready"') < activation.indexOf('activate_daemons &'));
});

test("only memory's fixed launch receives the narrow projection reader group", () => {
  const runtime = source("../deploy/one-kenan-runtime");
  assert.match(runtime, /if role == 'memory' and config.get\('memoryTimezoneGroup'\)/);
  assert.ok(runtime.indexOf("os.initgroups(") < runtime.indexOf("grp.getgrnam(config['memoryTimezoneGroup'])"));
  assert.ok(runtime.indexOf("grp.getgrnam(config['memoryTimezoneGroup'])") < runtime.indexOf("os.setuid("));
  assert.match(source("../apps/remote/server/pi-timezone-provision"), /settingValueWritten.*False/);
});

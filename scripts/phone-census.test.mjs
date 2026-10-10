import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "phone-census-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const bin = join(root, "bin"), trace = join(root, "trace");
  mkdirSync(bin);
  writeFileSync(join(bin, "systemctl"), `#!/bin/sh
printf '%s\\n' "$*" >> "$TRACE"
case "$*" in
  *LoadState*) printf '%s\\n' "$LOAD"; exit "$DISCOVERY_STATUS";;
  *ActiveState*) printf '%s\\n' "$STATE";;
  *) exit 99;;
esac
`, { mode: 0o755 });
  writeFileSync(join(bin, "bun"), `#!/bin/sh
printf '%s\\n' "$*" >> "$TRACE"
[ "$1" = /fixture/pi-call ] && [ "$2" = status ] || exit 99
printf '%s\\n' "$STATUS"
exit "$REQUEST_STATUS"
`, { mode: 0o755 });
  return (options = {}) => {
    writeFileSync(trace, "");
    const result = spawnSync("bash", [new URL("../deploy/phone-census", import.meta.url).pathname, "/fixture/pi-call"], {
      encoding: "utf8", timeout: 3000,
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, TRACE: trace,
        LOAD: "loaded", STATE: "active", STATUS: '{"activeCalls":0,"storedCallerId":"private"}',
        REQUEST_STATUS: "0", DISCOVERY_STATUS: "0", ...options },
    });
    return { ...result, trace: readFileSync(trace, "utf8") };
  };
}

test("telephone admission observes settled calls without mutation or caller disclosure", t => {
  const run = fixture(t);
  for (const activeCalls of [0, 1, 4]) {
    const result = run({ STATUS: JSON.stringify({ activeCalls, storedCallerId: "private" }) });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), { activeCalls });
    assert.doesNotMatch(result.stdout, /private/);
    assert.match(result.trace, /\/fixture\/pi-call status/);
    assert.doesNotMatch(result.trace, /restart|stop|end|prepare|check/);
  }
  for (const options of [{ LOAD: "not-found" }, { STATE: "inactive" }]) {
    const result = run(options);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), { activeCalls: 0 });
    assert.doesNotMatch(result.trace, /pi-call/);
  }
});

test("invalid or unavailable telephone census cannot masquerade as idle or live calls", t => {
  const run = fixture(t);
  for (const activeCalls of [null, "0", -1, 0.5, true, 9007199254740992]) {
    const result = run({ STATUS: JSON.stringify({ activeCalls }) });
    assert.equal(result.status, 66, `${activeCalls}: ${result.stderr}`);
    assert.match(result.stderr, /Phone census unavailable: invalid activeCalls count/);
    assert.equal(result.stdout, "");
  }
  for (const options of [{ STATUS: "{}" }, { STATUS: "invalid" }, { STATUS: "" },
    { STATUS: '{"activeCalls":0}\n{"activeCalls":0}' }, { REQUEST_STATUS: "1" },
    { DISCOVERY_STATUS: "1" }, { LOAD: "masked" }, { LOAD: "" },
    ...["failed", "activating", "deactivating", "reloading", "refreshing", "unknown", ""].map(STATE => ({ STATE }))]) {
    const result = run(options);
    assert.equal(result.status, 66, JSON.stringify(options));
    assert.match(result.stderr, /Phone census unavailable/);
    assert.equal(result.stdout, "");
    assert.doesNotMatch(result.trace, /restart|stop|end/);
  }
});

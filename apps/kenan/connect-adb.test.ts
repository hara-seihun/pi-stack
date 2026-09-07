import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

function connect(mode: string, endpoint: string, args: string[] = [], cached?: string) {
  const root = mkdtempSync(join(tmpdir(), "kenan-adb-test-"));
  const cache = join(root, "cache/pi-remote");
  mkdirSync(cache, { recursive: true });
  if (cached) writeFileSync(join(cache, "android-adb-endpoint"), cached);
  writeFileSync(join(root, "adb"), `#!/usr/bin/env bash
printf '%s' "$PWD" > "$TEST_ROOT/cwd"
case $1 in
  devices)
    echo 'List of devices attached'
    if [[ $TEST_MODE == connected || -f $TEST_ROOT/ready ]]; then echo "$TEST_ENDPOINT device model:Pixel_7"; fi ;;
  connect)
    if [[ $TEST_MODE != missing && $2 == "$TEST_ENDPOINT" ]]; then touch "$TEST_ROOT/ready"; else exit 1; fi ;;
  -s)
    if [[ $2 == "$TEST_ENDPOINT" && ( $TEST_MODE == connected || -f $TEST_ROOT/ready ) ]]; then echo device; else exit 1; fi ;;
  mdns)
    if [[ $TEST_MODE == mdns ]]; then printf 'phone _adb-tls-connect._tcp. %s\\n' "$TEST_ENDPOINT"; fi ;;
esac
`, { mode: 0o755 });
  try {
    const result = spawnSync("bash", [join(import.meta.dir, "connect-adb"), ...args], {
      encoding: "utf8", timeout: 2_000,
      env: { ...process.env, PATH: `${root}:${process.env.PATH}`, XDG_CACHE_HOME: join(root, "cache"), PI_REMOTE_ANDROID_MODEL: "Pixel_7", TEST_ROOT: root, TEST_MODE: mode, TEST_ENDPOINT: endpoint },
    });
    expect(readFileSync(join(root, "cwd"), "utf8")).toBe(cache);
    if (result.status === 0) expect(readFileSync(join(cache, "android-adb-endpoint"), "utf8").trim()).toBe(endpoint);
    return result;
  } finally { rmSync(root, { recursive: true, force: true }); }
}

test("discovers an authorized USB phone, saved LAN endpoint, or wireless mDNS endpoint", () => {
  for (const result of [connect("connected", "USB-serial"), connect("cached", "192.0.2.4:41000", [], "192.0.2.4:41000"), connect("mdns", "192.0.2.4:42000")]) {
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).not.toBe("");
  }
});
test("an explicit endpoint takes precedence and failures ask for debugging or pairing", () => {
  expect(connect("explicit", "192.0.2.4:43000", ["192.0.2.4:43000"]).status).toBe(0);
  const failed = connect("missing", "192.0.2.4:43000", ["192.0.2.4:43000"]);
  expect(failed.status).toBe(1);
  expect(failed.stderr).toContain("pair this host");
  expect(connect("missing", "none").status).toBe(1);
});

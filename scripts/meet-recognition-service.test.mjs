import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "pi-stack-meet-recognition-service-"));
  mkdirSync(join(directory, "deploy"));
  copyFileSync(join(root, "deploy/meet-recognition-service"), join(directory, "deploy/meet-recognition-service"));
  writeFileSync(join(directory, "deploy/lib"), `
pi_stack_enter_deployment() { :; }
sleep() { SECONDS=$((SECONDS + 1)); }
systemctl() {
  printf '%s %s\\n' "$SECONDS" "$*" >> "$TRACE"
  case $1 in
    enable|reset-failed) return 0 ;;
    restart) SECONDS=0; return "\${RESTART_EXIT:-0}" ;;
    is-active) (( SECONDS < \${STOP_AT:-1000} )) ;;
    status) echo 'fixture service diagnostics'; return 3 ;;
    *) return 64 ;;
  esac
}
pi_stack_as_root() {
  if [[ $1 == bash && -n \${PROBE_AT:-} ]]; then
    [[ $* == 'bash -c echo >/dev/tcp/127.0.0.1/8797' ]] || return 64
    printf '%s probe\\n' "$SECONDS" >> "$TRACE"
    (( SECONDS >= PROBE_AT ))
  else
    "$@"
  fi
}
`);
  const trace = join(directory, "trace");
  return {
    run(env = {}) {
      return spawnSync("bash", [join(directory, "deploy/meet-recognition-service"), "--activate"], {
        env: { ...process.env, PI_STACK_MEET_RECOGNITION_URL: "ws://127.0.0.1:8797/", TRACE: trace, ...env },
        encoding: "utf8", timeout: 3000,
      });
    },
    trace: () => readFileSync(trace, "utf8"),
    close: () => rmSync(directory, { recursive: true, force: true }),
  };
}

for (const readyAt of [0, 39]) test(`Meet recognition accepts a listener ready after ${readyAt} seconds without another restart`, () => {
  const f = fixture();
  try {
    const result = f.run({ PROBE_AT: String(readyAt) });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, "");
    assert.match(f.trace(), new RegExp(`^${readyAt} probe$`, "m"));
    assert.equal(f.trace().match(/restart pi-stack-meet-recognition.service/g).length, 1);
    assert.doesNotMatch(f.trace(), /status pi-stack-meet-recognition/);
  } finally { f.close(); }
});

test("Meet recognition bounds an unready service and reports diagnostics", () => {
  const f = fixture();
  try {
    const result = f.run({ PROBE_AT: "1000" });
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /did not bind its listener within 40 seconds/);
    assert.match(result.stderr, /fixture service diagnostics/);
    assert.match(f.trace(), /^40 status pi-stack-meet-recognition.service --no-pager --full$/m);
    assert.doesNotMatch(f.trace(), /^41 /m);
  } finally { f.close(); }
});

test("Meet recognition fails immediately when its unit exits or restart fails", () => {
  const f = fixture();
  try {
    const stopped = f.run({ PROBE_AT: "11", STOP_AT: "2" });
    assert.equal(stopped.status, 1, stopped.stderr);
    assert.match(stopped.stderr, /stopped before its listener was ready/);
    assert.match(stopped.stderr, /fixture service diagnostics/);
    assert.match(f.trace(), /^2 status pi-stack-meet-recognition.service/m);
    assert.doesNotMatch(f.trace(), /^2 probe/m);
    const failed = f.run({ RESTART_EXIT: "1", PROBE_AT: "0" });
    assert.equal(failed.status, 1, failed.stderr);
    assert.match(failed.stderr, /Meet recognition restart failed/);
    assert.match(failed.stderr, /fixture service diagnostics/);
  } finally { f.close(); }
});

test("Meet recognition probes the configured loopback TCP listener", async () => {
  const f = fixture();
  const listener = createServer((socket) => socket.destroy());
  try {
    await new Promise((resolve, reject) => {
      listener.once("error", reject);
      listener.listen(0, "127.0.0.1", resolve);
    });
    const result = f.run({ PROBE_AT: "", PI_STACK_MEET_RECOGNITION_URL: `ws://127.0.0.1:${listener.address().port}/` });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, "");
  } finally {
    listener.close();
    f.close();
  }
});

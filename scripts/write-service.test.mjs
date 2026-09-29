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
  const directory = mkdtempSync(join(tmpdir(), "pi-stack-write-service-"));
  mkdirSync(join(directory, "deploy"));
  copyFileSync(join(root, "deploy/write-service"), join(directory, "deploy/write-service"));
  // Only the host boundary and clock are simulated. Run the actual activation
  // script, advancing one second per poll so a 30-second timeout takes <1s.
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
      return spawnSync("bash", [join(directory, "deploy/write-service"), "--activate"], {
        env: { ...process.env, PI_STACK_WRITE_URL: "ws://127.0.0.1:8797/", TRACE: trace, ...env },
        encoding: "utf8", timeout: 3000,
      });
    },
    trace: () => readFileSync(trace, "utf8"),
    close: () => rmSync(directory, { recursive: true, force: true }),
  };
}

for (const readyAt of [0, 11, 29]) {
  test(`Write accepts a healthy listener ready after ${readyAt} seconds without restarting again`, () => {
    const f = fixture();
    try {
      const result = f.run({ PROBE_AT: String(readyAt) });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stderr, "");
      assert.match(f.trace(), new RegExp(`^${readyAt} probe$`, "m"));
      assert.equal(f.trace().match(/restart pi-stack-write.service/g).length, 1);
      assert.doesNotMatch(f.trace(), /status pi-stack-write/);
    } finally { f.close(); }
  });
}

test("Write bounds a live but unready engine and includes service diagnostics", () => {
  const f = fixture();
  try {
    const result = f.run({ PROBE_AT: "1000" });
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /did not bind its listener within 30 seconds/);
    assert.match(result.stderr, /fixture service diagnostics/);
    assert.match(f.trace(), /^30 status pi-stack-write.service --no-pager --full$/m);
    assert.doesNotMatch(f.trace(), /^31 /m);
  } finally { f.close(); }
});

test("Write fails immediately when the unit exits instead of spending the readiness budget", () => {
  const f = fixture();
  try {
    const result = f.run({ PROBE_AT: "11", STOP_AT: "2" });
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /stopped before its listener was ready/);
    assert.match(result.stderr, /fixture service diagnostics/);
    assert.match(f.trace(), /^2 status pi-stack-write.service/m);
    assert.doesNotMatch(f.trace(), /^2 probe/m);
  } finally { f.close(); }
});

test("Write reports restart failure without probing", () => {
  const f = fixture();
  try {
    const result = f.run({ RESTART_EXIT: "1", PROBE_AT: "0" });
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /Write engine restart failed/);
    assert.match(result.stderr, /fixture service diagnostics/);
    assert.doesNotMatch(f.trace(), /probe/);
  } finally { f.close(); }
});

test("Write probes the configured loopback listener using a real TCP connection", async () => {
  const f = fixture();
  const listener = createServer((socket) => socket.destroy());
  try {
    await new Promise((resolve, reject) => {
      listener.once("error", reject);
      listener.listen(0, "127.0.0.1", resolve);
    });
    const result = f.run({ PROBE_AT: "", PI_STACK_WRITE_URL: `ws://127.0.0.1:${listener.address().port}/` });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, "");
  } finally {
    listener.close();
    f.close();
  }
});

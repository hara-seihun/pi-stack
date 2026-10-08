import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "pi-stack-meet-recognition-service-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  mkdirSync(join(directory, "deploy"));
  copyFileSync(join(root, "deploy/meet-recognition-service"), join(directory, "deploy/meet-recognition-service"));
  const runtime = join(directory, "runtime"), trace = join(directory, "trace");
  mkdirSync(join(runtime, "venv/bin"), { recursive: true });
  mkdirSync(join(runtime, "model"));
  for (const file of ["ready", "server.py", "model/ready"]) writeFileSync(join(runtime, file), "fixture\n");
  writeFileSync(join(runtime, "venv/bin/python"), `#!/bin/sh
set -eu
printf 'python %s\\n' "$*" >> "$TRACE"
case $2 in
  preflight) grep -q 'stream.finish(9600)' || exit 64; exit "\${PREFLIGHT_EXIT:-0}";;
  endpoint)
    if [ "\${REAL_ENDPOINT:-0}" = 1 ]; then exec python3 "$@"; fi
    body=$(cat)
    printf '%s' "$body" | grep -Fq "partial['type'] == 'partial'" || exit 64
    printf '%s' "$body" | grep -Fq "final['type'] == 'final'" || exit 64
    exit "\${ENDPOINT_EXIT:-0}";;
  *) exit 64;;
esac
`, { mode: 0o755 });
  writeFileSync(join(directory, "deploy/lib"), `
pi_stack_enter_deployment() { :; }
pi_stack_as_root() { "$@"; }
systemctl() {
  printf 'systemctl %s\\n' "$*" >> "$TRACE"
  case $1 in
    show)
      case "$2:$4" in
        pi-stack-meet-recognition.service:LoadState) echo loaded;;
        pi-stack-meet-recognition.service:ActiveState) echo "\${PRIOR_ACTIVE:-inactive}";;
        pi-stack-meet-recognition.service:UnitFileState) echo "\${PRIOR_ENABLED:-disabled}";;
        pi-stack-write.service:LoadState) echo "\${OLD_LOADED:-loaded}";;
        pi-stack-write.service:ActiveState) echo active;;
        pi-stack-write.service:UnitFileState) echo enabled;;
        *) return 64;;
      esac;;
    restart) return "\${RESTART_EXIT:-0}";;
    is-active) return "\${ACTIVE_EXIT:-0}";;
    enable|disable|stop|start|reset-failed) return 0;;
    *) return 64;;
  esac
}
`);
  return {
    runtime, directory,
    run(env = {}) {
      return spawnSync("bash", [join(directory, "deploy/meet-recognition-service"), "--activate"], {
        env: { ...process.env, TRACE: trace, PI_STACK_MEET_RECOGNITION_DEST: runtime, PI_STACK_MEET_RECOGNITION_URL: "ws://127.0.0.1:8797/", ...env },
        encoding: "utf8", timeout: 3000,
      });
    },
    trace: () => readFileSync(trace, "utf8"),
  };
}

test("decoder preflight precedes same-port displacement; protocol acceptance precedes old engine disablement", t => {
  const f = fixture(t), result = f.run();
  assert.equal(result.status, 0, result.stderr);
  const trace = f.trace();
  assert.ok(trace.indexOf("python - preflight") < trace.indexOf("systemctl stop pi-stack-write.service"));
  assert.ok(trace.indexOf("systemctl restart pi-stack-meet-recognition.service") < trace.indexOf("python - endpoint"));
  assert.ok(trace.indexOf("python - endpoint") < trace.indexOf("systemctl disable pi-stack-write.service"));
  assert.equal(trace.match(/systemctl restart pi-stack-meet-recognition.service/g).length, 1);
});

test("unprepared or failed decoder leaves the previous speech owner untouched", t => {
  const f = fixture(t);
  const failed = f.run({ PREFLIGHT_EXIT: "23" });
  assert.equal(failed.status, 23, failed.stderr);
  assert.doesNotMatch(f.trace(), /systemctl (stop|restart|enable|disable|start)/);
  rmSync(join(f.runtime, "ready"));
  const missing = f.run();
  assert.equal(missing.status, 66, missing.stderr);
  assert.match(missing.stderr, /not prepared and selected/);
});

for (const failure of [{ RESTART_EXIT: "1" }, { ENDPOINT_EXIT: "1" }, { ACTIVE_EXIT: "1" }]) {
  test(`takeover restores prior speech lifecycle on ${JSON.stringify(failure)}`, t => {
    const f = fixture(t), result = f.run(failure);
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /restoring speech service lifecycle/);
    const trace = f.trace();
    assert.match(trace, /systemctl stop pi-stack-meet-recognition.service/);
    assert.match(trace, /systemctl disable pi-stack-meet-recognition.service/);
    assert.match(trace, /systemctl enable pi-stack-write.service/);
    assert.match(trace, /systemctl start pi-stack-write.service/);
    assert.doesNotMatch(trace, /systemctl disable pi-stack-write.service/);
  });
}

test("failed replacement restores an already-active recognizer and its enablement", t => {
  const f = fixture(t), result = f.run({ ENDPOINT_EXIT: "1", PRIOR_ACTIVE: "active", PRIOR_ENABLED: "enabled" });
  assert.equal(result.status, 1, result.stderr);
  assert.match(f.trace(), /systemctl start pi-stack-meet-recognition.service/);
  assert.doesNotMatch(f.trace(), /systemctl disable pi-stack-meet-recognition.service/);
});

test("protocol probe receives the declared loopback endpoint and rejects non-loopback destinations before mutation", t => {
  const f = fixture(t), result = f.run({ PI_STACK_MEET_RECOGNITION_URL: "ws://127.0.0.1:18881/", OLD_LOADED: "not-found" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(f.trace(), /python - endpoint ws:\/\/127\.0\.0\.1:18881\//);
  assert.doesNotMatch(f.trace(), /systemctl (stop|disable) pi-stack-write/);
  const invalid = f.run({ PI_STACK_MEET_RECOGNITION_URL: "ws://other.test:18881/" });
  assert.equal(invalid.status, 64, invalid.stderr);
});

for (const finalType of ["final", "wrong"]) test(`a reachable listener must actually accept PCM and return a ${finalType} protocol result`, async t => {
  const f = fixture(t), protocolTrace = join(f.directory, "protocol.json");
  const server = spawn("python3", ["-u", "-c", `
import asyncio, json, sys
from pathlib import Path
from websockets.asyncio.server import serve
sys.path.insert(0, sys.argv[3])
from protocol import Phase, parse_control
async def handle(socket):
    parsed = parse_control(await socket.recv(), Phase.AWAITING_START)
    if 'error' in parsed:
        await socket.send(json.dumps({'type': 'error', 'message': parsed['error']}))
        return
    assert parsed['value'] == {'type': 'start', 'turn': 'deployment-preflight'}
    audio = await socket.recv()
    assert isinstance(audio, bytes) and len(audio) == 3200
    await socket.send(json.dumps({'type': 'partial', 'text': ''}))
    assert json.loads(await socket.recv()) == {'type': 'finish'}
    Path(sys.argv[1]).write_text(json.dumps({'pcmBytes': len(audio), 'finish': True}))
    await socket.send(json.dumps({'type': sys.argv[2], 'text': ''}))
async def main():
    async with serve(handle, '127.0.0.1', 0) as server:
        print(server.sockets[0].getsockname()[1], flush=True)
        await asyncio.Future()
asyncio.run(main())
`, protocolTrace, finalType, join(root, "apps/meet-recognition")], { stdio: ["ignore", "pipe", "pipe"] });
  const exited = new Promise(resolve => server.once("exit", resolve));
  try {
    const port = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Protocol fixture did not listen")), 2000);
      server.once("error", error => { clearTimeout(timer); reject(error); });
      server.stdout.once("data", data => { clearTimeout(timer); resolve(Number(data.toString().trim())); });
    });
    const result = f.run({ REAL_ENDPOINT: "1", PI_STACK_MEET_RECOGNITION_URL: `ws://127.0.0.1:${port}/` });
    assert.equal(result.status, finalType === "final" ? 0 : 1, result.stderr);
    assert.deepEqual(JSON.parse(readFileSync(protocolTrace, "utf8")), { pcmBytes: 3200, finish: true });
    if (finalType === "wrong") {
      assert.match(result.stderr, /restoring speech service lifecycle/);
      assert.match(f.trace(), /systemctl start pi-stack-write.service/);
      assert.doesNotMatch(f.trace(), /systemctl disable pi-stack-write.service/);
    }
  } finally { server.kill("SIGKILL"); await exited; }
});

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";

const linux = process.platform === "linux";
const unpatchedReproduction = process.env.PI_TEST_BASH_CANCELLATION_UNPATCHED === "1";
const applyPatch = !unpatchedReproduction && process.env.PI_TEST_BASH_CANCELLATION_PATCH !== "0";
const tokens = new Set();
let directory;
let gnuTimeout;
let ownerModule;

function processIdentity(pid) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    return { pid, state: fields[0], start: fields[19] };
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "ESRCH") return undefined;
    throw error;
  }
}

function sameProcess(record) {
  return processIdentity(record.pid)?.start === record.start;
}

function ownedProcesses(token) {
  const result = new Map();
  if (!linux) return result;
  for (const entry of readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    const pid = Number(entry);
    if (pid === process.pid) continue;
    try {
      const argv = readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0");
      const testScope = argv.some(arg => arg.startsWith(`${directory}/modules/`) && arg.endsWith("/pi-shell-owner.py"))
        && argv.some(arg => arg.includes(`PI_BASH_CANCELLATION_TEST_TOKEN=${shellQuote(token)}`));
      if (!testScope && !argv.includes(join(directory, token))) continue;
      const env = testScope ? [] : readFileSync(`/proc/${pid}/environ`, "utf8").split("\0");
      if (testScope || env.includes(`PI_BASH_CANCELLATION_TEST_TOKEN=${token}`)) {
        const record = processIdentity(pid);
        if (record) result.set(pid, record);
      }
    } catch (error) {
      if (!["ENOENT", "ESRCH", "EACCES", "EPERM"].includes(error.code)) throw error;
    }
  }
  return result;
}

function signalPinned(records) {
  if (records.length === 0) return;
  // Pin before checking identity: no raw PID or group signal can hit a reused peer.
  const cleanup = spawnSync("/usr/bin/python3", ["-c", String.raw`
import json, os, signal, sys
from pathlib import Path
for record in json.load(sys.stdin):
    try:
        fd = os.pidfd_open(record["pid"])
    except ProcessLookupError:
        continue
    try:
        try:
            stat = Path(f'/proc/{record["pid"]}/stat').read_text()
            fields = stat[stat.rfind(")") + 2:].split()
            if fields[19] == record["start"]:
                signal.pidfd_send_signal(fd, signal.SIGKILL)
        except (FileNotFoundError, ProcessLookupError):
            pass
    finally:
        os.close(fd)
`], { input: JSON.stringify(records), encoding: "utf8", timeout: 2000 });
  assert.equal(cleanup.status, 0, `pidfd fixture cleanup failed: ${cleanup.stderr || cleanup.error}`);
}

function killOwned(token, recorded = []) {
  const records = new Map([...recorded.map(record => [record.pid, record]), ...ownedProcesses(token)]);
  signalPinned([...records.values()].filter(sameProcess));
}

process.on("exit", () => {
  for (const token of tokens) killOwned(token);
  if (directory) rmSync(directory, { recursive: true, force: true });
});

async function until(predicate, milliseconds, message) {
  const deadline = performance.now() + milliseconds;
  while (true) {
    if (predicate()) return;
    if (performance.now() >= deadline) assert.fail(message);
    await delay(10);
  }
}

const fixtureSource = String.raw`
import json, os, signal, subprocess, sys, time
from pathlib import Path

folder = Path(sys.argv[1])
mode = sys.argv[2]
signal.signal(signal.SIGTERM, signal.SIG_IGN)

def record(name, pid=None):
    pid = os.getpid() if pid is None else pid
    stat = Path(f"/proc/{pid}/stat").read_text()
    fields = stat[stat.rfind(")") + 2:].split()
    value = {"pid": pid, "start": fields[19], "pgid": os.getpgid(pid), "sid": os.getsid(pid)}
    temporary = folder / (name + ".tmp")
    temporary.write_text(json.dumps(value))
    temporary.replace(folder / (name + ".json"))

def wait_forever(name):
    record(name)
    time.sleep(30)

if mode == "leaf":
    wait_forever(sys.argv[3])
elif mode == "daemon":
    if os.fork():
        os._exit(0)
    os.setsid()
    if os.fork():
        os._exit(0)
    wait_forever("daemon")
elif mode == "sibling":
    record("sibling")
    deadline = time.monotonic() + 12
    while not (folder / "release").exists():
        if time.monotonic() > deadline:
            raise RuntimeError("sibling was never released")
        time.sleep(0.01)
    print("SIBLING-SUCCESS", flush=True)
elif mode == "tree":
    record("root")
    children = [subprocess.Popen([os.environ["PI_BASH_CANCELLATION_GNU_TIMEOUT"], "30s", sys.executable, __file__, str(folder), "leaf", f"worker-{i}"]) for i in range(3)]
    children.append(subprocess.Popen([sys.executable, __file__, str(folder), "leaf", "setsid"], start_new_session=True))
    daemon_parent = subprocess.Popen([sys.executable, __file__, str(folder), "daemon"])
    daemon_parent.wait()
    expected = [f"worker-{i}.json" for i in range(3)] + ["setsid.json", "daemon.json"]
    deadline = time.monotonic() + 5
    while not all((folder / name).exists() for name in expected):
        if time.monotonic() > deadline:
            raise RuntimeError("fixture descendants did not become ready")
        time.sleep(0.005)
    for i, child in enumerate(children[:3]):
        record(f"timeout-{i}", child.pid)
    (folder / "ready").write_text("ready")
    print("TREE-READY", flush=True)
    time.sleep(30)
else:
    raise RuntimeError(f"unknown fixture mode: {mode}")
`;

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function makeFixture(mode) {
  const token = randomUUID();
  tokens.add(token);
  const folder = join(directory, token);
  mkdirSync(folder);
  return {
    token, folder,
    command: `export PI_BASH_CANCELLATION_TEST_TOKEN=${shellQuote(token)} PI_BASH_CANCELLATION_GNU_TIMEOUT=${shellQuote(gnuTimeout)}; exec python3 ${shellQuote(join(directory, "fixture.py"))} ${shellQuote(folder)} ${mode}`,
  };
}

function recordsFor(fixture) {
  return readdirSync(fixture.folder).filter(name => name.endsWith(".json"))
    .map(name => ({ name: name.slice(0, -5), ...JSON.parse(readFileSync(join(fixture.folder, name), "utf8")) }));
}

async function cleanFixture(fixture) {
  const records = recordsFor(fixture);
  await until(() => {
    killOwned(fixture.token, records);
    return records.every(record => !sameProcess(record)) && ownedProcesses(fixture.token).size === 0;
  }, 2000, `test-owned leftovers did not disappear: ${JSON.stringify(records.filter(sameProcess))}`);
  tokens.delete(fixture.token);
}

function observed(promise) {
  return promise.then(value => ({ ok: true, value }), error => ({ ok: false, error }));
}

let backends = [];
if (linux) {
  const python = spawnSync("python3", ["--version"], { encoding: "utf8", timeout: 3000 });
  assert.equal(python.status, 0, `python3 is required: ${python.stderr}`);
  const timeoutCandidates = process.env.PI_TEST_GNU_TIMEOUT ? [process.env.PI_TEST_GNU_TIMEOUT] : ["timeout", "gnutimeout"];
  gnuTimeout = timeoutCandidates.find(command => {
    const proof = spawnSync(command, ["--version"], { encoding: "utf8", timeout: 3000 });
    return proof.status === 0 && /GNU coreutils/.test(proof.stdout);
  });
  assert.ok(gnuTimeout, "fixture requires GNU timeout (timeout, Ubuntu gnutimeout, or PI_TEST_GNU_TIMEOUT)");
  const runtime = process.env.PI_TEST_RUNTIME_ENTRY ?? import.meta.resolve("@earendil-works/pi-coding-agent");
  const originalBase = dirname(fileURLToPath(runtime));
  directory = mkdtempSync(join(tmpdir(), "pi-bash-cancellation-test-"));
  const modules = join(directory, "modules");
  const base = join(modules, "@earendil-works/pi-coding-agent/dist");
  const core = join(modules, "@earendil-works/pi-agent-core");
  mkdirSync(dirname(base), { recursive: true });
  cpSync(dirname(originalBase), dirname(base), { recursive: true });
  cpSync(join(dirname(dirname(originalBase)), "pi-agent-core"), core, { recursive: true });
  symlinkSync(dirname(dirname(dirname(originalBase))), join(directory, "node_modules"));
  writeFileSync(join(directory, "fixture.py"), fixtureSource);
  const patchBashCancellationCopies = applyPatch
    ? (await import("./patch-bash-cancellation.mjs")).patchBashCancellationCopies : undefined;
  if (applyPatch) patchBashCancellationCopies(modules);
  ownerModule = join(base, "pi-shell-owner.mjs");
  if (!unpatchedReproduction) {
    const paths = [join(base, "core/tools/bash.js"), join(base, "utils/shell.js"), join(base, "core/bash-executor.js"),
      join(core, "dist/harness/env/nodejs.js"),
      ...[base, join(core, "dist")].flatMap(path => [join(path, "pi-shell-owner.mjs"), join(path, "pi-shell-owner.py")])];
    const once = paths.map(path => readFileSync(path));
    if (applyPatch) {
      patchBashCancellationCopies(modules);
      paths.forEach((path, index) => assert.deepEqual(readFileSync(path), once[index], `patch idempotence: ${path}`));
    }
  }
  const load = path => import(pathToFileURL(path).href);
  const sdk = await load(join(base, "core/tools/bash.js"));
  const { NodeExecutionEnv } = await load(join(core, "dist/harness/env/nodejs.js"));
  const harness = await load(join(core, "dist/harness/utils/shell-output.js"));
  for (const [name, api] of [["SDK local Bash operations", sdk]]) {
    const operations = api.createLocalBashOperations();
    backends.push({ name, run: async (command, signal, timeout) => {
      const output = [];
      const result = await observed(operations.exec(command, directory, { signal, timeout, onData: chunk => output.push(chunk) }));
      if (!result.ok) return { kind: "error", error: result.error };
      return { kind: "success", exitCode: result.value.exitCode, output: Buffer.concat(output).toString("utf8") };
    } });
  }
  for (const [name, api] of [["SDK harness NodeExecutionEnv", harness]]) {
    const env = new NodeExecutionEnv({ cwd: directory });
    backends.push({ name, run: async (command, signal, timeout) => {
      const result = await api.executeShellWithCapture(env, command, { timeout }, { abortSignal: signal });
      if (!result.ok) return { kind: "error", error: result.error };
      if (result.value.cancelled) return { kind: "cancelled" };
      return { kind: "success", exitCode: result.value.exitCode, output: result.value.output };
    } });
  }
}

if (!linux) test("Bash descendant cancellation requires Linux /proc and subreaping", { skip: "Linux-only process lifecycle contract" }, () => {});

for (const backend of backends) {
  for (const mode of ["abort", "timeout"]) {
    test(`${backend.name}: ${mode} reaps escaped descendants without killing sibling execution`, { timeout: 12000 }, async () => {
      const victim = makeFixture("tree");
      const sibling = makeFixture("sibling");
      const controller = new AbortController();
      const siblingController = new AbortController();
      let victimRun;
      let siblingRun;
      try {
        siblingRun = observed(backend.run(sibling.command, siblingController.signal, 10));
        await until(() => existsSync(join(sibling.folder, "sibling.json")), 2000, "sibling did not start");
        const siblingRecord = recordsFor(sibling)[0];
        const started = performance.now();
        const timeoutSeconds = mode === "timeout" ? 1 : 10;
        victimRun = observed(backend.run(victim.command, controller.signal, timeoutSeconds));
        await until(() => existsSync(join(victim.folder, "ready")), 2000, "descendant fixture did not become ready before cancellation");
        const records = recordsFor(victim);
        assert.equal(records.length, 9, "root, three timeout/worker pairs, setsid worker and double-fork daemon are tracked");
        for (const record of records) {
          assert.ok(sameProcess(record), `${record.name} must be alive before cancellation`);
          assert.notEqual(processIdentity(record.pid)?.state, "Z", `${record.name} must not already be a zombie`);
        }
        const root = records.find(record => record.name === "root");
        for (let i = 0; i < 3; i++) {
          const timeout = records.find(record => record.name === `timeout-${i}`);
          const worker = records.find(record => record.name === `worker-${i}`);
          assert.equal(timeout.pgid, timeout.pid, "GNU timeout creates its own process group");
          assert.equal(worker.pgid, timeout.pgid);
          assert.notEqual(timeout.pgid, root.pgid);
        }
        for (const name of ["setsid", "daemon"]) {
          const escaped = records.find(record => record.name === name);
          assert.notEqual(escaped.sid, root.sid, `${name} escapes the original session`);
        }
        const cancellationStart = mode === "abort" ? performance.now() : started + timeoutSeconds * 1000;
        if (mode === "abort") controller.abort();
        const outcome = await Promise.race([
          victimRun,
          delay(Math.max(1, cancellationStart + 3000 - performance.now())).then(() => assert.fail("cancellation did not settle within 3 seconds")),
        ]);
        assert.equal(outcome.ok, true, "execution adapter itself must settle without throwing");
        const result = outcome.value;
        if (result.kind === "error") {
          assert.match(result.error.message, mode === "abort" ? /aborted/i : /timeout|timed out/i);
          if (result.error.code !== undefined) assert.equal(result.error.code, mode === "abort" ? "aborted" : "timeout");
        } else {
          assert.equal(mode, "abort");
          assert.equal(result.kind, "cancelled");
        }
        // ESRCH/absent identity is the oracle. A stopped or zombie process fails.
        await until(() => records.every(record => !sameProcess(record)),
          Math.max(1, cancellationStart + 3000 - performance.now()),
          `descendants survived ${mode}: ${JSON.stringify(records.filter(sameProcess))}`);
        assert.ok(performance.now() - cancellationStart < 3000, "full cancellation and reaping must take under 3 seconds");
        assert.equal(ownedProcesses(victim.token).size, 0, "no unrecorded test descendant may remain");
        assert.ok(sameProcess(siblingRecord), "cancellation must leave the concurrent sibling alive");
        assert.notEqual(processIdentity(siblingRecord.pid)?.state, "Z");
        writeFileSync(join(sibling.folder, "release"), "go");
        const siblingOutcome = await siblingRun;
        assert.equal(siblingOutcome.ok, true);
        assert.equal(siblingOutcome.value.kind, "success");
        assert.equal(siblingOutcome.value.exitCode, 0);
        assert.match(siblingOutcome.value.output, /SIBLING-SUCCESS/);
      } finally {
        controller.abort();
        siblingController.abort();
        // Cleanup runs even when readiness, cancellation or sibling isolation fails.
        // Each cleanup is attempted independently so one failure cannot leak the other tree.
        const cleanup = await Promise.allSettled([cleanFixture(victim), cleanFixture(sibling)]);
        await Promise.race([Promise.allSettled([victimRun, siblingRun].filter(Boolean)), delay(1000)]);
        const failures = cleanup.filter(result => result.status === "rejected");
        if (failures.length) throw new AggregateError(failures.map(result => result.reason), "fixture cleanup failed");
      }
    });
  }
}

if (linux && !unpatchedReproduction) {
  test("runner parent SIGKILL reaps its shell ownership scope without killing sibling execution", { timeout: 12000 }, async () => {
    const victim = makeFixture("tree");
    const sibling = makeFixture("sibling");
    const siblingController = new AbortController();
    const script = join(victim.folder, "owner.mjs");
    writeFileSync(script, `
import { spawnOwnedShell } from ${JSON.stringify(pathToFileURL(ownerModule).href)};
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
const child = spawnOwnedShell("/bin/bash", ["-c", process.argv[2]], {
  cwd: ${JSON.stringify(directory)}, stdio: ["ignore", "pipe", "pipe"],
});
const stat = readFileSync("/proc/" + child.pid + "/stat", "utf8");
const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
writeFileSync(${JSON.stringify(join(victim.folder, "scope.json"))}, JSON.stringify({ pid: child.pid, start: fields[19] }));
child.stdout.on("data", chunk => process.stdout.write(chunk));
child.stderr.on("data", chunk => process.stderr.write(chunk));
child.once("error", error => { console.error(error); process.exitCode = 1; });
while (!existsSync(${JSON.stringify(join(victim.folder, "die"))})) await delay(5);
process.kill(process.pid, "SIGKILL");
`);
    let ownerRecord;
    let ownerExit;
    let stderr = "";
    let siblingRun;
    try {
      siblingRun = observed(backends[0].run(sibling.command, siblingController.signal, 10));
      await until(() => existsSync(join(sibling.folder, "sibling.json")), 2000, "sibling did not start");
      const siblingRecord = recordsFor(sibling)[0];
      const owner = spawn(process.execPath, [script, victim.command], { stdio: ["ignore", "pipe", "pipe"] });
      ownerRecord = processIdentity(owner.pid);
      owner.stderr.on("data", chunk => { stderr += chunk; });
      owner.stdout.resume();
      ownerExit = observed(new Promise((resolve, reject) => {
        owner.once("error", reject);
        owner.once("exit", (code, signal) => resolve({ code, signal }));
      }));
      await until(() => existsSync(join(victim.folder, "ready")), 2500, "disposable runner did not launch descendants");
      const records = recordsFor(victim);
      assert.equal(records.length, 10, "nine fixture processes plus ownership supervisor are recorded");
      for (const record of records) assert.ok(sameProcess(record), `${record.name} is alive before parent death`);
      const started = performance.now();
      writeFileSync(join(victim.folder, "die"), "die");
      const death = await ownerExit;
      assert.equal(death.ok, true, stderr);
      assert.equal(death.value.signal, "SIGKILL", "only the disposable Node runner self-terminates");
      assert.ok(!sameProcess(ownerRecord));
      await until(() => records.every(record => !sameProcess(record)), 3000,
        `runner loss left descendants: ${JSON.stringify(records.filter(sameProcess))}; ${stderr}`);
      assert.ok(performance.now() - started < 3000, "runner-loss reaping takes under 3 seconds");
      assert.equal(ownedProcesses(victim.token).size, 0);
      assert.ok(sameProcess(siblingRecord), "runner death must not affect concurrent sibling execution");
      writeFileSync(join(sibling.folder, "release"), "go");
      const result = await siblingRun;
      assert.equal(result.ok, true);
      assert.equal(result.value.kind, "success");
      assert.equal(result.value.exitCode, 0);
      assert.match(result.value.output, /SIBLING-SUCCESS/);
    } finally {
      if (ownerRecord && sameProcess(ownerRecord)) signalPinned([ownerRecord]);
      siblingController.abort();
      const cleanup = await Promise.allSettled([cleanFixture(victim), cleanFixture(sibling)]);
      await Promise.race([Promise.allSettled([ownerExit, siblingRun].filter(Boolean)), delay(1000)]);
      const failures = cleanup.filter(result => result.status === "rejected");
      if (failures.length) throw new AggregateError(failures.map(result => result.reason), "fixture cleanup failed");
    }
  });
}

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { copyDeploymentOwner, copyRecognitionSources } from "./deployment-fixture.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const timeout = spawnSync("bash", ["-c", "command -v timeout"], { encoding: "utf8" }).stdout.trim();

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "pi-stack-prepare-"));
  const repo = join(directory, "repo"), bin = join(directory, "bin");
  mkdirSync(join(repo, "deploy"), { recursive: true });
  mkdirSync(bin);
  copyDeploymentOwner(root, repo);
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, PI_STACK_HOST_LOCK_HELD: "0", PI_STACK_HOST_LOCK_PATH: join(directory, "host.lock"), PI_STACK_DEPLOY_LOCK_HELD: "0", PI_STACK_DEPLOY_DEADLINE_ACTIVE: "0", PI_STACK_ALLOW_DIRTY: "0", PI_STACK_DEPLOY_NO_SUDO: "1", TRACE: join(directory, "trace"), TMPDIR: join(directory, "tmp"), PI_STACK_RUNTIME_DEST: join(directory, "srv/runtime"), PI_STACK_ORCHESTRATOR_DEST: join(directory, "srv/orchestrator"), PI_STACK_REMOTE_DEST: join(directory, "srv/remote"), PI_STACK_TOOLS_DEST: join(directory, "srv/tools"), PI_STACK_RELEASES_ROOT: join(directory, "srv/.pi-stack-releases"), PI_STACK_DEPENDENCIES_ROOT: join(directory, "srv/dependencies") };
  mkdirSync(env.TMPDIR);
  function executable(path, source) { writeFileSync(path, `#!/usr/bin/env bash\nset -euo pipefail\n${source}\n`, { mode: 0o755 }); }
  function commit() {
    for (const args of [["init", "-q"], ["add", "."], ["-c", "user.name=test", "-c", "user.email=test@example.test", "commit", "-qm", "fixture"]]) {
      const result = spawnSync("git", ["-C", repo, ...args], { encoding: "utf8" });
      assert.equal(result.status, 0, result.stderr);
    }
  }
  function run(name, extra = {}, args = []) {
    return spawnSync(join(repo, "deploy", name), args, { env: { ...env, ...extra }, encoding: "utf8", timeout: 3000 });
  }
  return { directory, repo, bin, env, executable, commit, run, close: () => rmSync(directory, { recursive: true, force: true }) };
}

function preparationFixture() {
  const f = fixture();
  copyFileSync(join(root, "deploy/prepared-components.mjs"), join(f.repo, "deploy/prepared-components.mjs"));
  f.executable(join(f.bin, "systemctl"), 'echo "preparation must delegate host discovery to its components" >&2; exit 64');
  f.executable(join(f.repo, "deploy/retain"), ':');
  writeFileSync(join(f.repo, "deploy/lib"), `${readFileSync(join(root, "deploy/lib"), "utf8")}\npi_stack_prepare_builds() { test "\${PI_STACK_DEPLOY_DEADLINE_ACTIVE:-}" = 1 || return 64; printf 'builds\\n' >> "$TRACE"; return "\${BUILD_EXIT:-0}"; }\n`);
  for (const name of ["runtime", "meet-recognition", "host", "orchestrator", "remote", "tools"]) {
    const isComponent = ["orchestrator", "remote", "tools"].includes(name);
    f.executable(join(f.repo, "deploy", name), `root=$(cd "$(dirname "$0")/.." && pwd)
source "$root/deploy/lib"
pi_stack_enter_deployment "$0" "$root" "$@"
printf '%s\\n' "${name}" >> "$TRACE"
sleep "\${${name.toUpperCase().replaceAll("-", "_")}_SECONDS:-\${WORK_SECONDS:-0}}"
finished=\${${name.toUpperCase().replaceAll("-", "_")}_FINISHED:-}
[[ -z $finished ]] || touch "$finished"
status=\${${name.toUpperCase().replaceAll("-", "_")}_EXIT:-0}
(( status == 0 )) || exit "$status"
${name === "runtime" ? '[[ $# == 1 && $1 == --prepare ]] || exit 64' : ""}
${isComponent ? `[[ $PI_STACK_PREPARE_ONLY == 1 && $PI_STACK_SKIP_TOOL_LINKS == 1 ]] || exit 64
commit=$(git -C "$root" rev-parse HEAD)
[[ $PI_STACK_RUNTIME_DEST == "$PI_STACK_RELEASES_ROOT/runtime/$commit" ]] || exit 64
[[ \${PI_STACK_${name.toUpperCase()}_DEST} == "$(dirname "$PI_STACK_RELEASES_ROOT")/.pi-stack-prepared/$commit/${name}" ]] || exit 64
[[ $(cat "$PI_STACK_RUNTIME_DEST/.pi-stack-commit") == "$commit" ]] || exit 66
${name === "orchestrator" ? "" : '[[ $(cat "$PI_STACK_ORCHESTRATOR_DEST/.pi-stack-commit") == "$commit" ]] || exit 66'}` : ""}
${name === "runtime" || isComponent ? `commit=$(git -C "$root" rev-parse HEAD)
release="$PI_STACK_RELEASES_ROOT/${name}/$commit"
mkdir -p "$release"
printf '%s\\n' "$commit" > "$release/.pi-stack-commit"
printf 'fixture ${name} artifact\\n' > "$release/payload"
${isComponent ? `ln -s "$release" "\${PI_STACK_${name.toUpperCase()}_DEST}"` : ""}` : ""}`);
  }
  f.executable(join(f.repo, "deploy/native-history-boundary"), `printf 'native-history-boundary\\n' >> "$TRACE"
[[ \${HISTORY_BOUNDARY_BUSY:-0} != 1 ]] || exit 75`);
  f.executable(join(f.bin, "timeout"), 'printf "deadline %s\\n" "$*" >> "$TRACE"; exit 124');
  f.commit();
  f.commitId = () => spawnSync("git", ["-C", f.repo, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();
  f.calls = () => readFileSync(f.env.TRACE, "utf8").trim().split("\n").sort();
  f.receipt = () => join(f.env.PI_STACK_RELEASES_ROOT, ".prepared", `${f.commitId()}.json`);
  const selected = [];
  for (const name of ["runtime", "orchestrator", "remote", "tools"]) {
    const live = f.env[`PI_STACK_${name.toUpperCase()}_DEST`];
    const old = join(f.env.PI_STACK_RELEASES_ROOT, name, "a".repeat(40));
    mkdirSync(old, { recursive: true });
    writeFileSync(join(old, ".pi-stack-commit"), `${"a".repeat(40)}\n`);
    symlinkSync(old, live);
    const link = join(f.directory, "home/.local/bin", name);
    mkdirSync(dirname(link), { recursive: true });
    symlinkSync(join(live, ".pi-stack-commit"), link);
    selected.push([live, old], [link, join(old, ".pi-stack-commit")]);
  }
  const intake = join(f.directory, "intake.json");
  writeFileSync(intake, '{"accepting":true,"nativeHistory":"busy"}\n');
  f.assertServing = () => {
    for (const [path, target] of selected) assert.equal(realpathSync(path), target, `${path} must retain its selected owner`);
    assert.equal(readFileSync(intake, "utf8"), '{"accepting":true,"nativeHistory":"busy"}\n');
  };
  return f;
}

test("preparation proves exact artifacts while native history is busy without changing selected owners or intake", () => {
  const f = preparationFixture();
  try {
    const result = f.run("prepare", { PI_STACK_SERVICES: "1", HISTORY_BOUNDARY_BUSY: "1", PI_STACK_HOST_FILE: join(f.directory, "host.json") });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(f.calls(), ["builds", "meet-recognition", "orchestrator", "remote", "runtime", "tools"]);
    f.assertServing();
    const receipt = JSON.parse(readFileSync(f.receipt(), "utf8"));
    assert.equal(receipt.commit, f.commitId());
    assert.equal(receipt.protocol, "prepared-components-v1");
    assert.deepEqual(receipt.artifacts.map(({ component }) => component), ["runtime", "orchestrator", "remote", "tools"]);
    for (const { component, path, sha256 } of receipt.artifacts) {
      assert.equal(path, join(f.env.PI_STACK_RELEASES_ROOT, component, f.commitId()));
      assert.match(sha256, /^[a-f0-9]{64}$/);
      assert.equal(readFileSync(join(path, ".pi-stack-commit"), "utf8").trim(), f.commitId());
    }
    const repeat = f.run("prepare", { HISTORY_BOUNDARY_BUSY: "1", BUILD_EXIT: "99" });
    assert.equal(repeat.status, 0, repeat.stderr);
    assert.match(repeat.stdout, /already prepared/);
    assert.deepEqual(f.calls(), ["builds", "meet-recognition", "meet-recognition", "orchestrator", "remote", "runtime", "tools"], "a verified receipt reuses stack artifacts while recognition checks its independent inputs");
    f.assertServing();
  } finally { f.close(); }
});

for (const state of ["missing", "restricted", "cached"]) test(`preparation makes public scratch ancestors traversable from ${state} state under a private umask`, () => {
  const f = preparationFixture();
  try {
    const scratchRoot = join(dirname(f.env.PI_STACK_RELEASES_ROOT), ".pi-stack-prepared");
    const candidate = join(scratchRoot, f.commitId());
    if (state === "cached") assert.equal(f.run("prepare").status, 0);
    if (state !== "missing") {
      mkdirSync(candidate, { recursive: true });
      chmodSync(scratchRoot, 0o700);
      chmodSync(candidate, 0o700);
    }
    const receipt = state === "cached" ? readFileSync(f.receipt(), "utf8") : undefined;
    const result = spawnSync("bash", ["-c", 'umask 077; exec "$@"', "prepare-fixture", join(f.repo, "deploy/prepare")], {
      env: { ...f.env, BUILD_EXIT: state === "cached" ? "99" : "0" }, encoding: "utf8", timeout: 3000,
    });
    assert.equal(result.status, 0, result.stderr);
    for (const path of [scratchRoot, candidate]) assert.equal(statSync(path).mode & 0o777, 0o755, `${path} must be traversable by public artifact consumers`);
    if (state === "cached") {
      assert.match(result.stdout, /already prepared/);
      assert.equal(readFileSync(f.receipt(), "utf8"), receipt, "mode reconciliation preserves the immutable artifact proof");
      assert.deepEqual(f.calls(), ["builds", "meet-recognition", "meet-recognition", "orchestrator", "remote", "runtime", "tools"]);
    }
    f.assertServing();
  } finally { f.close(); }
});

test("preparation uses the caller deadline for every child; standalone components keep theirs", () => {
  const f = preparationFixture();
  try {
    const prepared = f.run("prepare");
    assert.equal(prepared.status, 0, prepared.stderr);
    assert.equal(prepared.stderr, "");
    assert.deepEqual(f.calls(), ["builds", "meet-recognition", "orchestrator", "remote", "runtime", "tools"]);
    for (const name of ["host", "runtime", "meet-recognition"]) {
      const deployed = f.run(name);
      assert.equal(deployed.status, 124, deployed.stderr);
    }
    assert.equal(readFileSync(f.env.TRACE, "utf8").match(/deadline --signal=TERM --kill-after=2s 50s /g).length, 3);
  } finally { f.close(); }
});

for (const loadState of ["loaded", "not-found"]) test(`Recognition owns host discovery during preparation with its unit ${loadState}`, () => {
  const f = preparationFixture();
  try {
    copyFileSync(join(root, "deploy/meet-recognition"), join(f.repo, "deploy/meet-recognition"));
    copyRecognitionSources(root, f.repo);
    f.executable(join(f.bin, "systemctl"), `[[ "$*" == "show pi-stack-meet-recognition.service -p LoadState --value" ]] || exit 64
printf 'discovery\\n' >> "$TRACE"
printf '%s\\n' '${loadState}'`);
    f.executable(join(f.bin, "uv"), 'printf "uv\\n" >> "$TRACE"; exit 23');
    f.executable(join(f.bin, "curl"), 'echo "fixture must not download weights" >&2; exit 64');
    f.commit();
    const destination = join(f.directory, "meet-recognition");
    const result = f.run("prepare", { PI_STACK_MEET_RECOGNITION_DEST: destination, PI_STACK_MEET_RECOGNITION_FORCE: "0" });
    const calls = readFileSync(f.env.TRACE, "utf8").trim().split("\n").sort();
    if (loadState === "loaded") {
      assert.equal(result.status, 1, result.stderr);
      assert.deepEqual(calls, ["builds", "discovery", "runtime", "uv"]);
      assert.match(result.stderr, /meet-recognition exited 23/);
      assert.doesNotMatch(result.stdout, /prepared Pi stack/);
    } else {
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stderr, "");
      assert.deepEqual(calls, ["builds", "discovery", "orchestrator", "remote", "runtime", "tools"]);
      assert.match(result.stdout, /nothing to prepare/);
      assert.equal(existsSync(join(f.directory, ".pi-meet-recognition")), false);
    }
    assert.equal(existsSync(destination), false);
  } finally { f.close(); }
});

test("recognition prepares resumable pinned weights independently of dependencies and live selection", () => {
  const f = fixture();
  try {
    copyRecognitionSources(root, f.repo);
    const source = join(f.repo, "apps/meet-recognition");
    const bytes = Buffer.from("fixture pinned model bytes\n".repeat(8));
    const digest = createHash("sha256").update(bytes).digest("hex");
    const payload = join(f.directory, "payload");
    writeFileSync(payload, bytes);
    writeFileSync(join(source, "requirements.lock"), "first dependencies\n");
    writeFileSync(join(source, "server.py"), "# fixture\n");
    writeFileSync(join(source, "convert_fp32.py"), 'import os\nwith open(os.environ["TRACE"], "a") as f: f.write("convert\\n")\n');
    writeFileSync(join(source, "model.json"), JSON.stringify({
      files: { "encoder.onnx": digest, "vocab.txt": digest }, repository: "fixture", revision: "pin",
    }));
    const store = join(f.directory, ".pi-meet-recognition");
    const cached = join(store, "weights-cached");
    mkdirSync(cached, { recursive: true });
    writeFileSync(join(cached, "vocab.txt"), bytes);
    f.executable(join(f.bin, "uv"), `if [[ $1 == venv ]]; then
  mkdir -p "\${@: -1}/bin"
  ln -s "$(command -v python3)" "\${@: -1}/bin/python"
fi`);
    f.executable(join(f.bin, "sleep"), ":");
    f.executable(join(f.bin, "curl"), `while (( $# )); do
  if [[ $1 == -o ]]; then destination=$2; shift; fi
  shift
done
size=0
[[ ! -f $destination ]] || size=$(stat -c %s "$destination")
printf '%s %s\\n' "$(basename "$destination")" "$size" >> "$TRACE"
if (( size == 0 )); then
  head -c 32 "$PAYLOAD" > "$destination"
  printf '200'
  exit 92
fi
tail -c +$((size + 1)) "$PAYLOAD" >> "$destination"
printf '206'`);
    f.commit();
    const destination = join(f.directory, "meet-recognition");
    const env = { PI_STACK_MEET_RECOGNITION_DEST: destination, PI_STACK_MEET_RECOGNITION_FORCE: "1", PAYLOAD: payload };
    const unprepared = f.run("meet-recognition", env, ["--select"]);
    assert.equal(unprepared.status, 66, unprepared.stderr);
    assert.equal(existsSync(destination), false);
    const first = f.run("meet-recognition", env);
    assert.equal(first.status, 0, first.stderr);
    assert.equal(existsSync(destination), false, "preparation never selects recognition");
    const select = () => {
      const result = f.run("meet-recognition", env, ["--select"]);
      assert.equal(result.status, 0, result.stderr);
    };
    select();
    const firstTree = realpathSync(destination);
    const weights = realpathSync(join(destination, "model"));
    const venv = realpathSync(join(destination, "venv"));
    assert.deepEqual(readFileSync(join(weights, "encoder.onnx")), bytes);
    assert.deepEqual(readFileSync(join(weights, "vocab.txt")), bytes);
    const trace = readFileSync(f.env.TRACE, "utf8");
    assert.equal(trace, "encoder.onnx.part 0\nencoder.onnx.part 32\nconvert\n");
    writeFileSync(join(source, "requirements.lock"), "second dependencies\n");
    f.commit();
    const second = f.run("meet-recognition", env);
    assert.equal(second.status, 0, second.stderr);
    assert.equal(realpathSync(destination), firstTree, "preparation leaves the live selection unchanged");
    select();
    assert.notEqual(realpathSync(destination), firstTree);
    assert.notEqual(realpathSync(join(destination, "venv")), venv);
    assert.equal(realpathSync(join(destination, "model")), weights);
    assert.equal(readFileSync(f.env.TRACE, "utf8"), trace, "dependency changes reuse prepared weights");
    const secondTree = realpathSync(destination);
    select();
    assert.equal(realpathSync(`${destination}.previous`), firstTree, "repeat selection preserves the distinct rollback tree");
    writeFileSync(join(source, "server.py"), "# changed source\n");
    f.commit();
    const third = f.run("meet-recognition", env);
    assert.equal(third.status, 0, third.stderr);
    assert.equal(realpathSync(destination), secondTree);
    select();
    assert.equal(readFileSync(join(destination, "server.py"), "utf8"), "# changed source\n");
    assert.equal(realpathSync(join(destination, "model")), weights);
    assert.equal(readFileSync(f.env.TRACE, "utf8"), trace);
  } finally { f.close(); }
});

test("failed builds skip their dependent runtime while independent recognition is still awaited", () => {
  const f = preparationFixture();
  try {
    const finished = join(f.directory, "recognition-finished");
    const result = f.run("prepare", { RUNTIME_EXIT: "23", MEET_RECOGNITION_EXIT: "11", BUILD_EXIT: "9", MEET_RECOGNITION_SECONDS: "0.12", MEET_RECOGNITION_FINISHED: finished });
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /builds exited 9/);
    assert.doesNotMatch(result.stderr, /runtime exited/);
    assert.doesNotMatch(readFileSync(f.env.TRACE, "utf8"), /runtime/);
    assert.match(result.stderr, /meet-recognition exited 11/);
    assert.equal(existsSync(finished), true, "build failure must join recognition before returning");
    assert.equal(existsSync(f.receipt()), false);
    f.assertServing();
    assert.doesNotMatch(result.stdout, /prepared Pi stack/);
    const runtimeFailure = f.run("prepare", { RUNTIME_EXIT: "23", MEET_RECOGNITION_EXIT: "11" });
    assert.equal(runtimeFailure.status, 1, runtimeFailure.stderr);
    assert.match(runtimeFailure.stderr, /runtime exited 23/);
    assert.match(runtimeFailure.stderr, /meet-recognition exited 11/);
    assert.equal(existsSync(f.receipt()), false);
    f.assertServing();
  } finally { f.close(); }
});

for (const failed of ["remote", "tools"]) test(`failed ${failed} preparation joins its sibling before returning`, () => {
  const f = preparationFixture();
  try {
    const sibling = failed === "remote" ? "tools" : "remote";
    const finished = join(f.directory, `${sibling}-finished`);
    const result = f.run("prepare", {
      [`${failed.toUpperCase()}_EXIT`]: "23",
      [`${sibling.toUpperCase()}_SECONDS`]: "0.12",
      [`${sibling.toUpperCase()}_FINISHED`]: finished,
    });
    assert.equal(result.status, 1, result.stderr);
    assert.equal(existsSync(finished), true, "all independent stages must settle before failure returns");
    assert.equal(existsSync(f.receipt()), false, "failed components cannot acquire a prepared receipt");
    assert.doesNotMatch(result.stdout, /prepared Pi stack/);
    f.assertServing();
  } finally { f.close(); }
});

test("preparation refuses a changed artifact rather than rebuilding beneath a durable proof", () => {
  const f = preparationFixture();
  try {
    assert.equal(f.run("prepare").status, 0);
    const receipt = readFileSync(f.receipt(), "utf8");
    const calls = f.calls();
    writeFileSync(join(f.env.PI_STACK_RELEASES_ROOT, "remote", f.commitId(), "payload"), "changed artifact\n");
    const result = f.run("prepare");
    assert.equal(result.status, 66, result.stderr);
    assert.match(result.stdout, /prepared-artifact-changed/);
    assert.doesNotMatch(result.stdout, /already prepared/);
    assert.deepEqual(f.calls(), calls, "invalid proof must not rebuild or run components");
    assert.equal(readFileSync(f.receipt(), "utf8"), receipt);
    f.assertServing();
  } finally { f.close(); }
});

test("runtime consumes completed checkout declarations, never concurrent npm/build writes", () => {
  const f = preparationFixture();
  try {
    writeFileSync(join(f.repo, "deploy/lib"), `${readFileSync(join(root, "deploy/lib"), "utf8")}\npi_stack_prepare_builds() { sleep 0.15; touch "$DECLARATIONS_READY"; printf 'builds\\n' >> "$TRACE"; }\n`);
    const runtime = join(f.repo, "deploy/runtime");
    writeFileSync(runtime, readFileSync(runtime, "utf8").replace('printf \'%s\\n\' "runtime"', 'test -f "$DECLARATIONS_READY"; printf \'%s\\n\' "runtime"'));
    f.commit();
    const result = f.run("prepare", { DECLARATIONS_READY: join(f.directory, "declarations-ready") });
    assert.equal(result.status, 0, result.stderr);
    const trace = readFileSync(f.env.TRACE, "utf8").trim().split("\n");
    assert.ok(trace.indexOf("builds") < trace.indexOf("runtime"));
  } finally { f.close(); }
});

test("the caller can still terminate preparation and its children", async () => {
  const f = preparationFixture();
  let child;
  try {
    // Startup deliberately exceeds the former 200ms cancellation timer.
    f.executable(join(f.repo, "deploy/retain"), "/bin/sleep 0.3");
    f.commit();
    f.executable(join(f.bin, "sleep"), `printf 'ready %s\\n' "$PPID"
exec /bin/sleep "$@"`);
    child = spawn(timeout, ["--kill-after=1s", "10s", join(f.repo, "deploy/prepare")], {
      env: { ...f.env, WORK_SECONDS: "30" }, stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "", stderr = "", terminated = false;
    child.stdout.setEncoding("utf8").on("data", chunk => {
      stdout += chunk;
      if (!terminated && stdout.match(/^ready \d+$/gm)?.length === 2) {
        terminated = true;
        child.kill("SIGTERM");
      }
    });
    child.stderr.setEncoding("utf8").on("data", chunk => { stderr += chunk; });
    const result = await new Promise((resolve, reject) => {
      child.on("error", reject);
      child.on("close", (code, signal) => resolve({ code, signal }));
    });
    assert.equal(terminated, true, `both preparation children must start before cancellation: ${stderr}`);
    assert.deepEqual(result, { code: 124, signal: null }, stderr);
    assert.doesNotMatch(stdout, /prepared Pi stack/);
    assert.equal(existsSync(f.receipt()), false);
    f.assertServing();
    assert.deepEqual(readFileSync(f.env.TRACE, "utf8").trim().split("\n").sort(), ["builds", "meet-recognition", "runtime"]);
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    f.close();
  }
});

test("preparation still refuses dirty source", () => {
  const f = preparationFixture();
  try {
    writeFileSync(join(f.repo, "uncommitted"), "change");
    const result = f.run("prepare");
    assert.equal(result.status, 65, result.stderr);
    assert.equal(existsSync(f.env.TRACE), false);
    assert.equal(existsSync(f.receipt()), false);
    f.assertServing();
  } finally { f.close(); }
});

test("runtime dependency cache tracks its build recipe, package exports, compaction recovery and both Kenan packages", () => {
  const f = fixture();
  try {
    const runtime = readFileSync(join(root, "deploy/runtime"), "utf8");
    const hashScript = runtime.slice(runtime.indexOf("dependency_hash=$("), runtime.indexOf('\ndependency_release='));
    assert.ok(hashScript.startsWith("dependency_hash=$("));
    const inputs = [...hashScript.matchAll(/^\s+sha256sum (.+)\n/gm)].flatMap(match => match[1].split(" "));
    const changedInputs = [
      "deploy/runtime",
      "packages/orchestrator/package.json",
      "packages/runtime/extensions/codex-compaction/retry.mjs",
      ...["kenan-memory", "kenan-root"].flatMap(name => [
        `packages/${name}/src/nested/fixture.ts`,
        `packages/${name}/package.json`,
        `packages/${name}/tsconfig.json`,
      ]),
      "packages/kenan-memory/discretion.md",
      "packages/kenan-memory/person.md",
      "packages/kenan-root/instructions.md",
    ];
    for (const name of new Set([...inputs, ...changedInputs])) {
      mkdirSync(dirname(join(f.repo, name)), { recursive: true });
      writeFileSync(join(f.repo, name), "original\n");
    }
    function hash() {
      const result = spawnSync("bash", ["-euo", "pipefail", "-c", `${hashScript}\nprintf '%s' "$dependency_hash"`], {
        cwd: f.repo, encoding: "utf8", timeout: 3000,
      });
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /^[a-f0-9]{64}$/);
      return result.stdout;
    }
    const original = hash();
    assert.equal(hash(), original, "unchanged inputs reuse dependencies");
    for (const name of changedInputs) {
      writeFileSync(join(f.repo, name), "changed\n");
      assert.notEqual(hash(), original, `${name} must invalidate dependencies`);
      writeFileSync(join(f.repo, name), "original\n");
    }
    for (const name of ["kenan-memory", "kenan-root"]) {
      const added = join(f.repo, "packages", name, "src/added.ts");
      writeFileSync(added, "new source\n");
      assert.notEqual(hash(), original, `new ${name} source must invalidate dependencies`);
      rmSync(added);
      assert.equal(hash(), original, "removing the added source restores the original key");
    }
  } finally { f.close(); }
});

for (const signal of ["TERM", "INT", "HUP", "failure"]) {
  test(`runtime removes unpublished dependency stages after ${signal}`, () => {
    const f = fixture();
    try {
      for (const dir of ["packages/runtime", "vendor/pi", "apps", "tools"]) mkdirSync(join(f.repo, dir), { recursive: true });
      for (const name of ["package.json", "package-lock.json", "vendor/pi/package.tgz"]) writeFileSync(join(f.repo, name), "{}\n");
      const runtimeSource = readFileSync(join(root, "deploy/runtime"), "utf8");
      const hashInputs = [...runtimeSource.matchAll(/^\s+sha256sum (.+)\n/gm)].flatMap(match => match[1].split(" "));
      for (const name of hashInputs.filter((name) => name !== "package.json" && name !== "package-lock.json" && name !== "deploy/runtime")) {
        mkdirSync(dirname(join(f.repo, name)), { recursive: true });
        writeFileSync(join(f.repo, name), "\n");
      }
      for (const name of ["kenan-memory", "kenan-root"]) mkdirSync(join(f.repo, "packages", name, "src"), { recursive: true });
      f.executable(join(f.bin, "npm"), 'mkdir -p node_modules/.bin; printf "{}\\n" > node_modules/.package-lock.json');
      f.executable(join(f.bin, "node"), 'exit 0');
      f.executable(join(f.bin, "rsync"), `touch "\${@: -1}/partial"
${signal === "failure" ? "exit 23" : `kill -${signal} "$PPID"; exit 20`}`);
      f.commit();
      const dependencies = join(f.directory, "dependencies"), destination = join(f.directory, "runtime");
      mkdirSync(destination);
      writeFileSync(join(destination, ".pi-stack-commit"), "selected-release\n");
      const result = f.run("runtime", { PI_STACK_DEPLOY_DEADLINE_ACTIVE: "1", PI_STACK_DEPENDENCIES_ROOT: dependencies, PI_STACK_RUNTIME_DEST: destination });
      assert.equal(result.status, { TERM: 143, INT: 130, HUP: 129, failure: 23 }[signal], result.stderr);
      assert.deepEqual(readdirSync(dependencies), [], "partial dependencies cannot survive interruption");
      assert.deepEqual(readdirSync(f.env.TMPDIR), [], "temporary npm staging is removed too");
      assert.equal(readFileSync(join(destination, ".pi-stack-commit"), "utf8"), "selected-release\n");
    } finally { f.close(); }
  });
}

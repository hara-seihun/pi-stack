import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const timeout = spawnSync("bash", ["-c", "command -v timeout"], { encoding: "utf8" }).stdout.trim();

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "pi-stack-prepare-"));
  const repo = join(directory, "repo"), bin = join(directory, "bin");
  mkdirSync(join(repo, "deploy"), { recursive: true });
  mkdirSync(bin);
  for (const name of ["lib", "release-checkout", "prepare", "runtime", "retain"]) copyFileSync(join(root, "deploy", name), join(repo, "deploy", name));
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, PI_STACK_HOST_LOCK_HELD: "0", PI_STACK_HOST_LOCK_PATH: join(directory, "host.lock"), PI_STACK_DEPLOY_LOCK_HELD: "0", PI_STACK_DEPLOY_DEADLINE_ACTIVE: "0", PI_STACK_ALLOW_DIRTY: "0", PI_STACK_DEPLOY_NO_SUDO: "1", TRACE: join(directory, "trace"), TMPDIR: join(directory, "tmp"), PI_STACK_RUNTIME_DEST: join(directory, "srv/runtime"), PI_STACK_DEPENDENCIES_ROOT: join(directory, "srv/dependencies") };
  mkdirSync(env.TMPDIR);
  function executable(path, source) { writeFileSync(path, `#!/usr/bin/env bash\nset -euo pipefail\n${source}\n`, { mode: 0o755 }); }
  function commit() {
    for (const args of [["init", "-q"], ["add", "."], ["-c", "user.name=test", "-c", "user.email=test@example.test", "commit", "-qm", "fixture"]]) {
      const result = spawnSync("git", ["-C", repo, ...args], { encoding: "utf8" });
      assert.equal(result.status, 0, result.stderr);
    }
  }
  function run(name, extra = {}) {
    return spawnSync(join(repo, "deploy", name), [], { env: { ...env, ...extra }, encoding: "utf8", timeout: 3000 });
  }
  return { directory, repo, bin, env, executable, commit, run, close: () => rmSync(directory, { recursive: true, force: true }) };
}

function preparationFixture() {
  const f = fixture();
  f.executable(join(f.bin, "systemctl"), 'echo "preparation must delegate host discovery to its components" >&2; exit 64');
  writeFileSync(join(f.repo, "deploy/lib"), `${readFileSync(join(root, "deploy/lib"), "utf8")}\npi_stack_prepare_builds() { test "\${PI_STACK_DEPLOY_DEADLINE_ACTIVE:-}" = 1 || return 64; printf 'builds\\n' >> "$TRACE"; return "\${BUILD_EXIT:-0}"; }\n`);
  for (const name of ["runtime", "transcription", "write-engine", "host"]) {
    f.executable(join(f.repo, "deploy", name), `root=$(cd "$(dirname "$0")/.." && pwd)
source "$root/deploy/lib"
pi_stack_enter_deployment "$0" "$root" "$@"
printf '%s\\n' "${name}" >> "$TRACE"
sleep "\${WORK_SECONDS:-0}"
exit "\${${name.toUpperCase().replaceAll("-", "_")}_EXIT:-0}"`);
  }
  // Any nested activation deadline fails immediately, without a 50-second test.
  f.executable(join(f.bin, "timeout"), 'printf "deadline %s\\n" "$*" >> "$TRACE"; exit 124');
  f.commit();
  return f;
}

test("preparation uses the caller deadline for every child; standalone components keep theirs", () => {
  const f = preparationFixture();
  try {
    const prepared = f.run("prepare");
    assert.equal(prepared.status, 0, prepared.stderr);
    assert.equal(prepared.stderr, "");
    assert.deepEqual(readFileSync(f.env.TRACE, "utf8").trim().split("\n").sort(), ["builds", "runtime", "transcription", "write-engine"]);
    for (const name of ["host", "runtime", "transcription", "write-engine"]) {
      const deployed = f.run(name);
      assert.equal(deployed.status, 124, deployed.stderr);
    }
    assert.equal(readFileSync(f.env.TRACE, "utf8").match(/deadline --signal=TERM --kill-after=2s 50s /g).length, 4);
  } finally { f.close(); }
});

for (const writeLoadState of ["loaded", "not-found"]) test(`Write owns host discovery during preparation with its unit ${writeLoadState}`, () => {
  const f = preparationFixture();
  try {
    copyFileSync(join(root, "deploy/write-engine"), join(f.repo, "deploy/write-engine"));
    f.executable(join(f.bin, "systemctl"), `[[ "$*" == "show pi-stack-write.service -p LoadState --value" ]] || exit 64
printf 'discovery\\n' >> "$TRACE"
printf '%s\\n' '${writeLoadState}'`);
    f.executable(join(f.bin, "uv"), 'printf "uv\\n" >> "$TRACE"; exit 23');
    f.executable(join(f.bin, "curl"), 'echo "fixture must not download weights" >&2; exit 64');
    const source = join(f.repo, "apps/write/engine");
    mkdirSync(join(source, "cleanup"), { recursive: true });
    for (const file of ["requirements.lock", "model.json", "server.py", "cleanup/model.json"]) writeFileSync(join(source, file), "\n");
    f.commit();
    const destination = join(f.directory, "write-engine");
    const result = f.run("prepare", { PI_STACK_WRITE_ENGINE_DEST: destination, PI_STACK_WRITE_ENGINE_FORCE: "0" });
    const calls = readFileSync(f.env.TRACE, "utf8").trim().split("\n").sort();
    if (writeLoadState === "loaded") {
      assert.equal(result.status, 1, result.stderr);
      assert.deepEqual(calls, ["builds", "discovery", "runtime", "transcription", "uv"]);
      assert.match(result.stderr, /write-engine exited 23/);
      assert.doesNotMatch(result.stdout, /prepared Pi stack/);
    } else {
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stderr, "");
      assert.deepEqual(calls, ["builds", "discovery", "runtime", "transcription"]);
      assert.match(result.stdout, /nothing to prepare/);
      assert.equal(existsSync(join(f.directory, ".pi-write")), false);
    }
    assert.equal(existsSync(destination), false);
  } finally { f.close(); }
});

test("preparation reports each failed child and never reports success", () => {
  const f = preparationFixture();
  try {
    const result = f.run("prepare", { RUNTIME_EXIT: "23", TRANSCRIPTION_EXIT: "7", WRITE_ENGINE_EXIT: "11", BUILD_EXIT: "9" });
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /builds exited 9/);
    assert.match(result.stderr, /runtime exited 23/);
    assert.match(result.stderr, /transcription exited 7/);
    assert.match(result.stderr, /write-engine exited 11/);
    assert.doesNotMatch(result.stdout, /prepared Pi stack/);
  } finally { f.close(); }
});

test("the caller can still terminate preparation and its children", () => {
  const f = preparationFixture();
  try {
    const result = spawnSync(timeout, ["--kill-after=1s", "0.2s", join(f.repo, "deploy/prepare")], {
      env: { ...f.env, WORK_SECONDS: "2" }, encoding: "utf8", timeout: 2000,
    });
    assert.equal(result.status, 124, result.stderr);
    assert.doesNotMatch(result.stdout, /prepared Pi stack/);
    assert.doesNotMatch(readFileSync(f.env.TRACE, "utf8"), /deadline/);
  } finally { f.close(); }
});

test("preparation still refuses dirty source", () => {
  const f = preparationFixture();
  try {
    writeFileSync(join(f.repo, "uncommitted"), "change");
    const result = f.run("prepare");
    assert.equal(result.status, 65, result.stderr);
    assert.equal(existsSync(f.env.TRACE), false);
  } finally { f.close(); }
});

for (const signal of ["TERM", "INT", "HUP", "failure"]) {
  test(`runtime removes unpublished dependency stages after ${signal}`, () => {
    const f = fixture();
    try {
      for (const dir of ["packages/runtime", "vendor/pi", "apps", "tools"]) mkdirSync(join(f.repo, dir), { recursive: true });
      for (const name of ["package.json", "package-lock.json", "vendor/pi/package.tgz"]) writeFileSync(join(f.repo, name), "{}\n");
      const runtimeSource = readFileSync(join(root, "deploy/runtime"), "utf8");
      const hashInputs = runtimeSource.match(/sha256sum (.+)\n/)[1].split(" ");
      for (const name of hashInputs.filter((name) => name !== "package.json" && name !== "package-lock.json")) {
        mkdirSync(dirname(join(f.repo, name)), { recursive: true });
        writeFileSync(join(f.repo, name), "\n");
      }
      f.executable(join(f.bin, "npm"), 'mkdir -p node_modules/.bin');
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
